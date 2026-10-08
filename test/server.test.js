// Testes da equipe (login, sessões, permissões) e do servidor HTTP no modo
// demonstração — sem navegador. Rodar com: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as auth from '../src/server/auth.js';
import * as db from '../src/main/db.js';
import forge from 'node-forge';

process.env.CRM_DEMO_QR_MS = '200';
const { startServer } = await import('../src/server/server.js');

let dir;
let srv;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-srv-'));
  srv = await startServer({ dataDir: dir, demo: true, port: 0 });
});
after(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Cliente HTTP mínimo que guarda o cookie de sessão. */
function client() {
  let cookie = '';
  const req = async (p, { body, headers = {}, raw, method = body || raw ? 'POST' : 'GET' } = {}) => {
    const r = await fetch(`${srv.url}${p}`, {
      method,
      headers: { 'X-CRM': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* não é JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const call = async (method, ...args) => {
    const r = await req(`/api/${method}`, { body: { args } });
    if (!r.json?.ok) throw new Error(r.json?.error || `HTTP ${r.status}`);
    return r.json.result;
  };
  return { req, call, cookie: () => cookie };
}
const cookieOf = async (c) => c.cookie();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function connected(c) {
  for (let i = 0; i < 40; i++) {
    if ((await c.call('wa:status')).state === 'open') return;
    await wait(100);
  }
  throw new Error('demo não conectou');
}

test('senha: hash confere só com a senha certa', () => {
  const h = auth.hashPassword('segredo1');
  assert.ok(auth.checkPassword('segredo1', h));
  assert.ok(!auth.checkPassword('segredo2', h));
  assert.ok(!auth.checkPassword('segredo1', 'lixo'));
});

test('perfis: estagiário não mexe no financeiro; advogado não mexe na equipe', () => {
  assert.ok(auth.can('socio', 'finance:list'));
  assert.ok(auth.can('socio', 'users:save'));
  assert.ok(!auth.can('estagiario', 'finance:list'));
  assert.ok(!auth.can('estagiario', 'finance:sendCharge'));
  assert.ok(auth.can('estagiario', 'messages:sendText'));
  assert.ok(auth.can('estagiario', 'cases:save'));
  assert.ok(!auth.can('advogado', 'users:save'));
  assert.ok(!auth.can('advogado', 'cases:delete'));
  assert.ok(auth.can('advogado', 'finance:sendCharge'));
  assert.ok(!auth.can('desconhecido', 'finance:list'), 'perfil desconhecido = o mais restrito');
  const k = auth.stripMoney({ id: 1, title: 'x', fee_total: 1000, paid_total: 500, billed_total: 900 });
  assert.deepEqual(k, { id: 1, title: 'x' });
});

test('sem login: a interface manda para a tela de entrar e a API recusa', async () => {
  const c = client();
  const page = await fetch(`${srv.url}/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');
  assert.equal((await c.req('/api/bootstrap', { body: {} })).status, 401);
  assert.equal((await c.req('/media/qualquer.jpg')).status, 401);
  const st = await c.req('/auth/state');
  assert.equal(st.json.setup, true);
});

test('primeiro acesso cria o sócio; depois disso só login', async () => {
  const c = client();
  const r = await c.req('/auth/setup', { body: { name: 'Rafael Barros', login: 'Barros', password: 'segredo1' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'socio');
  assert.equal(r.json.user.login, 'barros');
  const again = await client().req('/auth/setup', { body: { name: 'Intruso', login: 'x1', password: 'segredo1' } });
  assert.equal(again.status, 400);
  // sem o cabeçalho X-CRM (ex.: formulário de outro site) é recusado
  const csrf = await c.req('/api/bootstrap', { body: {}, headers: { 'X-CRM': '' } });
  assert.equal(csrf.status, 403);
  const b = await c.call('bootstrap');
  assert.equal(b.me.name, 'Rafael Barros');
  assert.equal(b.can.admin, true);
});

test('login errado é recusado; certo entra; sair encerra a sessão', async () => {
  const c = client();
  assert.equal((await c.req('/auth/login', { body: { login: 'barros', password: 'errada' } })).status, 401);
  assert.equal((await c.req('/auth/login', { body: { login: 'BARROS', password: 'segredo1' } })).status, 200);
  assert.equal((await c.call('bootstrap')).me.login, 'barros');
  await c.req('/auth/logout', { body: {} });
  assert.equal((await c.req('/api/bootstrap', { body: {} })).status, 401);
});

test('mensagens saem assinadas com o nome de quem enviou', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  await connected(c);
  await c.call('me:update', { signature: 'Dr. Barros' });
  const chat = (await c.call('chats:list')).find((x) => !x.is_group);
  const id = await c.call('messages:sendText', chat.jid, 'Bom dia!');
  await wait(100);
  const msg = db.getMessage(chat.jid, id);
  assert.equal(msg.text, '*Dr. Barros:*\nBom dia!');
  // desligando a assinatura (configuração do escritório)
  await c.call('settings:set', 'signMessages', false);
  const id2 = await c.call('messages:sendText', chat.jid, 'Sem assinatura');
  await wait(100);
  assert.equal(db.getMessage(chat.jid, id2).text, 'Sem assinatura');
  await c.call('settings:set', 'signMessages', true);
});

test('equipe: estagiária entra, não vê dinheiro e não muda o escritório', async () => {
  const socio = client();
  await socio.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const uid = await socio.call('users:save', { name: 'Isabella Costa', login: 'isabella', role: 'estagiario', password: 'estagio1' });
  await assert.rejects(socio.call('users:save', { name: 'Outra', login: 'isabella', password: 'estagio1' }), /Já existe/);

  const est = client();
  assert.equal((await est.req('/auth/login', { body: { login: 'isabella', password: 'estagio1' } })).status, 200);
  const b = await est.call('bootstrap');
  assert.equal(b.can.finance, false);
  assert.equal(b.dataDir, '');
  await assert.rejects(est.call('finance:list'), /permissão/);
  await assert.rejects(est.call('users:list'), /permissão/);
  await assert.rejects(est.call('settings:set', 'pixKey', 'x'), /sócio/);
  // preferência pessoal pode
  const s = await est.call('settings:set', 'theme', 'light');
  assert.equal(s.theme, 'light');
  assert.notEqual((await socio.call('settings:get')).theme, 'light', 'preferência é de cada pessoa');
  // casos chegam sem os valores
  const chat = (await est.call('chats:list')).find((x) => !x.is_group);
  const caseId = await socio.call('cases:save', { jid: chat.jid, title: 'Caso teste', fee_total: 5000, fee_fixed: true });
  const k = await est.call('cases:get', caseId);
  assert.equal(k.title, 'Caso teste');
  assert.equal(k.fee_total, undefined);
  assert.equal((await socio.call('cases:get', caseId)).fee_total, 5000);
  // estagiária salvando o caso não apaga os honorários
  await est.call('cases:save', { id: caseId, title: 'Caso teste 2', fee_total: 0 });
  assert.equal((await socio.call('cases:get', caseId)).fee_total, 5000);

  // desativada: a sessão dela cai
  await socio.call('users:save', { id: uid, name: 'Isabella Costa', login: 'isabella', active: false });
  assert.equal((await est.req('/api/bootstrap', { body: {} })).status, 401);
  // o último sócio não pode deixar de ser sócio
  const me = (await socio.call('bootstrap')).me;
  await assert.rejects(socio.call('users:save', { id: me.id, name: me.name, login: me.login, role: 'advogado' }), /pelo menos um sócio/);
});

test('arquivos: envio por /upload e mídia só de dentro da pasta', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const up = await c.req('/upload', { raw: Buffer.from('conteúdo de teste'), headers: { 'X-File-Name': encodeURIComponent('../../contrato.txt') } });
  assert.equal(up.status, 200);
  assert.match(up.json.token, /^[a-f0-9]{32}$/);
  assert.equal(up.json.name, 'contrato.txt', 'nome sem caminho');
  const chat = (await c.call('chats:list')).find((x) => !x.is_group);
  const [id] = await c.call('messages:sendFiles', chat.jid, [up.json.token]);
  await wait(150);
  const msg = db.getMessage(chat.jid, id);
  assert.ok(msg.media_file, 'arquivo guardado na mídia');
  const got = await c.req(`/media/${msg.media_file.split(/[\\/]/).map(encodeURIComponent).join('/')}`);
  assert.equal(got.status, 200);
  assert.equal(got.text, 'conteúdo de teste');
  assert.equal((await c.req('/media/..%2F..%2Fcrm.sqlite')).status, 404);
  await assert.rejects(c.call('messages:sendFiles', chat.jid, ['0'.repeat(32)]), /não encontrado/);
});

test('painel do dia: compromissos de cada pessoa, atrasados e passar para amanhã', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const me = (await c.call('bootstrap')).me;
  const team = await c.call('team:list');
  assert.ok(team.some((u) => u.id === me.id), 'equipe lista quem está ativo');
  assert.ok(team.every((u) => !('password_hash' in u) && !('login' in u)), 'sem dados sensíveis');

  const dayStart = new Date().setHours(0, 0, 0, 0);
  const DAY = 864e5;
  const range = { dayStart, dayEnd: dayStart + DAY, weekStart: dayStart - 2 * DAY, weekEnd: dayStart + 5 * DAY };
  const mine = await c.call('tasks:save', { title: 'Ligar para o cliente', due_at: dayStart + 15 * 3600e3, kind: 'tarefa' });
  const late = await c.call('tasks:save', { title: 'Protocolar petição', due_at: dayStart - DAY + 10 * 3600e3, kind: 'tarefa' });
  const other = await c.call('tasks:save', { title: 'Tarefa de outra pessoa', due_at: dayStart + 11 * 3600e3, assignee_id: 999 });

  const s = await c.call('today:summary', { ...range, scope: 'mine' });
  assert.ok(s.today.some((t) => t.id === mine), 'tarefa nova fica com quem criou');
  assert.ok(!s.today.some((t) => t.id === other), '"meus" não mostra a de outra pessoa');
  assert.ok(s.overdue.some((t) => t.id === late), 'atrasada aparece');
  assert.ok(s.payments, 'sócio recebe o resumo de cobranças');
  const all = await c.call('today:summary', { ...range, scope: 'all' });
  assert.ok(all.today.some((t) => t.id === other), 'escritório todo mostra todas');
  await assert.rejects(c.call('today:summary', {}), /período/);

  await c.call('tasks:save', { id: mine, done: true });
  assert.ok((await c.call('today:summary', { ...range, scope: 'mine' })).doneToday >= 1, 'conta o que foi concluído hoje');

  const tomorrow = dayStart + DAY + 10 * 3600e3;
  await c.call('tasks:reschedule', [{ id: late, due_at: tomorrow }]);
  const after = await c.call('today:summary', { ...range, scope: 'mine' });
  assert.ok(!after.overdue.some((t) => t.id === late), 'saiu dos atrasados');
  assert.ok(after.week.some((t) => t.id === late && t.due_at === tomorrow), 'foi para amanhã');
});

test('documentos: busca, permissões por pasta, pasta do caso e "usar como base"', async () => {
  const { docxText } = await import('../src/main/docs.js');
  const socio = client();
  await socio.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const st = await socio.call('docs:status');
  assert.equal(st.ok, true, 'demo tem a pasta do escritório');
  assert.ok(st.folders.includes('04 MODELOS'));

  const hits = await socio.call('docs:search', 'atraso voo guarulhos');
  assert.ok(hits.some((d) => d.rel.startsWith('03 ARQUIVO MORTO/') && /Guarulhos/.test(d.snippet)), 'acha pelo conteúdo, sem acento');
  assert.ok((await socio.call('docs:search', 'extrato')).length >= 1, 'sócio vê o financeiro');

  await socio.call('users:save', { name: 'Bia Estagiária', login: 'bia', role: 'estagiario', password: 'estagio1' });
  const est = client();
  await est.req('/auth/login', { body: { login: 'bia', password: 'estagio1' } });
  assert.equal((await est.call('docs:search', 'extrato')).length, 0, 'estagiária não acha nada do financeiro');
  await assert.rejects(est.call('docs:list', '05 FINANCEIRO'), /acesso/);
  assert.ok(!(await est.call('docs:list', '')).entries.some((e) => e.name === '05 FINANCEIRO'), 'nem vê a pasta');
  const extrato = (await socio.call('docs:search', 'extrato'))[0];
  assert.equal((await est.req(extrato.url)).status, 404);
  assert.equal((await socio.req(extrato.url)).status, 200);

  // cliente com pasta antiga é reconhecido; caso ganha pasta no padrão
  const carlos = (await socio.call('chats:list')).find((c) => c.display_name === 'Carlos Pereira');
  const carlosId = await socio.call('clients:fromChat', carlos.jid);
  const cf = await socio.call('docs:clientFolder', carlosId);
  assert.equal(cf.suggestion?.rel, '02 CLIENTES/CARLOS PEREIRA');
  await socio.call('docs:linkClient', carlosId, cf.suggestion.rel);
  await socio.call('clients:save', { id: carlosId, cpf: '123.456.789-00', nationality: 'brasileiro', marital: 'casado', gender: 'm', profession: 'motorista', address: 'Rua A, 10, Cuiabá-MT' });
  const caseId = await socio.call('cases:save', { client_id: carlosId, title: 'Horas extras', opposing_party: 'Transportes Rápido Ltda' });
  const info = await socio.call('docs:caseFolder', caseId);
  assert.equal(info.clientFolder, '02 CLIENTES/CARLOS PEREIRA');
  assert.ok(info.options.some((o) => o.endsWith('RECLAMAÇÃO TRABALHISTA x TRANSPORTES RÁPIDO LTDA')), 'oferece ligar a pasta antiga');
  const folder = await socio.call('docs:createCaseFolder', caseId);
  assert.equal(folder, '02 CLIENTES/CARLOS PEREIRA/HORAS EXTRAS x TRANSPORTES RÁPIDO LTDA');

  const tpl = (await socio.call('docs:templates')).find((t) => t.name === 'PROCURAÇÃO AD JUDICIA.docx');
  assert.equal(tpl.area, 'Procurações e contratos');
  const made = await socio.call('docs:useAsBase', tpl.rel, { caseId });
  assert.match(made.rel, /^02 CLIENTES\/CARLOS PEREIRA\/HORAS EXTRAS x .*\/\d{4}-\d{2}-\d{2} - PROCURAÇÃO AD JUDICIA\.docx$/);
  const text = docxText(Buffer.from(await (await fetch(`${srv.url}${made.url}`, { headers: { Cookie: await cookieOf(socio) } })).arrayBuffer()));
  assert.match(text, /OUTORGANTE: CARLOS PEREIRA, brasileiro, casado, motorista, inscrito\(a\) no CPF sob o nº 123\.456\.789-00/);
  assert.ok(!/\{/.test(text.replace('{rg}', '')), 'marcadores preenchidos');
  // o novo documento já entra na busca
  assert.ok((await socio.call('docs:search', 'procuração carlos')).some((d) => d.rel === made.rel));
  await assert.rejects(socio.call('docs:list', '../..'), /fora da pasta/);
});

test('clientes: cadastro sem WhatsApp, casos e tarefas do cliente; ligar o WhatsApp depois leva tudo junto', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const id = await c.call('clients:save', { name: 'Joana Lima', cpf: '987.654.321-00', phone: '(65) 99999-1111' });
  const caseId = await c.call('cases:save', { client_id: id, title: 'Revisional de aluguel' });
  const k = await c.call('cases:get', caseId);
  assert.equal(k.jid, `cliente:${id}`, 'sem WhatsApp, o caso fica com a chave do cliente');
  assert.equal(k.client_name, 'Joana Lima');
  await c.call('tasks:save', { case_id: caseId, title: 'Juntar contrato', due_at: Date.now() + 864e5 });
  await c.call('notes:add', `cliente:${id}`, 'Prefere contato por e-mail');
  assert.equal((await c.call('clients:list', { q: '98765' }))[0]?.id, id, 'busca pelo CPF');
  assert.equal((await c.call('clients:list', { q: 'joana' }))[0]?.cases_open, 1);
  await assert.rejects(c.call('cases:save', { title: 'Sem cliente' }), /cliente/);

  // liga o WhatsApp: casos, tarefas e notas passam para a conversa
  const chat = (await c.call('chats:list')).find((x) => !x.is_group && !x.client_id);
  await c.call('clients:linkChat', id, chat.jid);
  assert.equal((await c.call('cases:get', caseId)).jid, chat.jid);
  assert.ok((await c.call('tasks:list', { jid: chat.jid })).some((t) => t.title === 'Juntar contrato'));
  assert.ok((await c.call('notes:list', chat.jid)).some((n) => /e-mail/.test(n.text)));
  const other = await c.call('clients:save', { name: 'Outro' });
  await assert.rejects(c.call('clients:linkChat', other, chat.jid), /outro cliente/);
  const got = await c.call('clients:get', id);
  assert.equal(got.chat.jid, chat.jid);
  // desliga: os casos voltam para a chave do cliente
  await c.call('clients:linkChat', id, null);
  assert.equal((await c.call('cases:get', caseId)).jid, `cliente:${id}`);
});

test('processo: etapas automáticas e à mão, partes, andamentos e pedido de documentos com lembrete', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const me = (await c.call('bootstrap')).me;
  const cid = await c.call('clients:save', { name: 'Paulo Reis' });
  const id = await c.call('cases:save', { client_id: cid, title: 'Horas extras', area: 'Trabalhista' });
  await c.call('cases:save', { id, responsible_id: me.id, tribunal: 'TRT23', claim_value: '45.000,50' });

  let f = await c.call('cases:full', id);
  assert.equal(f.case.responsible_name, me.name);
  assert.equal(f.case.claim_value, 45000.5, 'valor em formato brasileiro');
  assert.equal(f.flow.steps.find((s) => s.key === 'triagem').status, 'done', 'triagem automática (tem cliente)');
  assert.equal(f.flow.next, 'Atendimento');
  assert.ok(f.suggested.items.some((i) => /CTPS|Carteira de trabalho/.test(i)), 'lista sugerida pela área');

  await c.call('cases:setStep', id, 'atendimento', 'done');
  await c.call('cases:save', { id, process_number: '0000001-02.2026.5.23.0001' });
  f = await c.call('cases:full', id);
  assert.equal(f.flow.steps.find((s) => s.key === 'atendimento').by, me.name);
  assert.equal(f.flow.steps.find((s) => s.key === 'peticao').status, 'done', 'nº do processo conclui o protocolo');
  assert.equal(f.flow.next, 'Proposta de honorários');

  await c.call('parties:save', { case_id: id, role: 'reu', name: 'Transportes Ltda', doc: '00.000.000/0001-00' });
  await c.call('moves:add', { case_id: id, text: 'Audiência designada para 10/11', ts: Date.now() });
  f = await c.call('cases:full', id);
  assert.equal(f.parties[0].name, 'Transportes Ltda');
  assert.equal(f.moves[0].user_name, me.name);

  // pedido de documentos (cliente sem WhatsApp: sem envio, só marca e agenda o lembrete)
  await c.call('checklist:add', id, f.suggested.items.slice(0, 4));
  f = await c.call('cases:full', id);
  const ids = f.checklist.map((i) => i.id);
  const text = await c.call('checklist:requestText', id, ids);
  assert.match(text, /^Olá, Paulo!/);
  assert.match(text, /• CPF/);
  await assert.rejects(c.call('checklist:request', id, ids, { text, send: true }), /WhatsApp/);
  const { taskId } = await c.call('checklist:request', id, ids, { send: false });
  const task = (await c.call('tasks:list', { caseId: id })).find((t) => t.id === taskId);
  assert.match(task.title, /Conferir documentos pedidos — Paulo Reis/);
  assert.ok(task.due_at > Date.now() + 864e5, 'lembrete em dias úteis');
  f = await c.call('cases:full', id);
  assert.ok(f.checklist.every((i) => i.status === 'solicitado'));
  await c.call('checklist:set', ids, 'recebido');
  f = await c.call('cases:full', id);
  assert.equal(f.flow.steps.find((s) => s.key === 'documentos').status, 'done', 'tudo recebido conclui a etapa');
  const withFlow = (await c.call('cases:list', { withFlow: true, responsible: 'me' })).find((k) => k.id === id);
  assert.equal(withFlow.next_step, 'Proposta de honorários');
});

test('intimações: OAB cadastrada, busca no DJEN, liga ao processo, vira prazo; processo novo é cadastrado com DataJud', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  await c.call('oabs:save', { name: 'Rafael Augusto de Barros Correa', number: '14.271', uf: 'mt' });
  await assert.rejects(c.call('oabs:save', { name: 'Outro', number: '14271', uf: 'MT' }), /já está cadastrada/);
  const cid = await c.call('clients:save', { name: 'Teste DJEN' });
  const caseId = await c.call('cases:save', { client_id: cid, title: 'Indenização' });
  await c.call('cases:save', { id: caseId, process_number: '0001111-22.2026.8.11.0041' });

  const r = await c.call('intimations:check', { days: 5 });
  assert.ok(r.new >= 2, 'intimações novas do DJEN');
  const list = await c.call('intimations:list', { status: 'nova' });
  const mine = list.find((i) => i.case_id === caseId);
  assert.ok(mine, 'intimação ligada ao processo pelo número');
  assert.ok((await c.call('intimations:check', { days: 5 })).new === 0, 'não duplica na 2ª busca');
  const full = await c.call('cases:full', caseId);
  assert.ok(full.moves.some((m) => m.source === 'djen'), 'entra nos andamentos do processo');

  const calc = await c.call('intimations:calc', mine.id, 15);
  assert.ok(calc.due > calc.published);
  const taskId = await c.call('intimations:deadline', mine.id, { due_at: calc.due });
  const t = (await c.call('tasks:list', { caseId })).find((x) => x.id === taskId);
  assert.equal(t.kind, 'prazo');
  assert.equal((await c.call('intimations:list', {})).find((i) => i.id === mine.id).status, 'prazo');

  // processo que só existe nas intimações → cadastrar
  const unknown = await c.call('courts:unknown');
  const p = unknown.find((u) => u.process_number === '1002345-67.2026.8.11.0041');
  assert.ok(p, 'processo novo aparece para cadastrar');
  const newCase = await c.call('courts:import', p.process_digits, { client_name: 'Elisa Martins', client_role: 'autor', title: 'Atraso de voo' });
  await wait(200);
  const nf = await c.call('cases:full', newCase);
  assert.equal(nf.case.tribunal, 'TJMT');
  assert.equal(nf.case.client_name, 'Elisa Martins');
  assert.ok(nf.parties.some((x) => x.name === 'Companhia Aérea Exemplo S.a.' || /Companhia Aérea/.test(x.name)));
  assert.ok(nf.parties.some((x) => /Companhia Aérea/.test(x.name)), 'parte contrária vem da intimação');
  assert.ok(nf.moves.some((m) => m.source === 'datajud'), 'andamentos do DataJud');
  assert.ok(!(await c.call('courts:unknown')).some((u) => u.process_number === p.process_number));
});

test('avisos de andamento novo: vão para o responsável, abrem o processo e respeitam "não avisar"', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const me = (await c.call('bootstrap')).me;
  const cid = await c.call('clients:save', { name: 'Aviso Teste' });
  const id = await c.call('cases:save', { client_id: cid, title: 'Cobrança' });
  await c.call('cases:save', { id, process_number: '0002222-33.2026.8.11.0041', responsible_id: me.id });
  await c.call('cases:datajud', id); // 1ª consulta: traz o histórico, sem aviso
  const got = [];
  const listen = (ch, data, to) => { if (ch === 'notify' && data.kind === 'moves') got.push({ data, to }); };
  srv.core.events.on('event', listen);
  try {
    // simula andamento novo desde a última consulta
    db.run("DELETE FROM case_moves WHERE case_id = ? AND source = 'datajud' AND text LIKE 'Juntada%'", id);
    db.run('UPDATE cases SET datajud_checked_at = ? WHERE process_number IS NOT NULL', Date.now() - 7 * 3600e3);
    await srv.core.runCourts();
    const mine = got.filter((g) => g.data.action?.case === id);
    assert.equal(mine.length, 1, 'um aviso para este processo');
    assert.equal(mine[0].to.user, me.id, 'para o responsável');
    assert.match(mine[0].data.title, /Andamento novo — Aviso Teste: Cobrança/);
    assert.match(mine[0].data.body, /Juntada de Petição/);
    // "não avisar"
    await c.call('settings:set', 'notifyCourts', 'off');
    got.length = 0;
    db.run("DELETE FROM case_moves WHERE case_id = ? AND source = 'datajud' AND text LIKE 'Juntada%'", id);
    db.run('UPDATE cases SET datajud_checked_at = ? WHERE id = ?', Date.now() - 7 * 3600e3, id);
    await srv.core.runCourts();
    assert.equal(got.filter((g) => g.data.action?.case === id && g.to.user === me.id).length, 0);
    // escritório manda avisar toda a equipe: todos recebem (menos quem escolheu "não avisar")
    await c.call('settings:set', 'courtsNotifyAll', true);
    got.length = 0;
    db.run("DELETE FROM case_moves WHERE case_id = ? AND source = 'datajud' AND text LIKE 'Juntada%'", id);
    db.run('UPDATE cases SET datajud_checked_at = ? WHERE id = ?', Date.now() - 7 * 3600e3, id);
    await srv.core.runCourts();
    const users = (await c.call('users:list')).filter((u) => u.active && u.id !== me.id);
    const to = new Set(got.filter((g) => g.data.action?.case === id).map((g) => g.to.user));
    assert.ok(users.length && users.every((u) => to.has(u.id)), 'toda a equipe avisada, inclusive estagiária');
    assert.ok(!to.has(me.id), 'quem desligou continua sem aviso');
  } finally {
    srv.core.events.off('event', listen);
    await c.call('settings:set', 'notifyCourts', 'mine');
    await c.call('settings:set', 'courtsNotifyAll', false);
  }
});

test('financeiro: recebimento com forma e recibo numerado, contas a pagar, custas reembolsáveis, fluxo de caixa e inadimplência', async () => {
  const { reais } = await import('../src/main/extenso.js');
  assert.equal(reais(1234.56), 'mil duzentos e trinta e quatro reais e cinquenta e seis centavos');
  assert.equal(reais(2005), 'dois mil e cinco reais');
  assert.equal(reais(1), 'um real');
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const cid = await c.call('clients:save', { name: 'Financeiro Teste', cpf: '111.111.111-11' });
  const caseId = await c.call('cases:save', { client_id: cid, title: 'Divórcio' });
  const [p1, p2] = await c.call('finance:generate', caseId, { total: 2000, count: 2, firstDue: Date.now() - 40 * 864e5, description: 'Honorários' });
  await c.call('finance:register', p1, { paid_amount: '950,00', method: 'pix' });
  const r1 = await c.call('finance:receipt', p1);
  const r1b = await c.call('finance:receipt', p1);
  assert.equal(r1.number, r1b.number, 'o mesmo recibo mantém o número');
  assert.match(r1.html, /Financeiro Teste/);
  assert.match(r1.html, /CPF 111\.111\.111-11/);
  assert.match(r1.html, /novecentos e cinquenta reais/);
  assert.match(r1.html, /parcela 1\/2/);
  assert.match(r1.html, /paga em Pix/);
  await assert.rejects(c.call('finance:receipt', p2), /Registre o recebimento/);

  // contas fixas do escritório (3 meses) e custa do processo, reembolsável pelo cliente
  const rent = await c.call('finance:saveExpense', { kind: 'escritorio', category: 'Aluguel', description: 'Aluguel da sala', amount: '2.500,00', due_at: Date.now(), repeat: 3 });
  assert.equal(rent.length, 3);
  const [custa] = await c.call('finance:saveExpense', { kind: 'custa', case_id: caseId, category: 'Custas judiciais', description: 'Guia de custas iniciais', amount: 300, due_at: Date.now() });
  await c.call('finance:expensePaid', custa, true, 'pix');
  await c.call('finance:expensePaid', rent[0], true);
  const reimb = await c.call('finance:expenses', { status: 'reimburse' });
  assert.ok(reimb.some((e) => e.id === custa && e.client_name === 'Financeiro Teste'), 'custa paga aguardando reembolso do cliente');
  await c.call('finance:reimbursed', custa, true);

  const from = new Date(); from.setDate(1); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setMonth(to.getMonth() + 1);
  const cf = await c.call('finance:cashflow', { from: from.getTime(), to: to.getTime() });
  assert.ok(cf.entries.some((e) => e.dir === 'in' && e.amount === 950 && e.method === 'pix'));
  assert.ok(cf.entries.some((e) => e.dir === 'in' && e.type === 'reembolso' && e.amount === 300));
  assert.ok(cf.entries.some((e) => e.dir === 'out' && e.amount === 2500));
  assert.ok(cf.totalOut >= 2800);
  const months = await c.call('finance:months', 12);
  assert.equal(months.length, 12);
  assert.ok(months[11].in >= 1250);

  const def = await c.call('finance:defaulters');
  assert.ok(def.some((d) => d.client_id === cid && d.n === 1 && d.total === 1000), 'parcela vencida aparece na inadimplência');

  // permissões: estagiária não vê; advogado não exclui despesa
  await c.call('users:save', { name: 'Ana Advogada', login: 'ana', role: 'advogado', password: 'advogado1' });
  const adv = client();
  await adv.req('/auth/login', { body: { login: 'ana', password: 'advogado1' } });
  await assert.rejects(adv.call('finance:deleteExpense', custa), /permissão/);
  const est = client();
  await est.req('/auth/login', { body: { login: 'bia', password: 'estagio1' } });
  await assert.rejects(est.call('finance:expenses', {}), /permissão/);
});

test('painel do financeiro: mês atual x anterior, 12 meses, categorias, áreas, vencimentos e previsão', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const from = new Date(); from.setDate(1); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setMonth(to.getMonth() + 1);
  const y = new Date(from); y.setMonth(y.getMonth() - 11);
  const d = await c.call('finance:dashboard', { monthFrom: from.getTime(), monthTo: to.getTime(), yearFrom: y.getTime() });
  assert.equal(d.months.length, 12);
  assert.ok(d.month.in >= 1250, 'recebido no mês (honorários + reembolso)');
  assert.ok(d.byCategory.some((x) => x.label === 'Aluguel' && x.value === 2500));
  assert.ok(d.byArea.length >= 1);
  assert.equal(d.forecast.length, 3);
  assert.ok(Array.isArray(d.payables) && Array.isArray(d.receivables));
  assert.ok(d.defaulters.length >= 1);
});

test('receita avulsa: com cliente ou só o nome, entra no caixa e no painel, recibo na mesma numeração', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const cid = await c.call('clients:save', { name: 'Consulente Cadastrado', cpf: '222.222.222-22' });
  const a = await c.call('finance:saveIncome', { client_id: cid, description: 'Consulta jurídica', category: 'Consulta', amount: '350,00', method: 'pix' });
  const b = await c.call('finance:saveIncome', { payer_name: 'João Avulso', description: 'Parecer sobre contrato', category: 'Parecer', amount: 1200, method: 'dinheiro' });
  await assert.rejects(c.call('finance:saveIncome', { description: 'x', amount: 0 }), /valor/);
  const ra = await c.call('finance:incomeReceipt', a);
  const rb = await c.call('finance:incomeReceipt', b);
  assert.equal(rb.number, ra.number + 1, 'mesma sequência de recibos');
  assert.match(ra.html, /Consulente Cadastrado<\/b>, CPF 222\.222\.222-22/);
  assert.match(ra.html, /trezentos e cinquenta reais/);
  assert.match(rb.html, /João Avulso/);
  const from = new Date(); from.setDate(1); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setMonth(to.getMonth() + 1);
  const cf = await c.call('finance:cashflow', { from: from.getTime(), to: to.getTime() });
  assert.ok(cf.entries.some((e) => e.type === 'avulsa' && e.who === 'João Avulso' && e.amount === 1200));
  const y = new Date(from); y.setMonth(y.getMonth() - 11);
  const d = await c.call('finance:dashboard', { monthFrom: from.getTime(), monthTo: to.getTime(), yearFrom: y.getTime() });
  assert.ok(d.byArea.some((x) => x.label === 'Avulsa: Parecer' && x.value === 1200));
  assert.equal((await c.call('finance:incomes', { clientId: cid })).length, 1, 'aparece na ficha do cliente');
});

test('comercial: interessado, consulta na agenda, atendimento, proposta pelo WhatsApp, virar cliente com processo e parcelas', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  await connected(c);
  const chat = (await c.call('chats:list')).find((x) => !x.is_group && !x.client_id);
  const id = await c.call('leads:save', {
    name: 'Paula Interessada', jid: chat.jid, source: 'Instagram', area: 'Família', subject: 'Divórcio consensual',
    fee_kind: 'parcelado', fee_total: '6.000,00', fee_count: 6,
  });
  let l = await c.call('leads:get', id);
  assert.equal(l.stage, 'novo');
  assert.equal(l.fee_total, 6000);
  assert.equal((await c.call('leads:byJid', chat.jid)).id, id, 'conversa sabe que é um interessado');

  // consulta marcada vira compromisso e muda a etapa
  const when = Date.now() + 2 * 86400e3;
  await c.call('leads:save', { id, consult_at: when });
  l = await c.call('leads:get', id);
  assert.equal(l.stage, 'consulta');
  assert.ok(l.tasks.some((t) => t.kind === 'reuniao' && t.due_at === when && t.lead_name === 'Paula Interessada'));

  // atendimento com próximo passo = lembrete
  await c.call('leads:addContact', { lead_id: id, kind: 'ligacao', summary: 'Explicou o caso, tem dois filhos', next_step: 'Ligar para confirmar documentos', next_at: when + 3600e3 });
  l = await c.call('leads:get', id);
  assert.equal(l.contacts.length, 1);
  assert.equal(l.contacts[0].kind_label, 'Ligação');
  assert.ok(l.tasks.some((t) => t.title === 'Ligar para confirmar documentos'));

  // proposta: texto do modelo, envio pelo WhatsApp, lembrete de retomar
  const text = await c.call('leads:proposalText', id);
  assert.match(text, /Olá, Paula!/);
  assert.match(text, /R\$\s6\.000,00, em 6 parcelas mensais de R\$\s1\.000,00/);
  await c.call('leads:proposal', id, { text, send: true });
  l = await c.call('leads:get', id);
  assert.equal(l.stage, 'proposta');
  assert.ok(l.proposal_sent_at);
  assert.ok(l.tasks.some((t) => /^Retomar proposta/.test(t.title)));
  const msgs = await c.call('messages:list', chat.jid);
  assert.ok((msgs.messages || msgs).some((m) => m.from_me && /proposta de honorários/.test(m.text)), 'proposta saiu pelo WhatsApp');
  assert.match((await c.call('leads:proposalHtml', id)).html, /PROPOSTA DE HONORÁRIOS/);

  // estagiária vê o funil sem valores e não faz proposta
  const est = client();
  await est.req('/auth/login', { body: { login: 'bia', password: 'estagio1' } });
  const seen = (await est.call('leads:list', { open: true })).find((x) => x.id === id);
  assert.ok(seen);
  assert.equal(seen.fee_total, undefined);
  await assert.rejects(est.call('leads:proposalText', id), /permissão/);
  await assert.rejects(est.call('leads:delete', id), /permissão/);

  // virar cliente: cliente com o WhatsApp, processo com honorários e parcelas; lembretes vão junto
  const due = new Date(); due.setMonth(due.getMonth() + 1); due.setHours(12, 0, 0, 0);
  const r = await c.call('leads:convert', id, { firstDue: due.getTime() });
  const cl = await c.call('clients:get', r.clientId);
  assert.equal(cl.name, 'Paula Interessada');
  assert.equal(cl.jid, chat.jid);
  assert.match(cl.origin, /Instagram/);
  const k = await c.call('cases:get', r.caseId);
  assert.equal(k.title, 'Divórcio consensual');
  assert.equal(k.area, 'Família');
  assert.equal(k.fee_total, 6000);
  assert.equal(k.payments_count, 6);
  l = await c.call('leads:get', id);
  assert.equal(l.stage, 'ganho');
  assert.ok(l.tasks.some((t) => t.title === 'Ligar para confirmar documentos' && t.client_id === r.clientId), 'lembretes passaram para o cliente');
  assert.equal((await c.call('leads:contacts', { clientId: r.clientId })).length, 1, 'atendimentos aparecem na ficha do cliente');
  await assert.rejects(c.call('leads:convert', id, {}), /já virou cliente/);

  // quem não fechou: motivo e lembretes encerrados
  const lost = await c.call('leads:save', { name: 'Carlos Desistiu', phone: '65 99999-1111', source: 'Google' });
  await c.call('leads:addContact', { lead_id: lost, kind: 'presencial', summary: 'Achou caro', next_step: 'Retomar', next_at: Date.now() + 86400e3 });
  await c.call('leads:setStage', lost, 'perdido', { lostReason: 'Preço' });
  assert.equal((await c.call('leads:get', lost)).tasks.filter((t) => !t.done).length, 0);
  const st = await c.call('leads:stats', {});
  assert.equal(st.won, 1);
  assert.equal(st.lost, 1);
  assert.equal(st.conversion, 50);
  assert.ok(st.bySource.some((x) => x.label === 'Instagram'));
  assert.ok(st.lostReasons.some((x) => x.label === 'Preço'));
  await c.call('leads:delete', lost);
  assert.equal((await c.call('leads:list', {})).some((x) => x.id === lost), false);
});

test('relatórios: processos abertos/encerrados, prazos no prazo x atrasados, equipe, atendimento, financeiro; estagiária não vê', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  await connected(c);
  const me = (await c.call('bootstrap')).me;
  const range = { from: Date.now() - 30 * 86400e3, to: Date.now() + 60 * 86400e3 };
  const base = await c.call('reports:get', 'overview', range);
  const baseTeam = (await c.call('reports:get', 'team', range)).rows.find((r) => r.id === me.id);

  const cid = await c.call('clients:save', { name: 'Cliente do Relatório' });
  const k = await c.call('cases:save', { client_id: cid, title: 'Caso relatório', area: 'Tributário', responsible_id: me.id });
  await c.call('cases:setStatus', k, 'encerrado');
  // prazo cumprido com atraso (venceu ontem) e um cumprido antes de vencer
  const late = await c.call('tasks:save', { title: 'Contestação', kind: 'prazo', due_at: Date.now() - 86400e3, case_id: k, assignee_id: me.id });
  const ok = await c.call('tasks:save', { title: 'Réplica', kind: 'prazo', due_at: Date.now() + 86400e3, case_id: k, assignee_id: me.id });
  await c.call('tasks:save', { id: late, done: true });
  await c.call('tasks:save', { id: ok, done: true });
  const chat = (await c.call('chats:list')).find((x) => !x.is_group);
  await c.call('messages:sendText', chat.jid, 'Mensagem para o relatório');

  const o = await c.call('reports:get', 'overview', range);
  assert.equal(o.cases.opened, base.cases.opened + 1);
  assert.equal(o.cases.closed, base.cases.closed + 1);
  assert.equal(o.deadlines.onTime, base.deadlines.onTime + 1);
  assert.equal(o.deadlines.late, base.deadlines.late + 1);
  assert.equal(o.clients.created, base.clients.created + 1);
  assert.equal(o.cases.months.length, 12);

  const t = (await c.call('reports:get', 'team', range)).rows.find((r) => r.id === me.id);
  assert.equal(t.tasksDone, baseTeam.tasksDone + 2);
  assert.equal(t.deadlinesLate, baseTeam.deadlinesLate + 1);
  assert.equal(t.messages, baseTeam.messages + 1, 'mensagem assinada conta para quem enviou');

  const w = await c.call('reports:get', 'whatsapp', range);
  assert.ok(w.received > 0 && w.sent > 0);
  assert.equal(w.hours.length, 24);
  const f = await c.call('reports:get', 'finance', range);
  assert.ok('received' in f && Array.isArray(f.topClients) && f.months.length >= 3);
  const cm = await c.call('reports:get', 'commercial', range);
  assert.ok(cm.won >= 1);
  await assert.rejects(c.call('reports:get', 'overview', { from: 10, to: 5 }), /Período/);

  const est = client();
  await est.req('/auth/login', { body: { login: 'bia', password: 'estagio1' } });
  await assert.rejects(est.call('reports:get', 'overview', range), /permissão/);
});

/** Certificado de teste e um "token" que assina como o Windows (CMS destacado). */
function testCert() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 365 * 864e5);
  cert.setSubject([{ name: 'commonName', value: 'RAFAEL TESTE:12345678900' }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC Teste' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const signCms = (data) => {
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(data.toString('binary'));
    p7.addCertificate(cert);
    p7.addSigner({ key: keys.privateKey, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest }, { type: forge.pki.oids.signingTime, value: new Date() }] });
    p7.sign({ detached: true });
    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
  };
  return { signCms };
}

test('recibo em PDF: imagem da assinatura, certificado A3 assinado no app de desktop e envio pelo WhatsApp', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  await connected(c);
  const chat = (await c.call('chats:list')).find((x) => !x.is_group && !x.client_id);
  const cid = await c.call('clients:save', { name: 'Cliente do Recibo', cpf: '999.888.777-66' });
  await c.call('clients:linkChat', cid, chat.jid);
  const k = await c.call('cases:save', { client_id: cid, title: 'Inventário' });
  const [p] = await c.call('finance:generate', k, { total: 1500, count: 1, firstDue: Date.now(), description: 'Honorários' });
  await c.call('finance:register', p, { method: 'pix' });
  const pdfOf = (r) => Buffer.from(r.pdf, 'base64');

  // sem nada configurado: PDF simples
  let r = await c.call('finance:receiptPdf', p, {});
  assert.equal(pdfOf(r).subarray(0, 5).toString(), '%PDF-');
  assert.equal(r.signed, false);
  assert.equal(r.canSend, true);
  assert.match(r.name, /^Recibo \d{4} - Cliente do Recibo\.pdf$/);

  // imagem da assinatura
  const up = await c.req('/upload', { raw: fs.readFileSync('assets/icon.png'), headers: { 'X-File-Name': 'assinatura.png' } });
  let st = await c.call('receipts:setImage', up.json.token);
  assert.match(st.image, /^data:image\/png;base64,/);
  await c.call('settings:set', 'receiptSigner', 'Rafael Barros');
  assert.match((await c.call('finance:receipt', p)).html, /data:image\/png;base64/, 'imagem também no recibo da tela');

  const { signCms } = testCert();
  assert.ok(!(await c.call('settings:get')).receiptSignMode, 'sem assinatura digital por padrão');
  // A3: o servidor devolve o que assinar; o "token" assina; o servidor monta o PDF
  await c.call('settings:set', 'receiptSignMode', 'a3');
  const ph = await c.call('finance:receiptPdf', p, { a3: { name: 'RAFAEL TESTE:12345678900', issuer: 'AC Teste' } });
  assert.ok(ph.pending && ph.data);
  await assert.rejects(c.call('finance:receiptSign', ph.pending, Buffer.from('lixo').toString('base64')), /inválida/);
  const ph2 = await c.call('finance:receiptPdf', p, { a3: { name: 'RAFAEL TESTE', issuer: 'AC Teste' } });
  r = await c.call('finance:receiptSign', ph2.pending, signCms(Buffer.from(ph2.data, 'base64')).toString('base64'));
  assert.equal(r.signed, true);
  assert.match(pdfOf(r).toString('latin1'), /\/ByteRange \[0 \d+ \d+ \d+\]/);
  await assert.rejects(c.call('finance:receiptSign', ph2.pending, 'x'), /demorou demais/, 'cada assinatura vale uma vez');

  // envio pelo WhatsApp
  await c.call('finance:sendReceipt', r.token, 'Segue o seu recibo.');
  const msgs = await c.call('messages:list', chat.jid);
  assert.ok((msgs.messages || msgs).some((m) => m.from_me && m.type === 'document' && /Recibo \d{4}/.test(m.media_name || '')), 'PDF saiu como documento');

  // estagiária não mexe em recibos
  const est = client();
  await est.req('/auth/login', { body: { login: 'bia', password: 'estagio1' } });
  await assert.rejects(est.call('receipts:status'), /permissão/);
  await assert.rejects(est.call('finance:receiptPdf', p, {}), /permissão/);
  await c.call('receipts:clearImage');
  await c.call('settings:set', 'receiptSignMode', 'none');
});

test('avisos no celular e depois da audiência: inscrição do aparelho, escolha do que receber, aviso da audiência que terminou e lista no Hoje', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const me = (await c.call('bootstrap')).me;
  const info = await c.call('push:info');
  assert.match(info.key, /^[A-Za-z0-9_-]{80,}$/, 'chave pública VAPID');
  assert.equal(info.prefs.mensagens, false, 'mensagens do WhatsApp não vão ao celular por padrão');
  const sub = { endpoint: 'https://push.exemplo.com/aparelho-1', keys: { p256dh: 'BOr' + 'x'.repeat(84), auth: 'abcdefghijklmnopqrstuv' } };
  let devs = await c.call('push:subscribe', sub, 'Celular de teste');
  assert.equal(devs.length, 1);
  await c.call('push:subscribe', sub, 'Celular de teste');
  assert.equal((await c.call('push:info')).devices.length, 1, 'mesmo aparelho não duplica');
  await assert.rejects(c.call('push:subscribe', { endpoint: 'x' }), /inválida/);
  assert.equal(await c.call('push:test'), 1);

  // audiência que terminou há 1 h: aviso para o responsável (celular) e lista no Hoje
  const cid = await c.call('clients:save', { name: 'Cliente da Audiência' });
  const k = await c.call('cases:save', { client_id: cid, title: 'Ação de cobrança' });
  const start = Date.now() - 3 * 3600e3;
  const t = await c.call('tasks:save', { title: 'Audiência de conciliação', kind: 'audiencia', due_at: start, end_at: start + 2 * 3600e3, case_id: k, assignee_id: me.id });
  await srv.core.runChecks();
  const out = await c.call('push:outbox');
  const hearing = out.find((x) => /Audiência terminou — Cliente da Audiência/.test(x.title));
  assert.ok(hearing, 'aviso da audiência foi para o celular');
  assert.deepEqual(hearing.action, { case: k, tab: 'prazos' });
  await srv.core.runChecks();
  assert.equal((await c.call('push:outbox')).filter((x) => /Cliente da Audiência/.test(x.title)).length, 1, 'avisa uma vez só');
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const range = { dayStart: day.getTime(), dayEnd: day.getTime() + 86400e3, weekStart: day.getTime(), weekEnd: day.getTime() + 7 * 86400e3 };
  let sum = await c.call('today:summary', { ...range, scope: 'mine' });
  assert.ok(sum.hearings.some((h) => h.id === t), 'Hoje: audiência para agendar prazos');
  await c.call('hearings:followUp', t, true);
  sum = await c.call('today:summary', { ...range, scope: 'mine' });
  assert.ok(!sum.hearings.some((h) => h.id === t));

  // desligar um tipo de aviso no celular
  await c.call('settings:set', 'pushKinds', { ...info.prefs, agenda: false });
  const before = (await c.call('push:outbox')).length;
  await c.call('tasks:save', { title: 'Lembrete sem celular', due_at: Date.now() - 1000 });
  await srv.core.runChecks();
  assert.equal((await c.call('push:outbox')).length, before, 'lembrete não foi ao celular (agenda desligada)');
  await c.call('settings:set', 'pushKinds', null);
  devs = await c.call('push:unsubscribe', sub.endpoint);
  assert.equal(devs.length, 0);
});

test('buscar meus processos: varre o DJEN mês a mês pela OAB, publicações antigas não vão para "conferir"', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  let st = await c.call('intimations:status');
  if (!st.oabs.some((o) => o.active)) await c.call('oabs:save', { name: 'Rafael Augusto de Barros Correa', number: '14.271', uf: 'MT' });
  const novasAntes = (await c.call('intimations:list', { status: 'nova' })).length;
  const sub = { endpoint: 'https://push.exemplo.com/aparelho-hist', keys: { p256dh: 'BOr' + 'y'.repeat(84), auth: 'abcdefghijklmnopqrstuv' } };
  await c.call('push:subscribe', sub, 'Celular');
  const h = await c.call('courts:history', { months: 3 });
  assert.equal(h.running, true);
  assert.equal(h.total, 3 * (await c.call('intimations:status')).oabs.filter((o) => o.active).length);
  for (let i = 0; i < 100 && (st = await c.call('intimations:status')).history.running; i++) await wait(50);
  assert.equal(st.history.running, false);
  assert.equal(st.history.done, st.history.total, 'todos os meses buscados');
  assert.ok(st.history.processes >= 1, 'achou processos nas publicações');
  assert.deepEqual(st.history.errors, []);
  assert.ok((await c.call('intimations:list', { status: 'nova' })).length >= novasAntes);
  const out = await c.call('push:outbox');
  assert.ok(out.some((x) => x.title === 'Busca dos seus processos concluída'), 'avisa quando termina');
  await c.call('push:unsubscribe', sub.endpoint);
});

test('cadastro do cliente: CEP e CNPJ pelo servidor, endereço montado, {qualificacao} e aviso de repetido', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const saved = srv.core.lookup.fetch;
  srv.core.lookup.fetch = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('viacep')
    ? { cep: '78043-306', logradouro: 'Rua Presidente Marques', complemento: '', bairro: 'Quilombo', localidade: 'Cuiabá', uf: 'MT' }
    : {}) });
  try {
    const cep = await c.call('clients:lookupCep', '78043-306');
    assert.equal(cep.street, 'Rua Presidente Marques');
    const id = await c.call('clients:save', { name: 'Joana Teste Qualificação', kind: 'pf', gender: 'f', marital: 'divorciado', profession: 'Contadora', cpf: '987.654.321-00', ...cep, number: '77' });
    const cl = await c.call('clients:get', id);
    assert.equal(cl.address, 'Rua Presidente Marques, nº 77, Bairro Quilombo, Cuiabá/MT, CEP 78043-306', 'endereço em uma linha acompanha os campos');
    const vals = await c.call('docs:values', { clientId: id });
    assert.match(vals.qualificacao, /^JOANA TESTE QUALIFICAÇÃO, brasileira, divorciada, contadora, inscrita no CPF sob o nº 987\.654\.321-00, residente e domiciliada na Rua Presidente Marques/);
    assert.equal(vals.bairro, 'Quilombo');
    const sim = await c.call('clients:similar', { name: 'JOANA TESTE QUALIFICACAO' });
    assert.ok(sim.some((x) => x.id === id), 'acha pelo nome sem acento');
    assert.ok((await c.call('clients:similar', { cpf: '98765432100', excludeId: id })).every((x) => x.id !== id));
    const pj = await c.call('clients:save', { name: 'Empresa Teste Ltda', kind: 'pj', cpf: '12.345.678/0001-90', rep: { name: 'Fulano Sócio', role: 'sócio-administrador', gender: 'm', same_address: true } });
    const pjv = await c.call('docs:values', { clientId: pj });
    assert.match(pjv.qualificacao, /^EMPRESA TESTE LTDA, pessoa jurídica de direito privado, inscrita no CNPJ sob o nº 12\.345\.678\/0001-90, neste ato representada por seu sócio-administrador, FULANO SÓCIO, brasileiro/);
    assert.equal(pjv.representante, 'Fulano Sócio');
  } finally { srv.core.lookup.fetch = saved; }
});

/** .xlsx mínimo (texto em linha), no formato da exportação do LinkLei. */
async function makeXlsx(rows) {
  const { writeZip } = await import('../src/main/zip.js');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const col = (i) => String.fromCharCode(65 + i);
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('');
  return writeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Processos" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
  });
}

test('importar processos do LinkLei: prévia, cadastro sem cliente, DataJud organiza (área, arquivados), partes do DJEN e escolha do cliente', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const TJ = 'Tribunal de Justiça do Mato Grosso - TJMT';
  const xlsx = await makeXlsx([
    ['Processo', 'Situação', 'Atualizado em', 'Nº do processo', 'Casos vinculados', 'Tribunal', 'Últimos eventos da agenda', 'Última interação e atividade', 'Últimas movimentações'],
    [TJ, 'Ativo', '07/10/2026', '1001556-08.2023.8.11.0042', '', TJ, '', '', 'Arquivado Provisoriamente'],
    [TJ, 'Ativo', '07/10/2026', '8020964-28.2019.8.11.0001', '', TJ, '', '', ''],
    [TJ, 'Ativo', '07/10/2026', '1007883-32.2024.8.11.0044', '', TJ, '', '', ''],
    ['Tribunal Regional do Trabalho da Vigésima Terceira Região - TRT23', 'Ativo', '07/10/2026', '0001095-63.2026.5.23.0107', '', 'TRT da 23ª Região - TRT23', '', '', ''],
    [TJ, 'Falhado', '07/10/2026', '1000001-11.2025.8.11.0009', '', TJ, '', '', ''],
    ['ELSON FERREIRA BARROS x CLEBERSON DA ROCHA', 'Ativo', '07/10/2026', '1012345-10.2022.8.11.0003', '', TJ, '', '', ''],
    [TJ, 'Ativo', '07/10/2026', '1001556-08.2023.8.11.0042', '', TJ, '', '', ''],
    ['Sem número', 'Ativo', '07/10/2026', '123', '', TJ, '', '', ''],
  ]);
  const up = await c.req('/upload', { raw: xlsx, headers: { 'X-File-Name': 'relatorio-processos.xlsx' } });
  const pre = await c.call('cases:importPreview', up.json.token);
  assert.equal(pre.map.number, 3, 'acha a coluna do nº pelo conteúdo');
  assert.equal(pre.newCount, 6);
  assert.equal(pre.duplicates, 1, 'nº repetido entra uma vez');
  assert.equal(pre.problems.length, 1);
  assert.equal(pre.byTribunal.TRT23, 1);
  assert.deepEqual(pre.sample.find((x) => x.digits.endsWith('0003')).parties.map((p) => p.name), ['Elson Ferreira Barros', 'Cleberson da Rocha']);

  let st = await c.call('cases:importRun', up.json.token, {});
  assert.equal(st.created, 6);
  for (let i = 0; i < 200 && (st = await c.call('cases:importStatus')).running; i++) await wait(50);
  assert.equal(st.done, 6);
  const again = await c.call('cases:importPreview', up.json.token);
  assert.equal(again.newCount, 0, 'importar de novo não duplica');

  const list = await c.call('cases:withoutClient');
  assert.equal(list.length, 6, 'entram como "cliente a identificar"');
  const by = (end) => list.find((k) => k.process_number.replace(/\D/g, '').endsWith(end));
  const prov = by('0042');
  assert.equal(prov.archive_state, 'provisorio', 'arquivado provisoriamente: vigiar');
  assert.ok(prov.prescription_at > prov.archive_since, 'com data para conferir a prescrição');
  assert.equal(prov.status, 'aberto', 'provisório não vai para o arquivo morto');
  assert.equal(prov.area, 'Família e Sucessões', 'área pela classe do DataJud');
  const def = by('0001');
  assert.equal(def.archive_state, 'definitivo', 'baixa definitiva só fica sugerida');
  assert.equal(def.status, 'aberto');
  const trt = by('0107');
  assert.equal(trt.area, 'Trabalhista');
  assert.equal(trt.title, 'Ação Trabalhista - Rito Ordinário', 'título genérico vira a classe');
  assert.ok(trt.parties_found.some((p) => p.suggested && p.polo === 'ativo'), 'sugere o cliente pela OAB do escritório');
  assert.equal(by('0009').parties_found.length, 0, 'sem publicação no DJEN: escolhe à mão');
  assert.ok(by('0003').parties_found.length >= 2);

  // escolher o cliente: cria pelo nome e a outra parte vira parte contrária
  const sug = trt.parties_found.find((p) => p.suggested);
  const other = trt.parties_found.find((p) => !p.suggested);
  const r = await c.call('cases:assignClient', trt.id, { name: sug.name, role: sug.polo, opposing: [other] });
  const full = await c.call('cases:full', trt.id);
  assert.equal(full.case.client_id, r.clientId);
  assert.equal(full.case.client_role, 'autor');
  assert.ok(full.parties.some((p) => p.name === other.name), 'parte contrária gravada');
  assert.equal((await c.call('cases:withoutClient')).length, 5);
  // o mesmo nome em outro processo usa o cliente já cadastrado
  const r2 = await c.call('cases:assignClient', by('0044').id, { name: sug.name.toUpperCase() });
  assert.equal(r2.clientId, r.clientId, 'não duplica o cliente');

  // baixa definitiva: encerrar só com confirmação
  await c.call('cases:archive', def.id, { action: 'close' });
  assert.equal((await c.call('cases:full', def.id)).case.status, 'encerrado');
  // prescrição perto: aviso para o responsável
  const notes = [];
  const listen = (ch, data) => { if (ch === 'notify') notes.push(data); };
  srv.core.events.on('event', listen);
  await c.call('cases:archive', prov.id, { prescription_at: Date.now() + 10 * 864e5 });
  await srv.core.runChecks();
  srv.core.events.off('event', listen);
  assert.ok(notes.some((n) => n.kind === 'prescription' && /faltam 10 dia/.test(n.title)), 'avisa a prescrição');
});

test('tribunais por advogado: cada um cadastra a própria OAB; processo da intimação fica com o dono da OAB', async () => {
  const s = client();
  await s.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const advId = await s.call('users:save', { name: 'Ivan Advogado', login: 'ivan', role: 'advogado', password: 'ivanadv1' });
  const a = client();
  await a.req('/auth/login', { body: { login: 'ivan', password: 'ivanadv1' } });
  const oabId = await a.call('oabs:save', { name: 'Ivan Advogado', number: '22.333', uf: 'MT', user_id: 999 });
  let oab = (await a.call('oabs:list')).find((o) => o.id === oabId);
  assert.equal(oab.user_id, advId, 'advogado cadastra a OAB em nome dele');
  const other = (await a.call('oabs:list')).find((o) => o.user_id && o.user_id !== advId);
  if (other) await assert.rejects(a.call('oabs:save', { ...other, name: 'Outro nome' }), /Só o sócio/);
  // intimação recebida pela OAB do Ivan, de processo não cadastrado: quem cadastra é o sócio, o responsável é o Ivan
  db.addIntimation({ ext_id: 'teste-oab-1', date: Date.now(), tribunal: 'TJMT', kind: 'Intimação', orgao: '1ª Vara', classe: 'PROCEDIMENTO COMUM CÍVEL',
    process_number: '1009999-11.2026.8.11.0041', text: 'Intime-se.', link: '', parties: [{ name: 'CLIENTE DO IVAN', polo: 'A' }], lawyers: [] }, oabId);
  const caseId = await s.call('courts:import', '10099991120268110041', { client_name: 'Cliente do Ivan' });
  const k = (await s.call('cases:full', caseId)).case;
  assert.equal(k.responsible_id, advId, 'responsável é o dono da OAB, não quem clicou');
  oab = (await s.call('oabs:list')).find((o) => o.id === oabId);
  await s.call('oabs:save', { ...oab, user_id: null });
  assert.equal((await s.call('oabs:list')).find((o) => o.id === oabId).user_id, null, 'sócio troca o dono');
});

test('dia a dia: intimação com audiência vira sugestão para a agenda; sentença vira "avisar o cliente"; processos parados no Hoje', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const cid = await c.call('clients:save', { name: 'Cliente Aviso Teste' });
  const caseId = await c.call('cases:save', { client_id: cid, title: 'Indenização' });
  await c.call('cases:save', { id: caseId, process_number: '1004444-22.2026.8.11.0041' });
  let oab = (await c.call('oabs:list')).find((o) => o.active);
  if (!oab) await c.call('oabs:save', { name: 'Rafael Barros', number: '14271', uf: 'MT' });
  const saved = srv.core.courts.fetch;
  const day = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  srv.core.courts.fetch = async (url) => {
    const u = new URL(url);
    const items = u.searchParams.get('pagina') === '1' ? [
      { id: 'aud-1', data_disponibilizacao: day, siglaTribunal: 'TJMT', tipoComunicacao: 'Intimação', tipoDocumento: 'Despacho', nomeOrgao: '5ª Vara',
        numeroprocessocommascara: '1004444-22.2026.8.11.0041', texto: 'Designo audiência de conciliação para 20/11/2099, às 14:30, por videoconferência.', destinatarios: [], destinatarioadvogados: [] },
      { id: 'sent-1', data_disponibilizacao: day, siglaTribunal: 'TJMT', tipoComunicacao: 'Intimação', tipoDocumento: 'Sentença', nomeOrgao: '5ª Vara',
        numeroprocessocommascara: '1004444-22.2026.8.11.0041', texto: 'Ante o exposto, JULGO PROCEDENTE o pedido inicial.', destinatarios: [], destinatarioadvogados: [] },
    ] : [];
    return new Response(JSON.stringify({ count: items.length, items }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try { await c.call('intimations:check', { days: 3 }); } finally { srv.core.courts.fetch = saved; }
  const full = await c.call('cases:full', caseId);
  const hear = full.hints.find((x) => x.kind === 'hearing');
  assert.ok(hear, 'audiência detectada');
  assert.equal(new Date(hear.ts).getFullYear(), 2099);
  assert.equal(new Date(hear.ts).getHours(), 14);
  assert.equal(hear.title, 'Audiência de conciliação');
  const sent = full.hints.find((x) => x.kind === 'client' && /procedente/i.test(x.text));
  assert.ok(sent, 'sentença sugere avisar o cliente');
  const today = await c.call('today:summary', { dayStart: Date.now() - 864e5, dayEnd: Date.now() + 864e5, weekStart: Date.now() - 864e5, weekEnd: Date.now() + 7 * 864e5, scope: 'all' });
  assert.ok(today.hints.some((x) => x.id === hear.id), 'sugestões aparecem no Hoje');
  assert.ok(Array.isArray(today.idleCases));
  // pôr na agenda
  const taskId = await c.call('hints:hearing', hear.id, {});
  const t = (await c.call('tasks:list', { caseId })).find((x) => x.id === taskId);
  assert.equal(t.kind, 'audiencia');
  // avisar o cliente: texto explicado, sem WhatsApp → copiar e marcar
  const msg = await c.call('hints:clientText', sent.id);
  assert.match(msg.text, /^Olá, Cliente! .*saiu a sentença/s);
  assert.equal(msg.jid, null);
  await assert.rejects(c.call('hints:sendClient', sent.id, msg.text, { via: 'whatsapp' }), /não tem WhatsApp/);
  await c.call('hints:sendClient', sent.id, msg.text, { via: 'copy' });
  assert.equal((await c.call('cases:full', caseId)).hints.length, 0, 'sugestões resolvidas saem da ficha');
});

test('cadastro: sugere a conversa do WhatsApp, salva o contato (opção), pasta vai e volta do arquivo morto', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const linked = new Set((await c.call('clients:list', { status: 'todos' })).map((x) => x.jid).filter(Boolean));
  const chat = (await c.call('chats:list')).find((x) => !x.is_group && !linked.has(x.jid) && x.jid.endsWith('@s.whatsapp.net') && /\s/.test(x.display_name));
  const id = await c.call('clients:save', { name: `${chat.display_name} Teste`, phone: '' });
  const sug = await c.call('clients:suggestChats', id);
  assert.ok(sug.some((x) => x.jid === chat.jid && x.by === 'nome'), 'acha a conversa pelo nome');
  await c.call('settings:set', 'waSaveContacts', true);
  await c.call('clients:linkChat', id, chat.jid);
  for (let i = 0; i < 20 && !(srv.core.wa.savedContacts || []).some((x) => x.jid === chat.jid); i++) await wait(20);
  assert.ok(srv.core.wa.savedContacts.some((x) => x.jid === chat.jid && x.name === `${chat.display_name} Teste`), 'contato salvo no WhatsApp com o nome do cadastro');
  await c.call('settings:set', 'waSaveContacts', false);

  // pasta: cliente sem outro processo aberto → a pasta inteira vai para o arquivo morto
  const cid = await c.call('clients:save', { name: 'Arquivo Morto Teste' });
  const folder = await c.call('docs:createClientFolder', cid);
  const k = await c.call('cases:save', { client_id: cid, title: 'Cobrança' });
  const kf = await c.call('docs:createCaseFolder', k);
  assert.ok(kf.startsWith(`${folder}/`));
  await c.call('cases:archive', k, { action: 'close' });
  const plan = await c.call('docs:archivePlan', k);
  assert.equal(plan.mode, 'client');
  const to = await c.call('docs:archiveFolder', k);
  assert.equal(to, '03 ARQUIVO MORTO/ARQUIVO MORTO TESTE');
  assert.equal((await c.call('clients:get', cid)).folder, to);
  assert.ok((await c.call('cases:full', k)).case.folder.startsWith(`${to}/`), 'caminho do processo acompanha');
  // reabriu: volta
  await c.call('cases:setStatus', k, 'aberto');
  const back = await c.call('docs:archiveFolder', k, { back: true });
  assert.equal(back, folder);
  assert.ok((await c.call('docs:list', back)).exists !== false);
});

test('INSS administrativo: situação gera prazos e aviso ao cliente, conferência no Meu INSS no Hoje, importação de protocolos', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const cid = await c.call('clients:save', { name: 'Segurada Teste' });
  const k = await c.call('cases:save', { client_id: cid, title: 'Aposentadoria', kind: 'inss', inss_benefit: 'Aposentadoria por idade', process_number: '123456789' });
  let full = await c.call('cases:full', k);
  assert.equal(full.case.inss_status, 'analise');
  assert.equal(full.case.tribunal, 'INSS (administrativo)');
  await c.call('cases:save', { id: k, inss_status: 'exigencia' });
  let tasks = await c.call('tasks:list', { caseId: k });
  assert.ok(tasks.some((t) => t.kind === 'prazo' && /exigência/i.test(t.title) && Math.round((t.due_at - Date.now()) / 864e5) === 30), 'exigência: prazo de 30 dias');
  await c.call('cases:save', { id: k, inss_status: 'concedido' });
  full = await c.call('cases:full', k);
  const hint = full.hints.find((x) => x.kind === 'client');
  assert.ok(hint, 'concedido: sugere avisar o cliente');
  assert.match((await c.call('hints:clientText', hint.id)).text, /concedeu o benefício/);
  // conferência vencida aparece no Hoje
  db.run('UPDATE cases SET inss_checked_at = ? WHERE id = ?', Date.now() - 20 * 864e5, k);
  const range = { dayStart: Date.now() - 864e5, dayEnd: Date.now() + 864e5, weekStart: Date.now() - 864e5, weekEnd: Date.now() + 7 * 864e5, scope: 'all' };
  assert.ok((await c.call('today:summary', range)).inss.some((x) => x.id === k));
  await c.call('cases:inssChecked', k);
  assert.ok(!(await c.call('today:summary', range)).inss.some((x) => x.id === k), 'conferido sai da lista');
  // planilha de protocolos
  const csv = Buffer.from('Segurado;Protocolo;Benefício\nMaria Teste;987654321;BPC/LOAS\nJoão Teste;87654;Pensão por morte\n;12;x\n');
  const up = await c.req('/upload', { raw: csv, headers: { 'X-File-Name': 'protocolos.csv' } });
  const pre = await c.call('cases:importPreview', up.json.token, null, { mode: 'inss' });
  assert.equal(pre.newCount, 2);
  assert.equal(pre.problems.length, 1);
  const st = await c.call('cases:importRun', up.json.token, { mode: 'inss' });
  assert.equal(st.created, 2);
  const imp = (await c.call('cases:list', {})).filter((x) => x.import_batch === st.batch);
  assert.ok(imp.every((x) => x.kind === 'inss' && x.inss_status === 'analise' && x.client_id), 'protocolos com o segurado como cliente');
  assert.ok(imp.some((x) => x.inss_benefit === 'BPC/LOAS'));
});

test('documentos: anexo do WhatsApp vai para a pasta do cliente/processo, recentes, ver sem baixar', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  const chats = (await c.call('chats:list')).filter((x) => !x.is_group && x.jid.endsWith('@s.whatsapp.net'));
  const linked = new Set((await c.call('clients:list', { status: 'todos' })).map((x) => x.jid).filter(Boolean));
  const free = chats.find((x) => !linked.has(x.jid));
  if (free) assert.equal((await c.call('docs:messageTargets', free.jid)).client, null, 'sem cliente: nada a oferecer');
  const chat = free || chats[0];
  const up = await c.req('/upload', { raw: Buffer.from('RG frente e verso'), headers: { 'X-File-Name': encodeURIComponent('rg.txt') } });
  const [mid] = await c.call('messages:sendFiles', chat.jid, [up.json.token]);
  await wait(150);
  const cid = (await c.call('clients:list', { status: 'todos' })).find((x) => x.jid === chat.jid)?.id || await c.call('clients:fromChat', chat.jid);
  const folder = await c.call('docs:createClientFolder', cid);
  const k = await c.call('cases:save', { client_id: cid, title: 'Aposentadoria' });
  await c.call('docs:createCaseFolder', k);
  const t = await c.call('docs:messageTargets', chat.jid);
  assert.deepEqual(t.targets.slice(0, 2).map((x) => x.rel), [folder, `${folder}/_CADASTRO`]);
  const caseTarget = t.targets.find((x) => x.caseId === k);
  assert.ok(caseTarget, 'pasta do processo aberto');
  const r = await c.call('docs:saveMessage', chat.jid, mid, `${folder}/_CADASTRO`, 'RG');
  assert.ok(r.rel.startsWith(`${folder}/_CADASTRO/`));
  assert.match(r.rel.split('/').pop(), /^\d{4}-\d{2}-\d{2} - RG\.txt$/, 'data no começo e extensão mantida');
  const listed = await c.call('docs:list', `${folder}/_CADASTRO`);
  assert.ok(listed.entries.some((e) => e.rel === r.rel));
  const rec = await c.call('docs:recent');
  assert.equal(rec[0].rel, r.rel);
  assert.equal(rec[0].action, 'save');
  // ver dentro do sistema: texto e Word
  const pv = await c.call('docs:preview', r.rel);
  assert.equal(pv.kind, 'text');
  assert.equal(pv.text, 'RG frente e verso');
  const inl = await c.req(`${pv.url}?inline=1`);
  assert.equal(inl.status, 200);
  assert.equal(inl.headers.get('x-frame-options'), 'SAMEORIGIN', 'pode aparecer dentro do sistema');
  assert.equal((await c.req(`${pv.url}`)).headers.get('x-frame-options'), 'DENY', 'sem inline continua bloqueado');
  // pasta local (demonstração): não há link do OneDrive, edita no programa do computador
  assert.equal(await c.call('docs:editLinks', r.rel), null);
  await c.call('docs:forgetRecent', r.rel);
  assert.ok(!(await c.call('docs:recent')).some((x) => x.rel === r.rel));
});

test('OCR: PDF escaneado (só imagem) passa a ser achado pelo conteúdo', async () => {
  const c = client();
  await c.req('/auth/login', { body: { login: 'barros', password: 'segredo1' } });
  await c.call('docs:reindex');
  const before = await c.call('docs:search', 'energisa kwh');
  assert.ok(!before.some((d) => /Comprovante de residência/.test(d.name)), 'antes do OCR o PDF não tem texto');
  const r = await c.call('docs:ocrNow');
  assert.ok(r.read >= 1 && r.done >= 1);
  assert.equal(r.pending, 0);
  const hits = await c.call('docs:search', 'energisa kwh');
  const hit = hits.find((d) => /Comprovante de residência/.test(d.name));
  assert.ok(hit, 'achado pelo texto lido da imagem');
  assert.match(hit.snippet, /ENERGISA/i);
  // não lê de novo o que já leu (mesma versão do arquivo)
  assert.equal((await c.call('docs:ocrNow')).read, 0);
});
