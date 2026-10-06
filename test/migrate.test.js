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

test('v14: emojis dos funis, tipos e filtros viram nomes de ícone; "✔" sai das etapas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-mig-'));
  try {
    db.openDb(dir);
    db.run("UPDATE pipelines SET icon = '🎯' WHERE id = 'consultoria'");
    db.run("UPDATE contact_types SET icon = '⚖️' WHERE id = 'cliente'");
    db.run("UPDATE chat_filters SET icon = '⏳' WHERE name = 'Aguardando resposta'");
    db.run("UPDATE stages SET name = 'Faturado ✔' WHERE id = 'consultoria.faturado'");
    db.run("INSERT INTO pipelines (id, name, icon, position) VALUES ('x', 'Outro', '🦄', 9)");
    db.run("UPDATE meta SET value = '13' WHERE key = 'schema'");
    db.closeDb();

    db.openDb(dir);
    assert.equal(db.get("SELECT icon FROM pipelines WHERE id = 'consultoria'").icon, 'target');
    assert.equal(db.get("SELECT icon FROM pipelines WHERE id = 'x'").icon, 'tag', 'emoji desconhecido vira etiqueta');
    assert.equal(db.get("SELECT icon FROM contact_types WHERE id = 'cliente'").icon, 'scale');
    assert.equal(db.get("SELECT icon FROM chat_filters WHERE name = 'Aguardando resposta'").icon, 'clock');
    assert.equal(db.get("SELECT name FROM stages WHERE id = 'consultoria.faturado'").name, 'Faturado');
    assert.equal(db.emojiToIcon('💼'), 'briefcase');
    assert.equal(db.emojiToIcon('star'), 'star');
    db.closeDb();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v16: funil "Captação" sai; casos dele seguem em "Casos em andamento" (quem não contratou, encerrado)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-mig-'));
  try {
    db.openDb(dir);
    db.run("INSERT INTO pipelines (id, name, icon, position) VALUES ('captacao', 'Captação', 'target', 0)");
    db.run("INSERT INTO stages (id, pipeline_id, name, color, position) VALUES ('captacao.proposta', 'captacao', 'Proposta', '#f59e0b', 0), ('captacao.nao', 'captacao', 'Não contratou', '#ef4444', 1)");
    const cid = db.saveClient({ name: 'Cliente Antigo' });
    const a = db.saveCase({ client_id: cid, title: 'Em proposta', stage_id: 'captacao.proposta' });
    const b = db.saveCase({ client_id: cid, title: 'Desistiu', stage_id: 'captacao.nao' });
    db.run("UPDATE meta SET value = '15' WHERE key = 'schema'");
    db.closeDb();

    db.openDb(dir);
    assert.equal(db.get("SELECT 1 AS x FROM pipelines WHERE id = 'captacao'"), undefined);
    assert.equal(db.getCase(a).stage_id, 'casos.documentacao');
    assert.equal(db.getCase(a).status, 'aberto');
    assert.equal(db.getCase(b).status, 'encerrado');
    assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'legacy_pending'"), undefined);
    db.closeDb();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
