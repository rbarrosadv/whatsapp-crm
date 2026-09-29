// Modo demonstração (`npm run demo`): simula uma conta do WhatsApp com
// conversas de exemplo, sem conectar em nada. Serve pra conhecer o app e
// pra testar a interface. Usa uma pasta de dados separada da real.
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { WhatsAppService, guessMime, extFor } from './whatsapp.js';
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
  async start() {
    this.stopped = false;
    if (this.hasSession()) {
      this.setStatus({ state: 'connecting', qr: null });
      setTimeout(() => this.connected(false), 600);
      return;
    }
    const qr = await QRCode.toDataURL('demo-whatsapp-crm', { margin: 1, width: 320 });
    this.setStatus({ state: 'qr', qr });
    // no modo demo, "escaneia" sozinho depois de alguns segundos
    this.qrTimer = setTimeout(() => this.connected(true), Number(process.env.CRM_DEMO_QR_MS || 4000));
  }

  async connected(firstTime) {
    fs.mkdirSync(this.authDir, { recursive: true });
    fs.writeFileSync(path.join(this.authDir, 'creds.json'), '{"demo":true}');
    this.setStatus({ state: 'open', qr: null, me: { jid: ME, name: 'Minha Empresa (demo)' } });
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

  async sendText(chatJid, text, quotedId) {
    this.requireSock();
    const msg = textMsg(chatJid, true, text, Math.floor(Date.now() / 1000));
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
