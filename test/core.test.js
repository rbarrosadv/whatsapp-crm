// Testes do núcleo (banco + processamento das mensagens do WhatsApp),
// sem abrir janela e sem conectar em nada. Rodar com: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/main/db.js';
import { WhatsAppService } from '../src/main/whatsapp.js';
import { importLegacy } from '../src/main/legacy.js';
import { webmToOgg } from '../src/main/ogg.js';

const PN = '5511987654321@s.whatsapp.net';
const LID = '99887766554433@lid';
const GROUP = '120363000000000009@g.us';
let dir;
let wa;
const now = () => Math.floor(Date.now() / 1000);
let n = 0;
const id = () => `TEST${n++}`;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
  db.openDb(dir);
  wa = new WhatsAppService({ dataDir: dir, logFile: path.join(dir, 'logs', 'test.log') });
});
after(() => {
  db.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cria funis, etiquetas e respostas rápidas padrão', () => {
  const pipes = db.listPipelines();
  assert.ok(pipes.length >= 2);
  assert.ok(pipes[0].stages.length >= 3);
  assert.ok(db.listTags().length >= 1);
  assert.ok(db.listQuickReplies().length >= 1);
});

test('histórico: conversas, contatos e vários tipos de mensagem', async () => {
  const t = now() - 1000;
  await wa.onHistory({
    chats: [{ id: PN, unreadCount: 2 }, { id: GROUP, name: 'Time' }, { id: 'status@broadcast' }],
    contacts: [{ id: PN, name: 'Mariana (agenda)', notify: 'Mari' }],
    messages: [
      { key: { remoteJid: PN, fromMe: false, id: 'T1' }, message: { conversation: 'oi' }, messageTimestamp: t, pushName: 'Mari' },
      {
        key: { remoteJid: PN, fromMe: true, id: 'T2' },
        message: { extendedTextMessage: { text: 'resposta', contextInfo: { stanzaId: 'T1', quotedMessage: { conversation: 'oi' } } } },
        messageTimestamp: t + 1,
      },
      {
        key: { remoteJid: PN, fromMe: false, id: 'T3' },
        message: { imageMessage: { mimetype: 'image/jpeg', caption: 'foto', fileLength: 1234, jpegThumbnail: Buffer.from([1, 2, 3]), mediaKey: Buffer.from([9]) } },
        messageTimestamp: t + 2,
      },
      {
        key: { remoteJid: PN, fromMe: false, id: 'T4' },
        message: { ephemeralMessage: { message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 7 } } } },
        messageTimestamp: t + 3,
      },
      {
        key: { remoteJid: PN, fromMe: false, id: 'T5' },
        message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'contrato.pdf', mimetype: 'application/pdf', caption: 'segue' } } } },
        messageTimestamp: t + 4,
      },
      { key: { remoteJid: PN, fromMe: false, id: 'T6' }, message: { locationMessage: { degreesLatitude: -23.5, degreesLongitude: -46.6, name: 'Escritório' } }, messageTimestamp: t + 5 },
      { key: { remoteJid: 'status@broadcast', fromMe: false, id: 'S1' }, message: { conversation: 'status' }, messageTimestamp: t },
      { key: { remoteJid: GROUP, fromMe: false, id: 'G1', participant: PN }, message: { conversation: 'oi grupo' }, messageTimestamp: t + 6, pushName: 'Mari' },
    ],
  });
  const chat = db.getChat(PN);
  assert.equal(chat.display_name, 'Mariana (agenda)');
  assert.equal(chat.unread, 2);
  assert.equal(chat.last_preview, '📍 Escritório');
  assert.equal(db.getChat('status@broadcast'), null, 'status não vira conversa');

  const msgs = db.listMessages(PN);
  const byId = Object.fromEntries(msgs.map((m) => [m.id, m]));
  assert.equal(byId.T1.text, 'oi');
  assert.equal(byId.T2.quoted_id, 'T1');
  assert.equal(byId.T2.quoted_text, 'oi');
  assert.equal(byId.T3.type, 'image');
  assert.equal(byId.T3.text, 'foto');
  assert.equal(byId.T3.thumb, 'data:image/jpeg;base64,AQID');
  assert.equal(byId.T3.has_raw, 1, 'guarda a mensagem crua para baixar a mídia depois');
  assert.equal(byId.T4.type, 'ptt');
  assert.equal(byId.T4.media_seconds, 7);
  assert.equal(byId.T5.type, 'document');
  assert.equal(byId.T5.media_name, 'contrato.pdf');
  assert.equal(byId.T6.type, 'location');

  const g = db.listMessages(GROUP);
  assert.equal(g[0].sender, PN);
  assert.equal(g[0].sender_name, 'Mariana (agenda)');
  assert.equal(db.getChat(GROUP).display_name, 'Time');
});

test('mensagens novas: contagem de não lidas, reação, edição e apagada', async () => {
  db.setChatUnread(PN, 0);
  const events = [];
  wa.on('message', (e) => events.push(e));
  await wa.onMessages([{ key: { remoteJid: PN, fromMe: false, id: 'N1' }, message: { conversation: 'tudo bem?' }, messageTimestamp: now() }], 'notify');
  assert.equal(db.getChat(PN).unread, 1);
  assert.ok(events.some((e) => e.id === 'N1' && e.notify));

  // conversa aberta e janela em foco: já fica como lida
  wa.activeChat = PN;
  await wa.onMessages([{ key: { remoteJid: PN, fromMe: false, id: 'N2' }, message: { conversation: 'oi?' }, messageTimestamp: now() }], 'notify');
  assert.equal(db.getChat(PN).unread, 0);
  wa.activeChat = null;

  // resposta pelo celular zera
  db.setChatUnread(PN, 3);
  await wa.onMessages([{ key: { remoteJid: PN, fromMe: true, id: 'N3' }, message: { conversation: 'tudo!' }, messageTimestamp: now() }], 'notify');
  assert.equal(db.getChat(PN).unread, 0);

  await wa.onMessages([{ key: { remoteJid: PN, fromMe: false, id: 'R1' }, message: { reactionMessage: { key: { id: 'N3' }, text: '❤️' } }, messageTimestamp: now() }], 'notify');
  assert.deepEqual(JSON.parse(db.getMessage(PN, 'N3').reactions), [{ from: PN, text: '❤️' }]);

  await wa.onMessages([{ key: { remoteJid: PN, fromMe: false, id: 'E1' }, message: { protocolMessage: { type: 14, key: { id: 'N1' }, editedMessage: { conversation: 'tudo bem com você?' } } }, messageTimestamp: now() }], 'notify');
  assert.equal(db.getMessage(PN, 'N1').text, 'tudo bem com você?');
  assert.equal(db.getMessage(PN, 'N1').edited, 1);

  await wa.onMessages([{ key: { remoteJid: PN, fromMe: false, id: 'D1' }, message: { protocolMessage: { type: 0, key: { id: 'N2' } } }, messageTimestamp: now() }], 'notify');
  assert.equal(db.getMessage(PN, 'N2').deleted, 1);

  // status de entrega nunca volta atrás
  await wa.onMessageUpdates([{ key: { remoteJid: PN, id: 'N3', fromMe: true }, update: { status: 4 } }]);
  await wa.onMessageUpdates([{ key: { remoteJid: PN, id: 'N3', fromMe: true }, update: { status: 3 } }]);
  assert.equal(db.getMessage(PN, 'N3').status, 4);

  // chats.update: lida no celular / marcada como não lida
  await wa.onChats([{ id: PN, unreadCount: -1 }], false);
  assert.equal(db.getChat(PN).unread, 1);
  await wa.onChats([{ id: PN, unreadCount: 0 }], false);
  assert.equal(db.getChat(PN).unread, 0);
});

test('LID: conversa que chegou pelo @lid é unida à do número, com a ficha do CRM', async () => {
  const PN2 = '5521999998888@s.whatsapp.net';
  const LID2 = '11112222333344@lid';
  await wa.onMessages([{ key: { remoteJid: LID2, fromMe: false, id: 'L1' }, message: { conversation: 'via lid' }, messageTimestamp: now() - 10 }], 'notify');
  assert.ok(db.getChat(LID2));
  db.setStage(LID2, 'captacao.proposta');
  db.addNote(LID2, 'nota no lid');
  db.updateCrmFields(LID2, { value: '150,50' });

  await wa.onMessages([{ key: { remoteJid: PN2, fromMe: false, id: 'L2' }, message: { conversation: 'via número' }, messageTimestamp: now() }], 'notify');
  wa.onLidMapping([{ lid: LID2, pn: PN2 }]);

  assert.equal(db.getChat(LID2), null);
  const c = db.getChat(PN2);
  assert.equal(c.stage_id, 'captacao.proposta');
  assert.equal(c.value, 150.5);
  assert.equal(db.listMessages(PN2).length, 2);
  assert.equal(db.listNotes(PN2).length, 1);

  // mensagens futuras no @lid caem direto na conversa do número
  await wa.onMessages([{ key: { remoteJid: LID2, fromMe: false, id: 'L3' }, message: { conversation: 'de novo' }, messageTimestamp: now() + 1 }], 'notify');
  assert.equal(db.getMessage(PN2, 'L3').text, 'de novo');

  // remoteJidAlt também ensina o mapeamento
  await wa.onMessages([{ key: { remoteJid: LID, remoteJidAlt: PN, fromMe: false, id: 'L4' }, message: { conversation: 'alt' }, messageTimestamp: now() }], 'notify');
  assert.equal(db.getMessage(PN, 'L4').text, 'alt');
});

test('CRM: etapas, etiquetas, tarefas e funil', () => {
  assert.ok(db.listPipelines().some((x) => x.id === 'casos'), 'funis de casos criados');
  const pid = db.savePipeline({ name: 'Pós-venda', icon: '🎁', stages: [{ name: 'Entregue', color: '#000' }, { name: 'Avaliar', color: '#111' }] });
  const p = db.listPipelines().find((x) => x.id === pid);
  assert.equal(p.stages.length, 2);
  db.setStage(PN, p.stages[1].id);
  assert.equal(db.getChat(PN).pipeline_id, pid);
  // remover a etapa não some com o caso: ele vai para a primeira etapa
  db.savePipeline({ id: pid, name: 'Pós-venda', stages: [p.stages[0]] });
  assert.equal(db.getChat(PN).stage_id, p.stages[0].id);

  const tag = db.saveTag({ name: 'X', color: '#f00' });
  db.setChatTags(PN, [tag]);
  assert.deepEqual(db.getChat(PN).tag_ids, [tag]);

  const tid = db.saveTask({ jid: PN, title: 'ligar', due_at: Date.now() - 1000 });
  assert.equal(db.getChat(PN).open_tasks, 1);
  assert.ok(db.dueTasksToNotify().some((t) => t.id === tid));
  db.markTaskNotified(tid);
  assert.ok(!db.dueTasksToNotify().some((t) => t.id === tid));
  db.saveTask({ id: tid, due_at: Date.now() - 500 });
  assert.ok(db.dueTasksToNotify().some((t) => t.id === tid), 'mudar a data volta a avisar');
  db.saveTask({ id: tid, done: true });
  assert.equal(db.getChat(PN).open_tasks, 0);
  assert.ok(db.listActivity(PN).length >= 1);
});

test('importa o Kanban antigo e aplica pelo nome da conversa', () => {
  const file = path.join(dir, 'kanban-state.json');
  fs.writeFileSync(file, JSON.stringify({
    categoryList: [{ id: 'cliente', icon: '⚖️', label: 'Clientes' }],
    categoryColumns: { cliente: [{ id: 'entrada', name: 'Entrada', accent: '#9DACB8' }, { id: 'aguardando', name: 'Aguardando', accent: '#E6B85A' }] },
    categories: { 'name:Mariana (agenda)': 'cliente', 'name:Fulano Futuro': 'cliente' },
    assignments: { 'cliente:name:Mariana (agenda)': 'aguardando', 'cliente:name:Fulano Futuro': 'entrada' },
    notes: { 'name:Mariana (agenda)': { text: 'cliente antigo', deadline: '2030-01-10' } },
  }));
  const r = importLegacy(db, file);
  assert.equal(r.pipelines, 1);
  assert.equal(r.conversations, 2);
  assert.equal(r.applied, 1);
  assert.equal(db.getChat(PN).stage_id, 'legado_cliente.aguardando');
  assert.ok(db.listNotes(PN).some((x) => x.text === 'cliente antigo'));
  assert.equal(db.legacyPendingCount(), 1);

  // quando a conversa com o nome pendente aparecer, é aplicada
  db.upsertContact({ jid: '5511000000001@s.whatsapp.net', notify: 'Fulano Futuro' });
  assert.equal(db.legacyPendingCount(), 0);
});

test('conversor de áudio gera OGG válido a partir de WebM', () => {
  // WebM mínimo: EBML header + Segment(tamanho desconhecido) > Tracks > TrackEntry > CodecPrivate + Cluster > SimpleBlock
  const vint = (n) => Buffer.from([0x80 | n]);
  const el = (idBytes, payload) => Buffer.concat([Buffer.from(idBytes), vint(payload.length), payload]);
  const head = Buffer.alloc(19); head.write('OpusHead'); head[8] = 1; head[9] = 1; head.writeUInt32LE(48000, 12);
  const pkt = Buffer.from([0xfc, 0xff, 0xfe]); // TOC config 31 (CELT 20ms), code 0
  const block = Buffer.concat([Buffer.from([0x81, 0x00, 0x00, 0x80]), pkt]);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], el([0x63, 0xa2], head)));
  const cluster = Buffer.concat([Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    ...Array.from({ length: 100 }, () => el([0xa3], block))]);
  const segment = Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), tracks, cluster]);
  const { ogg, seconds } = webmToOgg(segment);
  assert.equal(ogg.subarray(0, 4).toString(), 'OggS');
  assert.equal(seconds, 2); // 100 pacotes de 20 ms
  assert.ok(ogg.includes(Buffer.from('OpusTags')));
});

test('queda de conexão (428): com sessão salva reconecta sem pedir QR; sem sessão gera QR novo', async () => {
  const auth = path.join(dir, 'auth');
  const writeCreds = (registered) => {
    fs.mkdirSync(auth, { recursive: true });
    fs.writeFileSync(path.join(auth, 'creds.json'), JSON.stringify(registered ? { me: { id: '5511@s.whatsapp.net' }, account: {} } : { me: null }));
  };
  const close = async (code) => {
    const fake = { end() {} };
    wa.sock = fake;
    wa.stopped = false;
    await wa.onConnectionUpdate(fake, { connection: 'close', lastDisconnect: { error: { message: 'Connection Closed', output: { statusCode: code } } } });
  };

  writeCreds(true);
  wa.retry = 0;
  await close(428);
  assert.equal(wa.getStatus().state, 'reconnecting');
  assert.equal(wa.getStatus().retryIn, 500, 'primeira tentativa é quase imediata');
  assert.ok(fs.existsSync(path.join(auth, 'creds.json')), 'sessão salva é mantida');
  await close(428);
  assert.equal(wa.getStatus().retryIn, 2000);
  await wa.stop();

  writeCreds(false);
  await close(428);
  assert.equal(wa.getStatus().state, 'starting');
  assert.ok(!fs.existsSync(auth), 'sessão incompleta é descartada');
  await wa.stop();
});

test('casos: vários por contato, honorários em parcelas e documentos', () => {
  const J = '5511911112222@s.whatsapp.net';
  db.upsertChat({ jid: J, name: 'Cliente Casos', last_ts: Date.now() });
  const c1 = db.saveCase({ jid: J, title: 'Reclamação trabalhista', stage_id: 'casos.protocolo', process_number: '0001234-56.2026.5.02.0001', fee_installments: true, fee_success: true, fee_percent: '30' });
  const c2 = db.saveCase({ jid: J, title: 'Consulta inventário', stage_id: 'captacao.consulta' });
  const chat = db.getChat(J);
  assert.equal(chat.open_cases, 2);
  assert.deepEqual(new Set(chat.stage_ids), new Set(['casos.protocolo', 'captacao.consulta']));
  assert.ok(chat.pipeline_ids.includes('casos') && chat.pipeline_ids.includes('captacao'));

  // 1000 em 3 parcelas: 333,33 + 333,33 + 333,34, vencimentos mensais (31 → último dia)
  const first = new Date(2030, 0, 31, 12).getTime();
  const ids = db.generateInstallments(c1, { total: '1000', count: 3, firstDue: first });
  const pays = db.listPayments({ caseId: c1 });
  assert.equal(ids.length, 3);
  assert.deepEqual(pays.map((x) => x.amount), [333.33, 333.33, 333.34]);
  assert.equal(new Date(pays[1].due_at).getDate(), 28, 'fevereiro de 2030 termina dia 28');
  assert.equal(pays[2].seq, 3);
  assert.equal(pays[2].of_total, 3);

  db.setPaymentPaid(ids[0], true);
  const k = db.getCase(c1);
  assert.equal(k.paid_total, 333.33);
  assert.equal(k.billed_total, 1000);
  assert.equal(k.fee_success, true);
  assert.equal(k.fee_percent, 30);

  // parcela vencida aparece no resumo e nos avisos
  const late = db.savePayment({ case_id: c2, amount: '500,50', due_at: Date.now() - 86400000, description: 'Consulta' });
  const sum = db.financeSummary();
  assert.ok(sum.overdue >= 500.5);
  assert.ok(db.paymentsToNotify(3).overdue.some((x) => x.id === late));
  db.markPaymentsNotified([late], 'overdue');
  assert.ok(!db.paymentsToNotify(3).overdue.some((x) => x.id === late));
  assert.equal(db.getChat(J).overdue_payments, 1);

  // tarefas e notas do caso
  db.saveTask({ case_id: c1, title: 'Audiência de instrução', kind: 'audiencia', due_at: Date.now() + 86400000 });
  assert.equal(db.listTasks({ caseId: c1 })[0].jid, J, 'tarefa do caso fica ligada ao contato');
  assert.equal(db.listTasks({ caseId: c1 })[0].case_title, 'Reclamação trabalhista');
  db.addNote(J, 'nota do caso', c1);
  assert.equal(db.listNotes(null, c1).length, 1);

  // documentos (sem duplicar a mesma mensagem)
  assert.ok(db.addCaseDoc({ case_id: c1, name: 'rg.pdf', file: 'x/rg.pdf', msg_id: 'M1' }));
  assert.equal(db.addCaseDoc({ case_id: c1, name: 'rg.pdf', file: 'x/rg.pdf', msg_id: 'M1' }), null);
  assert.equal(db.getCase(c1).docs_count, 1);

  // encerrar caso tira ele das etapas abertas; mover reabre
  db.setCaseStatus(c2, 'encerrado');
  assert.deepEqual(db.getChat(J).stage_ids, ['casos.protocolo']);
  db.setCaseStage(c2, 'captacao.contratou');
  assert.equal(db.getCase(c2).status, 'aberto');

  // sem retorno ao cliente
  db.run('UPDATE cases SET last_update_at = ? WHERE id = ?', Date.now() - 20 * 86400000, c1);
  assert.ok(db.staleCases(15 * 86400000).some((x) => x.id === c1));
  db.touchCasesOfContact(J);
  assert.ok(!db.staleCases(15 * 86400000).some((x) => x.id === c1));

  db.deleteCase(c2);
  assert.equal(db.getCase(c2), null);
  assert.equal(db.listPayments({ caseId: c2 }).length, 0);
});
