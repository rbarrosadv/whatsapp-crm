// Processo principal do Electron: janela, bandeja, notificações,
// lembretes e a ponte (IPC) entre a interface e o WhatsApp/banco.
import {
  app, BrowserWindow, ipcMain, protocol, net, shell, dialog, Notification, Tray, Menu, nativeImage,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as db from './db.js';
import { WhatsAppService } from './whatsapp.js';
import { DemoWhatsAppService } from './demo.js';
import { webmToOgg } from './ogg.js';
import { importLegacy, legacyStateFile } from './legacy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DEMO = process.argv.includes('--demo') || process.env.CRM_DEMO === '1';

// Pasta de dados fixa: a sessão do WhatsApp e o banco ficam sempre no
// mesmo lugar, mesmo rodando via "npm start" sem instalar.
const LEGACY_STATE_FILE = legacyStateFile(app.getPath('appData'));
const DATA_DIR = process.env.CRM_DATA_DIR
  || path.join(app.getPath('appData'), DEMO ? 'WhatsAppCRM-Demo' : 'WhatsAppCRM');
app.setPath('userData', DATA_DIR);
// No Windows, sem instalador, as notificações precisam do caminho do executável como id.
app.setAppUserModelId(app.isPackaged ? 'com.whatsappcrm.desktop' : process.execPath);

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
    title: DEMO ? 'WhatsApp CRM (demonstração)' : 'WhatsApp CRM',
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

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: fs.existsSync(ICON) ? ICON : undefined, silent: false });
  if (onClick) n.on('click', onClick);
  n.show();
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
  });
}

function maybeNotifyMessage(chatJid, msg) {
  if (settings.notifications === false) return;
  const chat = db.getChat(chatJid);
  if (!chat) return;
  if (chat.muted_until && (chat.muted_until === -1 || chat.muted_until > Date.now())) return;
  const focusedHere = win && win.isFocused() && wa.activeChat === chatJid;
  if (focusedHere) return;
  if (win && !win.isFocused()) win.flashFrame(true);
  const who = chat.is_group ? `${chat.display_name} — ${msg.sender_name || 'alguém'}` : chat.display_name;
  const body = settings.notificationPreview === false ? 'Nova mensagem' : db.previewOf(msg).slice(0, 180);
  notify(who, body, () => { showWindow(); send('ui:open-chat', chatJid); });
}

function startReminders() {
  const check = () => {
    try {
      for (const t of db.dueTasksToNotify()) {
        db.markTaskNotified(t.id);
        const chat = t.jid ? db.getChat(t.jid) : null;
        notify(`⏰ Lembrete${chat ? ` — ${chat.display_name}` : ''}`, t.title, () => {
          showWindow();
          if (t.jid) send('ui:open-chat', t.jid); else send('ui:open-view', 'tasks');
        });
        send('tasks:changed', null);
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
    settings: publicSettings(),
    dataDir: DATA_DIR,
    legacyAvailable: !DEMO && fs.existsSync(LEGACY_STATE_FILE),
    legacyPending: db.legacyPendingCount(),
    version: app.getVersion(),
  }),
  'wa:logout': () => wa.logout(),
  'wa:reconnect': () => { wa.retry = 0; return wa.start(); },
  'wa:status': () => wa.getStatus(),
  'wa:reset': () => wa.reset(),
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
  'crm:setTags': (jid, tagIds) => { db.setChatTags(jid, tagIds); wa.markChanged(jid); },
  'crm:activity': (jid) => db.listActivity(jid),
  'notes:list': (jid) => db.listNotes(jid),
  'notes:add': (jid, text) => { const id = db.addNote(jid, text); db.logActivity(jid, 'note', 'Nota adicionada'); return id; },
  'notes:delete': (id) => db.deleteNote(id),
  'tasks:list': (opts) => db.listTasks(opts || {}),
  'tasks:save': (task) => {
    const id = db.saveTask(task);
    if (task.jid) wa.markChanged(task.jid);
    else { const t = db.get('SELECT jid FROM tasks WHERE id = ?', id); if (t?.jid) wa.markChanged(t.jid); }
    return id;
  },
  'tasks:delete': (id) => {
    const t = db.get('SELECT jid FROM tasks WHERE id = ?', id);
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
      'theme', 'lastView', 'lastPipeline', 'enterToSend'];
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
