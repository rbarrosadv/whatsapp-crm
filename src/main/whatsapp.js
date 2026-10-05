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
  fetchLatestWaWebVersion,
  DEFAULT_CONNECTION_CONFIG,
  downloadMediaMessage,
  jidNormalizedUser,
  isJidGroup,
  isLidUser,
  isPnUser,
  isJidBroadcast,
  isJidNewsletter,
  proto,
  BufferJSON,
  decodeMessageNode,
  getBinaryNodeChild,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import * as db from './db.js';
import { parseMessage, rawToMessage, tsOf } from './parse.js';

// Perfis de "aparelho" usados na conexão; se um falhar antes de ler o QR,
// tenta o próximo.
// Perfis de navegador anunciados ao WhatsApp. O "Windows Desktop" passou a ser
// recusado (428 logo depois do login), por isso o Chrome vem primeiro.
// A sessão só é aceita depois com o MESMO perfil usado ao ler o QR code:
// ele fica gravado em auth/perfil.json.
const BROWSERS = [
  () => Browsers.ubuntu('Chrome'),
  () => Browsers.macOS('Desktop'),
  () => Browsers.windows('Desktop'),
];

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/amr': 'amr', 'application/pdf': 'pdf',
};

// Mídias pequenas desses tipos são baixadas automaticamente quando chegam
const AUTO_DOWNLOAD = { image: 8e6, sticker: 2e6, ptt: 8e6, audio: 8e6 };
// Contatos de tipo com "baixar arquivos automaticamente" (ex.: Cliente): tudo até este tamanho
const CLIENT_MAX_SIZE = 100e6;
// ao conectar/classificar, busca os arquivos antigos destes últimos dias
const BACKFILL_DAYS = 180;
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker']);

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
    // alguém da equipe está com a conversa aberta e a janela em foco?
    // (o servidor troca por uma função que olha todas as janelas abertas)
    this.isViewing = () => false;
    this.sendReadReceipts = true;
    this.changedChats = new Set();
    this.flushTimer = null;
    this.stopped = false;
    this.pnCache = new Map();
    this.historyProgress = null;
    this.failedPairing = 0;
    this.profileShift = 0;
    this.dlQueue = [];
    this.dlQueued = new Set();
    this.dlRunning = false;
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

  /** Perfil de navegador desta tentativa: o da sessão salva, ou o próximo da fila no pareamento. */
  browserIndex(registered) {
    if (!registered) return this.failedPairing % BROWSERS.length;
    try {
      const n = JSON.parse(fs.readFileSync(path.join(this.authDir, 'perfil.json'), 'utf-8')).browser;
      // perfil gravado = o do pareamento: nunca troca (outro perfil é sempre recusado)
      if (Number.isInteger(n) && n >= 0 && n < BROWSERS.length) return n;
    } catch { /* sem arquivo */ }
    // sessões antigas sem perfil.json: começa pelo Chrome e, se cair logo, tenta os outros
    return this.profileShift % BROWSERS.length;
  }

  saveBrowserIndex(i) {
    try {
      fs.writeFileSync(path.join(this.authDir, 'perfil.json'), JSON.stringify({ browser: i }));
    } catch (e) {
      this.logger.warn({ err: e?.message }, 'não foi possível gravar o perfil da sessão');
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
    await this.forgetRoute(state.creds, saveCreds);
    // versão do WhatsApp Web anunciada na conexão; nunca pode ficar vazia
    const version = await this.pickVersion();
    this.lastVersion = version;
    this.startedAt = Date.now();
    const browserIndex = this.browserIndex(registered);
    this.lastBrowser = browserIndex;
    this.lastRegistered = registered;
    const browser = BROWSERS[browserIndex]();
    this.logger.warn({ version, registered, attempt: this.failedPairing, browser }, 'iniciando conexão');

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
      browser,
      syncFullHistory: true,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => this.lookupRaw(key)?.message || undefined,
      shouldSyncHistoryMessage: () => true,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    // mensagens de visualização única chegam só como aviso e o Baileys as descarta
    sock.ws.on('CB:message', (node) => this.safe(() => this.onRawMessageNode(node)));
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

  // "routingInfo" aponta para o servidor do WhatsApp da última conexão. Depois de
  // suspender/hibernar (ou trocar de rede) ele fica velho e o WhatsApp derruba a
  // conexão em meio segundo (428) a cada tentativa. Sem ele o servidor escolhe outro.
  async forgetRoute(creds, saveCreds) {
    if (!creds.routingInfo) return false;
    delete creds.routingInfo;
    await saveCreds();
    this.logger.warn('rota antiga do servidor descartada');
    return true;
  }

  /** Aviso de "visualização única" (o conteúdo fica só no celular) vira uma mensagem na conversa. */
  async onRawMessageNode(node) {
    const type = getBinaryNodeChild(node, 'unavailable')?.attrs?.type || '';
    if (!type.startsWith('view_once')) return;
    const me = this.sock?.user;
    if (!me?.id) return;
    let full;
    try { ({ fullMessage: full } = decodeMessageNode(node, me.id, me.lid || '')); } catch { return; }
    if (db.getMessage(await this.canonical(full.key.remoteJid, full.key.remoteJidAlt), full.key.id)) return;
    await this.onMessages([{ ...full, key: { ...full.key, isViewOnce: true } }], 'notify');
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
      this.logger.warn({ version: this.lastVersion }, 'conectado');
      this.logger.level = 'warn';
      this.retry = 0;
      this.fastFails = 0;
      this.failedPairing = 0;
      this.profileShift = 0;
      // o perfil que funcionou é o da sessão; reconexões precisam usar o mesmo
      this.saveBrowserIndex(this.lastBrowser ?? 0);
      // arquivos de clientes que chegaram enquanto o app estava fechado
      setTimeout(() => { if (this.state.state === 'open') this.backfillDownloads(); }, 15000);
      const me = sock.user ? { jid: jidNormalizedUser(sock.user.id), name: sock.user.name || sock.user.verifiedName } : null;
      this.setStatus({ state: 'open', registered: true, qr: null, pairingCode: null, me, error: null, suggestRepair: false });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      clearTimeout(this.watchdog);
      this.logger.warn({
        code, err: lastDisconnect?.error?.message, data: lastDisconnect?.error?.data,
        msAfterStart: Date.now() - (this.startedAt || 0),
      }, 'conexão fechada');
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
        // normal logo depois de ler o QR: reinicia já com a sessão nova, com o
        // mesmo perfil de navegador com que o celular acabou de parear
        if (!this.lastRegistered && this.hasSession()) this.saveBrowserIndex(this.lastBrowser ?? 0);
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
        // sem internet (ex.: logo depois de acordar o notebook): só espera a rede voltar,
        // sem contar como recusa do WhatsApp
        const offline = isOfflineError(lastDisconnect?.error);
        if (offline) this.retry = 1; // quando a rede voltar, a 1ª tentativa é rápida
        // queda logo após abrir (< 5 s), várias vezes seguidas: algo no caminho
        // derruba a conexão; avisa com uma dica e alterna a versão usada
        if (offline) { /* não conta */ } else if (Date.now() - (this.startedAt || 0) < 5000) this.fastFails = (this.fastFails || 0) + 1;
        else this.fastFails = 0;
        // depois de várias quedas imediatas, tenta a próxima versão conhecida
        if (this.fastFails && this.fastFails % 4 === 0) this.versionIndex = (this.versionIndex || 0) + 1;
        // a cada 3 quedas imediatas, tenta outro perfil de navegador (sessões pareadas
        // antes de o perfil ser gravado podem ter usado qualquer um deles)
        if (this.fastFails && this.fastFails % 3 === 0) this.profileShift++;
        // quedas imediatas repetidas: registra mais detalhes no whatsapp.log
        if (this.fastFails >= 3 && this.logger.level !== 'info') {
          this.logger.level = 'info';
          this.logger.warn({ candidatos: this.versionCache?.list }, 'quedas seguidas logo ao abrir: registro detalhado ligado');
        }
        // quedas rápidas (428/408) são comuns: tenta logo, depois vai espaçando
        const delay = offline ? 3000 : [500, 2000, 5000, 10000, 20000][this.retry - 1] ?? 30000;
        const blocked = this.fastFails >= 3
          ? ' — a conexão cai logo ao abrir; use “Testar conexão” em Configurações' : '';
        // muitas quedas seguidas logo ao abrir com a sessão salva: o WhatsApp
        // provavelmente não aceita mais essa sessão → oferece ler o QR de novo
        const suggestRepair = this.fastFails >= 6;
        this.setStatus({ state: 'reconnecting', error: describeError(lastDisconnect?.error, code) + blocked, retryIn: delay, suggestRepair });
        this.scheduleReconnect(delay);
      }
    }
  }

  /** Fecha a conexão atual (se houver) e conecta de novo, sem abrir duas ao mesmo tempo. */
  async reconnectNow() {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.watchdog);
    const old = this.sock;
    this.sock = null; // o evento 'close' da conexão antiga passa a ser ignorado
    try { old?.end(undefined); } catch { /* ignore */ }
    this.retry = 0;
    await this.start();
  }

  /**
   * Versões candidatas do WhatsApp Web, em ordem de preferência: a atual do
   * próprio site do WhatsApp, a indicada pelo Baileys e a embutida.
   * Guardadas por 1 h para não buscar a cada reconexão.
   */
  async versionCandidates() {
    if (this.versionCache && Date.now() - this.versionCache.at < 3600e3) return this.versionCache.list;
    const list = [];
    const add = (v) => {
      if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) && !list.some((x) => x.join('.') === v.join('.'))) list.push(v);
    };
    try {
      const r = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(6000) });
      if (!r?.error) add(r?.version);
    } catch { /* sem acesso ao site */ }
    try { add((await fetchLatestBaileysVersion({ signal: AbortSignal.timeout(6000) }))?.version); } catch { /* ignore */ }
    add(DEFAULT_CONNECTION_CONFIG.version);
    this.versionCache = { at: Date.now(), list };
    return list;
  }

  async pickVersion() {
    const list = await this.versionCandidates();
    return list[(this.versionIndex || 0) % list.length];
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

  /**
   * Descarta a sessão salva (que o WhatsApp deixou de aceitar) e volta para o
   * QR code. Conversas e dados do CRM ficam intactos (estão no banco). A
   * sessão antiga é guardada em auth-antiga-<data> por segurança.
   */
  async repair() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.watchdog);
    const old = this.sock;
    this.sock = null;
    try { old?.end(undefined); } catch { /* ignore */ }
    if (fs.existsSync(this.authDir)) {
      const dest = `${this.authDir}-antiga-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
      try { fs.renameSync(this.authDir, dest); } catch { this.clearAuth(); }
    }
    this.logger.warn('sessão descartada pelo usuário para ler o QR code de novo');
    this.retry = 0;
    this.fastFails = 0;
    this.failedPairing = 0;
    this.profileShift = 0;
    this.versionIndex = 0;
    this.setStatus({ state: 'starting', registered: false, me: null, error: null, suggestRepair: false });
    await this.start();
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
          && !this.isViewing(chatJid);
        db.bumpChat(chatJid, row, { incrementUnread: unreadInc, isGroup });
        if (isNotify && row.from_me) db.setChatUnread(chatJid, 0);
        results.push({ chatJid, id: row.id, isNew, row, notify: isNotify && isNew && !row.from_me, msg });
      }
    });

    for (const r of results) {
      this.markChanged(r.chatJid);
      if (type !== 'history') this.emit('message', { chatJid: r.chatJid, id: r.id, isNew: r.isNew, notify: !!r.notify });
      if (r.row && MEDIA_KINDS.has(r.row.type) && type !== 'history') {
        const size = r.row.media_size || 0;
        const small = AUTO_DOWNLOAD[r.row.type] && size <= AUTO_DOWNLOAD[r.row.type];
        if (small || (size <= CLIENT_MAX_SIZE && db.chatAutoDownload(r.chatJid))) this.queueDownload(r.chatJid, r.id, { first: true });
      }
      if (r.notify && this.isViewing(r.chatJid)) {
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

  /** Edita uma mensagem de texto enviada por você (o WhatsApp permite até 15 minutos). */
  async editMessage(chatJid, id, text) {
    const sock = this.requireSock();
    const m = editableCheck(db.getMessage(chatJid, id), text);
    await sock.sendMessage(chatJid, { text, edit: { remoteJid: chatJid, id, fromMe: true } });
    this.applyEdit(chatJid, m.id, text);
  }

  applyEdit(chatJid, id, text) {
    db.updateMessage(chatJid, id, { text, edited: 1 });
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

  /** Fila de downloads automáticos: um por vez, sem repetir. */
  queueDownload(chatJid, id, { first = false } = {}) {
    const key = `${chatJid}|${id}`;
    if (this.dlQueued.has(key)) return;
    this.dlQueued.add(key);
    // arquivo que acabou de chegar passa na frente dos antigos
    if (first) this.dlQueue.unshift([chatJid, id]); else this.dlQueue.push([chatJid, id]);
    this.runDownloads();
  }

  async runDownloads() {
    if (this.dlRunning) return;
    this.dlRunning = true;
    try {
      while (this.dlQueue.length && this.state.state === 'open') {
        const [chatJid, id] = this.dlQueue.shift();
        try {
          await this.downloadMedia(chatJid, id);
          this.emit('message', { chatJid, id, isNew: false });
        } catch (e) {
          // não tenta de novo para sempre: depois de 2 falhas fica só no botão "Baixar"
          db.markDownloadFailed(chatJid, id);
          this.logger.warn({ chatJid, id, err: String(e?.message || e).slice(0, 120) }, 'download automático falhou');
        } finally {
          this.dlQueued.delete(`${chatJid}|${id}`);
        }
      }
    } finally {
      this.dlRunning = false;
    }
  }

  /** Baixa os arquivos que ainda faltam das conversas cujo tipo pede download automático. */
  backfillDownloads(jids = db.autoDownloadChats()) {
    const since = Date.now() - BACKFILL_DAYS * 86400e3;
    let n = 0;
    for (const jid of jids) {
      if (!db.chatAutoDownload(jid)) continue;
      for (const m of db.pendingMedia(jid, { since, maxSize: CLIENT_MAX_SIZE })) { this.queueDownload(jid, m.id); n++; }
    }
    return n;
  }

  async downloadMedia(chatJid, id) {
    const m = db.getMessage(chatJid, id);
    if (!m) throw new Error('Mensagem não encontrada');
    if (m.media_file && fs.existsSync(path.join(this.mediaDir, m.media_file))) return m.media_file;
    if (!m.raw) throw new Error('Esta mídia não está mais disponível.');
    const sock = this.requireSock();
    let msg = rawToMessage(m.raw);
    let buf;
    try {
      buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: this.logger, reuploadRequest: (x) => sock.updateMediaMessage(x) });
    } catch (e) {
      // link vencido: o Baileys só pede o reenvio quando o erro tem .status, mas o
      // erro dele vem com output.statusCode — então pedimos aqui ao celular um link novo
      const status = e?.status ?? e?.output?.statusCode;
      if (![403, 404, 410].includes(status)) throw e;
      try {
        // o celular precisa estar ligado e com internet; não espera mais que 20 s
        msg = await Promise.race([
          sock.updateMediaMessage(msg),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
        ]);
      } catch {
        throw new Error('O arquivo não está mais disponível no WhatsApp (nem no celular).');
      }
      buf = await downloadMediaMessage(msg, 'buffer', {});
      db.updateMessage(chatJid, id, { raw: JSON.stringify(msg, BufferJSON.replacer) });
    }
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

export const EDIT_WINDOW_MS = 15 * 60 * 1000;

/** Confere se a mensagem ainda pode ser editada; devolve a mensagem. */
export function editableCheck(m, text) {
  if (!m || !m.from_me) throw new Error('Só é possível editar mensagens enviadas por você.');
  if (m.deleted || m.type !== 'text') throw new Error('Só mensagens de texto podem ser editadas.');
  if (Date.now() - m.ts > EDIT_WINDOW_MS) throw new Error('O WhatsApp só permite editar até 15 minutos depois do envio.');
  if (!String(text || '').trim()) throw new Error('A mensagem não pode ficar vazia.');
  return m;
}

/** Falha de rede local (sem internet / DNS), não uma recusa do WhatsApp. */
export function isOfflineError(err) {
  const c = err?.data?.code || err?.code || '';
  return ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ECONNREFUSED'].includes(c)
    || /getaddrinfo|ENOTFOUND|EAI_AGAIN|ENETUNREACH/.test(err?.message || '');
}

function describeError(err, code) {
  const msg = err?.message || 'erro desconhecido';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'sem internet ou o endereço do WhatsApp está bloqueado (DNS)';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(msg)) return 'conexão recusada — verifique firewall/antivírus ou VPN';
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
