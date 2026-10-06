// Conversão dos dados de quem já usava o sistema: contatos com casos viram
// clientes (o cliente passou a ser o centro, o WhatsApp é só um canal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/main/db.js';

test('banco antigo (v8): casos e contatos "Cliente" viram clientes, com os dados da ficha', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-mig-'));
  try {
    db.openDb(dir);
    const J1 = '5565999990001@s.whatsapp.net';
    const J2 = '5565999990002@s.whatsapp.net';
    db.upsertChat({ jid: J1, name: 'Maria da Penha', last_ts: Date.now() });
    db.upsertChat({ jid: J2, name: 'Vitor Hugo', last_ts: Date.now() });
    db.updateCrmFields(J1, { cpf: '111.222.333-44', folder: '02 CLIENTES/MARIA DA PENHA' });
    db.setContactType(J2, 'cliente');
    // caso gravado como antes da versão 9 (sem cliente)
    db.run(`INSERT INTO cases (jid, title, created_at, updated_at) VALUES (?, 'Pensão', ?, ?)`, J1, Date.now(), Date.now());
    db.run('DELETE FROM clients');
    db.run('UPDATE cases SET client_id = NULL');
    db.run("UPDATE meta SET value = '8' WHERE key = 'schema'");
    db.closeDb();

    db.openDb(dir);
    const maria = db.clientByJid(J1);
    assert.equal(maria.name, 'Maria da Penha');
    assert.equal(maria.cpf, '111.222.333-44');
    assert.equal(maria.folder, '02 CLIENTES/MARIA DA PENHA');
    assert.equal(maria.phone, '5565999990001');
    assert.equal(maria.cases_open, 1);
    assert.equal(db.listCases({ clientId: maria.id })[0].title, 'Pensão');
    assert.ok(db.clientByJid(J2), 'contato classificado como Cliente também vira cliente');
    db.closeDb();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
