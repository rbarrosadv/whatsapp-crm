// Conexão com o WhatsApp (não oficial) via Baileys: o app se conecta como
// um "aparelho conectado", igual ao WhatsApp Web, lendo o QR code uma vez.
// A sessão fica salva em disco (pasta `auth`), então nas próximas vezes
// ele reconecta sozinho, sem pedir QR code de novo.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser,
  isJidGroup,
  isLidUser,
  isPnUser,
  isJidBroadcast,
  isJidNewsletter,
  proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import * as db from './db.js';
import { parseMessage, rawToMessage, tsOf } from './parse.js';

// Perfis de "aparelho" usados na conexão; se um falhar antes de ler o QR,
// tenta o próximo.
const BROWSERS = [
  () => Browsers.windows('Desktop'),
  () => Browsers.macOS('Desktop'),
  () => Browsers.ubuntu('Chrome'),
];

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/amr': 'amr', 'application/pdf': 'pdf',
};

// Mídias pequenas desses tipos são baixadas automaticamente quando chegam
const AUTO_DOWNLOAD = { image: 8e6, sticker: 2e6, ptt: 8e6, audio: 8e6 };

export function extFor(mime, name) {
  const fromName = name && path.extname(name).slice(1);
  if (fromName) return fromName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const base = (mime || '').split(';')[0].trim();
  return MIME_EXT[base] || base.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
}

export class WhatsAppService extends EventEmitter {
  constructor({ dataDir, logFile }) {
    super();
    this.dataDir = dataDir;
    this.authDir = path.join(dataDir, 'auth');
    this.mediaDir = path.join(dataDir, 'media');
    fs.mkdirSync(this.mediaDir, { recursive: true });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this.logger = pino({ level: 'warn' }, pino.destination({ dest: logFile, sync: false }));
    this.sock = null;
    this.state = { state: 'idle' };
    this.retry = 0;
    this.activeChat = null;
    this.windowFocused = true;
    this.sendReadReceipts = true;
    this.changedChats = new Set();
    this.flushTimer = null;
    this.stopped = false;
    this.pnCache = new Map();
    this.historyProgress = null;
    this.failedPairing = 0;
  }

  // ----------------------------------------------------------- conexão

  setStatus(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('status', this.state);
  }

  getStatus() { return this.state; }

  /** true só quando o celular já confirmou a conexão (não basta existir o arquivo). */
  hasSession() {
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(this.authDir, 'creds.json'), 'utf-8'));
      return !!(creds.me?.id && creds.account);
    } catch {
      return false;
    }
  }

  async start() {
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    const registered = this.hasSession();
    // sessão incompleta (QR nunca lido): começa do zero pra gerar QR novo
    if (!registered) this.clearAuth();
    this.setStatus({ state: registered ? 'connecting' : 'starting', registered, qr: null, pairingCode: null, error: registered ? null : this.state.error });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion({ signal: AbortSignal.timeout(6000) }));
    } catch { /* usa a versão embutida */ }
    this.logger.warn({ version, registered, attempt: this.failedPairing }, 'iniciando conexão');

    // se em 40 s não vier nem QR nem conexão, avisa e tenta de novo do zero
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.stopped || ['qr', 'open'].includes(this.state.state)) return;
      this.logger.warn('sem resposta do WhatsApp em 40 s');
      if (!this.hasSession()) this.failedPairing++;
      this.setStatus({
        error: 'O WhatsApp não respondeu. Verifique a internet e se o antivírus/firewall não está bloqueando o app. Tentando de novo…',
      });
      try { this.sock?.end(new Error('timeout')); } catch { /* ignore */ }
      this.sock = null;
      this.scheduleReconnect(3000);
    }, 40000);

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger) },
      logger: this.logger,
      browser: BROWSERS[this.failedPairing % BROWSERS.length](),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => this.lookupRaw(key)?.message || undefined,
      shouldSyncHistoryMessage: () => true,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this.onConnectionUpdate(sock, u).catch((e) => this.logger.error(e)));
    sock.ev.on('messaging-history.set', (h) => this.safe(() => this.onHistory(h)));
    sock.ev.on('chats.upsert', (chats) => this.safe(() => this.onChats(chats, true)));
    sock.ev.on('chats.update', (chats) => this.safe(() => this.onChats(chats, false)));
    sock.ev.on('chats.delete', (ids) => this.safe(() => ids.forEach((id) => this.markChanged(id))));
    sock.ev.on('contacts.upsert', (cs) => this.safe(() => this.onContacts(cs)));
    sock.ev.on('contacts.update', (cs) => this.safe(() => this.onContacts(cs)));
    sock.ev.on('lid-mapping.update', (m) => this.safe(() => this.onLidMapping([m])));
    sock.ev.on('messages.upsert', (u) => this.safe(() => this.onMessages(u.messages, u.type)));
    sock.ev.on('messages.update', (list) => this.safe(() => this.onMessageUpdates(list)));
    sock.ev.on('messages.reaction', (list) => this.safe(() => this.onReactions(list)));
    sock.ev.on('message-receipt.update', (list) => this.safe(() => this.onReceipts(list)));
    sock.ev.on('messages.delete', (d) => this.safe(() => this.onDelete(d)));
    sock.ev.on('groups.upsert', (gs) => this.safe(() => this.onGroups(gs)));
    sock.ev.on('groups.update', (gs) => this.safe(() => this.onGroups(gs)));
  }

  async safe(fn) {
    try {
      await fn();
    } catch (e) {
      this.logger.error({ err: e }, 'erro processando evento');
      console.error('[whatsapp]', e);
    }
  }

  async onConnectionUpdate(sock, u) {
    if (sock !== this.sock) return;
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      this.setStatus({ state: 'qr', qr: dataUrl, error: null });
    }
    if (connection === 'connecting' && !qr && this.state.state !== 'qr') {
      this.setStatus({ state: 'connecting' });
    }
    if (connection === 'open') {
      clearTimeout(this.watchdog);
      this.logger.warn('conectado');
      this.retry = 0;
      this.failedPairing = 0;
      const me = sock.user ? { jid: jidNormalizedUser(sock.user.id), name: sock.user.name || sock.user.verifiedName } : null;
      this.setStatus({ state: 'open', registered: true, qr: null, pairingCode: null, me, error: null });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      clearTimeout(this.watchdog);
      this.logger.warn({ code, err: lastDisconnect?.error?.message }, 'conexão fechada');
      this.sock = null;
      if (this.stopped) return;
      if (code === DisconnectReason.loggedOut) {
        // desconectado pelo celular: apaga a sessão e pede QR de novo
        this.clearAuth();
        this.setStatus({ state: 'logged_out', me: null, error: 'O aparelho foi desconectado pelo celular.' });
        this.scheduleReconnect(500);
      } else if (code === DisconnectReason.connectionReplaced) {
        this.setStatus({ state: 'replaced', error: 'O WhatsApp foi aberto em outro lugar com esta mesma sessão.' });
      } else if (code === DisconnectReason.restartRequired) {
        // normal logo depois de ler o QR: reinicia já com a sessão nova
        this.scheduleReconnect(0);
      } else if (!this.hasSession()) {
        // ainda não conectou nenhuma vez: descarta a tentativa e gera QR novo
        this.failedPairing++;
        this.clearAuth();
        const delay = Math.min(15000, 1500 * this.failedPairing);
        this.setStatus({
          state: 'starting',
          qr: null,
          pairingCode: null,
          error: `Não foi possível falar com o WhatsApp (${describeError(lastDisconnect?.error, code)}). Tentando de novo…`,
        });
        this.scheduleReconnect(delay);
      } else {
        this.retry++;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retry, 5));
        this.setStatus({ state: 'reconnecting', error: describeError(lastDisconnect?.error, code), retryIn: delay });
        this.scheduleReconnect(delay);
      }
    }
  }

  scheduleReconnect(ms) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.start().catch((e) => {
      this.setStatus({ state: 'reconnecting', error: e.message });
      this.scheduleReconnect(10000);
    }), ms);
  }

  clearAuth() {
    try { fs.rmSync(this.authDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /** Descarta a tentativa atual e começa de novo (gera um QR novo se ainda não conectou). */
  async reset() {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.reconnectTimer);
    try { this.sock?.end(undefined); } catch { /* ignore */ }
    this.sock = null;
    this.retry = 0;
    this.setStatus({ error: null });
    await this.start();
  }

  /** Alternativa ao QR: gera um código de 8 letras para digitar no celular. */
  async requestPairingCode(phone) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 11) digits = `55${digits}`;
    if (digits.length < 12) throw new Error('Digite o número com DDD (ex.: 11 98765-4321).');
    if (this.hasSession()) throw new Error('Este computador já está conectado.');
    if (!this.sock || this.state.state !== 'qr') throw new Error('Aguarde o QR code aparecer e tente de novo.');
    const code = await this.sock.requestPairingCode(digits);
    const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
    this.setStatus({ pairingCode: pretty, pairingPhone: digits });
    return pretty;
  }

  async logout() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = null;
    try { await sock?.logout(); } catch { /* sem conexão: só apaga */ }
    try { sock?.end(undefined); } catch { /* ignore */ }
    this.clearAuth();
    this.setStatus({ state: 'logged_out', me: null, qr: null, error: null });
    await this.start();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.reconnectTimer);
    try { this.sock?.end(undefined); } catch { /* ignore */ }
    this.sock = null;
  }

  requireSock() {
    if (!this.sock || this.state.state !== 'open') throw new Error('WhatsApp não está conectado no momento.');
    return this.sock;
  }

  // ------------------------------------------------------- identidades

  /** Resolve o id "principal" de uma conversa (número de telefone, quando possível). */
  async canonical(jid, alt) {
    if (!jid) return null;
    let j = jidNormalizedUser(jid) || jid;
    const a = alt ? jidNormalizedUser(alt) : null;
    if (a) {
      if (isLidUser(j) && isPnUser(a)) this.alias(j, a);
      else if (isLidUser(a) && isPnUser(j)) this.alias(a, j);
    }
    if (isLidUser(j)) {
      const known = db.resolveJid(j);
      if (known !== j) return known;
      const pn = await this.pnForLid(j);
      if (pn) { this.alias(j, pn); return pn; }
      return j;
    }
    return db.resolveJid(j);
  }

  async pnForLid(lid) {
    if (this.pnCache.has(lid)) return this.pnCache.get(lid);
    let pn = null;
    try {
      const r = await this.sock?.signalRepository?.lidMapping?.getPNForLID(lid);
      pn = r ? jidNormalizedUser(r) : null;
    } catch { /* ignore */ }
    this.pnCache.set(lid, pn);
    return pn;
  }

  alias(lid, pn) {
    if (db.addAlias(lid, pn)) {
      this.markChanged(pn);
      this.emit('chat-merged', { from: lid, to: pn });
    }
  }

  onLidMapping(list) {
    for (const m of list || []) {
      if (m?.lid && m?.pn) this.alias(jidNormalizedUser(m.lid), jidNormalizedUser(m.pn));
    }
  }

  static skipJid(jid) {
    return !jid || isJidBroadcast(jid) || isJidNewsletter(jid) || jid === 'status@broadcast';
  }

  // --------------------------------------------------------- eventos

  markChanged(jid) {
    if (!jid) return;
    this.changedChats.add(jid);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        const list = [...this.changedChats];
        this.changedChats.clear();
        this.flushTimer = null;
        this.emit('chats-changed', list);
      }, 250);
    }
  }

  async onHistory({ chats, contacts, messages, lidPnMappings, progress, syncType }) {
    if (lidPnMappings?.length) this.onLidMapping(lidPnMappings);
    await this.onContacts(contacts || []);
    await this.onChats(chats || [], true, true);
    await this.onMessages(messages || [], 'history');
    if (progress != null) {
      this.historyProgress = progress;
      this.emit('history', { progress, syncType });
    }
  }

  async onChats(chats, isUpsert, fromHistory = false) {
    const rows = [];
    for (const c of chats) {
      if (WhatsAppService.skipJid(c.id)) continue;
      const jid = await this.canonical(c.id, c.pnJid || c.lidJid);
      const row = { jid, is_group: !!isJidGroup(jid) };
      if (c.name) row.name = c.name;
      if (c.archived != null) row.archived = c.archived ? 1 : 0;
      if (c.pinned != null) row.pinned = c.pinned ? 1 : 0;
      if (c.muteEndTime != null) row.muted_until = Number(c.muteEndTime) || 0;
      if (fromHistory) {
        if (typeof c.unreadCount === 'number' && c.unreadCount >= 0) row.unread = c.unreadCount;
      } else if (c.unreadCount === 0) {
        row.unread = 0;
      } else if (c.unreadCount === -1) {
        row.unread = Math.max(1, db.getChat(jid)?.unread || 0);
      }
      rows.push(row);
    }
    db.tx(() => rows.forEach((r) => { db.upsertChat(r); }));
    rows.forEach((r) => this.markChanged(r.jid));
    if (!isUpsert) rows.forEach((r) => { if (r.unread === 0) this.emit('chat-read', r.jid); });
  }

  async onContacts(contacts) {
    const rows = [];
    for (const c of contacts) {
      if (!c?.id || WhatsAppService.skipJid(c.id)) continue;
      const pn = c.phoneNumber ? jidNormalizedUser(c.phoneNumber) : null;
      const lid = c.lid ? jidNormalizedUser(c.lid) : null;
      if (pn && lid) this.alias(lid, pn);
      const jid = await this.canonical(c.id, pn || lid);
      rows.push({ jid, name: c.name, notify: c.notify, verified_name: c.verifiedName });
    }
    db.tx(() => rows.forEach((r) => db.upsertContact(r)));
    rows.forEach((r) => { if (db.chatExists(r.jid)) this.markChanged(r.jid); });
  }

  async onGroups(groups) {
    for (const g of groups) {
      if (!g?.id) continue;
      if (g.subject) {
        db.upsertChat({ jid: g.id, is_group: true, name: g.subject });
        this.markChanged(g.id);
      }
    }
  }

  async onMessages(messages, type) {
    const isNotify = type === 'notify';
    const results = [];
    // resolve ids antes da transação (pode precisar de consultas assíncronas)
    const prepared = [];
    for (const msg of messages) {
      const key = msg.key;
      if (!key?.remoteJid || WhatsAppService.skipJid(key.remoteJid)) continue;
      const chatJid = await this.canonical(key.remoteJid, key.remoteJidAlt);
      const isGroup = !!isJidGroup(chatJid);
      let senderJid = null;
      if (isGroup && !key.fromMe) senderJid = await this.canonical(key.participant || msg.participant, key.participantAlt);
      prepared.push({ msg, chatJid, isGroup, senderJid });
    }

    db.tx(() => {
      for (const { msg, chatJid, isGroup, senderJid } of prepared) {
        const key = msg.key;
        if (msg.pushName && !key.fromMe) {
          db.upsertContact({ jid: isGroup ? senderJid : chatJid, notify: msg.pushName });
        }
        const senderName = isGroup && !key.fromMe ? (db.contactName(senderJid) || msg.pushName || null) : null;
        const parsed = parseMessage(msg, { chatJid, senderJid, senderName, keepRaw: !!key.fromMe });
        if (parsed.kind === 'ignore') continue;
        if (parsed.kind === 'reaction') {
          this.applyReaction(chatJid, parsed.targetId, parsed.reaction);
          continue;
        }
        if (parsed.kind === 'revoke') {
          db.updateMessage(chatJid, parsed.targetId, { deleted: 1, text: '', raw: null });
          this.refreshPreview(chatJid);
          results.push({ chatJid, id: parsed.targetId, isNew: false });
          continue;
        }
        if (parsed.kind === 'edit') {
          db.updateMessage(chatJid, parsed.targetId, { text: parsed.text, edited: 1 });
          this.refreshPreview(chatJid);
          results.push({ chatJid, id: parsed.targetId, isNew: false });
          continue;
        }
        const row = parsed.row;
        const isNew = db.saveMessage(row);
        const unreadInc = isNotify && isNew && !row.from_me && row.type !== 'system'
          && !(this.activeChat === chatJid && this.windowFocused);
        db.bumpChat(chatJid, row, { incrementUnread: unreadInc, isGroup });
        if (isNotify && row.from_me) db.setChatUnread(chatJid, 0);
        results.push({ chatJid, id: row.id, isNew, row, notify: isNotify && isNew && !row.from_me, msg });
      }
    });

    for (const r of results) {
      this.markChanged(r.chatJid);
      if (type !== 'history') this.emit('message', { chatJid: r.chatJid, id: r.id, isNew: r.isNew, notify: !!r.notify });
      if (r.row && AUTO_DOWNLOAD[r.row.type] && (r.row.media_size || 0) <= AUTO_DOWNLOAD[r.row.type] && type !== 'history') {
        this.downloadMedia(r.chatJid, r.id).then(() => this.emit('message', { chatJid: r.chatJid, id: r.id, isNew: false }))
          .catch(() => {});
      }
      if (r.notify && this.activeChat === r.chatJid && this.windowFocused) {
        this.markRead(r.chatJid).catch(() => {});
      }
    }
  }

  refreshPreview(chatJid) {
    const last = db.listMessages(chatJid, { limit: 1 })[0];
    if (last) db.run('UPDATE chats SET last_preview = ? WHERE jid = ?', db.previewOf(last), chatJid);
  }

  applyReaction(chatJid, targetId, reaction) {
    if (!targetId) return;
    const m = db.getMessage(chatJid, targetId);
    if (!m) return;
    let list = [];
    try { list = JSON.parse(m.reactions || '[]'); } catch { list = []; }
    list = list.filter((r) => r.from !== reaction.from);
    if (reaction.text) list.push(reaction);
    db.updateMessage(chatJid, targetId, { reactions: JSON.stringify(list) });
    this.emit('message', { chatJid, id: targetId, isNew: false });
  }

  async onReactions(list) {
    for (const { key, reaction } of list) {
      const chatJid = await this.canonical(key.remoteJid, key.remoteJidAlt);
      const from = reaction.key?.fromMe ? 'me' : await this.canonical(reaction.key?.participant || reaction.key?.remoteJid);
      this.applyReaction(chatJid, key.id, { from, text: reaction.text || '' });
    }
  }

  async onMessageUpdates(list) {
    for (const { key, update } of list) {
      if (!key?.remoteJid || WhatsAppService.skipJid(key.remoteJid)) continue;
      const chatJid = await this.canonical(key.remoteJid, key.remoteJidAlt);
      const fields = {};
      if (update.status != null) {
        const cur = db.getMessage(chatJid, key.id);
        if (cur && (cur.status == null || update.status > cur.status)) fields.status = update.status;
      }
      if (update.message === null || update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
        fields.deleted = 1; fields.text = ''; fields.raw = null;
      } else if (update.message) {
        const edited = update.message.editedMessage?.message?.protocolMessage?.editedMessage
          || update.message.protocolMessage?.editedMessage;
        if (edited) {
          const p = parseMessage({ key, message: edited, messageTimestamp: Date.now() / 1000 }, { chatJid });
          if (p.kind === 'message') { fields.text = p.row.text; fields.edited = 1; }
        }
      }
      if (!Object.keys(fields).length) continue;
      db.updateMessage(chatJid, key.id, fields);
      if (fields.status != null) {
        const c = db.getChat(chatJid);
        const last = db.listMessages(chatJid, { limit: 1 })[0];
        if (c && last?.id === key.id) db.run('UPDATE chats SET last_status = ? WHERE jid = ?', fields.status, chatJid);
      }
      if (fields.deleted || fields.edited) this.refreshPreview(chatJid);
      this.markChanged(chatJid);
      this.emit('message', { chatJid, id: key.id, isNew: false });
    }
  }

  async onReceipts(list) {
    for (const { key, receipt } of list) {
      if (!key?.fromMe) continue;
      const chatJid = await this.canonical(key.remoteJid, key.remoteJidAlt);
      const status = receipt.playedTimestamp ? 5 : receipt.readTimestamp ? 4 : receipt.receiptTimestamp ? 3 : null;
      if (!status) continue;
      const cur = db.getMessage(chatJid, key.id);
      if (!cur || (cur.status ?? 0) >= status) continue;
      db.updateMessage(chatJid, key.id, { status });
      this.emit('message', { chatJid, id: key.id, isNew: false });
    }
  }

  async onDelete(d) {
    if ('keys' in d) {
      for (const key of d.keys) {
        const chatJid = await this.canonical(key.remoteJid, key.remoteJidAlt);
        db.run('DELETE FROM messages WHERE chat_jid = ? AND id = ?', chatJid, key.id);
        this.refreshPreview(chatJid);
        this.markChanged(chatJid);
        this.emit('message', { chatJid, id: key.id, isNew: false, removed: true });
      }
    }
  }

  lookupRaw(key) {
    const m = db.findMessageById(key.id);
    return m?.raw ? rawToMessage(m.raw) : null;
  }

  // ------------------------------------------------------------ ações

  async sendText(chatJid, text, quotedId) {
    const sock = this.requireSock();
    const opts = {};
    if (quotedId) {
      const q = db.getMessage(chatJid, quotedId);
      const raw = q?.raw ? rawToMessage(q.raw) : null;
      opts.quoted = raw || {
        key: { remoteJid: chatJid, id: quotedId, fromMe: !!q?.from_me, participant: q?.sender || undefined },
        message: { conversation: q?.text || '' },
      };
    }
    const sent = await sock.sendMessage(chatJid, { text }, opts);
    if (sent) await this.onMessages([sent], 'append');
    return sent?.key?.id;
  }

  async sendFile(chatJid, filePath, { caption, quotedId, asDocument } = {}) {
    const sock = this.requireSock();
    const buf = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const mime = guessMime(fileName);
    let content;
    if (!asDocument && mime.startsWith('image/') && !mime.includes('gif')) content = { image: buf, caption, mimetype: mime };
    else if (!asDocument && mime.startsWith('video/')) content = { video: buf, caption, mimetype: mime };
    else if (!asDocument && mime.startsWith('audio/')) content = { audio: buf, mimetype: mime };
    else content = { document: buf, mimetype: mime, fileName, caption };
    const opts = {};
    if (quotedId) {
      const q = db.getMessage(chatJid, quotedId);
      if (q?.raw) opts.quoted = rawToMessage(q.raw);
    }
    const sent = await sock.sendMessage(chatJid, content, opts);
    if (sent) {
      await this.onMessages([sent], 'append');
      // guarda uma cópia local do arquivo enviado pra mostrar na conversa
      const ext = extFor(mime, fileName);
      const rel = path.join(safeName(chatJid), `${safeName(sent.key.id)}.${ext}`);
      const abs = path.join(this.mediaDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      db.updateMessage(chatJid, sent.key.id, { media_file: rel });
      this.emit('message', { chatJid, id: sent.key.id, isNew: false });
    }
    return sent?.key?.id;
  }

  async sendVoice(chatJid, buffer, mimetype, seconds) {
    const sock = this.requireSock();
    const sent = await sock.sendMessage(chatJid, { audio: Buffer.from(buffer), mimetype, ptt: true, seconds });
    if (sent) {
      await this.onMessages([sent], 'append');
      const rel = path.join(safeName(chatJid), `${safeName(sent.key.id)}.${extFor(mimetype)}`);
      const abs = path.join(this.mediaDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(buffer));
      db.updateMessage(chatJid, sent.key.id, { media_file: rel });
      this.emit('message', { chatJid, id: sent.key.id, isNew: false });
    }
    return sent?.key?.id;
  }

  async react(chatJid, id, emoji) {
    const sock = this.requireSock();
    const m = db.getMessage(chatJid, id);
    if (!m) throw new Error('Mensagem não encontrada');
    const key = { remoteJid: chatJid, id, fromMe: !!m.from_me, participant: m.sender || undefined };
    await sock.sendMessage(chatJid, { react: { text: emoji, key } });
    this.applyReaction(chatJid, id, { from: 'me', text: emoji });
  }

  async deleteForEveryone(chatJid, id) {
    const sock = this.requireSock();
    const m = db.getMessage(chatJid, id);
    if (!m?.from_me) throw new Error('Só é possível apagar mensagens enviadas por você.');
    await sock.sendMessage(chatJid, { delete: { remoteJid: chatJid, id, fromMe: true } });
    db.updateMessage(chatJid, id, { deleted: 1, text: '', raw: null });
    this.refreshPreview(chatJid);
    this.markChanged(chatJid);
    this.emit('message', { chatJid, id, isNew: false });
  }

  async markRead(chatJid) {
    db.setChatUnread(chatJid, 0);
    this.markChanged(chatJid);
    if (!this.sock || this.state.state !== 'open' || !this.sendReadReceipts) return;
    const recent = db.unreadIncoming(chatJid, 20);
    if (!recent.length) return;
    const keys = recent.map((m) => ({ remoteJid: chatJid, id: m.id, fromMe: false, participant: m.sender || undefined }));
    try { await this.sock.readMessages(keys); } catch { /* ignore */ }
  }

  async sendPresence(chatJid, type) {
    try { await this.sock?.sendPresenceUpdate(type, chatJid); } catch { /* ignore */ }
  }

  async downloadMedia(chatJid, id) {
    const m = db.getMessage(chatJid, id);
    if (!m) throw new Error('Mensagem não encontrada');
    if (m.media_file && fs.existsSync(path.join(this.mediaDir, m.media_file))) return m.media_file;
    if (!m.raw) throw new Error('Esta mídia não está mais disponível.');
    const sock = this.requireSock();
    const msg = rawToMessage(m.raw);
    const buf = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: this.logger,
      reuploadRequest: (x) => sock.updateMediaMessage(x),
    });
    const rel = path.join(safeName(chatJid), `${safeName(id)}.${extFor(m.media_mime, m.media_name)}`);
    const abs = path.join(this.mediaDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    db.updateMessage(chatJid, id, { media_file: rel, media_size: m.media_size || buf.length });
    return rel;
  }

  async avatar(jid) {
    const c = db.getChat(jid);
    if (!c) return null;
    const dayMs = 24 * 3600 * 1000;
    if (c.avatar_file && fs.existsSync(path.join(this.mediaDir, c.avatar_file)) && Date.now() - c.avatar_checked_at < 7 * dayMs) {
      return c.avatar_file;
    }
    if (Date.now() - (c.avatar_checked_at || 0) < dayMs && !c.avatar_file) return null;
    if (!this.sock || this.state.state !== 'open') return c.avatar_file || null;
    let url = null;
    try { url = await this.sock.profilePictureUrl(jid, 'preview', 8000); } catch { url = null; }
    let rel = null;
    if (url) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          rel = path.join('_avatars', `${safeName(jid)}.jpg`);
          fs.mkdirSync(path.join(this.mediaDir, '_avatars'), { recursive: true });
          fs.writeFileSync(path.join(this.mediaDir, rel), buf);
        }
      } catch { rel = null; }
    }
    db.upsertChat({ jid, avatar_file: rel, avatar_checked_at: Date.now() });
    return rel;
  }

  async groupInfo(jid) {
    const sock = this.requireSock();
    const md = await sock.groupMetadata(jid);
    if (md?.subject) {
      db.upsertChat({ jid, is_group: true, name: md.subject });
      this.markChanged(jid);
    }
    const participants = [];
    for (const p of md?.participants || []) {
      const pj = await this.canonical(p.id, p.phoneNumber || p.lid);
      participants.push({ jid: pj, admin: p.admin || null, name: db.contactName(pj) });
    }
    return { subject: md?.subject, desc: md?.desc || '', participants };
  }

  /** Pede ao celular mensagens mais antigas desta conversa (chegam pelo histórico). */
  async loadOlder(chatJid) {
    const sock = this.requireSock();
    const oldest = db.oldestMessage(chatJid);
    if (!oldest) return false;
    const raw = oldest.raw ? rawToMessage(oldest.raw) : null;
    const key = raw?.key || { remoteJid: chatJid, id: oldest.id, fromMe: !!oldest.from_me };
    await sock.fetchMessageHistory(50, key, raw ? tsOf(raw) / 1000 : Math.floor(oldest.ts / 1000));
    return true;
  }

  async checkNumber(phone) {
    const sock = this.requireSock();
    const digits = String(phone).replace(/\D/g, '');
    if (!digits) throw new Error('Número inválido');
    const [r] = await sock.onWhatsApp(digits);
    if (!r?.exists) return null;
    return jidNormalizedUser(r.jid);
  }
}

function describeError(err, code) {
  const msg = err?.message || 'erro desconhecido';
  const hints = {
    401: 'sessão encerrada pelo celular',
    403: 'acesso negado pelo WhatsApp',
    405: 'o WhatsApp recusou a conexão',
    408: 'sem resposta — verifique a internet',
    428: 'conexão fechada',
    500: 'sessão corrompida',
    503: 'WhatsApp indisponível no momento',
  };
  return [hints[code], code ? `código ${code}` : null, hints[code] ? null : msg].filter(Boolean).join(', ');
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function guessMime(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', ogg: 'audio/ogg; codecs=opus', opus: 'audio/ogg; codecs=opus', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', rar: 'application/vnd.rar',
  };
  return map[ext] || 'application/octet-stream';
}
