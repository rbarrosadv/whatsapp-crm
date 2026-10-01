// Processo principal do Electron: janela, bandeja, notificações,
// lembretes e a ponte (IPC) entre a interface e o WhatsApp/banco.
import {
  app, BrowserWindow, ipcMain, protocol, net, shell, dialog, Notification, Tray, Menu, nativeImage, powerMonitor, safeStorage,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as db from './db.js';
import { WhatsAppService } from './whatsapp.js';
import { DemoWhatsAppService, DemoGoogleService } from './demo.js';
import { GoogleService } from './google.js';
import { CalendarSync } from './calendar-sync.js';
import { webmToOgg } from './ogg.js';
import { importLegacy, legacyStateFile } from './legacy.js';
import { diagnoseConnection } from './diag.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DEMO = process.argv.includes('--demo') || process.env.CRM_DEMO === '1';

// Pasta de dados fixa: a sessão do WhatsApp e o banco ficam sempre no
// mesmo lugar, mesmo rodando via "npm start" sem instalar.
const LEGACY_STATE_FILE = legacyStateFile(app.getPath('appData'));
const DATA_DIR = process.env.CRM_DATA_DIR
  || path.join(app.getPath('appData'), DEMO ? 'WhatsAppCRM-Demo' : 'WhatsAppCRM');
app.setPath('userData', DATA_DIR);
// Identidade do app no Windows: é ela que faz as notificações aparecerem
// como "WhatsApp CRM" (com ícone) e ficarem na Central de Notificações.
// Precisa de um atalho no Menu Iniciar com o mesmo id (ensureStartMenuShortcut).
const AUMID = 'com.whatsappcrm.desktop';
app.setAppUserModelId(AUMID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'crm-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

let win = null;
let tray = null;
let wa = null;
let google = null;
let calSync = null;
let quitting = false;
let settings = {};

const ICON = path.join(ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('event', channel, payload);
}

function createWindow() {
  const bounds = settings.windowBounds || { width: 1360, height: 860 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 980,
    minHeight: 600,
    show: false,
    title: `WhatsApp CRM ${app.getVersion()}${DEMO ? ' (demonstração)' : ''}`,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#0b141a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  if (settings.windowMaximized) win.maximize();
  // só o microfone (gravar áudio) e notificações são permitidos
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'notifications', 'clipboard-sanitized-write'].includes(permission));
  });
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  // mantém a versão no título (o <title> do HTML trocaria) — ajuda a saber qual cópia está aberta
  win.on('page-title-updated', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });

  // links externos abrem no navegador padrão
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    settings.windowMaximized = win.isMaximized();
    if (!win.isMaximized()) settings.windowBounds = win.getBounds();
    db.setSetting('windowBounds', settings.windowBounds);
    db.setSetting('windowMaximized', settings.windowMaximized);
  };
  win.on('resize', debounce(saveBounds, 500));
  win.on('move', debounce(saveBounds, 500));
  win.on('focus', () => {
    wa.windowFocused = true;
    win.flashFrame(false);
    if (wa.activeChat) wa.markRead(wa.activeChat).catch(() => {});
  });
  win.on('blur', () => { wa.windowFocused = false; });
  win.on('close', (e) => {
    if (!quitting && settings.minimizeToTray !== false && tray) {
      e.preventDefault();
      win.hide();
      if (!settings.trayHintShown) {
        settings.trayHintShown = true;
        db.setSetting('trayHintShown', true);
        notify('WhatsApp CRM continua aberto', 'O app segue recebendo mensagens na bandeja do sistema (perto do relógio).');
      }
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const trayIcon = path.join(ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'tray.png');
  if (!fs.existsSync(trayIcon)) return;
  tray = new Tray(nativeImage.createFromPath(trayIcon));
  tray.setToolTip('WhatsApp CRM');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir WhatsApp CRM', click: showWindow },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// Guarda as notificações abertas: se forem descartadas da memória, o clique
// nelas deixa de funcionar no Windows.
const liveNotifications = new Set();

/**
 * `discreet`: texto genérico usado no lugar quando o modo discreto está ligado
 * (o aviso não mostra nomes, mensagens nem valores).
 */
function notify(title, body, onClick, discreet) {
  if (!Notification.isSupported()) return;
  if (discreet && settings.discreet) {
    title = discreet;
    body = 'Abra o WhatsApp CRM para ver.';
  }
  const n = new Notification({
    title, body, icon: fs.existsSync(ICON) ? ICON : undefined, silent: false, timeoutType: 'default',
  });
  liveNotifications.add(n);
  const drop = () => liveNotifications.delete(n);
  n.on('click', () => { drop(); (onClick || showWindow)(); });
  n.on('close', drop);
  n.on('failed', (_e, err) => { drop(); console.error('notificação falhou:', err); });
  n.show();
  // evita acumular para sempre
  setTimeout(drop, 24 * 3600 * 1000);
}

/**
 * Cria/atualiza o atalho "WhatsApp CRM" no Menu Iniciar com a identidade do
 * app (AppUserModelID). Sem ele o Windows não mostra as notificações direito.
 */
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32' || DEMO) return;
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WhatsApp CRM.lnk');
    const options = {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${ROOT}"`,
      cwd: ROOT,
      icon: path.join(ROOT, 'assets', 'icon.ico'),
      iconIndex: 0,
      description: 'WhatsApp CRM',
      appUserModelId: AUMID,
    };
    let current = null;
    try { current = shell.readShortcutLink(lnk); } catch { /* não existe */ }
    const same = current && current.target === options.target && current.args === options.args
      && current.appUserModelId === AUMID;
    if (!same) shell.writeShortcutLink(lnk, current ? 'replace' : 'create', options);
  } catch (e) {
    console.error('não foi possível criar o atalho do Menu Iniciar:', e);
  }
}

function updateUnreadBadge() {
  const total = db.get('SELECT COUNT(*) AS n FROM chats WHERE unread > 0 AND archived = 0')?.n || 0;
  if (process.platform !== 'win32') app.setBadgeCount(total);
  const base = DEMO ? 'WhatsApp CRM (demonstração)' : 'WhatsApp CRM';
  if (win && !win.isDestroyed()) win.setTitle(total ? `(${total}) ${base}` : base);
  tray?.setToolTip(total ? `WhatsApp CRM — ${total} conversa(s) não lida(s)` : 'WhatsApp CRM');
}

function wireWhatsApp() {
  wa.on('status', (s) => send('wa:status', s));
  wa.on('chats-changed', (jids) => {
    const chats = jids.map((j) => db.getChat(j)).filter(Boolean);
    const removed = jids.filter((j) => !chats.some((c) => c.jid === j));
    send('chats:changed', { chats, removed });
    updateUnreadBadge();
  });
  wa.on('chat-merged', (m) => send('chats:merged', m));
  wa.on('history', (h) => send('wa:history', h));
  wa.on('message', (ev) => {
    const msg = ev.removed ? null : db.getMessage(ev.chatJid, ev.id);
    if (msg) delete msg.raw;
    send('message', { chatJid: ev.chatJid, id: ev.id, isNew: ev.isNew, removed: !!ev.removed, message: msg });
    if (ev.notify && msg) maybeNotifyMessage(ev.chatJid, msg);
    // mensagem sua para o cliente = retorno dado nos casos dele
    if (ev.isNew && msg?.from_me && msg.type !== 'system') {
      try { db.touchCasesOfContact(ev.chatJid); } catch { /* ignore */ }
    }
  });
}

function maybeNotifyMessage(chatJid, msg) {
  if (settings.notifications === false) return;
  const chat = db.getChat(chatJid);
  if (!chat) return;
  if (chat.muted_until && (chat.muted_until === -1 || chat.muted_until > Date.now())) return;
  // tipos de contato com aviso desligado (ex.: Pessoal em horário de trabalho)
  if (chat.type_id && db.get('SELECT notify FROM contact_types WHERE id = ?', chat.type_id)?.notify === 0) return;
  const focusedHere = win && win.isFocused() && wa.activeChat === chatJid;
  if (focusedHere) return;
  if (win && !win.isFocused()) win.flashFrame(true);
  const who = chat.is_group ? `${chat.display_name} — ${msg.sender_name || 'alguém'}` : chat.display_name;
  const body = settings.notificationPreview === false ? 'Nova mensagem' : db.previewOf(msg).slice(0, 180);
  notify(who, body, () => { showWindow(); send('ui:open-chat', chatJid); }, '💬 Nova mensagem');
}

// avisa quando conversas de trabalho estão há muito tempo sem resposta
function checkForgotten() {
  const hours = Number(settings.forgottenHours ?? 24);
  if (!hours || settings.notifications === false) return;
  const list = db.forgottenChats(hours * 3600 * 1000);
  if (!list.length) return;
  db.markChatsAlerted(list.map((c) => c.jid));
  const names = list.slice(0, 3).map((c) => db.getChat(c.jid)?.display_name).filter(Boolean);
  const more = list.length > 3 ? ` e mais ${list.length - 3}` : '';
  notify(`⏳ ${list.length} conversa(s) aguardando sua resposta há mais de ${hours} h`, `${names.join(', ')}${more}`, () => {
    showWindow();
    if (list.length === 1) send('ui:open-chat', list[0].jid); else send('ui:open-filter', 'awaiting');
  }, '⏳ Conversas aguardando resposta');
}

const DAY = 24 * 3600 * 1000;
const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateBR = (ts) => (ts ? new Date(ts).toLocaleDateString('pt-BR') : 'sem data');

// honorários vencendo / vencidos e casos sem retorno ao cliente
function checkFinanceAndCases() {
  if (settings.notifications === false) return;
  const days = Number(settings.paymentNoticeDays ?? 3);
  const { upcoming, overdue } = db.paymentsToNotify(days);
  if (upcoming.length) {
    db.markPaymentsNotified(upcoming.map((p) => p.id), 'upcoming');
    const total = upcoming.reduce((a, p) => a + p.amount, 0);
    notify(`💰 ${upcoming.length} parcela(s) de honorários vencendo em até ${days} dia(s)`, `Total ${money(total)}`,
      () => { showWindow(); send('ui:open-view', 'finance'); }, '💰 Honorários vencendo');
  }
  if (overdue.length) {
    db.markPaymentsNotified(overdue.map((p) => p.id), 'overdue');
    const total = overdue.reduce((a, p) => a + p.amount, 0);
    notify(`⚠ ${overdue.length} parcela(s) de honorários vencida(s)`, `Total ${money(total)} — abra o Financeiro para cobrar`,
      () => { showWindow(); send('ui:open-view', 'finance'); }, '⚠ Honorários vencidos');
  }
  const staleDays = Number(settings.staleCaseDays ?? 15);
  if (staleDays > 0) {
    const stale = db.staleCases(staleDays * DAY);
    if (stale.length) {
      db.markCasesAlerted(stale.map((c) => c.id));
      const names = stale.slice(0, 3).map((c) => `${db.getChat(c.jid)?.display_name || ''} (${c.title})`);
      notify(`📣 ${stale.length} caso(s) sem notícia ao cliente há mais de ${staleDays} dias`,
        `${names.join(', ')}${stale.length > 3 ? ` e mais ${stale.length - 3}` : ''}`,
        () => { showWindow(); if (stale.length === 1) send('ui:open-chat', stale[0].jid); else send('ui:open-view', 'board'); },
        '📣 Casos sem retorno ao cliente');
    }
  }
}

const DEFAULT_CHARGE_TEMPLATE = 'Olá, {nome}! Tudo bem? Passando para lembrar da {parcela} dos honorários referentes a {caso}, '
  + 'no valor de {valor}, com vencimento em {vencimento}.{pix_linha}\nQualquer dúvida, estou à disposição.';

function chargeText(paymentId) {
  const p = db.getPayment(paymentId);
  if (!p) throw new Error('Parcela não encontrada');
  const chat = db.getChat(p.jid);
  const first = (chat?.display_name || '').split(' ')[0];
  const pix = (settings.pixKey || '').trim();
  const tpl = settings.chargeTemplate || DEFAULT_CHARGE_TEMPLATE;
  const vars = {
    nome: first,
    nome_completo: chat?.display_name || '',
    valor: money(p.amount),
    vencimento: dateBR(p.due_at),
    parcela: p.of_total > 1 ? `parcela ${p.seq}/${p.of_total}` : 'parcela',
    descricao: p.description || 'honorários',
    caso: p.case_title || 'seu atendimento',
    processo: p.process_number || '',
    pix,
    pix_linha: pix ? `\nChave PIX: ${pix}` : '',
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// envia ao Google em segundo plano, sem travar a tela
function syncTaskLater(id) {
  calSync?.syncTask(id).catch((e) => console.error('google: sincronizar', e.message));
}

let googleTick = 0;
function startReminders() {
  const check = () => {
    try {
      for (const t of db.dueTasksToNotify()) {
        db.markTaskNotified(t.id);
        const chat = t.jid ? db.getChat(t.jid) : null;
        notify(`⏰ Lembrete${chat ? ` — ${chat.display_name}` : ''}`, t.title, () => {
          showWindow();
          if (t.jid) send('ui:open-chat', t.jid); else send('ui:open-view', 'tasks');
        }, '⏰ Lembrete');
        send('tasks:changed', null);
      }
      checkForgotten();
      checkFinanceAndCases();
      // a cada ~10 min traz mudanças de horário feitas no Google
      if (++googleTick % 20 === 1 && google?.status().connected) {
        calSync.agenda(Date.now() - 7 * DAY, Date.now() + 120 * DAY).catch(() => {});
      }
    } catch (e) { console.error(e); }
  };
  setInterval(check, 30000);
  setTimeout(check, 5000);
}

// arquivos que o Windows executaria ao abrir
const RISKY_EXT = new Set(['exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'lnk', 'hta', 'jar', 'reg', 'pif', 'cpl', 'msc', 'dll', 'appx', 'msix', 'url', 'scf', 'inf', 'sys']);

function resolveMedia(rel) {
  const base = path.resolve(wa.mediaDir);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) throw new Error('caminho inválido');
  return abs;
}

// ------------------------------------------------------------------ API

function chatOrThrow(jid) {
  if (!jid) throw new Error('Conversa inválida');
  return jid;
}

const api = {
  // estado geral
  bootstrap: () => ({
    demo: DEMO,
    status: wa.getStatus(),
    chats: db.listChats(),
    pipelines: db.listPipelines(),
    tags: db.listTags(),
    quickReplies: db.listQuickReplies(),
    contactTypes: db.listContactTypes(),
    filters: db.listChatFilters(),
    settings: publicSettings(),
    dataDir: DATA_DIR,
    legacyAvailable: !DEMO && fs.existsSync(LEGACY_STATE_FILE),
    legacyPending: db.legacyPendingCount(),
    version: app.getVersion(),
  }),
  'wa:logout': () => wa.logout(),
  'wa:reconnect': () => wa.reconnectNow(),
  'wa:status': () => wa.getStatus(),
  'wa:reset': () => wa.reset(),
  'wa:repair': () => wa.repair(),
  // usado pelos testes do modo demo
  ...(DEMO ? { 'demo:simulateStuck': () => wa.setStatus({ state: 'reconnecting', registered: true, error: 'conexão fechada, código 428', suggestRepair: true }) } : {}),
  'wa:diagnose': async () => {
    const r = await diagnoseConnection();
    wa.logger.warn({ diagnostico: r }, 'teste de conexão');
    return r;
  },
  'wa:pairingCode': (phone) => wa.requestPairingCode(phone),
  'app:openLogs': () => shell.openPath(path.join(DATA_DIR, 'logs')),
  'wa:checkNumber': (phone) => wa.checkNumber(phone),

  // conversas
  'chats:list': () => db.listChats(),
  'chats:get': (jid) => db.getChat(jid),
  'chats:setActive': (jid) => {
    wa.activeChat = jid || null;
    if (jid && wa.windowFocused) return wa.markRead(jid);
    return null;
  },
  'chats:markRead': (jid) => wa.markRead(chatOrThrow(jid)),
  'chats:markUnread': (jid) => { db.setChatUnread(jid, 1); wa.markChanged(jid); },
  'chats:start': async (phone, name) => {
    const jid = await wa.checkNumber(phone);
    if (!jid) throw new Error('Este número não tem WhatsApp.');
    db.upsertChat({ jid, is_group: false });
    if (name) db.updateCrmFields(jid, { custom_name: name });
    if (!db.getChat(jid).last_ts) db.run('UPDATE chats SET last_ts = ? WHERE jid = ?', Date.now(), jid);
    wa.markChanged(jid);
    return db.getChat(jid);
  },
  'chats:avatar': async (jid) => {
    const rel = await wa.avatar(jid);
    return rel ? mediaUrl(rel) : null;
  },
  'chats:groupInfo': (jid) => wa.groupInfo(jid),
  'chats:presence': (jid, type) => wa.sendPresence(jid, type),

  // mensagens
  'messages:list': (jid, opts) => db.listMessages(chatOrThrow(jid), opts || {}),
  'messages:search': (q) => db.searchMessages(String(q || '')),
  'messages:sendText': (jid, text, quotedId) => wa.sendText(chatOrThrow(jid), text, quotedId),
  'messages:sendFiles': async (jid, files, caption, quotedId) => {
    const ids = [];
    for (let i = 0; i < files.length; i++) {
      ids.push(await wa.sendFile(chatOrThrow(jid), files[i], { caption: i === 0 ? caption : undefined, quotedId }));
    }
    return ids;
  },
  'messages:pickFiles': async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: 'Enviar arquivos' });
    return r.canceled ? [] : r.filePaths;
  },
  'messages:sendVoice': (jid, webmBytes) => {
    const { ogg, seconds } = webmToOgg(Buffer.from(webmBytes));
    return wa.sendVoice(chatOrThrow(jid), ogg, 'audio/ogg; codecs=opus', seconds);
  },
  'messages:sendBuffer': async (jid, name, bytes, caption) => {
    const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'crm-'));
    const file = path.join(dir, path.basename(name || 'arquivo').replace(/[<>:"/\\|?*]/g, '_'));
    fs.writeFileSync(file, Buffer.from(bytes));
    try {
      return await wa.sendFile(chatOrThrow(jid), file, { caption });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  'messages:react': (jid, id, emoji) => wa.react(jid, id, emoji),
  'messages:delete': (jid, id) => wa.deleteForEveryone(jid, id),
  'messages:download': async (jid, id) => {
    const rel = await wa.downloadMedia(jid, id);
    send('message', { chatJid: jid, id, isNew: false, message: stripRaw(db.getMessage(jid, id)) });
    return rel;
  },
  'messages:loadOlder': (jid) => wa.loadOlder(jid),
  'media:open': async (rel) => {
    const file = resolveMedia(rel);
    if (RISKY_EXT.has(path.extname(file).slice(1).toLowerCase())) {
      throw new Error('Por segurança, arquivos executáveis não são abertos direto. Use "Salvar como…" se confiar no remetente.');
    }
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
  },
  'media:saveAs': async (rel, suggested) => {
    const src = resolveMedia(rel);
    const r = await dialog.showSaveDialog(win, { defaultPath: suggested || path.basename(src) });
    if (r.canceled || !r.filePath) return false;
    fs.copyFileSync(src, r.filePath);
    return true;
  },
  'media:showInFolder': (rel) => shell.showItemInFolder(resolveMedia(rel)),

  // CRM
  'crm:setStage': (jid, stageId) => { db.setStage(jid, stageId); wa.markChanged(jid); },
  'crm:update': (jid, fields) => { db.updateCrmFields(jid, fields); wa.markChanged(jid); },
  'crm:setType': (jid, typeId) => { db.setContactType(jid, typeId); wa.markChanged(jid); },
  'types:save': (t) => { const id = db.saveContactType(t); broadcastConfig(); return id; },
  'types:delete': (id) => { db.deleteContactType(id); broadcastConfig(); refreshAllChats(); },
  'types:reorder': (ids) => { db.reorderContactTypes(ids); broadcastConfig(); },
  'filters:save': (f) => { const id = db.saveChatFilter(f); broadcastConfig(); return id; },
  'filters:delete': (id) => { db.deleteChatFilter(id); broadcastConfig(); },
  'filters:reorder': (ids) => { db.reorderChatFilters(ids); broadcastConfig(); },
  'crm:setTags': (jid, tagIds) => { db.setChatTags(jid, tagIds); wa.markChanged(jid); },
  'crm:activity': (jid) => db.listActivity(jid),
  'notes:list': (jid, caseId) => db.listNotes(jid, caseId),
  'notes:add': (jid, text, caseId) => { const id = db.addNote(jid, text, caseId); db.logActivity(jid, 'note', 'Nota adicionada'); return id; },

  // casos
  'cases:list': (opts) => db.listCases(opts || {}),
  'cases:get': (id) => db.getCase(id),
  'cases:save': (c) => { const id = db.saveCase(c); const k = db.getCase(id); wa.markChanged(k.jid); send('cases:changed', k.jid); return id; },
  'cases:setStage': (id, stageId) => { db.setCaseStage(id, stageId); const k = db.getCase(id); wa.markChanged(k.jid); send('cases:changed', k.jid); },
  'cases:setStatus': (id, status) => { db.setCaseStatus(id, status); const k = db.getCase(id); wa.markChanged(k.jid); send('cases:changed', k.jid); },
  'cases:touch': (id) => { db.touchCase(id); send('cases:changed', db.getCase(id)?.jid); },
  'cases:delete': (id) => { const jid = db.deleteCase(id); if (jid) { wa.markChanged(jid); send('cases:changed', jid); } },
  'cases:docs': (id) => db.listCaseDocs(id).map((d) => ({ ...d, url: mediaUrl(d.file) })),
  'cases:attachMessage': async (caseId, chatJid, msgId) => {
    const m = db.getMessage(chatJid, msgId);
    if (!m) throw new Error('Mensagem não encontrada');
    const rel = m.media_file && fs.existsSync(resolveMedia(m.media_file)) ? m.media_file : await wa.downloadMedia(chatJid, msgId);
    const name = m.media_name || `${{ image: 'foto', video: 'video', audio: 'audio', ptt: 'audio', sticker: 'figurinha' }[m.type] || 'arquivo'}-${new Date(m.ts).toISOString().slice(0, 10)}${path.extname(rel)}`;
    const id = db.addCaseDoc({ case_id: caseId, name, file: rel, mime: m.media_mime, size: m.media_size, msg_id: msgId });
    send('cases:changed', db.getCase(caseId)?.jid);
    return id;
  },
  'cases:addFiles': async (caseId) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: 'Adicionar documentos ao caso' });
    if (r.canceled) return 0;
    const dir = path.join(wa.mediaDir, '_casos', String(caseId));
    fs.mkdirSync(dir, { recursive: true });
    for (const f of r.filePaths) {
      let name = path.basename(f);
      let dest = path.join(dir, name);
      for (let i = 2; fs.existsSync(dest); i++) { name = `${path.parse(f).name} (${i})${path.extname(f)}`; dest = path.join(dir, name); }
      fs.copyFileSync(f, dest);
      db.addCaseDoc({ case_id: caseId, name, file: path.relative(wa.mediaDir, dest), size: fs.statSync(dest).size });
    }
    send('cases:changed', db.getCase(caseId)?.jid);
    return r.filePaths.length;
  },
  'cases:deleteDoc': (id) => { const d = db.deleteCaseDoc(id); if (d) send('cases:changed', db.getCase(d.case_id)?.jid); },

  // honorários / financeiro
  'finance:summary': () => db.financeSummary(),
  'finance:list': (opts) => db.listPayments(opts || {}),
  'finance:save': (p) => { const id = db.savePayment(p); const k = db.getCase(p.case_id || db.getPayment(id)?.case_id); if (k) { wa.markChanged(k.jid); send('cases:changed', k.jid); } send('finance:changed'); return id; },
  'finance:generate': (caseId, opts) => { const ids = db.generateInstallments(caseId, opts); const k = db.getCase(caseId); wa.markChanged(k.jid); send('cases:changed', k.jid); send('finance:changed'); return ids; },
  'finance:setPaid': (id, paid) => { db.setPaymentPaid(id, paid); const p = db.getPayment(id); if (p) { wa.markChanged(p.jid); send('cases:changed', p.jid); } send('finance:changed'); },
  'finance:delete': (id) => { const p = db.getPayment(id); db.deletePayment(id); if (p) { wa.markChanged(p.jid); send('cases:changed', p.jid); } send('finance:changed'); },
  'finance:chargeText': (id) => chargeText(id),
  'finance:sendCharge': async (id, text) => {
    const p = db.getPayment(id);
    if (!p) throw new Error('Parcela não encontrada');
    await wa.sendText(p.jid, text || chargeText(id));
    db.markPaymentCharged(id);
    db.logActivity(p.jid, 'charge', `Cobrança enviada: ${p.description || 'honorários'} (${money(p.amount)})`);
    send('finance:changed');
  },
  'finance:defaultTemplate': () => DEFAULT_CHARGE_TEMPLATE,
  'notes:delete': (id) => db.deleteNote(id),
  'tasks:list': (opts) => db.listTasks(opts || {}),
  'tasks:save': async (task) => {
    const id = db.saveTask(task);
    if (task.calendar_id) {
      // escolheu outra agenda do Google: move o evento para lá
      const cur = db.getTask(id);
      if (cur.gcal_event_id && cur.gcal_calendar_id !== task.calendar_id) {
        await calSync?.removeTask(cur).catch(() => {});
        db.setTaskGcal(id, null, null);
      }
      db.run('UPDATE tasks SET gcal_calendar_id = ? WHERE id = ? AND gcal_event_id IS NULL', task.calendar_id, id);
    }
    syncTaskLater(id);
    const cid = task.case_id ?? db.get('SELECT case_id FROM tasks WHERE id = ?', id)?.case_id;
    if (cid) send('cases:changed', db.getCase(cid)?.jid);
    if (task.jid) wa.markChanged(task.jid);
    else { const t = db.get('SELECT jid FROM tasks WHERE id = ?', id); if (t?.jid) wa.markChanged(t.jid); }
    return id;
  },
  'tasks:delete': (id) => {
    const t = db.getTask(id);
    calSync?.removeTask(t).catch((e) => console.error('google: apagar evento', e.message));
    db.deleteTask(id);
    if (t?.jid) wa.markChanged(t.jid);
  },
  'pipelines:list': () => db.listPipelines(),
  'pipelines:save': (p) => { const id = db.savePipeline(p); broadcastConfig(); return id; },
  'pipelines:delete': (id) => { db.deletePipeline(id); broadcastConfig(); refreshAllChats(); },
  'pipelines:reorder': (ids) => { db.reorderPipelines(ids); broadcastConfig(); },
  'tags:save': (t) => { const id = db.saveTag(t); broadcastConfig(); return id; },
  'tags:delete': (id) => { db.deleteTag(id); broadcastConfig(); refreshAllChats(); },
  'quick:save': (q) => { const id = db.saveQuickReply(q); broadcastConfig(); return id; },
  'quick:delete': (id) => { db.deleteQuickReply(id); broadcastConfig(); },
  stats: () => db.stats(),

  // configurações
  'settings:set': (key, value) => {
    const allowed = ['notifications', 'notificationPreview', 'minimizeToTray', 'sendReadReceipts', 'openAtLogin',
      'theme', 'lastView', 'lastPipeline', 'enterToSend', 'forgottenHours', 'lastFilter',
      'chargeTemplate', 'pixKey', 'paymentNoticeDays', 'staleCaseDays',
      'googleSync', 'googleCalendarId', 'agendaHidden', 'agendaView', 'agendaHours',
      'discreet', 'discreetMessages'];
    if (!allowed.includes(key)) throw new Error('configuração desconhecida');
    settings[key] = value;
    db.setSetting(key, value);
    applySettings();
    return publicSettings();
  },
  'backup:export': async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: 'Salvar backup do CRM', defaultPath: `backup-whatsapp-crm-${stamp}.sqlite`,
      filters: [{ name: 'Banco de dados', extensions: ['sqlite'] }],
    });
    if (r.canceled || !r.filePath) return false;
    if (fs.existsSync(r.filePath)) fs.rmSync(r.filePath);
    db.run('VACUUM INTO ?', r.filePath);
    return r.filePath;
  },
  'contacts:exportCsv': async (rows) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Exportar contatos', defaultPath: 'contatos-crm.csv', filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled || !r.filePath) return false;
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((row) => row.map(esc).join(';'));
    fs.writeFileSync(r.filePath, `﻿${lines.join('\r\n')}`, 'utf-8');
    return r.filePath;
  },
  'legacy:import': () => {
    const res = importLegacy(db, LEGACY_STATE_FILE);
    broadcastConfig();
    refreshAllChats();
    return res;
  },
  // agenda / Google
  'google:status': () => google.status(),
  'google:importClient': async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Escolha o arquivo da chave do Google (client_secret….json)',
      filters: [{ name: 'Chave do Google', extensions: ['json'] }], properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return google.status();
    google.importClient(r.filePaths[0]);
    return google.status();
  },
  'google:connect': async () => {
    const st = await google.connect();
    showWindow();
    calSync.syncAll().then((n) => { if (n) notify('📅 Google Agenda conectado', `${n} compromisso(s) do CRM enviados para a sua agenda.`); }).catch(() => {});
    return st;
  },
  'google:disconnect': () => google.disconnect(),
  'google:calendars': (force) => google.calendars(force),
  'google:syncAll': () => calSync.syncAll(),
  'agenda:events': async (from, to, calendarIds) => {
    // o que foi criado com o Google desconectado vai agora
    if (calSync.enabled() && db.tasksToSync().length) await calSync.syncAll().catch(() => {});
    return calSync.agenda(from, to, calendarIds);
  },
  'agenda:saveEvent': async (calendarId, ev, eventId) => google.saveEvent(calendarId, ev, eventId),
  'agenda:deleteEvent': (calendarId, eventId) => google.deleteEvent(calendarId, eventId),

  'app:testNotification': () => {
    if (!Notification.isSupported()) throw new Error('Este Windows não permite notificações para o app.');
    notify('WhatsApp CRM — teste', 'Se você está vendo isto, as notificações estão funcionando. 👍');
  },
  'app:openNotificationSettings': () => {
    if (process.platform === 'win32') shell.openExternal('ms-settings:notifications');
  },
  'app:openDataDir': () => shell.openPath(DATA_DIR),
  'app:openExternal': (url) => { if (/^https?:/i.test(url)) shell.openExternal(url); },
};

function mediaUrl(rel) {
  return `crm-media://file/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
}

function stripRaw(m) { if (m) delete m.raw; return m; }

function broadcastConfig() {
  send('config:changed', {
    pipelines: db.listPipelines(), tags: db.listTags(), quickReplies: db.listQuickReplies(),
    contactTypes: db.listContactTypes(), filters: db.listChatFilters(),
  });
}

function refreshAllChats() {
  send('chats:reload', db.listChats());
}

function publicSettings() {
  const { windowBounds, windowMaximized, trayHintShown, ...rest } = settings;
  return rest;
}

function applySettings() {
  wa.sendReadReceipts = settings.sendReadReceipts !== false;
  if (app.isPackaged || process.platform === 'win32') {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!settings.openAtLogin,
        path: process.execPath,
        args: app.isPackaged ? ['--hidden'] : [ROOT, '--hidden'],
      });
    } catch { /* ignore */ }
  }
}

ipcMain.handle('api', async (_e, method, args) => {
  const fn = api[method];
  if (!fn) throw new Error(`Método desconhecido: ${method}`);
  return fn(...(args || []));
});

// usado só pelos testes automáticos no modo demo
if (DEMO) {
  api['demo:incoming'] = (phone, text, name) => wa.simulateIncoming(phone, text, name);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ------------------------------------------------------------ ciclo de vida

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  db.openDb(DATA_DIR);
  settings = db.getSettings();

  protocol.handle('crm-media', (req) => {
    try {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      return net.fetch(pathToFileURL(resolveMedia(rel)).toString());
    } catch {
      return new Response('não encontrado', { status: 404 });
    }
  });

  const Service = DEMO ? DemoWhatsAppService : WhatsAppService;
  wa = new Service({ dataDir: DATA_DIR, logFile: path.join(DATA_DIR, 'logs', 'whatsapp.log') });
  applySettings();
  wireWhatsApp();
  wa.logger.warn({ versaoApp: app.getVersion(), pastaApp: ROOT, electron: process.versions.electron }, 'app aberto');

  google = DEMO ? new DemoGoogleService() : new GoogleService({
    dir: path.join(DATA_DIR, 'google'),
    fetch: (url, opts) => net.fetch(url, opts),
    openExternal: (url) => shell.openExternal(url),
    safeStorage,
  });
  calSync = new CalendarSync({ google, getSettings: () => settings, onChange: () => send('tasks:changed', null) });
  let warnedReconnect = false;
  google.on('status', (st) => {
    send('google:status', st);
    if (st.needsReconnect && !warnedReconnect) {
      warnedReconnect = true;
      notify('📅 Reconectar Google Agenda', 'A conexão com o Google expirou (acontece a cada 7 dias no modo de teste). Clique para reconectar.',
        () => { showWindow(); send('ui:open-view', 'agenda'); });
    }
    if (!st.needsReconnect) warnedReconnect = false;
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'WhatsApp CRM',
      submenu: [
        { label: 'Recarregar interface', accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
        { label: 'Ferramentas do desenvolvedor', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'zoomIn', label: 'Aumentar zoom' },
        { role: 'zoomOut', label: 'Diminuir zoom' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { type: 'separator' },
        { label: 'Sair', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' }, { role: 'redo', label: 'Refazer' }, { type: 'separator' },
        { role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
      ],
    },
  ]));

  // ao voltar da suspensão a conexão antiga já morreu: reconecta na hora
  powerMonitor.on('resume', () => {
    if (!wa.hasSession()) return;
    setTimeout(() => wa.reconnectNow().catch((e) => console.error(e)), 1500);
  });

  ensureStartMenuShortcut();
  createWindow();
  createTray();
  updateUnreadBadge();
  startReminders();
  wa.start().catch((e) => {
    console.error(e);
    send('wa:status', { state: 'reconnecting', error: e.message });
    wa.scheduleReconnect(10000);
  });
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || quitting) app.quit();
});
app.on('will-quit', async () => {
  await wa?.stop();
  db.closeDb();
});
app.on('activate', showWindow);
