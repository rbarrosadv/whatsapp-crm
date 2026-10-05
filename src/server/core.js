// Motor do sistema, sem Electron: banco, WhatsApp, Google Agenda, lembretes
// e a tabela `api` que a interface chama. Roda no servidor do escritório
// (ou no próprio computador, no modo local). Eventos para a interface saem
// por `core.events` ('event', canal, dados, destino) e o servidor HTTP os
// repassa às janelas abertas.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as db from '../main/db.js';
import * as auth from './auth.js';
import { WhatsAppService } from '../main/whatsapp.js';
import { DemoWhatsAppService, DemoGoogleService } from '../main/demo.js';
import { GoogleService } from '../main/google.js';
import { CalendarSync } from '../main/calendar-sync.js';
import { webmToOgg } from '../main/ogg.js';
import { importLegacy, legacyStateFile } from '../main/legacy.js';
import { diagnoseConnection } from '../main/diag.js';

const DAY = 24 * 3600 * 1000;
const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateBR = (ts) => (ts ? new Date(ts).toLocaleDateString('pt-BR') : 'sem data');

// Preferências de cada pessoa (ficam no usuário) × configurações do escritório (valem para todos).
export const USER_KEYS = ['notifications', 'notificationPreview', 'theme', 'lastView', 'lastPipeline', 'enterToSend',
  'lastFilter', 'agendaHidden', 'agendaView', 'agendaHours', 'discreet', 'discreetMessages'];
export const OFFICE_KEYS = ['sendReadReceipts', 'forgottenHours', 'chargeTemplate', 'pixKey', 'paymentNoticeDays',
  'staleCaseDays', 'googleSync', 'googleCalendarId', 'signMessages'];

export const DEFAULT_CHARGE_TEMPLATE = 'Olá, {nome}! Tudo bem? Passando para lembrar da {parcela} dos honorários referentes a {caso}, '
  + 'no valor de {valor}, com vencimento em {vencimento}.{pix_linha}\nQualquer dúvida, estou à disposição.';

// arquivos que o Windows executaria ao abrir
export const RISKY_EXT = new Set(['exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'lnk', 'hta', 'jar', 'reg', 'pif', 'cpl', 'msc', 'dll', 'appx', 'msix', 'url', 'scf', 'inf', 'sys']);

/** Pasta de dados padrão (a mesma do app antigo no Windows, para não perder nada). */
export function defaultDataDir(demo) {
  const base = process.env.APPDATA || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'));
  return path.join(base, demo ? 'WhatsAppCRM-Demo' : 'WhatsAppCRM');
}

/** Criptografia do token do Google quando não há o cofre do sistema (servidor). */
function fileSafeStorage(dir) {
  const keyFile = path.join(dir, 'secret.key');
  const key = () => {
    if (!fs.existsSync(keyFile)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    }
    return fs.readFileSync(keyFile);
  };
  return {
    isEncryptionAvailable: () => true,
    encryptString(s) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
      const body = Buffer.concat([c.update(s, 'utf-8'), c.final()]);
      return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
    },
    decryptString(b) {
      if (b[0] !== 1) throw new Error('formato desconhecido');
      const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(1, 13));
      d.setAuthTag(b.subarray(13, 29));
      return Buffer.concat([d.update(b.subarray(29)), d.final()]).toString('utf-8');
    },
  };
}

/**
 * @param {{dataDir: string, demo?: boolean, version?: string, safeStorage?: object,
 *          resolveUpload?: (token: string) => {path: string, name: string}}} opts
 */
export async function createCore({ dataDir, demo = false, version = '', safeStorage, resolveUpload }) {
  const events = new EventEmitter();
  const LEGACY_STATE_FILE = legacyStateFile(process.env.APPDATA || path.join(os.homedir(), '.config'));

  db.openDb(dataDir);
  let settings = db.getSettings();

  /** Evento para as janelas abertas. `to`: {conn} | {user} | undefined (todas). */
  const send = (channel, payload, to) => events.emit('event', channel, payload, to);

  /** Aviso (notificação). Cada janela decide se mostra, conforme as preferências da pessoa. */
  const notify = (n, to) => send('notify', n, to);

  const Service = demo ? DemoWhatsAppService : WhatsAppService;
  const wa = new Service({ dataDir, logFile: path.join(dataDir, 'logs', 'whatsapp.log') });

  // ---------------------------------------------------- quem está vendo o quê
  // Uma entrada por janela aberta: conversa aberta, se a janela está em foco.
  const viewers = new Map();
  wa.isViewing = (jid) => [...viewers.values()].some((v) => v.jid === jid && v.focused);
  const broadcastViewers = () => send('viewers', [...viewers.values()]
    .filter((v) => v.jid).map((v) => ({ jid: v.jid, userId: v.userId, name: v.name })));

  function viewerOf(ctx) {
    if (!ctx.conn) return null;
    if (!viewers.has(ctx.conn)) viewers.set(ctx.conn, { userId: ctx.user.id, name: ctx.user.name, jid: null, focused: true });
    return viewers.get(ctx.conn);
  }

  // ---------------------------------------------------- WhatsApp → janelas
  wa.on('status', (s) => send('wa:status', s));
  wa.on('chats-changed', (jids) => {
    const chats = jids.map((j) => db.getChat(j)).filter(Boolean);
    const removed = jids.filter((j) => !chats.some((c) => c.jid === j));
    send('chats:changed', { chats, removed });
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

  function maybeNotifyMessage(chatJid, msg) {
    const chat = db.getChat(chatJid);
    if (!chat) return;
    if (chat.muted_until && (chat.muted_until === -1 || chat.muted_until > Date.now())) return;
    // tipos de contato com aviso desligado (ex.: Pessoal)
    if (chat.type_id && db.get('SELECT notify FROM contact_types WHERE id = ?', chat.type_id)?.notify === 0) return;
    const who = chat.is_group ? `${chat.display_name} — ${msg.sender_name || 'alguém'}` : chat.display_name;
    notify({
      kind: 'message', chatJid, title: who, body: db.previewOf(msg).slice(0, 180),
      discreet: '💬 Nova mensagem', action: { chat: chatJid },
    });
  }

  // ---------------------------------------------------- avisos periódicos
  function checkForgotten() {
    const hours = Number(settings.forgottenHours ?? 24);
    if (!hours) return;
    const list = db.forgottenChats(hours * 3600 * 1000);
    if (!list.length) return;
    db.markChatsAlerted(list.map((c) => c.jid));
    const names = list.slice(0, 3).map((c) => db.getChat(c.jid)?.display_name).filter(Boolean);
    const more = list.length > 3 ? ` e mais ${list.length - 3}` : '';
    notify({
      kind: 'forgotten', title: `⏳ ${list.length} conversa(s) aguardando resposta há mais de ${hours} h`,
      body: `${names.join(', ')}${more}`, discreet: '⏳ Conversas aguardando resposta',
      action: list.length === 1 ? { chat: list[0].jid } : { filter: 'awaiting' },
    });
  }

  function checkFinanceAndCases() {
    const days = Number(settings.paymentNoticeDays ?? 3);
    const { upcoming, overdue } = db.paymentsToNotify(days);
    if (upcoming.length) {
      db.markPaymentsNotified(upcoming.map((p) => p.id), 'upcoming');
      const total = upcoming.reduce((a, p) => a + p.amount, 0);
      notify({
        kind: 'finance', audience: 'finance', title: `💰 ${upcoming.length} parcela(s) de honorários vencendo em até ${days} dia(s)`,
        body: `Total ${money(total)}`, discreet: '💰 Honorários vencendo', action: { view: 'finance' },
      });
    }
    if (overdue.length) {
      db.markPaymentsNotified(overdue.map((p) => p.id), 'overdue');
      const total = overdue.reduce((a, p) => a + p.amount, 0);
      notify({
        kind: 'finance', audience: 'finance', title: `⚠ ${overdue.length} parcela(s) de honorários vencida(s)`,
        body: `Total ${money(total)} — abra o Financeiro para cobrar`, discreet: '⚠ Honorários vencidos', action: { view: 'finance' },
      });
    }
    const staleDays = Number(settings.staleCaseDays ?? 15);
    if (staleDays > 0) {
      const stale = db.staleCases(staleDays * DAY);
      if (stale.length) {
        db.markCasesAlerted(stale.map((c) => c.id));
        const names = stale.slice(0, 3).map((c) => `${db.getChat(c.jid)?.display_name || ''} (${c.title})`);
        notify({
          kind: 'cases', title: `📣 ${stale.length} caso(s) sem notícia ao cliente há mais de ${staleDays} dias`,
          body: `${names.join(', ')}${stale.length > 3 ? ` e mais ${stale.length - 3}` : ''}`,
          discreet: '📣 Casos sem retorno ao cliente',
          action: stale.length === 1 ? { chat: stale[0].jid } : { view: 'board' },
        });
      }
    }
  }

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

  // ---------------------------------------------------- Google Agenda
  let googleRequester = null; // janela que pediu para conectar (recebe o link de login)
  const google = demo ? new DemoGoogleService() : new GoogleService({
    dir: path.join(dataDir, 'google'),
    fetch: (url, opts) => fetch(url, opts),
    openExternal: (url) => send('ui:open-url', url, googleRequester ? { conn: googleRequester } : undefined),
    safeStorage: safeStorage || fileSafeStorage(path.join(dataDir, 'google')),
  });
  const calSync = new CalendarSync({ google, getSettings: () => settings, onChange: () => send('tasks:changed', null) });
  let warnedReconnect = false;
  google.on('status', (st) => {
    send('google:status', st);
    if (st.needsReconnect && !warnedReconnect) {
      warnedReconnect = true;
      notify({
        kind: 'google', title: '📅 Reconectar Google Agenda',
        body: 'A conexão com o Google expirou (acontece a cada 7 dias no modo de teste). Clique para reconectar.',
        action: { view: 'agenda' },
      });
    }
    if (!st.needsReconnect) warnedReconnect = false;
  });
  const syncTaskLater = (id) => calSync.syncTask(id).catch((e) => console.error('google: sincronizar', e.message));

  // ---------------------------------------------------- lembretes
  let googleTick = 0;
  const check = () => {
    try {
      for (const t of db.dueTasksToNotify()) {
        db.markTaskNotified(t.id);
        const chat = t.jid ? db.getChat(t.jid) : null;
        notify({
          kind: 'reminder', title: `⏰ Lembrete${chat ? ` — ${chat.display_name}` : ''}`, body: t.title,
          discreet: '⏰ Lembrete', action: t.jid ? { chat: t.jid } : { view: 'tasks' },
        });
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
  const timers = [setInterval(check, 30000), setTimeout(check, 5000)];

  // ---------------------------------------------------- utilidades da API
  function resolveMedia(rel) {
    const base = path.resolve(wa.mediaDir);
    const abs = path.resolve(base, String(rel || ''));
    if (!abs.startsWith(base + path.sep)) throw new Error('caminho inválido');
    return abs;
  }
  const mediaUrl = (rel) => `/media/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
  const stripRaw = (m) => { if (m) delete m.raw; return m; };
  const chatOrThrow = (jid) => { if (!jid) throw new Error('Conversa inválida'); return jid; };
  const uploads = (tokens) => (tokens || []).map((t) => {
    const f = resolveUpload?.(t);
    if (!f) throw new Error('Arquivo enviado não encontrado. Tente de novo.');
    return f;
  });

  function broadcastConfig() {
    send('config:changed', {
      pipelines: db.listPipelines(), tags: db.listTags(), quickReplies: db.listQuickReplies(),
      contactTypes: db.listContactTypes(), filters: db.listChatFilters(),
    });
  }
  const refreshAllChats = () => send('chats:reload', db.listChats());

  /** Configurações vistas por uma pessoa: as do escritório + as preferências dela. */
  function settingsFor(user) {
    const { windowBounds, windowMaximized, trayHintShown, ...office } = settings;
    return { ...office, ...auth.userPrefs(user.id) };
  }

  /** Assinatura "*Nome:*" no início das mensagens enviadas pela equipe. */
  function sign(ctx, text) {
    if (settings.signMessages === false || !ctx.user) return text;
    const sig = (ctx.user.signature || auth.defaultSignature(ctx.user.name)).trim();
    return sig ? `*${sig}:*\n${text}` : text;
  }

  const forMoney = (ctx, v) => (auth.can(ctx.user.role, 'finance:list') ? v : auth.stripMoney(v));
  const who = (ctx) => ctx.user?.name || null;

  const applySettings = () => { wa.sendReadReceipts = settings.sendReadReceipts !== false; };

  // ---------------------------------------------------- API
  // Todo método recebe `ctx` ({user, conn}) e depois os argumentos da interface.
  const api = {
    bootstrap: (ctx) => ({
      demo,
      me: auth.publicUser(ctx.user),
      can: auth.capabilities(ctx.user.role),
      status: wa.getStatus(),
      chats: db.listChats(),
      pipelines: db.listPipelines(),
      tags: db.listTags(),
      quickReplies: db.listQuickReplies(),
      contactTypes: db.listContactTypes(),
      filters: db.listChatFilters(),
      settings: settingsFor(ctx.user),
      dataDir: ctx.user.role === 'socio' ? dataDir : '',
      legacyAvailable: !demo && ctx.user.role === 'socio' && fs.existsSync(LEGACY_STATE_FILE),
      legacyPending: db.legacyPendingCount(),
      version,
      viewers: [...viewers.values()].filter((v) => v.jid).map((v) => ({ jid: v.jid, userId: v.userId, name: v.name })),
    }),
    'wa:logout': () => wa.logout(),
    'wa:reconnect': () => wa.reconnectNow(),
    'wa:status': () => wa.getStatus(),
    'wa:reset': () => wa.reset(),
    'wa:repair': () => wa.repair(),
    'wa:diagnose': async () => {
      const r = await diagnoseConnection();
      wa.logger.warn({ diagnostico: r }, 'teste de conexão');
      return r;
    },
    'wa:pairingCode': (_c, phone) => wa.requestPairingCode(phone),
    'wa:checkNumber': (_c, phone) => wa.checkNumber(phone),

    // equipe
    'users:list': () => auth.listUsers(),
    'users:save': (ctx, u) => {
      const id = auth.saveUser(u);
      send('users:changed', null);
      if (id === ctx.user.id) send('me:changed', auth.publicUser(auth.getUser(id)), { user: id });
      return id;
    },
    'users:roles': () => auth.ROLES,
    'me:update': (ctx, { name, signature }) => {
      const u = ctx.user;
      auth.saveUser({ id: u.id, name: name ?? u.name, login: u.login, signature: signature ?? u.signature });
      const pub = auth.publicUser(auth.getUser(u.id));
      send('me:changed', pub, { user: u.id });
      send('users:changed', null);
      return pub;
    },
    'me:password': (ctx, current, next) => {
      if (!auth.checkPassword(current, ctx.user.pass_hash)) throw new Error('A senha atual não confere.');
      auth.setPassword(ctx.user.id, next);
    },

    // presença da equipe nas conversas
    'app:focus': (ctx, focused) => {
      const v = viewerOf(ctx);
      if (!v) return null;
      v.focused = !!focused;
      if (v.focused && v.jid) return wa.markRead(v.jid);
      return null;
    },

    // conversas
    'chats:list': () => db.listChats(),
    'chats:get': (_c, jid) => db.getChat(jid),
    'chats:setActive': (ctx, jid) => {
      const v = viewerOf(ctx);
      if (v) { v.jid = jid || null; broadcastViewers(); }
      if (jid && (!v || v.focused)) return wa.markRead(jid);
      return null;
    },
    'chats:typing': (ctx, jid) => { send('chats:typing', { jid, userId: ctx.user.id, name: ctx.user.name }); },
    'chats:markRead': (_c, jid) => wa.markRead(chatOrThrow(jid)),
    'chats:markUnread': (_c, jid) => { db.setChatUnread(jid, 1); wa.markChanged(jid); },
    'chats:start': async (_c, phone, name) => {
      const jid = await wa.checkNumber(phone);
      if (!jid) throw new Error('Este número não tem WhatsApp.');
      db.upsertChat({ jid, is_group: false });
      if (name) db.updateCrmFields(jid, { custom_name: name });
      if (!db.getChat(jid).last_ts) db.run('UPDATE chats SET last_ts = ? WHERE jid = ?', Date.now(), jid);
      wa.markChanged(jid);
      return db.getChat(jid);
    },
    'chats:avatar': async (_c, jid) => {
      const rel = await wa.avatar(jid);
      return rel ? mediaUrl(rel) : null;
    },
    'chats:groupInfo': (_c, jid) => wa.groupInfo(jid),
    'chats:presence': (_c, jid, type) => wa.sendPresence(jid, type),

    // mensagens
    'messages:list': (_c, jid, opts) => db.listMessages(chatOrThrow(jid), opts || {}),
    'messages:search': (_c, q) => db.searchMessages(String(q || '')),
    'messages:sendText': (ctx, jid, text, quotedId) => wa.sendText(chatOrThrow(jid), sign(ctx, text), quotedId),
    /** Arquivos já enviados ao servidor por /upload (cada um vira um token). */
    'messages:sendFiles': async (_c, jid, tokens, caption, quotedId) => {
      const files = uploads(tokens);
      const ids = [];
      try {
        for (let i = 0; i < files.length; i++) {
          ids.push(await wa.sendFile(chatOrThrow(jid), files[i].path, { caption: i === 0 ? caption : undefined, quotedId }));
        }
      } finally {
        files.forEach((f) => fs.rmSync(path.dirname(f.path), { recursive: true, force: true }));
      }
      return ids;
    },
    'messages:sendVoice': (_c, jid, token) => {
      const [f] = uploads([token]);
      try {
        const { ogg, seconds } = webmToOgg(fs.readFileSync(f.path));
        return wa.sendVoice(chatOrThrow(jid), ogg, 'audio/ogg; codecs=opus', seconds);
      } finally {
        fs.rmSync(path.dirname(f.path), { recursive: true, force: true });
      }
    },
    'messages:react': (_c, jid, id, emoji) => wa.react(jid, id, emoji),
    'messages:delete': (_c, jid, id) => wa.deleteForEveryone(jid, id),
    'messages:edit': (_c, jid, id, text) => wa.editMessage(jid, id, text),
    'messages:download': async (_c, jid, id) => {
      const rel = await wa.downloadMedia(jid, id);
      send('message', { chatJid: jid, id, isNew: false, message: stripRaw(db.getMessage(jid, id)) });
      return rel;
    },
    'messages:loadOlder': (_c, jid) => wa.loadOlder(jid),
    'media:check': (_c, rel) => {
      const file = resolveMedia(rel);
      if (!fs.existsSync(file)) throw new Error('Arquivo não encontrado.');
      return { url: mediaUrl(rel), risky: RISKY_EXT.has(path.extname(file).slice(1).toLowerCase()) };
    },

    // CRM
    'crm:setStage': (_c, jid, stageId) => { db.setStage(jid, stageId); wa.markChanged(jid); },
    'crm:update': (_c, jid, fields) => { db.updateCrmFields(jid, fields); wa.markChanged(jid); },
    'crm:setType': (_c, jid, typeId) => { db.setContactType(jid, typeId); wa.markChanged(jid); wa.backfillDownloads([jid]); },
    'types:save': (_c, t) => {
      const id = db.saveContactType(t);
      broadcastConfig();
      if (t.autodownload) wa.backfillDownloads(db.autoDownloadChats(id));
      return id;
    },
    'types:delete': (_c, id) => { db.deleteContactType(id); broadcastConfig(); refreshAllChats(); },
    'types:reorder': (_c, ids) => { db.reorderContactTypes(ids); broadcastConfig(); },
    'filters:save': (_c, f) => { const id = db.saveChatFilter(f); broadcastConfig(); return id; },
    'filters:delete': (_c, id) => { db.deleteChatFilter(id); broadcastConfig(); },
    'filters:reorder': (_c, ids) => { db.reorderChatFilters(ids); broadcastConfig(); },
    'crm:setTags': (_c, jid, tagIds) => { db.setChatTags(jid, tagIds); wa.markChanged(jid); },
    'crm:activity': (_c, jid) => db.listActivity(jid),
    'notes:list': (_c, jid, caseId) => db.listNotes(jid, caseId),
    'notes:add': (ctx, jid, text, caseId) => {
      const id = db.addNote(jid, text, caseId);
      db.logActivity(jid, 'note', 'Nota adicionada', who(ctx));
      return id;
    },
    'notes:delete': (_c, id) => db.deleteNote(id),

    // casos
    'cases:list': (ctx, opts) => forMoney(ctx, db.listCases(opts || {})),
    'cases:get': (ctx, id) => forMoney(ctx, db.getCase(id)),
    'cases:save': (ctx, c) => {
      if (!auth.can(ctx.user.role, 'finance:list')) c = auth.stripMoney(c);
      const id = db.saveCase(c);
      const k = db.getCase(id);
      wa.markChanged(k.jid);
      send('cases:changed', k.jid);
      return id;
    },
    'cases:setStage': (_c, id, stageId) => { db.setCaseStage(id, stageId); const k = db.getCase(id); wa.markChanged(k.jid); send('cases:changed', k.jid); },
    'cases:setStatus': (_c, id, status) => { db.setCaseStatus(id, status); const k = db.getCase(id); wa.markChanged(k.jid); send('cases:changed', k.jid); },
    'cases:touch': (_c, id) => { db.touchCase(id); send('cases:changed', db.getCase(id)?.jid); },
    'cases:delete': (_c, id) => { const jid = db.deleteCase(id); if (jid) { wa.markChanged(jid); send('cases:changed', jid); } },
    'cases:docs': (_c, id) => db.listCaseDocs(id).map((d) => ({ ...d, url: mediaUrl(d.file) })),
    'cases:attachMessage': async (_c, caseId, chatJid, msgId) => {
      const m = db.getMessage(chatJid, msgId);
      if (!m) throw new Error('Mensagem não encontrada');
      const rel = m.media_file && fs.existsSync(resolveMedia(m.media_file)) ? m.media_file : await wa.downloadMedia(chatJid, msgId);
      const name = m.media_name || `${{ image: 'foto', video: 'video', audio: 'audio', ptt: 'audio', sticker: 'figurinha' }[m.type] || 'arquivo'}-${new Date(m.ts).toISOString().slice(0, 10)}${path.extname(rel)}`;
      const id = db.addCaseDoc({ case_id: caseId, name, file: rel, mime: m.media_mime, size: m.media_size, msg_id: msgId });
      send('cases:changed', db.getCase(caseId)?.jid);
      return id;
    },
    'cases:addFiles': (_c, caseId, tokens) => {
      const files = uploads(tokens);
      const dir = path.join(wa.mediaDir, '_casos', String(caseId));
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) {
        let name = path.basename(f.name);
        let dest = path.join(dir, name);
        for (let i = 2; fs.existsSync(dest); i++) { name = `${path.parse(f.name).name} (${i})${path.extname(f.name)}`; dest = path.join(dir, name); }
        fs.copyFileSync(f.path, dest);
        fs.rmSync(path.dirname(f.path), { recursive: true, force: true });
        db.addCaseDoc({ case_id: caseId, name, file: path.relative(wa.mediaDir, dest), size: fs.statSync(dest).size });
      }
      send('cases:changed', db.getCase(caseId)?.jid);
      return files.length;
    },
    'cases:deleteDoc': (_c, id) => { const d = db.deleteCaseDoc(id); if (d) send('cases:changed', db.getCase(d.case_id)?.jid); },

    // honorários / financeiro
    'finance:summary': () => db.financeSummary(),
    'finance:list': (_c, opts) => db.listPayments(opts || {}),
    'finance:save': (_c, p) => { const id = db.savePayment(p); const k = db.getCase(p.case_id || db.getPayment(id)?.case_id); if (k) { wa.markChanged(k.jid); send('cases:changed', k.jid); } send('finance:changed'); return id; },
    'finance:generate': (_c, caseId, opts) => { const ids = db.generateInstallments(caseId, opts); const k = db.getCase(caseId); wa.markChanged(k.jid); send('cases:changed', k.jid); send('finance:changed'); return ids; },
    'finance:setPaid': (_c, id, paid) => { db.setPaymentPaid(id, paid); const p = db.getPayment(id); if (p) { wa.markChanged(p.jid); send('cases:changed', p.jid); } send('finance:changed'); },
    'finance:delete': (_c, id) => { const p = db.getPayment(id); db.deletePayment(id); if (p) { wa.markChanged(p.jid); send('cases:changed', p.jid); } send('finance:changed'); },
    'finance:chargeText': (_c, id) => chargeText(id),
    'finance:sendCharge': async (ctx, id, text) => {
      const p = db.getPayment(id);
      if (!p) throw new Error('Parcela não encontrada');
      await wa.sendText(p.jid, sign(ctx, text || chargeText(id)));
      db.markPaymentCharged(id);
      db.logActivity(p.jid, 'charge', `Cobrança enviada: ${p.description || 'honorários'} (${money(p.amount)})`, who(ctx));
      send('finance:changed');
    },
    'finance:defaultTemplate': () => DEFAULT_CHARGE_TEMPLATE,

    // tarefas
    'tasks:list': (_c, opts) => db.listTasks(opts || {}),
    'tasks:save': async (_c, task) => {
      const id = db.saveTask(task);
      if (task.calendar_id) {
        // escolheu outra agenda do Google: move o evento para lá
        const cur = db.getTask(id);
        if (cur.gcal_event_id && cur.gcal_calendar_id !== task.calendar_id) {
          await calSync.removeTask(cur).catch(() => {});
          db.setTaskGcal(id, null, null);
        }
        db.run('UPDATE tasks SET gcal_calendar_id = ? WHERE id = ? AND gcal_event_id IS NULL', task.calendar_id, id);
      }
      syncTaskLater(id);
      const cid = task.case_id ?? db.get('SELECT case_id FROM tasks WHERE id = ?', id)?.case_id;
      if (cid) send('cases:changed', db.getCase(cid)?.jid);
      const jid = task.jid || db.get('SELECT jid FROM tasks WHERE id = ?', id)?.jid;
      if (jid) wa.markChanged(jid);
      send('tasks:changed', null);
      return id;
    },
    'tasks:delete': (_c, id) => {
      const t = db.getTask(id);
      calSync.removeTask(t).catch((e) => console.error('google: apagar evento', e.message));
      db.deleteTask(id);
      if (t?.jid) wa.markChanged(t.jid);
      send('tasks:changed', null);
    },

    // configurações do CRM
    'pipelines:list': () => db.listPipelines(),
    'pipelines:save': (_c, p) => { const id = db.savePipeline(p); broadcastConfig(); return id; },
    'pipelines:delete': (_c, id) => { db.deletePipeline(id); broadcastConfig(); refreshAllChats(); },
    'pipelines:reorder': (_c, ids) => { db.reorderPipelines(ids); broadcastConfig(); },
    'tags:save': (_c, t) => { const id = db.saveTag(t); broadcastConfig(); return id; },
    'tags:delete': (_c, id) => { db.deleteTag(id); broadcastConfig(); refreshAllChats(); },
    'quick:save': (_c, q) => { const id = db.saveQuickReply(q); broadcastConfig(); return id; },
    'quick:delete': (_c, id) => { db.deleteQuickReply(id); broadcastConfig(); },
    stats: () => db.stats(),

    'settings:set': (ctx, key, value) => {
      if (USER_KEYS.includes(key)) {
        auth.setUserPref(ctx.user.id, key, value);
      } else if (OFFICE_KEYS.includes(key)) {
        if (ctx.user.role !== 'socio') throw new Error('Só um sócio pode mudar as configurações do escritório.');
        settings[key] = value;
        db.setSetting(key, value);
        applySettings();
        send('settings:office', null);
      } else {
        throw new Error('configuração desconhecida');
      }
      return settingsFor(ctx.user);
    },
    'settings:get': (ctx) => settingsFor(ctx.user),
    'legacy:import': () => {
      const res = importLegacy(db, LEGACY_STATE_FILE);
      broadcastConfig();
      refreshAllChats();
      return res;
    },

    // agenda / Google
    'google:status': () => google.status(),
    'google:importClient': (_c, token) => {
      const [f] = uploads([token]);
      try { google.importClient(f.path); } finally { fs.rmSync(path.dirname(f.path), { recursive: true, force: true }); }
      return google.status();
    },
    'google:connect': async (ctx) => {
      googleRequester = ctx.conn;
      const st = await google.connect();
      calSync.syncAll().then((n) => {
        if (n) notify({ kind: 'google', title: '📅 Google Agenda conectado', body: `${n} compromisso(s) do CRM enviados para a sua agenda.` }, { conn: ctx.conn });
      }).catch(() => {});
      return st;
    },
    'google:disconnect': () => google.disconnect(),
    'google:calendars': (_c, force) => google.calendars(force),
    'google:syncAll': () => calSync.syncAll(),
    'agenda:events': async (_c, from, to, calendarIds) => {
      // o que foi criado com o Google desconectado vai agora
      if (calSync.enabled() && db.tasksToSync().length) await calSync.syncAll().catch(() => {});
      return calSync.agenda(from, to, calendarIds);
    },
    'agenda:saveEvent': (_c, calendarId, ev, eventId) => google.saveEvent(calendarId, ev, eventId),
    'agenda:deleteEvent': (_c, calendarId, eventId) => google.deleteEvent(calendarId, eventId),

    'app:testNotification': (ctx) => {
      notify({ kind: 'test', title: 'Barros Associados — teste', body: 'Se você está vendo isto, as notificações estão funcionando. 👍', force: true }, { conn: ctx.conn });
    },
  };

  if (demo) {
    api['demo:incoming'] = (_c, phone, text, name) => wa.simulateIncoming(phone, text, name);
    api['demo:simulateStuck'] = () => wa.setStatus({ state: 'reconnecting', registered: true, error: 'conexão fechada, código 428', suggestRepair: true });
  }

  /** Chama um método da API em nome de alguém (confere a permissão do perfil). */
  async function call(method, args, ctx) {
    const fn = api[method];
    if (!fn) throw new Error(`Método desconhecido: ${method}`);
    if (!auth.can(ctx.user.role, method)) throw new Error('Seu perfil não tem permissão para isso.');
    return fn(ctx, ...(args || []));
  }

  /** Uma janela fechou: some da lista de quem está vendo conversas. */
  function dropConn(conn) {
    if (viewers.delete(conn)) broadcastViewers();
  }

  /** Cópia do banco para o backup (o chamador apaga o arquivo depois). */
  function backupFile() {
    const file = path.join(os.tmpdir(), `backup-barros-${Date.now()}.sqlite`);
    db.run('VACUUM INTO ?', file);
    return file;
  }

  applySettings();
  wa.logger.warn({ versaoApp: version, dados: dataDir, node: process.versions.node }, 'sistema iniciado');
  wa.start().catch((e) => {
    console.error(e);
    send('wa:status', { state: 'reconnecting', error: e.message });
    wa.scheduleReconnect(10000);
  });

  return {
    events, api, call, dropConn, backupFile, resolveMedia, wa, google, dataDir, demo,
    /** O computador voltou da suspensão (modo local): a conexão antiga morreu. */
    onResume() {
      if (!wa.hasSession()) return;
      setTimeout(() => wa.reconnectNow().catch((e) => console.error(e)), 1500);
    },
    logFile: path.join(dataDir, 'logs', 'whatsapp.log'),
    async stop() {
      timers.forEach((t) => clearInterval(t));
      await wa.stop();
      // nada mais pode tocar no banco depois de fechado (avisos atrasados do WhatsApp)
      clearTimeout(wa.flushTimer);
      wa.removeAllListeners();
      google.removeAllListeners?.();
      db.closeDb();
    },
  };
}
