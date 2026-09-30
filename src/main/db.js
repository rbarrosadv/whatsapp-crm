// Banco de dados local (SQLite embutido no Electron via `node:sqlite`,
// sem módulo nativo pra compilar). Guarda tudo: conversas, contatos,
// mensagens e os dados do CRM (funis, etapas, etiquetas, notas, tarefas,
// respostas rápidas, configurações).
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

let db;

const SCHEMA_VERSION = 3;

const DEFAULT_PIPELINES = [
  {
    id: 'vendas', name: 'Atendimento', icon: '💼',
    stages: [
      ['novo', 'Novo contato', '#94a3b8'],
      ['atendimento', 'Em atendimento', '#3b82f6'],
      ['proposta', 'Proposta enviada', '#f59e0b'],
      ['negociacao', 'Negociação', '#a855f7'],
      ['ganho', 'Fechado ✔', '#22c55e'],
      ['perdido', 'Perdido', '#ef4444'],
    ],
  },
  {
    id: 'pessoal', name: 'Pessoal', icon: '👤',
    stages: [
      ['responder', 'Para responder', '#f59e0b'],
      ['aguardando', 'Aguardando', '#3b82f6'],
      ['resolvido', 'Resolvido', '#22c55e'],
    ],
  },
];

// Tipos de contato (editáveis). `personal` = não conta como trabalho
// (fica fora de "Aguardando resposta" e dos avisos de conversa esquecida).
const DEFAULT_CONTACT_TYPES = [
  ['pessoal', 'Pessoal', '👤', '#a855f7', 1],
  ['cliente', 'Cliente', '⚖️', '#22c55e', 0],
  ['empresa', 'Empresa', '🏢', '#3b82f6', 0],
];

// Filtros da lista de conversas (editáveis). Regras em JSON — ver chatMatchesRules no renderer.
const DEFAULT_FILTERS = [
  ['Tudo', '💬', {}],
  ['Trabalho', '💼', { types: ['cliente', 'empresa'], unclassified: 'include', groups: 'exclude' }],
  ['Pessoal', '👤', { types: ['pessoal'], unclassified: 'include' }],
  ['Para classificar', '❓', { unclassified: 'only', groups: 'exclude' }],
  ['Aguardando resposta', '⏳', { awaiting: true, work: true, groups: 'exclude' }],
  ['Não lidas', '🔵', { unread: true }],
];

// Funis de casos (versão 3). A última etapa de cada um é a de encerramento.
const CASE_PIPELINES = [
  {
    id: 'captacao', name: 'Captação', icon: '🎯',
    stages: [
      ['contato', 'Primeiro contato', '#94a3b8'],
      ['consulta', 'Consulta agendada', '#3b82f6'],
      ['proposta', 'Proposta de honorários', '#f59e0b'],
      ['contratou', 'Contratou ✔', '#22c55e'],
      ['nao', 'Não contratou', '#ef4444'],
    ],
  },
  {
    id: 'casos', name: 'Casos em andamento', icon: '⚖️',
    stages: [
      ['documentacao', 'Documentação', '#94a3b8'],
      ['protocolo', 'Protocolo / Petição', '#3b82f6'],
      ['aguardando', 'Aguardando decisão', '#f59e0b'],
      ['recurso', 'Recurso', '#a855f7'],
      ['encerrado', 'Encerrado', '#22c55e'],
    ],
  },
  {
    id: 'consultoria', name: 'Consultoria', icon: '🏢',
    stages: [
      ['demanda', 'Demanda recebida', '#94a3b8'],
      ['analise', 'Em análise', '#3b82f6'],
      ['entrega', 'Parecer / Entrega', '#f59e0b'],
      ['faturado', 'Faturado', '#22c55e'],
    ],
  },
];

const DEFAULT_TAGS = [
  ['Cliente', '#22c55e'],
  ['Lead quente', '#ef4444'],
  ['Retornar', '#f59e0b'],
  ['VIP', '#a855f7'],
];

const DEFAULT_QUICK_REPLIES = [
  ['ola', 'Olá! Tudo bem? Obrigado pelo contato. Como posso ajudar?'],
  ['aguarde', 'Um momento, por favor, já verifico pra você.'],
  ['obrigado', 'Obrigado pelo contato! Qualquer dúvida, é só chamar. 😊'],
];

export function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'crm.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  migrate();
  return db;
}

export function closeDb() {
  try { db?.close(); } catch { /* já fechado */ }
  db = undefined;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      is_group INTEGER NOT NULL DEFAULT 0,
      unread INTEGER NOT NULL DEFAULT 0,
      last_ts INTEGER NOT NULL DEFAULT 0,
      last_preview TEXT,
      last_from_me INTEGER NOT NULL DEFAULT 0,
      last_status INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      muted_until INTEGER NOT NULL DEFAULT 0,
      avatar_file TEXT,
      avatar_checked_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS chats_last_ts ON chats(last_ts DESC);

    CREATE TABLE IF NOT EXISTS contacts (
      jid TEXT PRIMARY KEY,
      name TEXT,          -- nome salvo na agenda do celular
      notify TEXT,        -- nome que a pessoa colocou no próprio WhatsApp
      verified_name TEXT, -- nome de conta comercial
      phone TEXT
    );

    -- Um mesmo contato pode aparecer como número (@s.whatsapp.net) ou
    -- como LID (@lid). Guardamos o apelido -> id principal.
    CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, jid TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS messages (
      chat_jid TEXT NOT NULL,
      id TEXT NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0,
      sender TEXT,
      sender_name TEXT,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      text TEXT,
      media_mime TEXT,
      media_file TEXT,
      media_name TEXT,
      media_size INTEGER,
      media_seconds INTEGER,
      thumb TEXT,
      quoted_id TEXT,
      quoted_text TEXT,
      quoted_sender TEXT,
      status INTEGER,
      reactions TEXT,
      extra TEXT,
      edited INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      raw TEXT,
      PRIMARY KEY (chat_jid, id)
    );
    CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_jid, ts);

    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS stages (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      name TEXT NOT NULL, color TEXT, position INTEGER NOT NULL DEFAULT 0
    );

    -- Ficha de CRM de cada conversa
    CREATE TABLE IF NOT EXISTS crm (
      jid TEXT PRIMARY KEY,
      custom_name TEXT,
      email TEXT,
      company TEXT,
      value REAL,
      pipeline_id TEXT,
      stage_id TEXT,
      stage_changed_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT);
    CREATE TABLE IF NOT EXISTS chat_tags (
      jid TEXT NOT NULL, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (jid, tag_id)
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, jid TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_jid ON notes(jid);

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT,
      title TEXT NOT NULL,
      due_at INTEGER,
      done INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_due ON tasks(done, due_at);

    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, jid TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS activity_jid ON activity(jid, ts);

    CREATE TABLE IF NOT EXISTS quick_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shortcut TEXT NOT NULL, text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

    -- Classificações importadas do Kanban antigo (que identificava as
    -- conversas pelo nome). Aplicadas assim que uma conversa com o mesmo
    -- nome aparecer.
    CREATE TABLE IF NOT EXISTS legacy_pending (
      name TEXT PRIMARY KEY, pipeline_id TEXT, stage_id TEXT, note TEXT, deadline TEXT
    );
  `);

  // versão 2: tipos de contato e filtros editáveis
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_types (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, color TEXT,
      personal INTEGER NOT NULL DEFAULT 0, notify INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT, rules TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL DEFAULT 0
    );
  `);
  addColumn('crm', 'type_id', 'TEXT');
  addColumn('chats', 'alerted_ts', 'INTEGER');

  // versão 3: casos, parcelas de honorários e documentos
  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      title TEXT NOT NULL,
      pipeline_id TEXT,
      stage_id TEXT,
      stage_changed_at INTEGER,
      process_number TEXT,
      area TEXT,
      court TEXT,
      opposing_party TEXT,
      fee_fixed INTEGER NOT NULL DEFAULT 0,
      fee_installments INTEGER NOT NULL DEFAULT 0,
      fee_success INTEGER NOT NULL DEFAULT 0,
      fee_total REAL,
      fee_percent REAL,
      status TEXT NOT NULL DEFAULT 'aberto',
      last_update_at INTEGER,
      alerted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cases_jid ON cases(jid);
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      description TEXT,
      amount REAL NOT NULL,
      due_at INTEGER,
      paid_at INTEGER,
      charged_at INTEGER,
      notified_before INTEGER NOT NULL DEFAULT 0,
      notified_due INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payments_due ON payments(paid_at, due_at);
    CREATE TABLE IF NOT EXISTS case_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      file TEXT NOT NULL,
      mime TEXT,
      size INTEGER,
      msg_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  addColumn('tasks', 'case_id', 'INTEGER');
  addColumn('tasks', 'kind', "TEXT NOT NULL DEFAULT 'tarefa'");
  addColumn('notes', 'case_id', 'INTEGER');

  const version = Number(get('SELECT value FROM meta WHERE key = ?', 'schema')?.value || 0);
  if (version < 1) seedDefaults();
  if (version < 2) seedV2();
  if (version < 3) migrateV3();
  run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', 'schema', String(SCHEMA_VERSION));
}

function addColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

function seedV2() {
  tx(() => {
    DEFAULT_CONTACT_TYPES.forEach(([id, name, icon, color, personal], i) => {
      run('INSERT OR IGNORE INTO contact_types (id, name, icon, color, personal, position) VALUES (?, ?, ?, ?, ?, ?)',
        id, name, icon, color, personal, i);
    });
    if (!get('SELECT COUNT(*) AS n FROM chat_filters')?.n) {
      DEFAULT_FILTERS.forEach(([name, icon, rules], i) => {
        run('INSERT INTO chat_filters (name, icon, rules, position) VALUES (?, ?, ?, ?)', name, icon, JSON.stringify(rules), i);
      });
    }
  });
}

/** Cria os funis de casos e transforma a etapa que cada contato tinha em um caso. */
function migrateV3() {
  tx(() => {
    CASE_PIPELINES.forEach((p, pi) => {
      run('INSERT OR IGNORE INTO pipelines (id, name, icon, position) VALUES (?, ?, ?, ?)', p.id, p.name, p.icon, pi - CASE_PIPELINES.length);
      p.stages.forEach(([id, name, color], si) => {
        run('INSERT OR IGNORE INTO stages (id, pipeline_id, name, color, position) VALUES (?, ?, ?, ?, ?)',
          `${p.id}.${id}`, p.id, name, color, si);
      });
    });
    // o que já estava no funil vira um caso
    for (const r of all(`SELECT crm.jid, crm.stage_id, crm.pipeline_id, crm.stage_changed_at, crm.value, p.name AS pname
                          FROM crm JOIN pipelines p ON p.id = crm.pipeline_id WHERE crm.stage_id IS NOT NULL`)) {
      run(`INSERT INTO cases (jid, title, pipeline_id, stage_id, stage_changed_at, fee_total, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, r.jid, r.pname, r.pipeline_id, r.stage_id, r.stage_changed_at || now(), r.value, now(), now());
    }
    // funis de exemplo antigos que ninguém usa saem da frente
    for (const id of ['vendas', 'pessoal']) {
      if (!get('SELECT 1 AS x FROM cases WHERE pipeline_id = ? LIMIT 1', id)) {
        run('DELETE FROM stages WHERE pipeline_id = ?', id);
        run('DELETE FROM pipelines WHERE id = ?', id);
      }
    }
    all('SELECT id FROM pipelines ORDER BY position, rowid').forEach((p, i) => run('UPDATE pipelines SET position = ? WHERE id = ?', i, p.id));
  });
}

function seedDefaults() {
  tx(() => {
    DEFAULT_PIPELINES.forEach((p, pi) => {
      run('INSERT OR IGNORE INTO pipelines (id, name, icon, position) VALUES (?, ?, ?, ?)', p.id, p.name, p.icon, pi);
      p.stages.forEach(([id, name, color], si) => {
        run('INSERT OR IGNORE INTO stages (id, pipeline_id, name, color, position) VALUES (?, ?, ?, ?, ?)',
          `${p.id}.${id}`, p.id, name, color, si);
      });
    });
    DEFAULT_TAGS.forEach(([name, color]) => run('INSERT INTO tags (name, color) VALUES (?, ?)', name, color));
    DEFAULT_QUICK_REPLIES.forEach(([s, t]) => run('INSERT INTO quick_replies (shortcut, text) VALUES (?, ?)', s, t));
  });
}

// ---------------------------------------------------------------- helpers

const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
export function run(sql, ...args) { return stmt(sql).run(...args.map(norm)); }
export function get(sql, ...args) { return stmt(sql).get(...args.map(norm)); }
export function all(sql, ...args) { return stmt(sql).all(...args.map(norm)); }
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

const now = () => Date.now();

// ------------------------------------------------------------- jid aliases

export function resolveJid(jid) {
  if (!jid) return jid;
  return get('SELECT jid FROM aliases WHERE alias = ?', jid)?.jid || jid;
}

/**
 * Registra que `alias` (normalmente um @lid) e `jid` (normalmente o
 * número @s.whatsapp.net) são a mesma pessoa. Se já existirem dados
 * gravados com o apelido, move tudo pro id principal.
 * Retorna true se algo foi mesclado.
 */
export function addAlias(alias, jid) {
  if (!alias || !jid || alias === jid) return false;
  const current = get('SELECT jid FROM aliases WHERE alias = ?', alias)?.jid;
  if (current === jid) return false;
  let merged = false;
  tx(() => {
    run('INSERT OR REPLACE INTO aliases (alias, jid) VALUES (?, ?)', alias, jid);
    run('UPDATE aliases SET jid = ? WHERE jid = ?', jid, alias);
    merged = mergeJid(alias, jid);
  });
  return merged;
}

function mergeJid(from, to) {
  const fromChat = get('SELECT * FROM chats WHERE jid = ?', from);
  const hasMsgs = get('SELECT 1 AS x FROM messages WHERE chat_jid = ? LIMIT 1', from);
  const fromCrm = get('SELECT * FROM crm WHERE jid = ?', from);
  if (!fromChat && !hasMsgs && !fromCrm) return false;

  run('UPDATE OR IGNORE messages SET chat_jid = ? WHERE chat_jid = ?', to, from);
  run('DELETE FROM messages WHERE chat_jid = ?', from);

  if (fromChat) {
    const toChat = get('SELECT * FROM chats WHERE jid = ?', to);
    if (!toChat) {
      run('UPDATE chats SET jid = ? WHERE jid = ?', to, from);
    } else {
      const newer = fromChat.last_ts > toChat.last_ts ? fromChat : toChat;
      run(`UPDATE chats SET name = COALESCE(name, ?), unread = unread + ?, last_ts = ?, last_preview = ?,
             last_from_me = ?, last_status = ? WHERE jid = ?`,
        fromChat.name, fromChat.unread, newer.last_ts, newer.last_preview, newer.last_from_me, newer.last_status, to);
      run('DELETE FROM chats WHERE jid = ?', from);
    }
  }
  const fromContact = get('SELECT * FROM contacts WHERE jid = ?', from);
  if (fromContact) {
    upsertContact({ jid: to, name: fromContact.name, notify: fromContact.notify, verified_name: fromContact.verified_name });
    run('DELETE FROM contacts WHERE jid = ?', from);
  }
  if (fromCrm) {
    const toCrm = get('SELECT * FROM crm WHERE jid = ?', to);
    if (!toCrm) run('UPDATE crm SET jid = ? WHERE jid = ?', to, from);
    else run('DELETE FROM crm WHERE jid = ?', from);
  }
  run('UPDATE OR IGNORE chat_tags SET jid = ? WHERE jid = ?', to, from);
  run('DELETE FROM chat_tags WHERE jid = ?', from);
  run('UPDATE notes SET jid = ? WHERE jid = ?', to, from);
  run('UPDATE tasks SET jid = ? WHERE jid = ?', to, from);
  run('UPDATE cases SET jid = ? WHERE jid = ?', to, from);
  run('UPDATE activity SET jid = ? WHERE jid = ?', to, from);
  return true;
}

// ------------------------------------------------------------------ chats

const CHAT_FIELDS = ['name', 'is_group', 'unread', 'last_ts', 'last_preview', 'last_from_me', 'last_status',
  'archived', 'pinned', 'muted_until', 'avatar_file', 'avatar_checked_at'];

export function upsertChat(chat) {
  const existing = get('SELECT jid FROM chats WHERE jid = ?', chat.jid);
  if (!existing) {
    run('INSERT INTO chats (jid, is_group) VALUES (?, ?)', chat.jid, chat.is_group ? 1 : 0);
  }
  const sets = [];
  const vals = [];
  for (const f of CHAT_FIELDS) {
    if (chat[f] === undefined) continue;
    sets.push(`${f} = ?`);
    vals.push(chat[f]);
  }
  if (sets.length) run(`UPDATE chats SET ${sets.join(', ')} WHERE jid = ?`, ...vals, chat.jid);
  if (chat.name) applyLegacyPending(chat.jid, chat.name);
}

export function chatExists(jid) {
  return !!get('SELECT 1 AS x FROM chats WHERE jid = ?', jid);
}

/** Atualiza a "última mensagem" do chat se a mensagem for mais nova. */
export function bumpChat(jid, msg, { incrementUnread = false, isGroup = false } = {}) {
  if (!chatExists(jid)) upsertChat({ jid, is_group: isGroup });
  const c = get('SELECT last_ts FROM chats WHERE jid = ?', jid);
  if (msg.ts >= (c?.last_ts || 0)) {
    run('UPDATE chats SET last_ts = ?, last_preview = ?, last_from_me = ?, last_status = ? WHERE jid = ?',
      msg.ts, previewOf(msg), msg.from_me ? 1 : 0, msg.status ?? null, jid);
  }
  if (incrementUnread) run('UPDATE chats SET unread = unread + 1 WHERE jid = ?', jid);
}

export function previewOf(m) {
  if (m.deleted) return '🚫 Mensagem apagada';
  const icons = {
    image: '📷 Foto', video: '🎥 Vídeo', audio: '🎤 Áudio', ptt: '🎤 Áudio', document: '📄 Documento',
    sticker: '💟 Figurinha', location: '📍 Localização', contact: '👤 Contato', poll: '📊 Enquete', call: '📞 Chamada',
  };
  const base = icons[m.type];
  if (base) return m.text ? `${base.split(' ')[0]} ${m.text}` : base;
  return m.text || '';
}

export function listChats() {
  return all(`
    SELECT c.*, ct.name AS contact_name, ct.notify, ct.verified_name, ct.phone,
      crm.custom_name, crm.email, crm.company, crm.value, crm.pipeline_id, crm.stage_id, crm.stage_changed_at, crm.type_id,
      (SELECT group_concat(k.stage_id) FROM (SELECT stage_id FROM cases WHERE jid = c.jid AND status = 'aberto' ORDER BY updated_at DESC) k) AS case_stage_ids,
      (SELECT COUNT(*) FROM cases WHERE jid = c.jid AND status = 'aberto') AS open_cases,
      (SELECT COUNT(*) FROM payments pm JOIN cases cs ON cs.id = pm.case_id WHERE cs.jid = c.jid AND pm.paid_at IS NULL AND pm.due_at < strftime('%s','now') * 1000) AS overdue_payments,
      (SELECT group_concat(tag_id) FROM chat_tags t WHERE t.jid = c.jid) AS tag_ids,
      (SELECT COUNT(*) FROM tasks k WHERE k.jid = c.jid AND k.done = 0) AS open_tasks,
      (SELECT MIN(due_at) FROM tasks k WHERE k.jid = c.jid AND k.done = 0 AND k.due_at IS NOT NULL) AS next_due
    FROM chats c
    LEFT JOIN contacts ct ON ct.jid = c.jid
    LEFT JOIN crm ON crm.jid = c.jid
    WHERE c.last_ts > 0 OR crm.jid IS NOT NULL OR EXISTS (SELECT 1 FROM cases WHERE jid = c.jid)
    ORDER BY c.pinned DESC, c.last_ts DESC
  `).map(decorateChat);
}

export function getChat(jid) {
  const row = get(`
    SELECT c.*, ct.name AS contact_name, ct.notify, ct.verified_name, ct.phone,
      crm.custom_name, crm.email, crm.company, crm.value, crm.pipeline_id, crm.stage_id, crm.stage_changed_at, crm.type_id,
      (SELECT group_concat(k.stage_id) FROM (SELECT stage_id FROM cases WHERE jid = c.jid AND status = 'aberto' ORDER BY updated_at DESC) k) AS case_stage_ids,
      (SELECT COUNT(*) FROM cases WHERE jid = c.jid AND status = 'aberto') AS open_cases,
      (SELECT COUNT(*) FROM payments pm JOIN cases cs ON cs.id = pm.case_id WHERE cs.jid = c.jid AND pm.paid_at IS NULL AND pm.due_at < strftime('%s','now') * 1000) AS overdue_payments,
      (SELECT group_concat(tag_id) FROM chat_tags t WHERE t.jid = c.jid) AS tag_ids,
      (SELECT COUNT(*) FROM tasks k WHERE k.jid = c.jid AND k.done = 0) AS open_tasks,
      (SELECT MIN(due_at) FROM tasks k WHERE k.jid = c.jid AND k.done = 0 AND k.due_at IS NOT NULL) AS next_due
    FROM chats c
    LEFT JOIN contacts ct ON ct.jid = c.jid
    LEFT JOIN crm ON crm.jid = c.jid
    WHERE c.jid = ?`, jid);
  return row ? decorateChat(row) : null;
}

function decorateChat(r) {
  // etapas dos casos abertos (o mais recente primeiro); stage_id/pipeline_id
  // ficam com o caso mais recente, para o que só mostra uma etapa
  const stageIds = r.case_stage_ids ? String(r.case_stage_ids).split(',').filter(Boolean) : [];
  const pipelineIds = stageIds.map((sid) => sid.split('.')[0]);
  return {
    ...r,
    stage_ids: stageIds,
    pipeline_ids: [...new Set(pipelineIds)],
    stage_id: stageIds[0] || null,
    pipeline_id: stageIds[0] ? stageOwner(stageIds[0]) : null,
    is_group: !!r.is_group,
    tag_ids: r.tag_ids ? String(r.tag_ids).split(',').map(Number) : [],
    display_name: displayName(r),
  };
}

function stageOwner(stageId) {
  return get('SELECT pipeline_id FROM stages WHERE id = ?', stageId)?.pipeline_id || null;
}

export function phoneOf(jid) {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  return jid.split('@')[0].split(':')[0];
}

export function formatPhone(digits) {
  if (!digits) return '';
  const d = String(digits);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    const head = rest.length === 9 ? rest.slice(0, 5) : rest.slice(0, 4);
    return `+55 (${ddd}) ${head}-${rest.slice(head.length)}`;
  }
  return `+${d}`;
}

export function displayName(r) {
  const phone = phoneOf(r.jid);
  return r.custom_name || r.contact_name || r.name || r.notify || r.verified_name
    || (phone ? formatPhone(phone) : (r.is_group ? 'Grupo' : 'Contato'));
}

export function setChatUnread(jid, unread) {
  run('UPDATE chats SET unread = ? WHERE jid = ?', unread, jid);
}

// --------------------------------------------------------------- contacts

export function upsertContact(c) {
  if (!c.jid) return;
  run(`INSERT INTO contacts (jid, name, notify, verified_name, phone) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = COALESCE(excluded.name, contacts.name),
         notify = COALESCE(excluded.notify, contacts.notify),
         verified_name = COALESCE(excluded.verified_name, contacts.verified_name),
         phone = COALESCE(excluded.phone, contacts.phone)`,
  c.jid, c.name || null, c.notify || null, c.verified_name || null, c.phone || phoneOf(c.jid));
  const nm = c.name || c.notify;
  if (nm) applyLegacyPending(c.jid, nm);
}

export function contactName(jid) {
  const r = get(`SELECT ct.name, ct.notify, ct.verified_name, crm.custom_name
                 FROM contacts ct LEFT JOIN crm ON crm.jid = ct.jid WHERE ct.jid = ?`, jid);
  if (!r) return null;
  return r.custom_name || r.name || r.notify || r.verified_name || null;
}

// --------------------------------------------------------------- messages

const MSG_FIELDS = ['from_me', 'sender', 'sender_name', 'ts', 'type', 'text', 'media_mime', 'media_file', 'media_name',
  'media_size', 'media_seconds', 'thumb', 'quoted_id', 'quoted_text', 'quoted_sender', 'status', 'reactions',
  'extra', 'edited', 'deleted', 'raw'];

/** Grava a mensagem. Retorna true se era nova. */
export function saveMessage(m) {
  const existing = get('SELECT id, status, media_file FROM messages WHERE chat_jid = ? AND id = ?', m.chat_jid, m.id);
  if (!existing) {
    const cols = ['chat_jid', 'id', ...MSG_FIELDS.filter((f) => m[f] !== undefined)];
    run(`INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => m[c]));
    return true;
  }
  // Mensagem já conhecida (ex.: veio de novo no histórico): atualiza sem
  // perder o arquivo de mídia baixado nem regredir o status.
  const upd = { ...m };
  delete upd.media_file;
  if (existing.status != null && upd.status != null && upd.status < existing.status) delete upd.status;
  updateMessage(m.chat_jid, m.id, upd);
  return false;
}

export function updateMessage(chatJid, id, fields) {
  const sets = [];
  const vals = [];
  for (const f of MSG_FIELDS) {
    if (fields[f] === undefined) continue;
    sets.push(`${f} = ?`);
    vals.push(fields[f]);
  }
  if (!sets.length) return;
  run(`UPDATE messages SET ${sets.join(', ')} WHERE chat_jid = ? AND id = ?`, ...vals, chatJid, id);
}

export function getMessage(chatJid, id) {
  return get('SELECT * FROM messages WHERE chat_jid = ? AND id = ?', chatJid, id);
}

export function findMessageById(id) {
  return get('SELECT * FROM messages WHERE id = ? LIMIT 1', id);
}

const MSG_COLS = `chat_jid, id, from_me, sender, sender_name, ts, type, text, media_mime, media_file, media_name,
  media_size, media_seconds, thumb, quoted_id, quoted_text, quoted_sender, status, reactions, extra, edited, deleted,
  (raw IS NOT NULL) AS has_raw`;

export function listMessages(chatJid, { before, after, limit = 60 } = {}) {
  if (after) {
    return all(`SELECT ${MSG_COLS} FROM messages WHERE chat_jid = ? AND ts > ? ORDER BY ts ASC, rowid ASC LIMIT ?`,
      chatJid, after, limit);
  }
  const rows = before
    ? all(`SELECT ${MSG_COLS} FROM messages WHERE chat_jid = ? AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?`,
      chatJid, before, limit)
    : all(`SELECT ${MSG_COLS} FROM messages WHERE chat_jid = ? ORDER BY ts DESC, rowid DESC LIMIT ?`, chatJid, limit);
  return rows.reverse();
}

export function oldestMessage(chatJid) {
  return get('SELECT * FROM messages WHERE chat_jid = ? AND raw IS NOT NULL ORDER BY ts ASC LIMIT 1', chatJid)
    || get('SELECT * FROM messages WHERE chat_jid = ? ORDER BY ts ASC LIMIT 1', chatJid);
}

export function unreadIncoming(chatJid, limit = 50) {
  return all('SELECT id, sender FROM messages WHERE chat_jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT ?',
    chatJid, limit);
}

export function searchMessages(q, limit = 80) {
  const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  return all(`SELECT m.chat_jid, m.id, m.ts, m.text, m.from_me FROM messages m
              WHERE m.text LIKE ? ESCAPE '\\' AND m.deleted = 0 ORDER BY m.ts DESC LIMIT ?`, like, limit);
}

// -------------------------------------------------------------------- CRM

export function listPipelines() {
  const pipes = all('SELECT * FROM pipelines ORDER BY position, rowid');
  const stages = all('SELECT * FROM stages ORDER BY position, rowid');
  return pipes.map((p) => ({ ...p, stages: stages.filter((s) => s.pipeline_id === p.id) }));
}

export function savePipeline({ id, name, icon, stages }) {
  return tx(() => {
    const pid = id || uniqueId('funil');
    const pos = get('SELECT COUNT(*) AS n FROM pipelines')?.n || 0;
    run(`INSERT INTO pipelines (id, name, icon, position) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon`, pid, name, icon || '📁', pos);
    const keep = new Set();
    (stages || []).forEach((s, i) => {
      const sid = s.id || `${pid}.${uniqueId('etapa')}`;
      keep.add(sid);
      run(`INSERT INTO stages (id, pipeline_id, name, color, position) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, position = excluded.position`,
      sid, pid, s.name, s.color, i);
    });
    const firstKept = [...keep][0] || null;
    for (const s of all('SELECT id FROM stages WHERE pipeline_id = ?', pid)) {
      if (!keep.has(s.id)) {
        run('DELETE FROM stages WHERE id = ?', s.id);
        run('UPDATE crm SET pipeline_id = NULL, stage_id = NULL WHERE stage_id = ?', s.id);
        // casos daquela etapa não somem: vão para a primeira etapa do funil
        run('UPDATE cases SET stage_id = ?, stage_changed_at = ? WHERE stage_id = ?', firstKept, now(), s.id);
      }
    }
    return pid;
  });
}

export function deletePipeline(id) {
  tx(() => {
    run('UPDATE crm SET pipeline_id = NULL, stage_id = NULL WHERE pipeline_id = ?', id);
    run('UPDATE cases SET pipeline_id = NULL, stage_id = NULL WHERE pipeline_id = ?', id);
    run('DELETE FROM stages WHERE pipeline_id = ?', id);
    run('DELETE FROM pipelines WHERE id = ?', id);
  });
}

export function reorderPipelines(ids) {
  tx(() => ids.forEach((id, i) => run('UPDATE pipelines SET position = ? WHERE id = ?', i, id)));
}

function uniqueId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function ensureCrm(jid) {
  run('INSERT OR IGNORE INTO crm (jid, created_at, updated_at) VALUES (?, ?, ?)', jid, now(), now());
}

/**
 * Coloca o contato numa etapa: move o caso aberto dele naquele funil ou,
 * se não houver, abre um caso novo. (Usado pela importação do Kanban antigo.)
 */
export function setStage(jid, stageId) {
  const st = get('SELECT * FROM stages WHERE id = ?', stageId);
  if (!st) throw new Error('Etapa não encontrada');
  const open = get(`SELECT id FROM cases WHERE jid = ? AND pipeline_id = ? AND status = 'aberto' ORDER BY updated_at DESC LIMIT 1`, jid, st.pipeline_id);
  if (open) return setCaseStage(open.id, stageId);
  return saveCase({ jid, stage_id: stageId });
}

// ------------------------------------------------------------------ casos

const CASE_FIELDS = ['title', 'process_number', 'area', 'court', 'opposing_party', 'fee_fixed', 'fee_installments',
  'fee_success', 'fee_total', 'fee_percent'];

function caseRow(c) {
  if (!c) return null;
  const pay = get(`SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(CASE WHEN paid_at IS NOT NULL THEN amount END), 0) AS paid,
                          COUNT(*) AS n, SUM(CASE WHEN paid_at IS NULL AND due_at < ? THEN 1 ELSE 0 END) AS overdue
                   FROM payments WHERE case_id = ?`, now(), c.id);
  const next = get(`SELECT MIN(due_at) AS t FROM tasks WHERE case_id = ? AND done = 0 AND due_at IS NOT NULL`, c.id)?.t || null;
  return {
    ...c,
    fee_fixed: !!c.fee_fixed, fee_installments: !!c.fee_installments, fee_success: !!c.fee_success,
    paid_total: pay.paid, billed_total: pay.total, payments_count: pay.n, overdue_payments: pay.overdue || 0,
    next_due: next,
    open_tasks: get('SELECT COUNT(*) AS n FROM tasks WHERE case_id = ? AND done = 0', c.id)?.n || 0,
    docs_count: get('SELECT COUNT(*) AS n FROM case_docs WHERE case_id = ?', c.id)?.n || 0,
  };
}

export function listCases({ jid, pipelineId, includeClosed = true } = {}) {
  const where = [];
  const args = [];
  if (jid) { where.push('jid = ?'); args.push(jid); }
  if (pipelineId) { where.push('pipeline_id = ?'); args.push(pipelineId); }
  if (!includeClosed) where.push("status = 'aberto'");
  return all(`SELECT * FROM cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
              ORDER BY status = 'aberto' DESC, updated_at DESC`, ...args).map(caseRow);
}

export function getCase(id) { return caseRow(get('SELECT * FROM cases WHERE id = ?', id)); }

export function saveCase(c) {
  return tx(() => {
    let id = c.id;
    if (!id) {
      const st = c.stage_id ? get('SELECT s.*, p.name AS pname FROM stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = ?', c.stage_id) : null;
      if (c.stage_id && !st) throw new Error('Etapa não encontrada');
      id = Number(run(`INSERT INTO cases (jid, title, pipeline_id, stage_id, stage_changed_at, last_update_at, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      c.jid, (c.title || st?.pname || 'Novo caso').trim(), st?.pipeline_id || null, st?.id || null, now(), now(), now(), now()).lastInsertRowid);
      logActivity(c.jid, 'case', `Caso aberto: ${c.title || st?.pname || 'Novo caso'}${st ? ` (${st.name})` : ''}`);
    }
    const sets = [];
    const vals = [];
    for (const f of CASE_FIELDS) {
      if (c[f] === undefined) continue;
      let v = c[f];
      if (f.startsWith('fee_') && ['fee_fixed', 'fee_installments', 'fee_success'].includes(f)) v = v ? 1 : 0;
      else if (f === 'fee_total' || f === 'fee_percent') v = v === '' || v == null ? null : Number(String(v).replace(',', '.')) || 0;
      else v = v == null ? null : String(v).trim() || null;
      if (f === 'title' && !v) continue;
      sets.push(`${f} = ?`);
      vals.push(v);
    }
    if (sets.length) run(`UPDATE cases SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, now(), id);
    return id;
  });
}

export function setCaseStage(id, stageId) {
  return tx(() => {
    const c = get('SELECT * FROM cases WHERE id = ?', id);
    if (!c) throw new Error('Caso não encontrado');
    const st = get('SELECT s.*, p.name AS pname FROM stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = ?', stageId);
    if (!st) throw new Error('Etapa não encontrada');
    if (c.stage_id === stageId) return id;
    run(`UPDATE cases SET pipeline_id = ?, stage_id = ?, stage_changed_at = ?, status = 'aberto', updated_at = ? WHERE id = ?`,
      st.pipeline_id, stageId, now(), now(), id);
    logActivity(c.jid, 'stage', `${c.title}: ${st.pname} → ${st.name}`);
    return id;
  });
}

export function setCaseStatus(id, status) {
  const c = get('SELECT * FROM cases WHERE id = ?', id);
  if (!c) throw new Error('Caso não encontrado');
  run('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
  logActivity(c.jid, 'case', `${c.title}: ${status === 'aberto' ? 'reaberto' : 'encerrado'}`);
}

export function deleteCase(id) {
  const c = get('SELECT * FROM cases WHERE id = ?', id);
  if (!c) return null;
  tx(() => {
    run('DELETE FROM payments WHERE case_id = ?', id);
    run('DELETE FROM case_docs WHERE case_id = ?', id);
    run('UPDATE tasks SET case_id = NULL WHERE case_id = ?', id);
    run('UPDATE notes SET case_id = NULL WHERE case_id = ?', id);
    run('DELETE FROM cases WHERE id = ?', id);
    logActivity(c.jid, 'case', `Caso excluído: ${c.title}`);
  });
  return c.jid;
}

/** Registra que o cliente recebeu notícia (zera o contador de "sem retorno"). */
export function touchCasesOfContact(jid) {
  run(`UPDATE cases SET last_update_at = ? WHERE jid = ? AND status = 'aberto'`, now(), jid);
}
export function touchCase(id) { run('UPDATE cases SET last_update_at = ? WHERE id = ?', now(), id); }

/** Casos abertos sem retorno ao cliente há mais de `ms` (e ainda não avisados). */
export function staleCases(ms) {
  return all(`SELECT * FROM cases WHERE status = 'aberto' AND COALESCE(last_update_at, created_at) < ?
              AND (alerted_at IS NULL OR alerted_at < COALESCE(last_update_at, created_at))`, now() - ms);
}
export function markCasesAlerted(ids) {
  tx(() => ids.forEach((id) => run('UPDATE cases SET alerted_at = ? WHERE id = ?', now(), id)));
}

// honorários / parcelas
export function listPayments({ caseId, status } = {}) {
  const where = [];
  const args = [];
  if (caseId) { where.push('p.case_id = ?'); args.push(caseId); }
  if (status === 'open') where.push('p.paid_at IS NULL');
  if (status === 'overdue') { where.push('p.paid_at IS NULL AND p.due_at < ?'); args.push(now()); }
  if (status === 'upcoming') { where.push('p.paid_at IS NULL AND (p.due_at IS NULL OR p.due_at >= ?)'); args.push(now()); }
  if (status === 'paid') where.push('p.paid_at IS NOT NULL');
  return all(`SELECT p.*, c.title AS case_title, c.jid, c.process_number,
                (SELECT COUNT(*) FROM payments x WHERE x.case_id = p.case_id) AS of_total,
                (SELECT COUNT(*) FROM payments x WHERE x.case_id = p.case_id AND (x.due_at < p.due_at OR (x.due_at = p.due_at AND x.id <= p.id))) AS seq
              FROM payments p JOIN cases c ON c.id = p.case_id
              ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
              ORDER BY ${caseId ? '' : 'p.paid_at IS NOT NULL, '}COALESCE(p.due_at, 9e15), p.id`, ...args);
}
export function getPayment(id) { return listPayments().find((p) => p.id === id) || null; }

export function savePayment({ id, case_id, description, amount, due_at }) {
  const v = Number(String(amount ?? '').replace(',', '.'));
  if (!(v > 0)) throw new Error('Informe um valor maior que zero');
  if (id) {
    const cur = get('SELECT * FROM payments WHERE id = ?', id);
    run('UPDATE payments SET description = ?, amount = ?, due_at = ?, notified_before = ?, notified_due = ? WHERE id = ?',
      description ?? cur.description, v, due_at === undefined ? cur.due_at : due_at,
      due_at !== undefined && due_at !== cur.due_at ? 0 : cur.notified_before,
      due_at !== undefined && due_at !== cur.due_at ? 0 : cur.notified_due, id);
    return id;
  }
  return Number(run('INSERT INTO payments (case_id, description, amount, due_at, created_at) VALUES (?, ?, ?, ?, ?)',
    case_id, description || null, v, due_at || null, now()).lastInsertRowid);
}

/** Gera N parcelas mensais iguais a partir do primeiro vencimento. */
export function generateInstallments(caseId, { total, count, firstDue, description }) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const t = Number(String(total).replace(',', '.'));
  if (!(t > 0)) throw new Error('Informe o valor total');
  const cents = Math.round(t * 100);
  const each = Math.floor(cents / n);
  const ids = [];
  tx(() => {
    for (let i = 0; i < n; i++) {
      const d = new Date(firstDue);
      const day = d.getDate();
      d.setMonth(d.getMonth() + i);
      if (d.getDate() !== day) d.setDate(0); // ex.: 31 → último dia do mês
      const amount = (i === n - 1 ? cents - each * (n - 1) : each) / 100;
      ids.push(savePayment({ case_id: caseId, amount, due_at: firstDue ? d.getTime() : null,
        description: `${description || 'Honorários'}${n > 1 ? ` — parcela ${i + 1}/${n}` : ''}` }));
    }
  });
  return ids;
}

export function setPaymentPaid(id, paid) {
  run('UPDATE payments SET paid_at = ? WHERE id = ?', paid ? now() : null, id);
}
export function markPaymentCharged(id) { run('UPDATE payments SET charged_at = ? WHERE id = ?', now(), id); }
export function deletePayment(id) { run('DELETE FROM payments WHERE id = ?', id); }

/** Parcelas para avisar: vencendo em `daysBefore` dias ou já vencidas. */
export function paymentsToNotify(daysBefore) {
  const soon = now() + daysBefore * 24 * 3600 * 1000;
  return {
    upcoming: daysBefore > 0 ? all(`SELECT * FROM payments WHERE paid_at IS NULL AND notified_before = 0 AND due_at IS NOT NULL
                                    AND due_at >= ? AND due_at <= ?`, now(), soon) : [],
    overdue: all('SELECT * FROM payments WHERE paid_at IS NULL AND notified_due = 0 AND due_at IS NOT NULL AND due_at < ?', now()),
  };
}
export function markPaymentsNotified(ids, kind) {
  const col = kind === 'overdue' ? 'notified_due' : 'notified_before';
  tx(() => ids.forEach((id) => run(`UPDATE payments SET ${col} = 1 WHERE id = ?`, id)));
}

export function financeSummary() {
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
  const monthStart = d.getTime();
  const e = new Date(d); e.setMonth(e.getMonth() + 1);
  const monthEnd = e.getTime();
  const one = (sql, ...a) => get(sql, ...a)?.v || 0;
  return {
    overdue: one('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE paid_at IS NULL AND due_at < ?', now()),
    overdueCount: one('SELECT COUNT(*) AS v FROM payments WHERE paid_at IS NULL AND due_at < ?', now()),
    dueMonth: one('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE paid_at IS NULL AND due_at >= ? AND due_at < ?', now(), monthEnd),
    receivedMonth: one('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE paid_at >= ? AND paid_at < ?', monthStart, monthEnd),
    openTotal: one('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE paid_at IS NULL'),
  };
}

// documentos do caso
export function listCaseDocs(caseId) { return all('SELECT * FROM case_docs WHERE case_id = ? ORDER BY created_at DESC', caseId); }
export function addCaseDoc({ case_id, name, file, mime, size, msg_id }) {
  if (msg_id && get('SELECT 1 AS x FROM case_docs WHERE case_id = ? AND msg_id = ?', case_id, msg_id)) return null;
  return Number(run('INSERT INTO case_docs (case_id, name, file, mime, size, msg_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    case_id, name, file, mime || null, size || null, msg_id || null, now()).lastInsertRowid);
}
export function deleteCaseDoc(id) {
  const d = get('SELECT * FROM case_docs WHERE id = ?', id);
  run('DELETE FROM case_docs WHERE id = ?', id);
  return d;
}

export function updateCrmFields(jid, fields) {
  const allowed = ['custom_name', 'email', 'company', 'value'];
  tx(() => {
    ensureCrm(jid);
    for (const f of allowed) {
      if (fields[f] === undefined) continue;
      let v = fields[f];
      if (f === 'value') v = v === '' || v === null ? null : Number(String(v).replace(',', '.')) || 0;
      else v = v ? String(v).trim() || null : null;
      run(`UPDATE crm SET ${f} = ?, updated_at = ? WHERE jid = ?`, v, now(), jid);
    }
  });
}

export function setContactType(jid, typeId) {
  tx(() => {
    ensureCrm(jid);
    const t = typeId ? get('SELECT name FROM contact_types WHERE id = ?', typeId) : null;
    if (typeId && !t) throw new Error('Tipo de contato não encontrado');
    run('UPDATE crm SET type_id = ?, updated_at = ? WHERE jid = ?', typeId || null, now(), jid);
    logActivity(jid, 'type', t ? `Classificado como ${t.name}` : 'Classificação removida');
  });
}

// tipos de contato
export function listContactTypes() { return all('SELECT * FROM contact_types ORDER BY position, rowid'); }
export function saveContactType({ id, name, icon, color, personal, notify }) {
  const tid = id || uniqueId('tipo');
  const pos = get('SELECT COUNT(*) AS n FROM contact_types')?.n || 0;
  run(`INSERT INTO contact_types (id, name, icon, color, personal, notify, position) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, color = excluded.color,
         personal = excluded.personal, notify = excluded.notify`,
  tid, name, icon || '🏷', color || '#94a3b8', personal ? 1 : 0, notify === false ? 0 : 1, pos);
  return tid;
}
export function deleteContactType(id) {
  tx(() => {
    run('UPDATE crm SET type_id = NULL WHERE type_id = ?', id);
    run('DELETE FROM contact_types WHERE id = ?', id);
  });
}
export function reorderContactTypes(ids) {
  tx(() => ids.forEach((id, i) => run('UPDATE contact_types SET position = ? WHERE id = ?', i, id)));
}

// filtros da lista de conversas
export function listChatFilters() {
  return all('SELECT * FROM chat_filters ORDER BY position, id').map((f) => ({ ...f, rules: safeJson(f.rules) }));
}
export function saveChatFilter({ id, name, icon, rules }) {
  if (id) {
    run('UPDATE chat_filters SET name = ?, icon = ?, rules = ? WHERE id = ?', name, icon || '', JSON.stringify(rules || {}), id);
    return id;
  }
  const pos = get('SELECT COUNT(*) AS n FROM chat_filters')?.n || 0;
  return Number(run('INSERT INTO chat_filters (name, icon, rules, position) VALUES (?, ?, ?, ?)',
    name, icon || '', JSON.stringify(rules || {}), pos).lastInsertRowid);
}
export function deleteChatFilter(id) { run('DELETE FROM chat_filters WHERE id = ?', id); }
export function reorderChatFilters(ids) {
  tx(() => ids.forEach((id, i) => run('UPDATE chat_filters SET position = ? WHERE id = ?', i, id)));
}
function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

/** Conversas de trabalho esperando resposta há mais de `ms` e ainda não avisadas. */
export function forgottenChats(ms) {
  return all(`SELECT c.jid, c.last_ts FROM chats c
              LEFT JOIN crm ON crm.jid = c.jid
              LEFT JOIN contact_types t ON t.id = crm.type_id
              WHERE c.is_group = 0 AND c.last_from_me = 0 AND c.last_ts > 0 AND c.last_ts < ?
                AND c.last_ts > ? AND COALESCE(t.personal, 0) = 0
                AND (c.alerted_ts IS NULL OR c.alerted_ts < c.last_ts)`,
  now() - ms, now() - 30 * 24 * 3600 * 1000);
}
export function markChatsAlerted(jids) {
  tx(() => jids.forEach((j) => run('UPDATE chats SET alerted_ts = ? WHERE jid = ?', now(), j)));
}

export function logActivity(jid, kind, detail) {
  run('INSERT INTO activity (jid, ts, kind, detail) VALUES (?, ?, ?, ?)', jid, now(), kind, detail);
}

export function listActivity(jid) {
  return all('SELECT * FROM activity WHERE jid = ? ORDER BY ts DESC LIMIT 100', jid);
}

// tags
export function listTags() { return all('SELECT * FROM tags ORDER BY name COLLATE NOCASE'); }
export function saveTag({ id, name, color }) {
  if (id) { run('UPDATE tags SET name = ?, color = ? WHERE id = ?', name, color, id); return id; }
  return Number(run('INSERT INTO tags (name, color) VALUES (?, ?)', name, color).lastInsertRowid);
}
export function deleteTag(id) { run('DELETE FROM tags WHERE id = ?', id); }
export function setChatTags(jid, tagIds) {
  tx(() => {
    run('DELETE FROM chat_tags WHERE jid = ?', jid);
    for (const t of tagIds) run('INSERT OR IGNORE INTO chat_tags (jid, tag_id) VALUES (?, ?)', jid, t);
  });
}

// notes
export function listNotes(jid, caseId) {
  if (caseId) return all('SELECT * FROM notes WHERE case_id = ? ORDER BY created_at DESC', caseId);
  return all('SELECT * FROM notes WHERE jid = ? ORDER BY created_at DESC', jid);
}
export function addNote(jid, text, caseId) {
  const id = Number(run('INSERT INTO notes (jid, text, created_at, case_id) VALUES (?, ?, ?, ?)', jid, text, now(), caseId || null).lastInsertRowid);
  return id;
}
export function deleteNote(id) { run('DELETE FROM notes WHERE id = ?', id); }

// tasks
export function listTasks({ jid, caseId, includeDone = false } = {}) {
  const where = [];
  const args = [];
  if (jid) { where.push('k.jid = ?'); args.push(jid); }
  if (caseId) { where.push('k.case_id = ?'); args.push(caseId); }
  if (!includeDone) where.push('k.done = 0');
  return all(`SELECT k.*, c.title AS case_title, c.process_number FROM tasks k LEFT JOIN cases c ON c.id = k.case_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
              ORDER BY k.done, CASE WHEN k.due_at IS NULL THEN 1 ELSE 0 END, k.due_at, k.id DESC`, ...args);
}
export function saveTask({ id, jid, title, due_at, done, case_id, kind }) {
  if (id) {
    const cur = get('SELECT * FROM tasks WHERE id = ?', id);
    if (!cur) return id;
    const newDue = due_at === undefined ? cur.due_at : due_at;
    run('UPDATE tasks SET title = ?, due_at = ?, done = ?, notified = ?, jid = ?, case_id = ?, kind = ? WHERE id = ?',
      title ?? cur.title, newDue, done === undefined ? cur.done : (done ? 1 : 0),
      newDue !== cur.due_at ? 0 : cur.notified,
      jid === undefined ? cur.jid : (jid || null), case_id === undefined ? cur.case_id : (case_id || null),
      kind || cur.kind || 'tarefa', id);
    return id;
  }
  if (case_id && !jid) jid = get('SELECT jid FROM cases WHERE id = ?', case_id)?.jid;
  return Number(run('INSERT INTO tasks (jid, title, due_at, created_at, case_id, kind) VALUES (?, ?, ?, ?, ?, ?)',
    jid || null, title, due_at || null, now(), case_id || null, kind || 'tarefa').lastInsertRowid);
}
export function deleteTask(id) { run('DELETE FROM tasks WHERE id = ?', id); }
export function dueTasksToNotify() {
  return all('SELECT * FROM tasks WHERE done = 0 AND notified = 0 AND due_at IS NOT NULL AND due_at <= ?', now());
}
export function markTaskNotified(id) { run('UPDATE tasks SET notified = 1 WHERE id = ?', id); }

// quick replies
export function listQuickReplies() { return all('SELECT * FROM quick_replies ORDER BY shortcut COLLATE NOCASE'); }
export function saveQuickReply({ id, shortcut, text }) {
  const sc = String(shortcut || '').replace(/^\//, '').trim();
  if (id) { run('UPDATE quick_replies SET shortcut = ?, text = ? WHERE id = ?', sc, text, id); return id; }
  return Number(run('INSERT INTO quick_replies (shortcut, text) VALUES (?, ?)', sc, text).lastInsertRowid);
}
export function deleteQuickReply(id) { run('DELETE FROM quick_replies WHERE id = ?', id); }

// settings
export function getSettings() {
  const out = {};
  for (const r of all('SELECT key, value FROM settings')) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}
export function setSetting(key, value) {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, JSON.stringify(value));
}

export function stats() {
  const since = now() - 7 * 24 * 3600 * 1000;
  return {
    chats: get('SELECT COUNT(*) AS n FROM chats WHERE last_ts > 0')?.n || 0,
    unreadChats: get('SELECT COUNT(*) AS n FROM chats WHERE unread > 0')?.n || 0,
    messages: get('SELECT COUNT(*) AS n FROM messages')?.n || 0,
    inWeek: get('SELECT COUNT(*) AS n FROM messages WHERE ts >= ? AND from_me = 0', since)?.n || 0,
    outWeek: get('SELECT COUNT(*) AS n FROM messages WHERE ts >= ? AND from_me = 1', since)?.n || 0,
    openTasks: get('SELECT COUNT(*) AS n FROM tasks WHERE done = 0')?.n || 0,
    overdueTasks: get('SELECT COUNT(*) AS n FROM tasks WHERE done = 0 AND due_at IS NOT NULL AND due_at < ?', now())?.n || 0,
    byStage: all(`SELECT s.id AS stage_id, s.pipeline_id, COUNT(c.id) AS n, COALESCE(SUM(c.fee_total), 0) AS total
                  FROM stages s LEFT JOIN cases c ON c.stage_id = s.id AND c.status = 'aberto' GROUP BY s.id`),
  };
}

// --------------------------------------------------- import do Kanban antigo

export function addLegacyPending(rows) {
  tx(() => {
    for (const r of rows) {
      run(`INSERT OR REPLACE INTO legacy_pending (name, pipeline_id, stage_id, note, deadline) VALUES (?, ?, ?, ?, ?)`,
        r.name, r.pipeline_id || null, r.stage_id || null, r.note || null, r.deadline || null);
    }
  });
  // tenta aplicar já com o que temos no banco
  const known = all(`SELECT c.jid, COALESCE(ct.name, c.name, ct.notify) AS nm FROM chats c
                     LEFT JOIN contacts ct ON ct.jid = c.jid`);
  let applied = 0;
  for (const k of known) if (k.nm && applyLegacyPending(k.jid, k.nm)) applied++;
  return applied;
}

function applyLegacyPending(jid, name) {
  const p = get('SELECT * FROM legacy_pending WHERE name = ?', name);
  if (!p) return false;
  tx(() => {
    run('DELETE FROM legacy_pending WHERE name = ?', name);
    if (p.stage_id && get('SELECT 1 AS x FROM stages WHERE id = ?', p.stage_id)) {
      const has = get(`SELECT 1 AS x FROM cases WHERE jid = ? AND pipeline_id = ? AND status = 'aberto'`, jid, p.pipeline_id);
      if (!has) setStage(jid, p.stage_id);
    }
    if (p.note) addNote(jid, p.note);
    if (p.deadline) {
      const due = new Date(`${p.deadline}T09:00:00`).getTime();
      if (!Number.isNaN(due)) saveTask({ jid, title: p.note ? p.note.slice(0, 80) : 'Prazo (importado)', due_at: due });
    }
  });
  return true;
}

export function legacyPendingCount() {
  return get('SELECT COUNT(*) AS n FROM legacy_pending')?.n || 0;
}
