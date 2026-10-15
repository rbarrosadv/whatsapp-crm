// Ponte do WhatsApp no servidor (modo demonstração): um sócio escolhe o
// computador do escritório, o WhatsApp só conecta com ele ligado e espera
// (sem tentar direto do servidor) quando ele desliga.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { runBridgeClient } from '../src/main/bridge.js';

process.env.CRM_DEMO_QR_MS = '200';
const { startServer } = await import('../src/server/server.js');

let dir;
let srv;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ponte-'));
  srv = await startServer({ dataDir: dir, demo: true, port: 0 });
});
after(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const req = async (p, { body } = {}) => {
    const r = await fetch(`${srv.url}${p}`, {
      method: 'POST',
      headers: { 'X-CRM': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body || {}),
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const call = async (method, ...args) => {
    const r = await req(`/api/${method}`, { body: { args } });
    if (!r.json?.ok) throw new Error(r.json?.error || `HTTP ${r.status}`);
    return r.json.result;
  };
  return { req, call };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what) {
  for (let i = 0; i < 60; i++) {
    if (await fn()) return;
    await wait(100);
  }
  throw new Error(`não aconteceu: ${what}`);
}

test('computador do escritório: escolher, ligar, desligar, chave errada', async () => {
  const socio = client();
  await socio.req('/auth/setup', { body: { name: 'Rafael Barros', login: 'barros', password: 'segredo1' } });
  await until(async () => (await socio.call('wa:status')).state === 'open', 'demo conectar');
  assert.equal((await socio.call('wa:bridge')).via, 'direto');

  // estagiária não escolhe o computador
  await socio.call('users:save', { name: 'Isabella', login: 'isa', password: 'segredo1', role: 'estagiario' });
  const isa = client();
  await isa.req('/auth/login', { body: { login: 'isa', password: 'segredo1' } });
  await assert.rejects(isa.call('wa:bridgeEnable', 'PC'), /permiss|sócio/i);

  const { token, status } = await socio.call('wa:bridgeEnable', 'PC-WHATSAPP');
  assert.ok(token.length > 30);
  assert.equal(status.via, 'escritorio');
  assert.equal(status.up, false);
  // a chave não vai para as configurações que a equipe recebe
  const b = await isa.call('bootstrap');
  assert.equal(b.settings.waBridgeHash, undefined);
  assert.equal(b.settings.waBridgeName, 'PC-WHATSAPP');
  // sem o computador: espera, não conecta direto
  await until(async () => (await socio.call('wa:status')).state === 'waiting_bridge', 'esperar o computador');

  // chave errada: recusada antes de abrir
  const bad = new WebSocket(`${srv.url.replace('http', 'ws')}/bridge`, { headers: { Authorization: 'Bearer errada' } });
  const err = await new Promise((ok) => bad.on('error', ok));
  assert.match(err.message, /401/);

  // o computador liga: o WhatsApp conecta
  const seen = [];
  const pc = runBridgeClient({ url: srv.url, token, name: 'PC-WHATSAPP', WebSocket, onStatus: (s) => seen.push(s) });
  await until(async () => (await socio.call('wa:bridge')).up, 'ponte ligada');
  await until(async () => (await socio.call('wa:status')).state === 'open', 'conectar pela ponte');
  assert.equal((await socio.call('wa:bridge')).name, 'PC-WHATSAPP');
  assert.ok(seen.some((s) => s.up));

  // o computador desliga: volta a esperar
  pc.stop();
  await until(async () => (await socio.call('wa:status')).state === 'waiting_bridge', 'voltar a esperar');
  assert.equal((await socio.call('wa:bridge')).up, false);

  // trocar de computador invalida a chave antiga
  const { token: token2 } = await socio.call('wa:bridgeEnable', 'OUTRO-PC');
  assert.notEqual(token2, token);
  const old = new WebSocket(`${srv.url.replace('http', 'ws')}/bridge`, { headers: { Authorization: `Bearer ${token}` } });
  assert.match((await new Promise((ok) => old.on('error', ok))).message, /401/);

  // voltar a conectar direto do servidor
  const back = await socio.call('wa:bridgeDisable');
  assert.equal(back.via, 'direto');
  await until(async () => (await socio.call('wa:status')).state === 'open', 'conectar direto');
});
