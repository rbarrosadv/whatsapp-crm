// Testes da equipe (login, sessões, permissões) e do servidor HTTP no modo
// demonstração — sem navegador. Rodar com: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as auth from '../src/server/auth.js';
import * as db from '../src/main/db.js';

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
    return { status: r.status, json, text };
  };
  const call = async (method, ...args) => {
    const r = await req(`/api/${method}`, { body: { args } });
    if (!r.json?.ok) throw new Error(r.json?.error || `HTTP ${r.status}`);
    return r.json.result;
  };
  return { req, call };
}

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
