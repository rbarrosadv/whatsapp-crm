// Código de primeiro acesso num servidor público (arquivo próprio: o banco é
// um só por processo). Rodar com: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startServer } = await import('../src/server/server.js');

test('código de primeiro acesso: pedido só para quem chega de fora (pelo proxy)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-code-'));
  const s2 = await startServer({ dataDir: d, demo: true, port: 0, requireSetupCode: true });
  try {
    const st = (h) => fetch(`${s2.url}/auth/state`, { headers: h }).then((r) => r.json());
    assert.equal((await st({})).setupCode, false, 'no próprio computador não pede');
    assert.equal((await st({ 'X-Forwarded-For': '200.1.2.3' })).setupCode, true, 'pela internet pede');
    const r = await fetch(`${s2.url}/auth/setup`, {
      method: 'POST', headers: { 'X-CRM': '1', 'Content-Type': 'application/json', 'X-Forwarded-For': '200.1.2.3' },
      body: JSON.stringify({ name: 'Intruso', login: 'intruso', password: 'segredo1' }),
    });
    assert.equal(r.status, 400);
    assert.ok(fs.existsSync(path.join(d, 'codigo-primeiro-acesso.txt')));
  } finally {
    await s2.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
