// Modo demonstração (`npm run demo`): simula uma conta do WhatsApp com
// conversas de exemplo, sem conectar em nada. Serve pra conhecer o app e
// pra testar a interface. Usa uma pasta de dados separada da real.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import QRCode from 'qrcode';
import { WhatsAppService, guessMime, extFor, editableCheck, toUrlInfo } from './whatsapp.js';
import * as db from './db.js';

const ME = '5511900000000@s.whatsapp.net';

const PEOPLE = [
  ['5511987654321', 'Mariana Souza', [
    [0, 'Oi! Vi o anúncio de vocês no Instagram'],
    [0, 'Queria saber o valor do plano mensal'],
    [1, 'Olá, Mariana! Tudo bem? O plano mensal sai por R$ 199,00.'],
    [0, 'Tem desconto pra pagamento anual?'],
  ]],
  ['5521991234567', 'Carlos Pereira', [
    [1, 'Bom dia, Carlos! Segue a proposta que conversamos.'],
    [0, 'Recebi, vou analisar com meu sócio e te retorno até sexta.'],
  ]],
  ['5531988887777', 'Ana Beatriz', [
    [0, 'Boa tarde, consegue me mandar o contrato atualizado?'],
    [1, 'Claro! Envio ainda hoje.'],
    [0, 'Obrigada 🙏'],
  ]],
  ['5511955554444', 'João (Fornecedor)', [
    [0, 'O pedido 1234 saiu pra entrega hoje cedo.'],
  ]],
  ['5548999990000', null, [
    [0, 'Olá, gostaria de agendar uma reunião'],
  ]],
];

let counter = 0;
const newId = () => `DEMO${Date.now().toString(36).toUpperCase()}${(counter++).toString(36).toUpperCase()}`;

function textMsg(remoteJid, fromMe, text, tsSec, pushName) {
  return {
    key: { remoteJid, fromMe: !!fromMe, id: newId() },
    message: { conversation: text },
    messageTimestamp: tsSec,
    pushName: fromMe ? undefined : pushName,
    status: fromMe ? 4 : undefined,
  };
}

export class DemoWhatsAppService extends WhatsAppService {
  hasSession() {
    return fs.existsSync(path.join(this.authDir, 'creds.json'));
  }

  async requestPairingCode(phone) {
    if (this.state.state !== 'qr') throw new Error('Aguarde o QR code aparecer e tente de novo.');
    clearTimeout(this.qrTimer);
    this.setStatus({ pairingCode: 'DEMO-1234', pairingPhone: String(phone).replace(/\D/g, '') });
    this.qrTimer = setTimeout(() => this.connected(true), 2500);
    return 'DEMO-1234';
  }

  async reset() {
    clearTimeout(this.qrTimer);
    await this.start();
  }

  async repair() {
    clearTimeout(this.qrTimer);
    this.clearAuth();
    this.setStatus({ state: 'starting', registered: false, suggestRepair: false, error: null });
    await this.start();
  }

  async start() {
    this.stopped = false;
    if (this.hasSession()) {
      this.setStatus({ state: 'connecting', registered: true, qr: null });
      setTimeout(() => this.connected(false), 600);
      return;
    }
    const qr = await QRCode.toDataURL('demo-whatsapp-crm', { margin: 1, width: 320 });
    this.setStatus({ state: 'qr', qr, registered: false, pairingCode: null });
    // no modo demo, "escaneia" sozinho depois de alguns segundos
    const ms = Number(process.env.CRM_DEMO_QR_MS ?? 4000);
    if (ms > 0) this.qrTimer = setTimeout(() => this.connected(true), ms);
  }

  async connected(firstTime) {
    fs.mkdirSync(this.authDir, { recursive: true });
    fs.writeFileSync(path.join(this.authDir, 'creds.json'), '{"demo":true}');
    this.setStatus({ state: 'open', registered: true, qr: null, pairingCode: null, me: { jid: ME, name: 'Minha Empresa (demo)' } });
    if (firstTime) await this.seed();
  }

  async seed() {
    const base = Math.floor(Date.now() / 1000) - 3600 * 30;
    const messages = [];
    const contacts = [];
    const chats = [];
    PEOPLE.forEach(([phone, name, lines], i) => {
      const jid = `${phone}@s.whatsapp.net`;
      if (name) contacts.push({ id: jid, notify: name });
      chats.push({ id: jid, unreadCount: lines[lines.length - 1][0] === 0 ? 1 : 0 });
      lines.forEach(([fromMe, text], j) => {
        messages.push(textMsg(jid, fromMe, text, base + i * 3600 * 5 + j * 240, name || undefined));
      });
    });
    const group = '120363000000000001@g.us';
    chats.push({ id: group, name: 'Equipe Comercial' });
    messages.push({
      key: { remoteJid: group, fromMe: false, id: newId(), participant: '5511987654321@s.whatsapp.net' },
      message: { conversation: 'Pessoal, reunião amanhã às 9h' },
      messageTimestamp: base + 3600 * 28,
      pushName: 'Mariana Souza',
    });
    await this.onHistory({ chats, contacts, messages, progress: 100 });

    // casos de exemplo, com honorários (um vencido) e um prazo
    const carlos = '5521991234567@s.whatsapp.net';
    db.setContactType(carlos, 'cliente');
    const caseId = db.saveCase({
      jid: carlos, title: 'Reclamação trabalhista', stage_id: 'casos.aguardando',
      process_number: '1000123-45.2026.5.01.0001', area: 'Trabalhista', court: '1ª Vara do Trabalho do RJ',
      opposing_party: 'Transportes Exemplo Ltda.', fee_installments: true, fee_success: true, fee_total: 3000, fee_percent: 30,
    });
    // 1ª parcela há ~2 meses (paga), 2ª há ~1 mês (vencida), 3ª agora
    const first = new Date(Date.now() - 62 * 864e5); first.setHours(12, 0, 0, 0);
    const ids = db.generateInstallments(caseId, { total: 3000, count: 3, firstDue: first.getTime(), description: 'Honorários' });
    db.setPaymentPaid(ids[0], true);
    db.saveTask({ case_id: caseId, kind: 'audiencia', title: 'Audiência de instrução', due_at: Date.now() + 5 * 864e5 });
    this.markChanged(carlos);
  }

  requireSock() {
    if (this.state.state !== 'open') throw new Error('WhatsApp não está conectado no momento.');
    return null;
  }

  async logout() {
    clearTimeout(this.qrTimer);
    this.clearAuth();
    this.setStatus({ state: 'logged_out', me: null });
    await this.start();
  }

  async stop() { clearTimeout(this.qrTimer); this.stopped = true; }

  async sendText(chatJid, text, quotedId, { linkPreview } = {}) {
    this.requireSock();
    const msg = textMsg(chatJid, true, text, Math.floor(Date.now() / 1000));
    const info = toUrlInfo(text, linkPreview);
    if (info) {
      msg.message = {
        extendedTextMessage: {
          text, matchedText: info['matched-text'], canonicalUrl: info['canonical-url'],
          title: info.title, description: info.description, jpegThumbnail: info.jpegThumbnail,
        },
      };
    }
    msg.status = 2;
    if (quotedId) {
      const q = db.getMessage(chatJid, quotedId);
      msg.message = {
        extendedTextMessage: {
          text,
          contextInfo: { stanzaId: quotedId, participant: q?.sender || undefined, quotedMessage: { conversation: q?.text || '' } },
        },
      };
    }
    await this.onMessages([msg], 'append');
    this.simulateDelivery(chatJid, msg.key);
    return msg.key.id;
  }

  simulateDelivery(chatJid, key) {
    setTimeout(() => this.onMessageUpdates([{ key, update: { status: 3 } }]), 700);
    setTimeout(() => this.onMessageUpdates([{ key, update: { status: 4 } }]), 1600);
    if (chatJid.endsWith('@g.us') || process.env.CRM_DEMO_NO_REPLY) return;
    setTimeout(() => {
      const name = db.contactName(chatJid) || undefined;
      this.onMessages([textMsg(chatJid, false, 'Perfeito, obrigado! 👍', Math.floor(Date.now() / 1000), name)], 'notify');
    }, 2500);
  }

  async sendFile(chatJid, filePath, { caption } = {}) {
    this.requireSock();
    const fileName = path.basename(filePath);
    const mime = guessMime(fileName);
    const kind = mime.startsWith('image/') ? 'imageMessage' : mime.startsWith('video/') ? 'videoMessage'
      : mime.startsWith('audio/') ? 'audioMessage' : 'documentMessage';
    const buf = fs.readFileSync(filePath);
    const msg = {
      key: { remoteJid: chatJid, fromMe: true, id: newId() },
      message: { [kind]: { mimetype: mime, caption, fileName, fileLength: buf.length } },
      messageTimestamp: Math.floor(Date.now() / 1000),
      status: 2,
    };
    await this.onMessages([msg], 'append');
    this.storeLocal(chatJid, msg.key.id, buf, extFor(mime, fileName));
    this.simulateDelivery(chatJid, msg.key);
    return msg.key.id;
  }

  async sendVoice(chatJid, buffer, mimetype, seconds) {
    this.requireSock();
    const msg = {
      key: { remoteJid: chatJid, fromMe: true, id: newId() },
      message: { audioMessage: { mimetype, ptt: true, seconds, fileLength: buffer.length } },
      messageTimestamp: Math.floor(Date.now() / 1000),
      status: 2,
    };
    await this.onMessages([msg], 'append');
    this.storeLocal(chatJid, msg.key.id, Buffer.from(buffer), extFor(mimetype));
    this.simulateDelivery(chatJid, msg.key);
    return msg.key.id;
  }

  storeLocal(chatJid, id, buf, ext) {
    const rel = path.join(chatJid.replace(/[^a-zA-Z0-9._-]/g, '_'), `${id}.${ext}`);
    fs.mkdirSync(path.join(this.mediaDir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(this.mediaDir, rel), buf);
    db.updateMessage(chatJid, id, { media_file: rel });
    this.emit('message', { chatJid, id, isNew: false });
  }

  async react(chatJid, id, emoji) {
    this.requireSock();
    this.applyReaction(chatJid, id, { from: 'me', text: emoji });
  }

  // no demo não há celular para sincronizar: apaga daqui e finge que sincronizou
  async deleteForMe(chatJid, id) {
    await super.deleteForMe(chatJid, id);
    return { synced: true };
  }

  async forwardMessage(chatJid, id, targets) {
    this.requireSock();
    const { m, msg } = this.forwardable(chatJid, id);
    const ok = [];
    for (const to of [...new Set(targets || [])].slice(0, 5)) {
      // cópia com a marca de encaminhada, como o Baileys faz
      const content = JSON.parse(JSON.stringify(msg.message || {}));
      if (content.conversation) {
        content.extendedTextMessage = { text: content.conversation };
        delete content.conversation;
      }
      const type = Object.keys(content)[0];
      // como no WhatsApp: encaminhar mensagem sua não ganha a marca "Encaminhada"
      const score = (content[type].contextInfo?.forwardingScore || 0) + (msg.key.fromMe ? 0 : 1);
      content[type].contextInfo = score ? { isForwarded: true, forwardingScore: score } : {};
      const fwd = { key: { remoteJid: to, fromMe: true, id: newId() }, message: content, messageTimestamp: Math.floor(Date.now() / 1000), status: 2 };
      await this.onMessages([fwd], 'append');
      if (m.media_file) db.updateMessage(to, fwd.key.id, { media_file: m.media_file });
      this.simulateDelivery(to, fwd.key);
      ok.push(to);
    }
    return ok;
  }

  async editMessage(chatJid, id, text) {
    this.requireSock();
    editableCheck(db.getMessage(chatJid, id), text);
    this.applyEdit(chatJid, id, text);
  }

  async deleteForEveryone(chatJid, id) {
    this.requireSock();
    db.updateMessage(chatJid, id, { deleted: 1, text: '' });
    this.refreshPreview(chatJid);
    this.markChanged(chatJid);
    this.emit('message', { chatJid, id, isNew: false });
  }

  async downloadMedia(chatJid, id) {
    const m = db.getMessage(chatJid, id);
    if (m?.media_file) return m.media_file;
    throw new Error('Mídia indisponível no modo demonstração.');
  }

  async avatar() { return null; }
  async loadOlder() { return false; }

  async groupInfo(jid) {
    return {
      subject: db.getChat(jid)?.name || 'Grupo',
      desc: 'Grupo de demonstração',
      participants: [{ jid: ME, admin: 'admin', name: 'Você' }, { jid: '5511987654321@s.whatsapp.net', name: 'Mariana Souza' }],
    };
  }

  async checkNumber(phone) {
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 10) return null;
    return `${digits}@s.whatsapp.net`;
  }

  /** usado pelos testes: simula uma mensagem recebida */
  async simulateIncoming(phone, text, name) {
    const jid = `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`;
    await this.onMessages([textMsg(jid, false, text, Math.floor(Date.now() / 1000), name)], 'notify');
    return jid;
  }
}

/** Google Agenda de mentira para o modo demonstração. */
export class DemoGoogleService extends EventEmitter {
  constructor() {
    super();
    this.cals = [
      { id: 'pessoal@demo', name: 'Pessoal', color: '#a855f7', primary: true, writable: true, selected: true },
      { id: 'escritorio@demo', name: 'Escritório', color: '#3b82f6', primary: false, writable: true, selected: true },
      { id: 'feriados@demo', name: 'Feriados no Brasil', color: '#22c55e', primary: false, writable: false, selected: true },
    ];
    const day = (d, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return x.getTime(); };
    let n = 0;
    this.items = [
      { calendarId: 'pessoal@demo', title: 'Academia', start: day(0, 7), end: day(0, 8) },
      { calendarId: 'pessoal@demo', title: 'Dentista', start: day(1, 17), end: day(1, 18) },
      { calendarId: 'escritorio@demo', title: 'Reunião com sócio', start: day(0, 14), end: day(0, 15, 30) },
      { calendarId: 'escritorio@demo', title: 'Despacho com juiz', start: day(2, 10), end: day(2, 11) },
      { calendarId: 'pessoal@demo', title: 'Aniversário da mãe', start: day(3, 0), end: day(4, 0), allDay: true },
      { calendarId: 'feriados@demo', title: 'Feriado', start: day(6, 0), end: day(7, 0), allDay: true },
    ].map((e) => ({ ...e, id: `demo${n++}` }));
    this.seq = n;
  }

  status() { return { configured: true, connected: true, needsReconnect: false, email: 'voce@hotmail.com (demonstração)' }; }
  importClient() {}
  async connect() { return this.status(); }
  async disconnect() {}
  async calendars() { return this.cals; }
  async events(ids, from, to) {
    return this.items.filter((e) => (!ids || ids.includes(e.calendarId)) && e.end > from && e.start < to).map((e) => {
      const cal = this.cals.find((c) => c.id === e.calendarId);
      return { description: '', location: '', allDay: false, taskId: null, ...e, source: 'google', calendarName: cal.name, color: cal.color, writable: cal.writable, htmlLink: null };
    });
  }
  async saveEvent(calendarId, ev, eventId) {
    let item = eventId && this.items.find((e) => e.id === eventId);
    if (!item) { item = { id: `demo${this.seq++}`, calendarId }; this.items.push(item); }
    Object.assign(item, Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined)), { calendarId });
    return { id: item.id };
  }
  async deleteEvent(calendarId, eventId) { this.items = this.items.filter((e) => e.id !== eventId); }
}
