// Modo demonstração (`npm run demo`): simula uma conta do WhatsApp com
// conversas de exemplo, sem conectar em nada. Serve pra conhecer o app e
// pra testar a interface. Usa uma pasta de dados separada da real.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import QRCode from 'qrcode';
import { WhatsAppService, guessMime, extFor, editableCheck } from './whatsapp.js';
import * as db from './db.js';
import * as leads from './leads.js';

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
  /** Demonstração: guarda o que "teria sido" salvo na agenda do WhatsApp. */
  async saveContact(jid, name) {
    this.savedContacts = [...(this.savedContacts || []), { jid, name }];
    return true;
  }

  hasSession() {
    return fs.existsSync(path.join(this.authDir, 'creds.json'));
  }

  async requestPairingCode(phone) {
    if (this.state.state !== 'qr') throw new Error('Aguarde o QR code aparecer e tente de novo.');
    clearTimeout(this.qrTimer);
    this.setStatus({ pairingCode: 'DEMO-1234', pairingPhone: String(phone).replace(/\D/g, '') });
    this.qrTimer = this.later(() => this.connected(true), 2500);
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
      this.later(() => this.connected(false), 600);
      return;
    }
    const qr = await QRCode.toDataURL('demo-whatsapp-crm', { margin: 1, width: 320 });
    this.setStatus({ state: 'qr', qr, registered: false, pairingCode: null });
    // no modo demo, "escaneia" sozinho depois de alguns segundos
    const ms = Number(process.env.CRM_DEMO_QR_MS ?? 4000);
    if (ms > 0) this.qrTimer = this.later(() => this.connected(true), ms);
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

    // comercial: interessados em etapas diferentes
    const novo = PEOPLE.find(([, name]) => !name)?.[0];
    if (novo) {
      leads.saveLead({ name: 'Interessado pelo WhatsApp', jid: `${novo}@s.whatsapp.net`, phone: novo, source: 'WhatsApp', area: 'Cível', subject: 'Agendar reunião' });
      this.markChanged(`${novo}@s.whatsapp.net`);
    }
    const consulta = leads.saveLead({ name: 'Roberto Lima', phone: '(65) 99812-3456', source: 'Indicação', referred_by: 'Carlos Pereira',
      area: 'Previdenciário', subject: 'Aposentadoria por tempo de contribuição', stage: 'consulta', consult_at: Date.now() + 2 * 864e5 });
    db.saveTask({ jid: leads.leadKey(consulta), kind: 'reuniao', title: 'Consulta: Roberto Lima', due_at: Date.now() + 2 * 864e5 });
    const prop = leads.saveLead({ name: 'Fernanda Dias', phone: '(65) 99633-2211', email: 'fernanda@exemplo.com', source: 'Instagram',
      area: 'Família', subject: 'Divórcio com partilha de bens', stage: 'proposta', fee_kind: 'parcelado', fee_total: 4500, fee_count: 3 });
    leads.addContact({ lead_id: prop, kind: 'presencial', at: Date.now() - 3 * 864e5, summary: 'Consulta no escritório. Casados há 12 anos, um imóvel e um carro. Quer resolver rápido.', next_step: 'Enviar proposta' }, 'Rafael');
    leads.markProposalSent(prop, null);
    db.saveTask({ jid: leads.leadKey(prop), kind: 'tarefa', title: 'Retomar proposta — Fernanda Dias', due_at: Date.now() + 864e5 });
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

  async stop() {
    this.stopped = true;
    for (const t of this.timers || []) clearTimeout(t);
    this.timers?.clear();
  }

  /** setTimeout que é cancelado no stop() (nada roda com o banco já fechado). */
  later(fn, ms) {
    this.timers ||= new Set();
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn(); }, ms);
    this.timers.add(t);
    return t;
  }

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
    this.later(() => this.onMessageUpdates([{ key, update: { status: 3 } }]), 700);
    this.later(() => this.onMessageUpdates([{ key, update: { status: 4 } }]), 1600);
    if (chatJid.endsWith('@g.us') || process.env.CRM_DEMO_NO_REPLY) return;
    this.later(() => {
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

/**
 * Pasta "BARROS ADVOGADOS" de exemplo para a demonstração (dentro da pasta de
 * dados do demo), com a estrutura do escritório, modelos com marcadores e
 * algumas peças para a busca encontrar.
 */
export async function seedDemoDocs(root) {
  const { makeDocx, FOLDERS } = await import('./docs.js');
  if (fs.existsSync(path.join(root, FOLDERS.modelos))) return;
  const put = (rel, lines) => {
    const a = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.writeFileSync(a, Array.isArray(lines) ? makeDocx(lines) : lines);
  };
  for (const f of Object.values(FOLDERS)) fs.mkdirSync(path.join(root, f), { recursive: true });
  put('04 MODELOS/Procurações e contratos/PROCURAÇÃO AD JUDICIA.docx', [
    'PROCURAÇÃO AD JUDICIA',
    'OUTORGANTE: {NOME}, {nacionalidade}, {estado_civil}, {profissao}, inscrito(a) no CPF sob o nº {cpf}, RG {rg}, residente em {endereco}.',
    'OUTORGADOS: BARROS ASSOCIADOS, advogados.',
    'PODERES: os da cláusula ad judicia et extra, para o foro em geral.',
    'Cuiabá-MT, {data_extenso}.',
    '______________________________',
    '{NOME}',
  ]);
  put('04 MODELOS/Procurações e contratos/CONTRATO DE HONORÁRIOS.docx', [
    'CONTRATO DE PRESTAÇÃO DE SERVIÇOS ADVOCATÍCIOS',
    'CONTRATANTE: {nome}, CPF {cpf}, residente em {endereco}.',
    'OBJETO: atuação no caso {caso} em face de {parte_contraria}.',
    'HONORÁRIOS: {valor_honorarios}, e {percentual} sobre o proveito econômico em caso de êxito.',
    'Cuiabá-MT, {data_extenso}.',
  ]);
  put('04 MODELOS/Trabalhista/MODELO - Reclamação trabalhista.docx', [
    'EXCELENTÍSSIMO(A) SENHOR(A) JUIZ(A) DA __ VARA DO TRABALHO DE CUIABÁ-MT',
    '{NOME}, {nacionalidade}, {estado_civil}, {profissao}, CPF {cpf}, vem propor RECLAMAÇÃO TRABALHISTA em face de {parte_contraria}.',
    'DAS HORAS EXTRAS — o reclamante cumpria jornada superior a 8 horas diárias sem o pagamento das horas extras.',
  ]);
  put('04 MODELOS/Cível/MODELO - Indenização atraso de voo.docx', [
    'EXCELENTÍSSIMO(A) SENHOR(A) JUIZ(A) DO JUIZADO ESPECIAL CÍVEL',
    '{NOME} vem propor AÇÃO DE INDENIZAÇÃO POR DANOS MORAIS em face de {parte_contraria}, pelo atraso de voo superior a 4 horas.',
  ]);
  put('02 CLIENTES/CARLOS PEREIRA/_CADASTRO/2026-09-02 - RG e CPF.txt', 'Documento de identificação (exemplo da demonstração).');
  // PDF escaneado (só imagem): a busca acha pelo conteúdo depois do OCR
  const scan = new URL('../../assets/demo/conta-escaneada.pdf', import.meta.url);
  if (fs.existsSync(scan)) put('02 CLIENTES/CARLOS PEREIRA/_CADASTRO/2026-09-02 - Comprovante de residência.pdf', fs.readFileSync(scan));
  put('02 CLIENTES/CARLOS PEREIRA/RECLAMAÇÃO TRABALHISTA x TRANSPORTES RÁPIDO LTDA/2026-09-10 - Petição inicial.docx', [
    'EXCELENTÍSSIMO SENHOR JUIZ DA 3ª VARA DO TRABALHO DE CUIABÁ-MT',
    'CARLOS PEREIRA, brasileiro, motorista, vem propor RECLAMAÇÃO TRABALHISTA em face de TRANSPORTES RÁPIDO LTDA.',
    'DAS HORAS EXTRAS E DO ADICIONAL NOTURNO — o reclamante dirigia de madrugada sem receber o adicional noturno.',
  ]);
  put('03 ARQUIVO MORTO/ELISA x AZUL - ATRASO DE VOO/2025-03-01 - Inicial atraso de voo.docx', [
    'AÇÃO DE INDENIZAÇÃO POR DANOS MORAIS — atraso de voo de 9 horas e perda de conexão em Guarulhos.',
    'A jurisprudência do STJ reconhece o dano moral pelo atraso excessivo com falta de assistência material.',
  ]);
  put('05 FINANCEIRO/2026-09 - Extrato.txt', 'Extrato do mês (só sócios veem esta pasta).');
  put('07 EQUIPE/ISABELLA/Estudo - prescrição trabalhista.txt', 'Prescrição bienal e quinquenal na Justiça do Trabalho.');
}

/**
 * Tribunais na demonstração: responde como o DJEN e o DataJud responderiam
 * (mesmos campos), com intimações para os processos de exemplo e um
 * processo que ainda não está cadastrado.
 */
export function demoCourtsFetch(getCases) {
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() - offset); return d.toISOString().slice(0, 10); };
  const NAMES = [['ELSON FERREIRA BARROS', 'CLEBERSON DA ROCHA'], ['MARIA APARECIDA DOS SANTOS', 'BANCO BRADESCO S.A.'],
    ['JOSE CARLOS PEREIRA', 'DOCE SABOR RESTAURANTE LTDA'], ['ANA PAULA RIBEIRO', 'ESTADO DE MATO GROSSO'], ['MM COMERCIO DE PAPEIS LTDA', 'EMILLY SOUZA LIMA']];
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'comunicaapi.pje.jus.br' && u.searchParams.get('numeroProcesso')) {
      // busca pelo nº do processo: as partes (para escolher o cliente)
      const d = u.searchParams.get('numeroProcesso').replace(/\D/g, '');
      if (u.searchParams.get('pagina') !== '1' || Number(d.slice(-1)) === 9) return json({ status: 'success', count: 0, items: [] });
      const [a, b] = NAMES[Number(d.slice(-2)) % NAMES.length];
      return json({
        status: 'success', count: 1,
        items: [{
          id: Number(`77${d.slice(-6)}`), data_disponibilizacao: day(30), siglaTribunal: 'TJMT', tipoComunicacao: 'Intimação', tipoDocumento: 'Despacho',
          nomeOrgao: 'Vara de demonstração', nomeClasse: 'PROCEDIMENTO COMUM CÍVEL', numeroprocessocommascara: d, texto: 'Intimem-se as partes.',
          destinatarios: [{ nome: a, polo: 'A' }, { nome: b, polo: 'P' }],
          destinatarioadvogados: [{ advogado: { nome: 'RAFAEL AUGUSTO DE BARROS CORREA', numero_oab: '14271', uf_oab: 'MT' } }],
        }],
      });
    }
    if (u.host === 'comunicaapi.pje.jus.br' && u.searchParams.get('nomeParte')) {
      // vigiar clientes: uma ação nova contra o cliente, em processo que o escritório não acompanha
      if (u.searchParams.get('pagina') !== '1') return json({ status: 'success', count: 0, items: [] });
      const name = u.searchParams.get('nomeParte');
      const n = [...name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9000, 7) + 1000;
      return json({
        status: 'success', count: 1,
        items: [{
          id: 900400 + n, data_disponibilizacao: day(1), siglaTribunal: 'TJMT', tipoComunicacao: 'Citação', tipoDocumento: 'Despacho',
          nomeOrgao: '4ª Vara Cível de Cuiabá', nomeClasse: 'PROCEDIMENTO COMUM CÍVEL', numeroprocessocommascara: `080${n}-55.2026.8.11.0041`,
          texto: 'Cite-se a parte requerida para, querendo, apresentar contestação no prazo de 15 dias.', link: 'https://comunica.pje.jus.br/',
          destinatarios: [{ nome: 'CONDOMINIO EDIFICIO SOL NASCENTE', polo: 'A' }, { nome: name, polo: 'P' }],
          destinatarioadvogados: [{ advogado: { nome: 'ADVOGADO DA OUTRA PARTE', numero_oab: '99999', uf_oab: 'MT' } }],
        }],
      });
    }
    if (u.host === 'comunicaapi.pje.jus.br' && u.searchParams.get('nomeAdvogado')) {
      // busca pelo nome: uma publicação com o nome digitado errado e a OAB faltando um dígito
      if (u.searchParams.get('pagina') !== '1') return json({ status: 'success', count: 0, items: [] });
      return json({
        status: 'success', count: 1,
        items: [{
          id: 900300, hash: 'demoHash900300', data_disponibilizacao: day(3), siglaTribunal: 'TRT23', tipoComunicacao: 'Intimação', tipoDocumento: 'Sentença',
          nomeOrgao: '2ª Vara do Trabalho de Cuiabá', nomeClasse: 'AÇÃO TRABALHISTA - RITO ORDINÁRIO', numeroprocessocommascara: '0000456-12.2026.5.23.0002',
          texto: 'Ante o exposto, julgo PARCIALMENTE PROCEDENTES os pedidos. Custas pela reclamada. Intimem-se.', link: 'https://comunica.pje.jus.br/',
          destinatarios: [{ nome: 'JOAO BATISTA LEMOS', polo: 'A' }, { nome: 'TRANSPORTES RAPIDO LTDA', polo: 'P' }],
          destinatarioadvogados: [{ advogado: { nome: 'RAFAEL AUGUSTO DE BAROS CORREA', numero_oab: '1427', uf_oab: 'MT' } }],
        }],
      });
    }
    if (u.host === 'comunicaapi.pje.jus.br') {
      if (u.searchParams.get('pagina') !== '1') return json({ status: 'success', count: 0, items: [] });
      const known = getCases().filter((k) => k.process_number).slice(0, 2);
      const items = known.map((k, i) => ({
        id: 900100 + i,
        data_disponibilizacao: day(i + 1),
        siglaTribunal: k.tribunal || 'TJSP',
        tipoComunicacao: 'Intimação',
        tipoDocumento: i === 0 ? 'Despacho' : 'Sentença',
        nomeOrgao: k.court || '1ª Vara Cível',
        nomeClasse: 'PROCEDIMENTO COMUM CÍVEL',
        numeroprocessocommascara: k.process_number,
        texto: i === 0
          ? 'Intimem-se as partes para, no prazo de 15 (quinze) dias, especificarem as provas que pretendem produzir.'
          : 'Julgo PROCEDENTE o pedido. Intimem-se. Prazo para recurso: 15 dias.',
        link: 'https://comunica.pje.jus.br/',
        destinatarios: [{ nome: k.client_name || 'CLIENTE', polo: 'A' }, { nome: k.opposing_party || 'PARTE CONTRÁRIA', polo: 'P' }],
        destinatarioadvogados: [{ advogado: { nome: 'ADVOGADO DEMONSTRAÇÃO', numero_oab: u.searchParams.get('numeroOab'), uf_oab: u.searchParams.get('ufOab') } }],
      }));
      items.push({
        id: 900199,
        data_disponibilizacao: day(2),
        siglaTribunal: 'TJMT',
        tipoComunicacao: 'Intimação',
        tipoDocumento: 'Decisão',
        nomeOrgao: '3ª Vara Cível de Cuiabá',
        nomeClasse: 'PROCEDIMENTO DO JUIZADO ESPECIAL CÍVEL',
        numeroprocessocommascara: '1002345-67.2026.8.11.0041',
        texto: 'Designo audiência de conciliação. Cite-se a parte requerida. Intime-se a parte autora por seu advogado.',
        link: 'https://comunica.pje.jus.br/',
        destinatarios: [{ nome: 'ELISA MARTINS', polo: 'A' }, { nome: 'COMPANHIA AÉREA EXEMPLO S.A.', polo: 'P' }],
        destinatarioadvogados: [],
      });
      return json({ status: 'success', message: 'Sucesso', count: items.length, items });
    }
    if (u.host === 'api-publica.datajud.cnj.jus.br') {
      const now = Date.now();
      const iso = (d) => new Date(now - d * 864e5).toISOString();
      let asked = '';
      try { asked = String(JSON.parse(init.body || '{}').query?.match?.numeroProcesso || ''); } catch { /* sem corpo */ }
      if (/^\d{20}$/.test(asked) && !getCases().some((k) => String(k.process_number || '').replace(/\D/g, '') === asked && k.import_batch == null)) {
        // processos importados: variados (trabalhista, arquivado provisório, baixa definitiva, audiência marcada)
        const n = Number(asked.slice(-4));
        const trab = asked.slice(13, 14) === '5';
        const moves = [{ codigo: 26, nome: 'Distribuído por sorteio', dataHora: iso(700) }, { codigo: 11010, nome: 'Mero expediente', dataHora: iso(500) }];
        if (n % 7 === 0) moves.push({ codigo: 245, nome: 'Arquivado Provisoriamente', dataHora: iso(400) });
        else if (n % 7 === 1) moves.push({ codigo: 848, nome: 'Trânsito em julgado', dataHora: iso(320) }, { codigo: 22, nome: 'Baixa Definitiva', dataHora: iso(300) });
        else if (n % 7 === 2) moves.push({ codigo: 970, nome: `Audiência de conciliação designada para ${new Date(now + 20 * 864e5).toLocaleDateString('pt-BR')} às 14:00`, dataHora: iso(2) });
        else if (n % 7 === 3) moves.push({ codigo: 219, nome: 'Julgado procedente o pedido', dataHora: iso(1) });
        return json({
          hits: {
            hits: [{
              _source: {
                numeroProcesso: asked,
                classe: { nome: trab ? 'Ação Trabalhista - Rito Ordinário' : (n % 3 === 0 ? 'Divórcio Litigioso' : 'Procedimento Comum Cível') },
                assuntos: [{ nome: trab ? 'Verbas Rescisórias' : (n % 3 === 0 ? 'Dissolução' : 'Indenização por Dano Moral') }],
                orgaoJulgador: { nome: trab ? '3ª Vara do Trabalho de Cuiabá' : '5ª Vara Cível de Cuiabá' },
                dataAjuizamento: '20230115000000',
                dataHoraUltimaAtualizacao: iso(1),
                movimentos: moves,
              },
            }],
          },
        });
      }
      return json({
        hits: {
          hits: [{
            _source: {
              numeroProcesso: '00000000000000000000',
              classe: { nome: 'Procedimento Comum Cível' },
              orgaoJulgador: { nome: 'Vara de demonstração' },
              dataAjuizamento: '20260115000000',
              dataHoraUltimaAtualizacao: iso(1),
              movimentos: [
                { codigo: 26, nome: 'Distribuído por sorteio', dataHora: iso(60) },
                { codigo: 11010, nome: 'Mero expediente', dataHora: iso(20) },
                { codigo: 12266, nome: 'Juntada de Petição', complementosTabelados: [{ nome: 'Contestação' }], dataHora: iso(3) },
              ],
            },
          }],
        },
      });
    }
    return new Response('{}', { status: 404 });
  };
}
