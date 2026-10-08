// Banco de dados local (SQLite embutido no Electron via `node:sqlite`,
// sem módulo nativo pra compilar). Guarda tudo: conversas, contatos,
// mensagens e os dados do CRM (funis, etapas, etiquetas, notas, tarefas,
// respostas rápidas, configurações).
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fullAddress, sameName } from '../renderer/js/qualify.js';

let db;

const SCHEMA_VERSION = 20;

// Tipos de contato (editáveis). `personal` = não conta como trabalho
// (fica fora de "Aguardando resposta" e dos avisos de conversa esquecida).
const DEFAULT_CONTACT_TYPES = [
  ['pessoal', 'Pessoal', 'user', '#a855f7', 1],
  ['cliente', 'Cliente', 'scale', '#22c55e', 0],
  ['empresa', 'Empresa', 'building', '#3b82f6', 0],
];

// Filtros da lista de conversas (editáveis). Regras em JSON — ver chatMatchesRules no renderer.
const DEFAULT_FILTERS = [
  ['Tudo', 'message', {}],
  ['Trabalho', 'briefcase', { types: ['cliente', 'empresa'], unclassified: 'include', groups: 'exclude' }],
  ['Pessoal', 'user', { types: ['pessoal'], unclassified: 'include' }],
  ['Para classificar', 'help', { unclassified: 'only', groups: 'exclude' }],
  ['Aguardando resposta', 'clock', { awaiting: true, work: true, groups: 'exclude' }],
  ['Não lidas', 'dot', { unread: true }],
];

// Funis de casos (versão 3). A última etapa de cada um é a de encerramento.
const CASE_PIPELINES = [
  {
    id: 'casos', name: 'Casos em andamento', icon: 'scale',
    stages: [
      ['documentacao', 'Documentação', '#94a3b8'],
      ['protocolo', 'Protocolo / Petição', '#3b82f6'],
      ['aguardando', 'Aguardando decisão', '#f59e0b'],
      ['recurso', 'Recurso', '#a855f7'],
      ['encerrado', 'Encerrado', '#22c55e'],
    ],
  },
  {
    id: 'consultoria', name: 'Consultoria', icon: 'building',
    stages: [
      ['demanda', 'Demanda recebida', '#94a3b8'],
      ['analise', 'Em análise', '#3b82f6'],
      ['entrega', 'Parecer / Entrega', '#f59e0b'],
      ['faturado', 'Faturado', '#22c55e'],
    ],
  },
];

// "Cliente" é o tipo de contato e "interessado" é o Comercial: etiquetas são só marcas extras.
const DEFAULT_TAGS = [
  ['Urgente', '#ef4444'],
  ['Retornar', '#f59e0b'],
  ['Aguardando documentos', '#3b82f6'],
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
  // consultas preparadas são do banco fechado: reabrir precisa de novas
  stmtCache.clear();
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
  // versão 4: ligação de tarefas/prazos com eventos do Google Agenda
  addColumn('tasks', 'end_at', 'INTEGER');
  addColumn('tasks', 'gcal_event_id', 'TEXT');
  addColumn('tasks', 'gcal_calendar_id', 'TEXT');
  addColumn('tasks', 'gcal_synced_at', 'INTEGER');
  // versão 5: baixar arquivos automaticamente por tipo de contato
  addColumn('contact_types', 'autodownload', 'INTEGER NOT NULL DEFAULT 0');
  // downloads automáticos que falharam (link vencido etc.) — não repete sem parar
  addColumn('messages', 'dl_failed', 'INTEGER NOT NULL DEFAULT 0');
  // versão 6: equipe (vários usuários com login) — quem fez cada coisa
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      login TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL DEFAULT 'advogado',
      signature TEXT,
      pass_hash TEXT NOT NULL,
      prefs TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_login INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      agent TEXT
    );
  `);
  addColumn('activity', 'user_name', 'TEXT');
  // versão 7: responsável pela tarefa e quando foi concluída (painel do dia)
  addColumn('tasks', 'assignee_id', 'INTEGER');
  addColumn('tasks', 'done_at', 'INTEGER');
  // versão 8: documentos — dados do cliente para os modelos, pastas no OneDrive
  // (caminho relativo à pasta do escritório) e índice da busca nos documentos
  for (const c of CLIENT_FIELDS) addColumn('crm', c, 'TEXT');
  addColumn('crm', 'folder', 'TEXT');
  addColumn('cases', 'folder', 'TEXT');
  // versão 9: o CLIENTE passa a ser o centro (independente do WhatsApp). Casos,
  // notas, tarefas e histórico continuam com a coluna jid, que agora guarda a
  // "chave" do cliente: o jid do WhatsApp dele, ou "cliente:<id>" se não tiver.
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'pf',
      cpf TEXT, rg TEXT, nationality TEXT, marital TEXT, profession TEXT, address TEXT, birth TEXT,
      email TEXT, phone TEXT, phone2 TEXT,
      jid TEXT UNIQUE,
      folder TEXT,
      notes TEXT,
      origin TEXT,
      status TEXT NOT NULL DEFAULT 'ativo',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  addColumn('cases', 'client_id', 'INTEGER');
  // versão 10: processo completo — responsável, dados do processo, partes,
  // andamentos, as etapas do caso e o checklist de documentos
  addColumn('cases', 'responsible_id', 'INTEGER');
  addColumn('cases', 'tribunal', 'TEXT');
  addColumn('cases', 'kind', "TEXT NOT NULL DEFAULT 'judicial'");
  addColumn('cases', 'claim_value', 'REAL');
  addColumn('cases', 'filed_at', 'TEXT');
  addColumn('cases', 'client_role', 'TEXT');
  addColumn('cases', 'description', 'TEXT');
  // versão 11: intimações (DJEN, pelas OABs acompanhadas) e andamentos do DataJud
  db.exec(`
    CREATE TABLE IF NOT EXISTS oabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, number TEXT NOT NULL, uf TEXT NOT NULL,
      user_id INTEGER, active INTEGER NOT NULL DEFAULT 1, last_check INTEGER, last_error TEXT,
      UNIQUE (number, uf)
    );
    CREATE TABLE IF NOT EXISTS intimations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ext_id TEXT NOT NULL UNIQUE,
      oab_ids TEXT,
      date INTEGER, tribunal TEXT, kind TEXT, doc_kind TEXT, orgao TEXT, classe TEXT,
      process_number TEXT, process_digits TEXT, text TEXT, link TEXT, parties TEXT, lawyers TEXT,
      case_id INTEGER, status TEXT NOT NULL DEFAULT 'nova', task_id INTEGER, handled_by TEXT, handled_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS intimations_status ON intimations(status, date);
    CREATE INDEX IF NOT EXISTS intimations_proc ON intimations(process_digits);
  `);
  // versão 12: financeiro completo — recebimento (forma, valor, recibo) e despesas
  addColumn('payments', 'method', 'TEXT');
  addColumn('payments', 'paid_amount', 'REAL');
  addColumn('payments', 'receipt_no', 'INTEGER');
  addColumn('payments', 'paid_by', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'escritorio',
      case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
      category TEXT, description TEXT NOT NULL, amount REAL NOT NULL,
      due_at INTEGER, paid_at INTEGER, method TEXT,
      reimbursable INTEGER NOT NULL DEFAULT 0, reimbursed_at INTEGER,
      series TEXT, created_by TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS expenses_due ON expenses(paid_at, due_at);
    CREATE INDEX IF NOT EXISTS expenses_case ON expenses(case_id);
  `);
  // versão 13: receitas avulsas (sem processo: consulta, parecer, acordo…)
  db.exec(`
    CREATE TABLE IF NOT EXISTS incomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      payer_name TEXT, description TEXT NOT NULL, category TEXT,
      amount REAL NOT NULL, received_at INTEGER NOT NULL, method TEXT,
      receipt_no INTEGER, created_by TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS incomes_received ON incomes(received_at);
  `);
  // versão 15: comercial — interessados (ainda não clientes) e registros de atendimento
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, phone TEXT, email TEXT, jid TEXT,
      source TEXT, referred_by TEXT, area TEXT, subject TEXT, description TEXT,
      stage TEXT NOT NULL DEFAULT 'novo', stage_changed_at INTEGER, lost_reason TEXT,
      responsible_id INTEGER, consult_at INTEGER,
      fee_kind TEXT, fee_total REAL, fee_count INTEGER, fee_percent REAL,
      proposal_text TEXT, proposal_sent_at INTEGER,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, case_id INTEGER,
      created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS leads_stage ON leads(stage);
    CREATE INDEX IF NOT EXISTS leads_jid ON leads(jid);
    CREATE TABLE IF NOT EXISTS lead_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, at INTEGER NOT NULL, summary TEXT NOT NULL, next_step TEXT,
      user_name TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lead_contacts_lead ON lead_contacts(lead_id);
    CREATE INDEX IF NOT EXISTS lead_contacts_client ON lead_contacts(client_id);
  `);
  // versão 18: avisos no celular (uma inscrição por aparelho) e acompanhamento depois da audiência
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      agent TEXT, created_at INTEGER NOT NULL, last_ok INTEGER, fails INTEGER NOT NULL DEFAULT 0
    );
  `);
  addColumn('tasks', 'followup_notified', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('tasks', 'followup_done_at', 'INTEGER');
  // versão 17: data de encerramento do caso (relatórios)
  addColumn('cases', 'closed_at', 'INTEGER');
  addColumn('cases', 'datajud_checked_at', 'INTEGER');
  addColumn('cases', 'datajud_error', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      role TEXT NOT NULL, name TEXT NOT NULL, doc TEXT, notes TEXT
    );
    CREATE TABLE IF NOT EXISTS case_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual',
      ext_id TEXT, user_name TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS case_moves_case ON case_moves(case_id, ts);
    CREATE TABLE IF NOT EXISTS case_steps (
      case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      step TEXT NOT NULL, status TEXT NOT NULL, done_at INTEGER, user_name TEXT,
      PRIMARY KEY (case_id, step)
    );
    CREATE TABLE IF NOT EXISTS case_checklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pendente',
      requested_at INTEGER, received_at INTEGER, file TEXT, position INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_index (
      rel TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      text TEXT,
      fold TEXT
    );
  `);

  // versão 19: endereço em campos (busca pelo CEP), qualificação completa
  // (sexo, órgão do RG) e empresa (nome fantasia, inscrições, representante em JSON)
  for (const c of ['gender', 'rg_issuer', 'cep', 'street', 'number', 'complement', 'district', 'city', 'uf', 'trade_name', 'ie', 'im', 'rep']) addColumn('clients', c, 'TEXT');
  // processos importados: situação de arquivamento (provisório = vigiar a
  // prescrição; definitivo = sugerir encerrar), partes achadas no DJEN para
  // escolher o cliente, último andamento (processos parados)
  for (const [c, t] of [['archive_state', 'TEXT'], ['archive_since', 'INTEGER'], ['archive_dismissed', 'INTEGER'], ['prescription_at', 'INTEGER'],
    ['prescription_note', 'TEXT'], ['prescription_notified', 'INTEGER'], ['last_move_at', 'INTEGER'], ['parties_found', 'TEXT'],
    ['parties_checked_at', 'INTEGER'], ['import_batch', 'TEXT'], ['classe', 'TEXT'],
    // processo administrativo no INSS (sem consulta automática: o andamento fica no Meu INSS)
    ['inss_benefit', 'TEXT'], ['inss_status', 'TEXT'], ['inss_check_days', 'INTEGER'], ['inss_checked_at', 'INTEGER']]) addColumn('cases', c, t);
  // sugestões a partir dos andamentos/intimações: audiência para pôr na agenda,
  // andamento importante para avisar o cliente (nada é feito sem alguém conferir)
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_hints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, ts INTEGER, title TEXT NOT NULL, text TEXT, ref TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'nova', created_at INTEGER NOT NULL, done_at INTEGER, done_by TEXT,
      UNIQUE (case_id, kind, ref)
    );
  `);

  // v20: arquivos que cada pessoa abriu/criou (Documentos → Recentes) e a leitura
  // por OCR dos PDFs escaneados (feita aos poucos, uma vez por versão do arquivo)
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_recent (
      user_id INTEGER NOT NULL, rel TEXT NOT NULL, action TEXT, at INTEGER NOT NULL,
      PRIMARY KEY (user_id, rel)
    );
    CREATE TABLE IF NOT EXISTS doc_ocr (
      rel TEXT PRIMARY KEY, mtime INTEGER NOT NULL, status TEXT NOT NULL, pages INTEGER, at INTEGER NOT NULL
    );
  `);

  const version = Number(get('SELECT value FROM meta WHERE key = ?', 'schema')?.value || 0);
  if (version < 1) seedDefaults();
  if (version < 2) seedV2();
  if (version < 3) migrateV3();
  if (version < 5) run("UPDATE contact_types SET autodownload = 1 WHERE id = 'cliente'");
  if (version < 9) migrateV9();
  if (version < 14) migrateV14();
  if (version < 16) migrateV16();
  if (version < 18) run("UPDATE tasks SET followup_notified = 1, followup_done_at = COALESCE(followup_done_at, ?) WHERE kind = 'audiencia' AND COALESCE(end_at, due_at) < ?", now(), now());
  // endereço antigo (uma linha) vai para o campo da rua, para conferir
  if (version < 19) run("UPDATE clients SET street = address WHERE COALESCE(street, '') = '' AND COALESCE(address, '') <> ''");
  if (version < 17) run("UPDATE cases SET closed_at = updated_at WHERE status <> 'aberto' AND closed_at IS NULL");
  run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', 'schema', String(SCHEMA_VERSION));
}

// v14: ícones de funis, tipos e filtros passam de emoji para nome de ícone de traço
// (a interface desenha em SVG); "✔" sai do nome das etapas.
const EMOJI_ICONS = {
  '💼': 'briefcase', '👤': 'user', '👥': 'users', '🎯': 'target', '⚖': 'scale', '🏢': 'building', '🏛': 'landmark',
  '💬': 'message', '❓': 'help', '⏳': 'clock', '⌛': 'clock', '🔵': 'dot', '🟢': 'dot', '🔴': 'dot', '📁': 'folder',
  '📂': 'folder', '🏷': 'tag', '⭐': 'star', '❤': 'heart', '🚩': 'flag', '🏠': 'home', '🚗': 'car', '👶': 'baby',
  '🎓': 'graduation', '🌎': 'globe', '🌍': 'globe', '💰': 'coins', '💵': 'wallet', '📅': 'calendar', '⏰': 'clock',
  '🔔': 'bell', '📞': 'phone', '📧': 'mail', '✉': 'mail', '📥': 'inbox', '⚠': 'alert', '✅': 'check', '✔': 'check',
  '🤝': 'handshake', '🛡': 'shield', '📌': 'pin',
};
export function emojiToIcon(v) {
  const s = String(v || '').trim();
  if (!s || /^[a-zA-Z]+$/.test(s)) return s;
  return EMOJI_ICONS[s.replace(/[\uFE0F\u200D]/gu, '')] || EMOJI_ICONS[[...s][0]] || 'tag';
}

function migrateV14() {
  for (const t of ['pipelines', 'contact_types', 'chat_filters']) {
    for (const r of all(`SELECT id, icon FROM ${t}`)) {
      const n = emojiToIcon(r.icon);
      if (n !== (r.icon || '')) run(`UPDATE ${t} SET icon = ? WHERE id = ?`, n, r.id);
    }
  }
  run("UPDATE stages SET name = TRIM(REPLACE(name, '✔', '')) WHERE name LIKE '%✔%'");
}

// v16: o sistema começa do zero com o Comercial (interessados) no lugar do
// funil de casos "Captação"; sai também a importação do Kanban antigo.
function migrateV16() {
  tx(() => {
    if (get("SELECT 1 AS x FROM pipelines WHERE id = 'captacao'")) {
      // casos que estavam lá: quem não contratou é encerrado; o resto segue em "Casos em andamento"
      const first = get("SELECT id FROM stages WHERE pipeline_id = 'casos' ORDER BY position LIMIT 1")?.id || null;
      const last = get("SELECT id FROM stages WHERE pipeline_id = 'casos' ORDER BY position DESC LIMIT 1")?.id || null;
      run(`UPDATE cases SET status = 'encerrado', closed_at = updated_at, pipeline_id = ?, stage_id = ? WHERE stage_id = 'captacao.nao'`, last ? 'casos' : null, last);
      run("UPDATE cases SET pipeline_id = ?, stage_id = ? WHERE pipeline_id = 'captacao'", first ? 'casos' : null, first);
      run("UPDATE crm SET pipeline_id = NULL, stage_id = NULL WHERE pipeline_id = 'captacao'");
      run("DELETE FROM stages WHERE pipeline_id = 'captacao'");
      run("DELETE FROM pipelines WHERE id = 'captacao'");
      run("DELETE FROM settings WHERE key = 'lastPipeline' AND value LIKE '%captacao%'");
    }
    db.exec('DROP TABLE IF EXISTS legacy_pending');
    all('SELECT id FROM pipelines ORDER BY position, rowid').forEach((p, i) => run('UPDATE pipelines SET position = ? WHERE id = ?', i, p.id));
  });
}

/** Dados do cliente usados nos modelos de documento ({cpf}, {endereco}…). */
export const CLIENT_FIELDS = ['cpf', 'rg', 'nationality', 'marital', 'profession', 'address', 'birth'];

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
  if (!get('SELECT 1 AS x FROM clients WHERE jid = ?', to)) run('UPDATE clients SET jid = ? WHERE jid = ?', to, from);
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
      (SELECT id FROM clients WHERE clients.jid = c.jid) AS client_id,
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
      (SELECT id FROM clients WHERE clients.jid = c.jid) AS client_id,
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

/**
 * Mensagens ao redor de uma (para abrir a conversa no ponto de um resultado da busca).
 * @returns {{messages: object[], hasNewer: boolean}}
 */
export function messagesAround(chatJid, id, { before = 40, after = 40 } = {}) {
  const target = get(`SELECT ${MSG_COLS}, rowid AS _r FROM messages WHERE chat_jid = ? AND id = ?`, chatJid, id);
  if (!target) return { messages: [], hasNewer: false };
  const older = all(`SELECT ${MSG_COLS} FROM messages WHERE chat_jid = ? AND (ts < ? OR (ts = ? AND rowid < ?))
                     ORDER BY ts DESC, rowid DESC LIMIT ?`, chatJid, target.ts, target.ts, target._r, before).reverse();
  const newer = all(`SELECT ${MSG_COLS} FROM messages WHERE chat_jid = ? AND (ts > ? OR (ts = ? AND rowid > ?))
                     ORDER BY ts ASC, rowid ASC LIMIT ?`, chatJid, target.ts, target.ts, target._r, after + 1);
  delete target._r;
  return { messages: [...older, target, ...newer.slice(0, after)], hasNewer: newer.length > after };
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
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon`, pid, name, emojiToIcon(icon) || 'folder', pos);
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

const CASE_FIELDS = ['title', 'folder', 'process_number', 'area', 'court', 'opposing_party', 'tribunal', 'kind', 'filed_at',
  'client_role', 'description', 'responsible_id', 'claim_value', 'fee_fixed', 'fee_installments',
  'fee_success', 'fee_total', 'fee_percent', 'prescription_note', 'inss_benefit', 'inss_status', 'inss_check_days'];

function caseRow(c) {
  if (!c) return null;
  const pay = get(`SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(CASE WHEN paid_at IS NOT NULL THEN amount END), 0) AS paid,
                          COUNT(*) AS n, SUM(CASE WHEN paid_at IS NULL AND due_at < ? THEN 1 ELSE 0 END) AS overdue
                   FROM payments WHERE case_id = ?`, now(), c.id);
  const next = get(`SELECT MIN(due_at) AS t FROM tasks WHERE case_id = ? AND done = 0 AND due_at IS NOT NULL`, c.id)?.t || null;
  const cl = c.client_id ? get('SELECT name, jid FROM clients WHERE id = ?', c.client_id) : null;
  return {
    ...c,
    responsible_name: c.responsible_id ? get('SELECT name FROM users WHERE id = ?', c.responsible_id)?.name || null : null,
    client_name: cl?.name || (c.jid?.includes('@') ? getChat(c.jid)?.display_name : null) || null,
    client_jid: cl ? cl.jid : (c.jid?.includes('@') ? c.jid : null),
    no_client: !c.client_id && !c.jid?.includes('@'),
    parties_found: c.parties_found ? JSON.parse(c.parties_found) : null,
    fee_fixed: !!c.fee_fixed, fee_installments: !!c.fee_installments, fee_success: !!c.fee_success,
    paid_total: pay.paid, billed_total: pay.total, payments_count: pay.n, overdue_payments: pay.overdue || 0,
    next_due: next,
    open_tasks: get('SELECT COUNT(*) AS n FROM tasks WHERE case_id = ? AND done = 0', c.id)?.n || 0,
    docs_count: get('SELECT COUNT(*) AS n FROM case_docs WHERE case_id = ?', c.id)?.n || 0,
  };
}

// ------------------------------------------------------------------ clientes
//
// O cliente é o centro do sistema; o WhatsApp é só um canal ligado a ele
// (clients.jid, opcional). Casos, notas, tarefas e histórico usam a "chave" do
// cliente na coluna jid: o jid do WhatsApp, ou "cliente:<id>" sem WhatsApp.

const CLIENT_COLS = ['name', 'kind', 'cpf', 'rg', 'nationality', 'marital', 'profession', 'address', 'birth',
  'email', 'phone', 'phone2', 'folder', 'notes', 'origin', 'status',
  'gender', 'rg_issuer', 'cep', 'street', 'number', 'complement', 'district', 'city', 'uf', 'trade_name', 'ie', 'im', 'rep'];
const ADDRESS_COLS = ['cep', 'street', 'number', 'complement', 'district', 'city', 'uf'];
export const clientKey = (c) => (c ? c.jid || `cliente:${c.id}` : null);

/** Converte os contatos que já tinham casos (ou eram "Cliente") em clientes. */
function migrateV9() {
  const jids = new Set([
    ...all('SELECT DISTINCT jid FROM cases WHERE jid IS NOT NULL').map((r) => r.jid),
    ...all("SELECT jid FROM crm WHERE type_id = 'cliente'").map((r) => r.jid),
  ]);
  for (const jid of jids) {
    if (!jid || jid.endsWith('@g.us') || get('SELECT 1 AS x FROM clients WHERE jid = ?', jid)) continue;
    const chat = getChat(jid);
    const crm = get('SELECT * FROM crm WHERE jid = ?', jid) || {};
    const phone = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null;
    const id = Number(run(`INSERT INTO clients (name, cpf, rg, nationality, marital, profession, address, birth, email, phone, jid, folder, origin, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    chat?.display_name || crm.custom_name || phone || 'Cliente', crm.cpf || null, crm.rg || null, crm.nationality || null,
    crm.marital || null, crm.profession || null, crm.address || null, crm.birth || null, crm.email || null, phone, jid,
    crm.folder || null, 'WhatsApp', now(), now()).lastInsertRowid);
    run('UPDATE cases SET client_id = ? WHERE jid = ?', id, jid);
  }
}

function clientRow(c) {
  if (!c) return null;
  const key = clientKey(c);
  const st = get(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'aberto' THEN 1 ELSE 0 END) AS open FROM cases WHERE client_id = ?`, c.id);
  return {
    ...c,
    key,
    cases_total: st?.total || 0,
    cases_open: st?.open || 0,
    overdue_payments: get(`SELECT COUNT(*) AS n FROM payments p JOIN cases k ON k.id = p.case_id
                           WHERE k.client_id = ? AND p.paid_at IS NULL AND p.due_at < ?`, c.id, now())?.n || 0,
    next_due: get('SELECT MIN(due_at) AS t FROM tasks WHERE jid = ? AND done = 0 AND due_at IS NOT NULL', key)?.t || null,
  };
}

export function listClients({ q, status = 'ativo' } = {}) {
  const where = [];
  const args = [];
  if (status && status !== 'todos') { where.push('status = ?'); args.push(status); }
  const rows = all(`SELECT * FROM clients ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE`, ...args);
  const f = (x) => String(x || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const digits = String(q || '').replace(/\D/g, '');
  const words = f(q).split(/\s+/).filter(Boolean);
  const hit = (c) => !words.length
    || words.every((w) => f(`${c.name} ${c.email || ''}`).includes(w))
    || (digits.length >= 3 && [c.cpf, c.phone, c.phone2].some((v) => String(v || '').replace(/\D/g, '').includes(digits)));
  return rows.filter(hit).map(clientRow);
}

export function getClient(id) { return clientRow(get('SELECT * FROM clients WHERE id = ?', id)); }
export function clientByJid(jid) { return jid ? clientRow(get('SELECT * FROM clients WHERE jid = ?', jid)) : null; }
/** Cliente a partir da chave usada nos casos/tarefas (jid ou "cliente:<id>"). */
export function clientByKey(key) {
  const m = /^cliente:(\d+)$/.exec(String(key || ''));
  return m ? getClient(Number(m[1])) : clientByJid(key);
}

export function saveClient(c) {
  return tx(() => {
    let id = c.id;
    if (!id) {
      if (!String(c.name || '').trim()) throw new Error('Informe o nome do cliente.');
      if (c.jid && get('SELECT 1 AS x FROM clients WHERE jid = ?', c.jid)) throw new Error('Este WhatsApp já está ligado a outro cliente.');
      id = Number(run('INSERT INTO clients (name, jid, created_at, updated_at) VALUES (?, ?, ?, ?)', String(c.name).trim(), c.jid || null, now(), now()).lastInsertRowid);
      logActivity(clientKey(getClientRaw(id)), 'client', `Cliente cadastrado: ${String(c.name).trim()}`, c.userName || null);
    }
    for (const f of CLIENT_COLS) {
      if (c[f] === undefined) continue;
      let v = c[f];
      if (f === 'rep') v = v && typeof v === 'object' ? (Object.values(v).some((x) => String(x ?? '').trim()) ? JSON.stringify(v) : null) : (v ? String(v) : null);
      else v = v == null ? null : String(v).trim() || null;
      if (f === 'name' && !v) continue;
      if (f === 'kind') v = v === 'pj' ? 'pj' : 'pf';
      if (f === 'status') v = v === 'arquivado' ? 'arquivado' : 'ativo';
      if (f === 'gender') v = ['m', 'f'].includes(v) ? v : null;
      if (f === 'uf' && v) v = v.toUpperCase().slice(0, 2);
      run(`UPDATE clients SET ${f} = ?, updated_at = ? WHERE id = ?`, v, now(), id);
    }
    // o endereço em uma linha (usado no recibo, nos modelos antigos…) acompanha os campos
    if (ADDRESS_COLS.some((f) => c[f] !== undefined)) {
      const full = fullAddress(getClientRaw(id));
      if (full) run('UPDATE clients SET address = ? WHERE id = ?', full, id);
    }
    return id;
  });
}
const getClientRaw = (id) => get('SELECT * FROM clients WHERE id = ?', id);

/** Clientes que podem ser o mesmo (CPF/CNPJ igual ou nome com as mesmas palavras). */
export function similarClients({ name, cpf, excludeId } = {}) {
  const d = String(cpf || '').replace(/\D/g, '');
  return all('SELECT id, name, cpf, status FROM clients WHERE id <> ?', Number(excludeId) || -1)
    .filter((c) => (d.length >= 11 && String(c.cpf || '').replace(/\D/g, '') === d) || (name && sameName(name, c.name)))
    .slice(0, 5);
}

/** Liga (ou desliga, com jid nulo) o WhatsApp do cliente; casos e notas acompanham. */
export function linkClientChat(id, jid) {
  return tx(() => {
    const c = getClientRaw(id);
    if (!c) throw new Error('Cliente não encontrado');
    if (jid && get('SELECT 1 AS x FROM clients WHERE jid = ? AND id <> ?', jid, id)) throw new Error('Este WhatsApp já está ligado a outro cliente.');
    const from = clientKey(c);
    const to = jid || `cliente:${id}`;
    if (from === to) return to;
    run('UPDATE clients SET jid = ?, updated_at = ? WHERE id = ?', jid || null, now(), id);
    run('UPDATE cases SET jid = ? WHERE client_id = ?', to, id);
    // o que era do cliente sem WhatsApp passa para a conversa (e vice-versa só o que é de casos)
    if (!c.jid) for (const t of ['notes', 'tasks', 'activity']) run(`UPDATE ${t} SET jid = ? WHERE jid = ?`, to, from);
    else run('UPDATE tasks SET jid = ? WHERE case_id IN (SELECT id FROM cases WHERE client_id = ?)', to, id);
    if (jid && !c.phone && jid.endsWith('@s.whatsapp.net')) run('UPDATE clients SET phone = ? WHERE id = ?', jid.split('@')[0], id);
    logActivity(to, 'client', jid ? 'WhatsApp ligado ao cliente' : 'WhatsApp desligado do cliente');
    return to;
  });
}

/**
 * Junta um cadastro repetido (`fromId`) no que fica (`intoId`): processos,
 * tarefas, notas, histórico, atendimentos, receitas e interessados passam para
 * ele; campos vazios do que fica são completados; o repetido é apagado.
 */
export function mergeClients(fromId, intoId, userName) {
  return tx(() => {
    const a = getClientRaw(fromId);
    const b = getClientRaw(intoId);
    if (!a || !b) throw new Error('Cliente não encontrado');
    if (a.id === b.id) throw new Error('Escolha outro cadastro para juntar.');
    const keyA = clientKey(a);
    const keyBOld = clientKey(b);
    // o WhatsApp do repetido vem junto se o que fica não tem
    const jid = b.jid || a.jid || null;
    if (!b.jid && a.jid) run('UPDATE clients SET jid = NULL WHERE id = ?', a.id);
    const keyB = jid || `cliente:${b.id}`;
    // campos vazios do que fica: completa com os do repetido
    for (const f of CLIENT_COLS) {
      if (['name', 'status'].includes(f)) continue;
      if ((b[f] == null || String(b[f]).trim() === '') && a[f] != null && String(a[f]).trim() !== '') run(`UPDATE clients SET ${f} = ? WHERE id = ?`, a[f], b.id);
    }
    if (b.status !== 'ativo' && a.status === 'ativo') run("UPDATE clients SET status = 'ativo' WHERE id = ?", b.id);
    run('UPDATE clients SET jid = ?, updated_at = ? WHERE id = ?', jid, now(), b.id);
    run('UPDATE cases SET client_id = ?, jid = ? WHERE client_id IN (?, ?)', b.id, keyB, a.id, b.id);
    for (const t of ['notes', 'tasks', 'activity']) run(`UPDATE ${t} SET jid = ? WHERE jid IN (?, ?)`, keyB, keyA, keyBOld);
    for (const t of ['incomes', 'leads', 'lead_contacts']) run(`UPDATE ${t} SET client_id = ? WHERE client_id = ?`, b.id, a.id);
    run('DELETE FROM clients WHERE id = ?', a.id);
    logActivity(keyB, 'client', `Cadastro repetido juntado a este: ${a.name}${a.cpf ? ` (${a.cpf})` : ''}`, userName || null);
    return { key: keyB, folderLeft: a.folder && b.folder && a.folder !== b.folder ? a.folder : null };
  });
}

/** O que impede excluir o cadastro (processos, receitas…); vazio = pode excluir. */
export function clientUsage(id) {
  const c = getClientRaw(id);
  if (!c) return null;
  return {
    cases: get('SELECT COUNT(*) AS n FROM cases WHERE client_id = ?', id)?.n || 0,
    incomes: get('SELECT COUNT(*) AS n FROM incomes WHERE client_id = ?', id)?.n || 0,
    tasks: get('SELECT COUNT(*) AS n FROM tasks WHERE jid = ? AND done = 0', `cliente:${id}`)?.n || 0,
  };
}

/** Apaga um cadastro sem processos nem receitas (notas e tarefas dele vão junto). */
export function deleteClient(id) {
  return tx(() => {
    const c = getClientRaw(id);
    if (!c) throw new Error('Cliente não encontrado');
    const u = clientUsage(id);
    if (u.cases || u.incomes) throw new Error('Este cadastro tem processos ou receitas. Use "Juntar com outro cadastro" para não perder nada.');
    // a conversa do WhatsApp (se ligada) continua com as notas dela; só o que era do cadastro sai
    for (const t of ['notes', 'tasks', 'activity']) run(`DELETE FROM ${t} WHERE jid = ?`, `cliente:${id}`);
    run('UPDATE leads SET client_id = NULL WHERE client_id = ?', id);
    run('DELETE FROM lead_contacts WHERE client_id = ? AND lead_id IS NULL', id);
    run('DELETE FROM clients WHERE id = ?', id);
    return c.jid || null;
  });
}

/** Grupos de cadastros que parecem o mesmo cliente (CPF/CNPJ igual ou mesmo nome). */
export function duplicateClients() {
  const rows = all('SELECT id, name, cpf FROM clients');
  const norm = (x) => String(x || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const groups = new Map();
  for (const c of rows) {
    const d = String(c.cpf || '').replace(/\D/g, '');
    for (const key of [d.length >= 11 ? `doc:${d}` : null, norm(c.name).length >= 5 ? `nome:${norm(c.name)}` : null].filter(Boolean)) {
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(c.id);
    }
  }
  const dup = new Map(); // id → ids do mesmo grupo
  for (const ids of groups.values()) {
    if (ids.size < 2) continue;
    for (const id of ids) dup.set(id, [...new Set([...(dup.get(id) || []), ...ids])].filter((x) => x !== id));
  }
  return dup;
}

/** Cliente da conversa; cria um com os dados do contato se ainda não houver. */
export function ensureClientForChat(jid, userName) {
  const have = clientByJid(jid);
  if (have) return have.id;
  const chat = getChat(jid);
  const crm = get('SELECT * FROM crm WHERE jid = ?', jid) || {};
  const phone = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null;
  const id = saveClient({
    name: chat?.display_name || phone || 'Cliente', jid, phone, email: crm.email, origin: 'WhatsApp', userName,
    cpf: crm.cpf, rg: crm.rg, nationality: crm.nationality, marital: crm.marital, profession: crm.profession,
    address: crm.address, birth: crm.birth, folder: crm.folder,
  });
  run('UPDATE cases SET client_id = ? WHERE jid = ? AND client_id IS NULL', id, jid);
  return id;
}

export function listCases({ jid, clientId, pipelineId, includeClosed = true, status } = {}) {
  const where = [];
  const args = [];
  if (jid) { where.push('jid = ?'); args.push(jid); }
  if (clientId) { where.push('client_id = ?'); args.push(clientId); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (pipelineId) { where.push('pipeline_id = ?'); args.push(pipelineId); }
  if (!includeClosed) where.push("status = 'aberto'");
  return all(`SELECT * FROM cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
              ORDER BY status = 'aberto' DESC, updated_at DESC`, ...args).map(caseRow);
}

export function getCase(id) { return caseRow(get('SELECT * FROM cases WHERE id = ?', id)); }

/** Processo sem cliente (importado): a chave provisória é "processo:<id>". */
export function createCaseWithoutClient({ title, process_number, tribunal, area, court, responsible_id, import_batch, status, kind = 'judicial', inss_benefit = null }) {
  return tx(() => {
    const id = Number(run(`INSERT INTO cases (jid, client_id, title, process_number, tribunal, area, court, responsible_id, import_batch, status, closed_at, kind, inss_benefit, inss_status, inss_check_days, last_update_at, created_at, updated_at)
                           VALUES ('processo:0', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    title, process_number, tribunal || null, area || null, court || null, responsible_id || null, import_batch || null,
    status === 'encerrado' ? 'encerrado' : 'aberto', status === 'encerrado' ? now() : null, kind, inss_benefit,
    kind === 'inss' ? 'analise' : null, kind === 'inss' ? 15 : null, now(), now()).lastInsertRowid);
    run('UPDATE cases SET jid = ? WHERE id = ?', `processo:${id}`, id);
    logActivity(`processo:${id}`, 'case', `Processo importado: ${process_number}`);
    return id;
  });
}

/** Liga o processo ao cliente: tarefas, notas e histórico do processo vão junto. */
export function setCaseClient(caseId, clientId, { role } = {}) {
  return tx(() => {
    const k = get('SELECT * FROM cases WHERE id = ?', caseId);
    const cl = getClientRaw(clientId);
    if (!k || !cl) throw new Error('Processo ou cliente não encontrado');
    const from = k.jid;
    const to = clientKey(cl);
    run('UPDATE cases SET client_id = ?, jid = ?, client_role = COALESCE(?, client_role), updated_at = ? WHERE id = ?', cl.id, to, role || null, now(), caseId);
    if (from !== to && from?.startsWith('processo:')) for (const t of ['notes', 'tasks', 'activity']) run(`UPDATE ${t} SET jid = ? WHERE jid = ?`, to, from);
    else run('UPDATE tasks SET jid = ? WHERE case_id = ?', to, caseId);
    logActivity(to, 'case', `Processo ${k.process_number || k.title} ligado ao cliente`);
    return caseId;
  });
}

export function casesWithoutClient() {
  return all("SELECT * FROM cases WHERE client_id IS NULL AND jid LIKE 'processo:%' ORDER BY status = 'aberto' DESC, id").map(caseRow);
}

// ------------------------------------------------------------------ sugestões dos andamentos

export function addHint({ case_id, kind, ts = null, title, text = '', ref }) {
  const r = run('INSERT OR IGNORE INTO case_hints (case_id, kind, ts, title, text, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    case_id, kind, ts, title, text, String(ref), now());
  return r.changes ? Number(r.lastInsertRowid) : null;
}
export function listHints({ status = 'nova', caseId, responsible } = {}) {
  const where = ['h.status = ?'];
  const args = [status];
  if (caseId) { where.push('h.case_id = ?'); args.push(caseId); }
  if (responsible) { where.push('(c.responsible_id = ? OR c.responsible_id IS NULL)'); args.push(responsible); }
  return all(`SELECT h.*, c.title AS case_title, c.process_number, c.client_id, c.responsible_id, c.jid AS case_jid,
                (SELECT name FROM clients WHERE id = c.client_id) AS client_name,
                (SELECT jid FROM clients WHERE id = c.client_id) AS client_jid
              FROM case_hints h JOIN cases c ON c.id = h.case_id
              WHERE ${where.join(' AND ')} AND c.status = 'aberto' ORDER BY h.created_at DESC LIMIT 100`, ...args);
}
export const getHint = (id) => get('SELECT * FROM case_hints WHERE id = ?', id);
export function setHint(id, status, by) { run('UPDATE case_hints SET status = ?, done_at = ?, done_by = ? WHERE id = ?', status, now(), by || null, id); }

/** Processos judiciais abertos sem andamento há `ms` (os arquivados provisoriamente ficam de fora: têm o controle próprio). */
export function idleCases(ms, { responsible } = {}) {
  const limit = now() - ms;
  return all(`SELECT * FROM cases WHERE status = 'aberto' AND COALESCE(process_number, '') <> '' AND COALESCE(kind, 'judicial') = 'judicial'
                AND archive_state IS NULL AND COALESCE(last_move_at, created_at) < ? ${responsible ? 'AND (responsible_id = ? OR responsible_id IS NULL)' : ''}
              ORDER BY COALESCE(last_move_at, created_at)`, limit, ...(responsible ? [responsible] : [])).map((c) => ({
    id: c.id, title: c.title, process_number: c.process_number, client_id: c.client_id, tribunal: c.tribunal,
    client_name: c.client_id ? get('SELECT name FROM clients WHERE id = ?', c.client_id)?.name : null,
    last_move_at: c.last_move_at, since: c.last_move_at || c.created_at,
  }));
}

/** Processos do INSS com a conferência no Meu INSS vencida. */
export function inssToCheck({ responsible } = {}) {
  return all(`SELECT id FROM cases WHERE status = 'aberto' AND kind = 'inss' AND COALESCE(inss_check_days, 15) > 0
                AND COALESCE(inss_checked_at, created_at) + COALESCE(inss_check_days, 15) * 86400000 < ?
                ${responsible ? 'AND (responsible_id = ? OR responsible_id IS NULL)' : ''}
              ORDER BY COALESCE(inss_checked_at, created_at)`, now(), ...(responsible ? [responsible] : [])).map((r) => caseRow(get('SELECT * FROM cases WHERE id = ?', r.id)));
}

/** A pasta mudou de lugar (arquivo morto): troca o caminho no cliente e nos casos. */
export function renameFolderPrefix(from, to) {
  for (const t of ['clients', 'cases']) {
    run(`UPDATE ${t} SET folder = ? || substr(folder, ?) WHERE folder = ? OR folder LIKE ? || '/%'`, to, String(from).length + 1, from, from);
  }
  run("UPDATE OR REPLACE doc_recent SET rel = ? || substr(rel, ?) WHERE rel LIKE ? || '/%'", to, String(from).length + 1, from);
}

// ------------------------------------------------------------ documentos recentes

/** Arquivo aberto/criado/editado por alguém (guarda os 60 últimos de cada pessoa). */
export function touchDoc(userId, rel, action = 'open') {
  if (!userId || !rel) return;
  // só "abrir" não apaga o que foi feito antes (criado, editado, salvo do WhatsApp…)
  run(`INSERT INTO doc_recent (user_id, rel, action, at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, rel) DO UPDATE SET at = excluded.at,
      action = CASE WHEN excluded.action = 'open' THEN doc_recent.action ELSE excluded.action END`, userId, rel, action, now());
  run('DELETE FROM doc_recent WHERE user_id = ? AND rel NOT IN (SELECT rel FROM doc_recent WHERE user_id = ? ORDER BY at DESC LIMIT 60)', userId, userId);
}

export function recentDocs(userId, limit = 40) {
  return all(`SELECT r.rel, r.action, r.at, i.size, i.mtime FROM doc_recent r LEFT JOIN doc_index i ON i.rel = r.rel
    WHERE r.user_id = ? ORDER BY r.at DESC LIMIT ?`, userId, limit);
}

export function forgetRecentDoc(userId, rel) { run('DELETE FROM doc_recent WHERE user_id = ? AND rel = ?', userId, rel); }

/** Campos de controle do processo (fora do formulário). */
export function setCaseMeta(id, fields) {
  const allowed = ['archive_state', 'archive_since', 'archive_dismissed', 'prescription_at', 'prescription_note', 'prescription_notified',
    'last_move_at', 'parties_found', 'parties_checked_at', 'classe', 'area', 'title', 'tribunal', 'court'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k) || v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(k === 'parties_found' && v && typeof v !== 'string' ? JSON.stringify(v) : v);
  }
  if (sets.length) run(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
}

export function saveCase(c) {
  return tx(() => {
    let id = c.id;
    if (!id) {
      const st = c.stage_id ? get('SELECT s.*, p.name AS pname FROM stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = ?', c.stage_id) : null;
      if (c.stage_id && !st) throw new Error('Etapa não encontrada');
      // todo caso é de um cliente; vindo de uma conversa, o cliente é o dela
      let clientId = c.client_id || null;
      if (!clientId && c.jid && !String(c.jid).endsWith('@g.us')) clientId = clientByKey(c.jid)?.id || ensureClientForChat(c.jid);
      const cl = clientId ? getClientRaw(clientId) : null;
      if (!cl && !c.jid) throw new Error('Escolha o cliente do caso.');
      const key = cl ? clientKey(cl) : c.jid;
      id = Number(run(`INSERT INTO cases (jid, client_id, title, pipeline_id, stage_id, stage_changed_at, last_update_at, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      key, cl?.id || null, (c.title || st?.pname || 'Novo caso').trim(), st?.pipeline_id || null, st?.id || null, now(), now(), now(), now()).lastInsertRowid);
      logActivity(key, 'case', `Caso aberto: ${c.title || st?.pname || 'Novo caso'}${st ? ` (${st.name})` : ''}`);
    }
    const sets = [];
    const vals = [];
    for (const f of CASE_FIELDS) {
      if (c[f] === undefined) continue;
      let v = c[f];
      if (f.startsWith('fee_') && ['fee_fixed', 'fee_installments', 'fee_success'].includes(f)) v = v ? 1 : 0;
      else if (f === 'fee_total' || f === 'fee_percent' || f === 'claim_value') v = v === '' || v == null ? null : Number(String(v).replace(/\./g, (m, i, str) => (str.includes(',') ? '' : m)).replace(',', '.')) || 0;
      else if (f === 'responsible_id') v = v ? Number(v) : null;
      else if (f === 'inss_check_days') v = v === '' || v == null ? null : Number(v);
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
    run(`UPDATE cases SET pipeline_id = ?, stage_id = ?, stage_changed_at = ?, status = 'aberto', closed_at = NULL, updated_at = ? WHERE id = ?`,
      st.pipeline_id, stageId, now(), now(), id);
    logActivity(c.jid, 'stage', `${c.title}: ${st.pname} → ${st.name}`);
    return id;
  });
}

export function setCaseStatus(id, status) {
  const c = get('SELECT * FROM cases WHERE id = ?', id);
  if (!c) throw new Error('Caso não encontrado');
  run('UPDATE cases SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?', status, status === 'aberto' ? null : now(), now(), id);
  logActivity(c.jid, 'case', `${c.title}: ${status === 'aberto' ? 'reaberto' : 'encerrado'}`);
}

export function deleteCase(id) {
  const c = get('SELECT * FROM cases WHERE id = ?', id);
  if (!c) return null;
  tx(() => {
    run('DELETE FROM payments WHERE case_id = ?', id);
    run('DELETE FROM case_docs WHERE case_id = ?', id);
    for (const t of ['case_parties', 'case_moves', 'case_steps', 'case_checklist']) run(`DELETE FROM ${t} WHERE case_id = ?`, id);
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
  return all(`SELECT p.*, c.title AS case_title, c.jid, c.process_number, c.client_id, (SELECT name FROM clients WHERE id = c.client_id) AS client_name,
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
  if (paid) run('UPDATE payments SET paid_at = ? WHERE id = ?', now(), id);
  else run('UPDATE payments SET paid_at = NULL, paid_amount = NULL, method = NULL, paid_by = NULL WHERE id = ?', id);
}
/** Recebimento com data, valor recebido (pode diferir da parcela) e forma. */
export function registerPayment(id, { paid_at, paid_amount, method, user_name } = {}) {
  const p = get('SELECT * FROM payments WHERE id = ?', id);
  if (!p) throw new Error('Parcela não encontrada');
  const amount = paid_amount == null || paid_amount === '' ? p.amount : Number(String(paid_amount).replace(',', '.'));
  if (!(amount > 0)) throw new Error('Valor recebido inválido.');
  run('UPDATE payments SET paid_at = ?, paid_amount = ?, method = ?, paid_by = ? WHERE id = ?', paid_at || now(), amount, method || null, user_name || null, id);
}
/** Número do recibo (sequencial do escritório), dado na 1ª emissão. */
export function receiptNumber(id) {
  const p = get('SELECT receipt_no FROM payments WHERE id = ?', id);
  if (p?.receipt_no) return p.receipt_no;
  const next = lastReceiptNo() + 1;
  run('UPDATE payments SET receipt_no = ? WHERE id = ?', next, id);
  return next;
}
const lastReceiptNo = () => Math.max(get('SELECT COALESCE(MAX(receipt_no), 0) AS n FROM payments').n || 0,
  get('SELECT COALESCE(MAX(receipt_no), 0) AS n FROM incomes').n || 0);

// ------------------------------------------------------------ receitas avulsas

const INCOME_SELECT = `SELECT i.*, COALESCE(cl.name, i.payer_name) AS who, cl.cpf, cl.kind AS client_kind
  FROM incomes i LEFT JOIN clients cl ON cl.id = i.client_id`;
export function listIncomes({ clientId, from, to } = {}) {
  const where = [];
  const args = [];
  if (clientId) { where.push('i.client_id = ?'); args.push(clientId); }
  if (from) { where.push('i.received_at >= ?'); args.push(from); }
  if (to) { where.push('i.received_at < ?'); args.push(to); }
  return all(`${INCOME_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.received_at DESC`, ...args);
}
export function getIncome(id) { return get(`${INCOME_SELECT} WHERE i.id = ?`, id); }
export function saveIncome(i) {
  const amount = Number(String(i.amount ?? '').replace(/\./g, (m, k, str) => (str.includes(',') ? '' : m)).replace(',', '.'));
  if (!String(i.description || '').trim()) throw new Error('Descreva a receita.');
  if (!(amount > 0)) throw new Error('Informe o valor.');
  const vals = [i.client_id || null, i.client_id ? null : (String(i.payer_name || '').trim() || null), i.description.trim(), i.category || null,
    amount, i.received_at || now(), i.method || null];
  if (i.id) {
    run('UPDATE incomes SET client_id = ?, payer_name = ?, description = ?, category = ?, amount = ?, received_at = ?, method = ? WHERE id = ?', ...vals, i.id);
    return i.id;
  }
  return Number(run(`INSERT INTO incomes (client_id, payer_name, description, category, amount, received_at, method, created_by, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...vals, i.created_by || null, now()).lastInsertRowid);
}
export function deleteIncome(id) { run('DELETE FROM incomes WHERE id = ?', id); }
export function incomeReceiptNumber(id) {
  const r = get('SELECT receipt_no FROM incomes WHERE id = ?', id);
  if (r?.receipt_no) return r.receipt_no;
  const next = lastReceiptNo() + 1;
  run('UPDATE incomes SET receipt_no = ? WHERE id = ?', next, id);
  return next;
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
    receivedMonth: one('SELECT COALESCE(SUM(COALESCE(paid_amount, amount)), 0) AS v FROM payments WHERE paid_at >= ? AND paid_at < ?', monthStart, monthEnd)
      + one('SELECT COALESCE(SUM(amount), 0) AS v FROM incomes WHERE received_at >= ? AND received_at < ?', monthStart, monthEnd),
    payableMonth: one('SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE paid_at IS NULL AND due_at < ?', monthEnd),
    payableOverdue: one('SELECT COUNT(*) AS v FROM expenses WHERE paid_at IS NULL AND due_at < ?', now()),
    paidOutMonth: one('SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE paid_at >= ? AND paid_at < ?', monthStart, monthEnd),
    reimbursePending: one("SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE kind = 'custa' AND reimbursable = 1 AND paid_at IS NOT NULL AND reimbursed_at IS NULL"),
    openTotal: one('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE paid_at IS NULL'),
  };
}

// ------------------------------------------------------------ despesas (contas a pagar)

const EXPENSE_SELECT = `SELECT e.*, c.title AS case_title, c.client_id, (SELECT name FROM clients WHERE id = c.client_id) AS client_name
  FROM expenses e LEFT JOIN cases c ON c.id = e.case_id`;

export function listExpenses({ caseId, kind, status, from, to } = {}) {
  const where = [];
  const args = [];
  if (caseId) { where.push('e.case_id = ?'); args.push(caseId); }
  if (kind) { where.push('e.kind = ?'); args.push(kind); }
  if (status === 'open') where.push('e.paid_at IS NULL');
  if (status === 'overdue') { where.push('e.paid_at IS NULL AND e.due_at < ?'); args.push(now()); }
  if (status === 'paid') where.push('e.paid_at IS NOT NULL');
  if (status === 'reimburse') where.push("e.kind = 'custa' AND e.reimbursable = 1 AND e.paid_at IS NOT NULL AND e.reimbursed_at IS NULL");
  if (from) { where.push('COALESCE(e.paid_at, e.due_at) >= ?'); args.push(from); }
  if (to) { where.push('COALESCE(e.paid_at, e.due_at) < ?'); args.push(to); }
  return all(`${EXPENSE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
              ORDER BY e.paid_at IS NOT NULL, COALESCE(e.due_at, e.paid_at) ${status === 'paid' ? 'DESC' : 'ASC'}`, ...args);
}
export function getExpense(id) { return get(`${EXPENSE_SELECT} WHERE e.id = ?`, id); }

/**
 * Lança uma despesa. `repeat` = quantos meses (contas fixas do escritório:
 * aluguel, internet…) — cria uma por mês com o mesmo dia de vencimento.
 */
export function saveExpense(e) {
  const amount = Number(String(e.amount ?? '').replace(/\./g, (m, i, str) => (str.includes(',') ? '' : m)).replace(',', '.'));
  if (!String(e.description || '').trim()) throw new Error('Descreva a despesa.');
  if (!(amount > 0)) throw new Error('Informe o valor.');
  const kind = e.kind === 'custa' ? 'custa' : 'escritorio';
  const fields = [kind, e.case_id || null, e.category || null, e.description.trim(), amount, e.method || null, kind === 'custa' && e.reimbursable !== false ? 1 : 0];
  if (e.id) {
    run('UPDATE expenses SET kind = ?, case_id = ?, category = ?, description = ?, amount = ?, method = ?, reimbursable = ?, due_at = ?, paid_at = ? WHERE id = ?',
      ...fields, e.due_at || null, e.paid_at || null, e.id);
    return [e.id];
  }
  const n = Math.min(60, Math.max(1, Number(e.repeat) || 1));
  const series = n > 1 ? `s${now()}` : null;
  const ids = [];
  for (let i = 0; i < n; i++) {
    let due = e.due_at || null;
    if (due && i) { const d = new Date(due); d.setMonth(d.getMonth() + i); due = d.getTime(); }
    ids.push(Number(run(`INSERT INTO expenses (kind, case_id, category, description, amount, method, reimbursable, due_at, paid_at, series, created_by, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...fields, due, i === 0 ? (e.paid_at || null) : null, series, e.created_by || null, now()).lastInsertRowid));
  }
  return ids;
}
export function setExpensePaid(id, paid, method) {
  run('UPDATE expenses SET paid_at = ?, method = COALESCE(?, method) WHERE id = ?', paid ? (typeof paid === 'number' ? paid : now()) : null, method || null, id);
}
export function setExpenseReimbursed(id, yes) { run('UPDATE expenses SET reimbursed_at = ? WHERE id = ?', yes ? now() : null, id); }
export function deleteExpense(id, { series = false } = {}) {
  const e = get('SELECT * FROM expenses WHERE id = ?', id);
  if (!e) return;
  if (series && e.series) run('DELETE FROM expenses WHERE series = ? AND paid_at IS NULL', e.series);
  run('DELETE FROM expenses WHERE id = ?', id);
}

// ------------------------------------------------------------ fluxo de caixa

/** Entradas (parcelas recebidas + reembolsos de custas) e saídas (despesas pagas) num período. */
export function cashflow(from, to) {
  const ins = all(`SELECT p.id, 'honorario' AS type, p.paid_at AS ts, COALESCE(p.paid_amount, p.amount) AS amount, p.method,
                     COALESCE(p.description, 'Honorários') AS description, c.title AS case_title, (SELECT name FROM clients WHERE id = c.client_id) AS who
                   FROM payments p JOIN cases c ON c.id = p.case_id WHERE p.paid_at >= ? AND p.paid_at < ?`, from, to);
  const reimb = all(`SELECT e.id, 'reembolso' AS type, e.reimbursed_at AS ts, e.amount, NULL AS method, 'Reembolso: ' || e.description AS description,
                       c.title AS case_title, (SELECT name FROM clients WHERE id = c.client_id) AS who
                     FROM expenses e LEFT JOIN cases c ON c.id = e.case_id WHERE e.reimbursed_at >= ? AND e.reimbursed_at < ?`, from, to);
  const extra = all(`SELECT i.id, 'avulsa' AS type, i.received_at AS ts, i.amount, i.method, i.description, i.category, i.receipt_no,
                       NULL AS case_title, COALESCE(cl.name, i.payer_name) AS who
                     FROM incomes i LEFT JOIN clients cl ON cl.id = i.client_id WHERE i.received_at >= ? AND i.received_at < ?`, from, to);
  const outs = all(`SELECT e.id, e.kind AS type, e.paid_at AS ts, e.amount, e.method, e.description, e.category,
                      c.title AS case_title, (SELECT name FROM clients WHERE id = c.client_id) AS who
                    FROM expenses e LEFT JOIN cases c ON c.id = e.case_id WHERE e.paid_at >= ? AND e.paid_at < ?`, from, to);
  const sum = (l) => l.reduce((a, x) => a + x.amount, 0);
  // previsto no período (ainda em aberto)
  const toReceive = get('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE paid_at IS NULL AND due_at >= ? AND due_at < ?', from, to).v;
  const toPay = get('SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE paid_at IS NULL AND due_at >= ? AND due_at < ?', from, to).v;
  const entries = [...ins.map((x) => ({ ...x, dir: 'in' })), ...reimb.map((x) => ({ ...x, dir: 'in' })), ...extra.map((x) => ({ ...x, dir: 'in' })),
    ...outs.map((x) => ({ ...x, dir: 'out' }))].sort((a, b) => a.ts - b.ts);
  return { entries, totalIn: sum(ins) + sum(reimb) + sum(extra), totalOut: sum(outs), toReceive, toPay };
}

/** Entradas e saídas mês a mês (últimos `months` meses, terminando no mês de `ref`). */
export function cashflowMonths(months = 12, ref = now()) {
  const out = [];
  const d = new Date(ref); d.setDate(1); d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() - (months - 1));
  for (let i = 0; i < months; i++) {
    const from = d.getTime();
    const e = new Date(d); e.setMonth(e.getMonth() + 1);
    const to = e.getTime();
    const inV = get('SELECT COALESCE(SUM(COALESCE(paid_amount, amount)), 0) AS v FROM payments WHERE paid_at >= ? AND paid_at < ?', from, to).v
      + get('SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE reimbursed_at >= ? AND reimbursed_at < ?', from, to).v
      + get('SELECT COALESCE(SUM(amount), 0) AS v FROM incomes WHERE received_at >= ? AND received_at < ?', from, to).v;
    const outV = get('SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE paid_at >= ? AND paid_at < ?', from, to).v;
    out.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, in: inV, out: outV });
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

/** Painel do financeiro: totais por categoria, por área, próximos vencimentos e previsão. */
export function financeBreakdown(monthFrom, monthTo, yearFrom) {
  return {
    byCategory: all(`SELECT COALESCE(category, CASE kind WHEN 'custa' THEN 'Custas de processo' ELSE 'Outras' END) AS label, SUM(amount) AS value
                     FROM expenses WHERE COALESCE(paid_at, due_at) >= ? AND COALESCE(paid_at, due_at) < ?
                     GROUP BY label ORDER BY value DESC`, monthFrom, monthTo),
    byArea: all(`SELECT label, SUM(value) AS value FROM (
                   SELECT COALESCE(NULLIF(TRIM(c.area), ''), 'Sem área') AS label, COALESCE(p.paid_amount, p.amount) AS value
                   FROM payments p JOIN cases c ON c.id = p.case_id WHERE p.paid_at >= ?
                   UNION ALL
                   SELECT 'Avulsa: ' || COALESCE(category, 'outras') AS label, amount AS value FROM incomes WHERE received_at >= ?
                 ) GROUP BY label ORDER BY value DESC`, yearFrom, yearFrom),
    receivables: all(`SELECT p.id, p.amount, p.due_at, COALESCE(p.description, 'Honorários') AS description, c.title AS case_title,
                        (SELECT name FROM clients WHERE id = c.client_id) AS who
                      FROM payments p JOIN cases c ON c.id = p.case_id
                      WHERE p.paid_at IS NULL AND p.due_at >= ? AND p.due_at < ? ORDER BY p.due_at LIMIT 8`, now() - 864e5, now() + 15 * 864e5),
    payables: all(`SELECT id, amount, due_at, description, category FROM expenses
                   WHERE paid_at IS NULL AND due_at < ? ORDER BY due_at LIMIT 8`, now() + 15 * 864e5),
    forecast: [0, 1, 2].map((i) => {
      const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + i);
      const e = new Date(d); e.setMonth(e.getMonth() + 1);
      return {
        month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        in: get('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE paid_at IS NULL AND due_at >= ? AND due_at < ?', i ? d.getTime() : 0, e.getTime()).v,
        out: get('SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE paid_at IS NULL AND due_at >= ? AND due_at < ?', i ? d.getTime() : 0, e.getTime()).v,
      };
    }),
  };
}

/** Inadimplência por cliente: parcelas vencidas, total, maior atraso, última cobrança. */
export function defaulters() {
  return all(`SELECT c.client_id, (SELECT name FROM clients WHERE id = c.client_id) AS client_name, MAX(c.jid) AS jid,
                COUNT(*) AS n, SUM(p.amount) AS total, MIN(p.due_at) AS oldest, MAX(p.charged_at) AS last_charge,
                group_concat(DISTINCT c.title) AS cases
              FROM payments p JOIN cases c ON c.id = p.case_id
              WHERE p.paid_at IS NULL AND p.due_at < ?
              GROUP BY c.client_id ORDER BY total DESC`, now());
}

// documentos do caso
export function listCaseDocs(caseId) { return all('SELECT * FROM case_docs WHERE case_id = ? ORDER BY created_at DESC', caseId); }
export function addCaseDoc({ case_id, name, file, mime, size, msg_id }) {
  if (msg_id && get('SELECT 1 AS x FROM case_docs WHERE case_id = ? AND msg_id = ?', case_id, msg_id)) return null;
  return Number(run('INSERT INTO case_docs (case_id, name, file, mime, size, msg_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    case_id, name, file, mime || null, size || null, msg_id || null, now()).lastInsertRowid);
}
// ------------------------------------------------------------ processo: partes, andamentos, etapas, documentos

export function listParties(caseId) { return all('SELECT * FROM case_parties WHERE case_id = ? ORDER BY id', caseId); }
export function saveParty(p) {
  const name = String(p.name || '').trim();
  if (!name) throw new Error('Informe o nome da parte.');
  if (p.id) { run('UPDATE case_parties SET role = ?, name = ?, doc = ?, notes = ? WHERE id = ?', p.role || 'outro', name, p.doc || null, p.notes || null, p.id); return p.id; }
  return Number(run('INSERT INTO case_parties (case_id, role, name, doc, notes) VALUES (?, ?, ?, ?, ?)', p.case_id, p.role || 'outro', name, p.doc || null, p.notes || null).lastInsertRowid);
}
export function deleteParty(id) { run('DELETE FROM case_parties WHERE id = ?', id); }

export function listMoves(caseId) { return all('SELECT * FROM case_moves WHERE case_id = ? ORDER BY ts DESC, id DESC', caseId); }
export function addMove({ case_id, ts, text, source = 'manual', ext_id = null, user_name = null }) {
  if (!String(text || '').trim()) throw new Error('Escreva o andamento.');
  if (ext_id && get('SELECT 1 AS x FROM case_moves WHERE case_id = ? AND ext_id = ?', case_id, ext_id)) return null;
  return Number(run('INSERT INTO case_moves (case_id, ts, text, source, ext_id, user_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    case_id, ts || now(), String(text).trim(), source, ext_id, user_name, now()).lastInsertRowid);
}
export function deleteMove(id) { run("DELETE FROM case_moves WHERE id = ? AND source = 'manual'", id); }

export function listSteps(caseId) { return all('SELECT * FROM case_steps WHERE case_id = ?', caseId); }
/** Etapa marcada à mão (feito / não se aplica); `null` volta ao automático. */
export function setStep(caseId, step, status, userName) {
  if (!status) { run('DELETE FROM case_steps WHERE case_id = ? AND step = ?', caseId, step); return; }
  run('INSERT OR REPLACE INTO case_steps (case_id, step, status, done_at, user_name) VALUES (?, ?, ?, ?, ?)', caseId, step, status, now(), userName || null);
}

export function listChecklist(caseId) { return all('SELECT * FROM case_checklist WHERE case_id = ? ORDER BY position, id', caseId); }
export function addChecklistItems(caseId, labels) {
  const have = new Set(listChecklist(caseId).map((i) => i.label.toLowerCase()));
  let pos = get('SELECT COALESCE(MAX(position), 0) AS p FROM case_checklist WHERE case_id = ?', caseId).p;
  let n = 0;
  for (const l of labels) {
    const label = String(l || '').trim();
    if (!label || have.has(label.toLowerCase())) continue;
    have.add(label.toLowerCase());
    run('INSERT INTO case_checklist (case_id, label, position) VALUES (?, ?, ?)', caseId, label, ++pos);
    n++;
  }
  return n;
}
export function setChecklistStatus(ids, status, file) {
  for (const id of ids) {
    if (status === 'solicitado') run("UPDATE case_checklist SET status = 'solicitado', requested_at = ? WHERE id = ? AND status <> 'recebido'", now(), id);
    else if (status === 'recebido') run("UPDATE case_checklist SET status = 'recebido', received_at = ?, file = COALESCE(?, file) WHERE id = ?", now(), file || null, id);
    else run("UPDATE case_checklist SET status = 'pendente', received_at = NULL WHERE id = ?", id);
  }
}
export function deleteChecklistItem(id) { run('DELETE FROM case_checklist WHERE id = ?', id); }
export function checklistItem(id) { return get('SELECT * FROM case_checklist WHERE id = ?', id); }
/** Documentos pedidos há mais de `ms` e ainda não recebidos (casos abertos). */
export function pendingDocRequests(ms) {
  return all(`SELECT i.case_id, COUNT(*) AS n, MIN(i.requested_at) AS since, c.title, c.client_id, c.jid, c.responsible_id,
                (SELECT name FROM clients WHERE id = c.client_id) AS client_name
              FROM case_checklist i JOIN cases c ON c.id = i.case_id
              WHERE i.status = 'solicitado' AND i.requested_at < ? AND c.status = 'aberto'
              GROUP BY i.case_id ORDER BY since`, now() - ms);
}

// ------------------------------------------------------------ OABs e intimações

const digitsOf = (s) => String(s || '').replace(/\D/g, '');

export function listOabs() {
  return all('SELECT o.*, u.name AS user_name FROM oabs o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.name');
}
export function saveOab(o) {
  const number = digitsOf(o.number);
  const uf = String(o.uf || '').trim().toUpperCase();
  if (!String(o.name || '').trim() || !number || !/^[A-Z]{2}$/.test(uf)) throw new Error('Informe nome, número da OAB e UF (ex.: MT).');
  const dup = get('SELECT id FROM oabs WHERE number = ? AND uf = ?', number, uf);
  if (dup && dup.id !== o.id) throw new Error('Esta OAB já está cadastrada.');
  if (o.id) {
    run('UPDATE oabs SET name = ?, number = ?, uf = ?, user_id = ?, active = ? WHERE id = ?', o.name.trim(), number, uf, o.user_id || null, o.active === false ? 0 : 1, o.id);
    return o.id;
  }
  return Number(run('INSERT INTO oabs (name, number, uf, user_id) VALUES (?, ?, ?, ?)', o.name.trim(), number, uf, o.user_id || null).lastInsertRowid);
}
export function deleteOab(id) { run('DELETE FROM oabs WHERE id = ?', id); }
export function markOabChecked(id, error) { run('UPDATE oabs SET last_check = ?, last_error = ? WHERE id = ?', now(), error || null, id); }

/** Processo cadastrado com este número (compara só os dígitos). */
export function caseByProcessNumber(num) {
  const d = digitsOf(num);
  if (d.length < 15) return null;
  const rows = all("SELECT id, process_number FROM cases WHERE process_number IS NOT NULL AND process_number <> ''");
  return rows.find((r) => digitsOf(r.process_number) === d)?.id || null;
}

/** Grava a intimação se ainda não existe; devolve o id novo (ou null se já tinha). */
/** Grava a publicação do DJEN (`status` 'historico' = antiga, achada na busca do histórico: não vai para "conferir"). */
export function addIntimation(i, oabId, status = 'nova') {
  const have = get('SELECT id, oab_ids FROM intimations WHERE ext_id = ?', i.ext_id);
  if (have) {
    const ids = new Set(String(have.oab_ids || '').split(',').filter(Boolean));
    if (oabId && !ids.has(String(oabId))) { ids.add(String(oabId)); run('UPDATE intimations SET oab_ids = ? WHERE id = ?', [...ids].join(','), have.id); }
    return null;
  }
  const caseId = caseByProcessNumber(i.process_number);
  return Number(run(`INSERT INTO intimations (ext_id, oab_ids, date, tribunal, kind, doc_kind, orgao, classe, process_number, process_digits, text, link, parties, lawyers, case_id, status, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  i.ext_id, oabId ? String(oabId) : null, i.date, i.tribunal, i.kind, i.doc_kind || null, i.orgao, i.classe, i.process_number, digitsOf(i.process_number),
  i.text, i.link, JSON.stringify(i.parties || []), JSON.stringify(i.lawyers || []), caseId, status === 'historico' ? 'historico' : 'nova', now()).lastInsertRowid);
}

const intimationRow = (r) => (r ? {
  ...r, parties: JSON.parse(r.parties || '[]'), lawyers: JSON.parse(r.lawyers || '[]'),
} : null);

export function listIntimations({ status, caseId, limit = 300 } = {}) {
  const where = [];
  const args = [];
  if (status === 'abertas') where.push("i.status = 'nova'");
  else if (status) { where.push('i.status = ?'); args.push(status); }
  if (caseId) { where.push('i.case_id = ?'); args.push(caseId); }
  return all(`SELECT i.*, c.title AS case_title, c.client_id, (SELECT name FROM clients WHERE id = c.client_id) AS client_name,
                c.responsible_id, t.due_at AS task_due
              FROM intimations i LEFT JOIN cases c ON c.id = i.case_id LEFT JOIN tasks t ON t.id = i.task_id
              ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.date DESC, i.id DESC LIMIT ?`, ...args, limit).map(intimationRow);
}
export function getIntimation(id) { return intimationRow(get('SELECT * FROM intimations WHERE id = ?', id)); }
export function setIntimation(id, fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (!['status', 'task_id', 'case_id', 'handled_by', 'handled_at'].includes(k)) continue;
    run(`UPDATE intimations SET ${k} = ? WHERE id = ?`, v ?? null, id);
  }
}
/** Liga ao processo as intimações que chegaram antes de ele ser cadastrado. */
export function relinkIntimations(caseId) {
  const k = get('SELECT process_number FROM cases WHERE id = ?', caseId);
  const d = digitsOf(k?.process_number);
  if (d.length < 15) return 0;
  return Number(run('UPDATE intimations SET case_id = ? WHERE process_digits = ? AND case_id IS NULL', caseId, d).changes || 0);
}
/** Processos que aparecem nas intimações e ainda não estão cadastrados. */
export function unknownProcesses() {
  return all(`SELECT process_number, process_digits, MAX(date) AS last, COUNT(*) AS n, MAX(tribunal) AS tribunal, MAX(classe) AS classe,
                MAX(orgao) AS orgao, MAX(parties) AS parties
              FROM intimations WHERE case_id IS NULL AND process_digits <> '' AND status <> 'ignorada'
              GROUP BY process_digits ORDER BY last DESC`).map((r) => ({ ...r, parties: JSON.parse(r.parties || '[]') }));
}
export function markDatajud(caseId, error) { run('UPDATE cases SET datajud_checked_at = ?, datajud_error = ? WHERE id = ?', now(), error || null, caseId); }

export function deleteCaseDoc(id) {
  const d = get('SELECT * FROM case_docs WHERE id = ?', id);
  run('DELETE FROM case_docs WHERE id = ?', id);
  return d;
}

export function updateCrmFields(jid, fields) {
  const allowed = ['custom_name', 'email', 'company', 'value', 'folder', ...CLIENT_FIELDS];
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
export function saveContactType({ id, name, icon, color, personal, notify, autodownload }) {
  const tid = id || uniqueId('tipo');
  const pos = get('SELECT COUNT(*) AS n FROM contact_types')?.n || 0;
  run(`INSERT INTO contact_types (id, name, icon, color, personal, notify, autodownload, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, color = excluded.color,
         personal = excluded.personal, notify = excluded.notify, autodownload = excluded.autodownload`,
  tid, name, emojiToIcon(icon) || 'tag', color || '#94a3b8', personal ? 1 : 0, notify === false ? 0 : 1, autodownload ? 1 : 0, pos);
  return tid;
}

/** O tipo do contato manda baixar todos os arquivos automaticamente? */
export function chatAutoDownload(jid) {
  return !!get(`SELECT t.autodownload FROM crm JOIN contact_types t ON t.id = crm.type_id
                WHERE crm.jid = ? AND t.autodownload = 1`, jid);
}

/**
 * Palavras que você mais usa (das suas mensagens enviadas e respostas rápidas),
 * para sugerir o resto da palavra enquanto digita. Mais usadas primeiro.
 */
export function vocabulary({ messages = 6000, max = 4000 } = {}) {
  const freq = new Map();
  const add = (text, w = 1) => {
    for (const m of String(text || '').matchAll(/[\p{L}][\p{L}'-]{3,}/gu)) {
      const word = m[0].replace(/[-']+$/, '');
      if (word.length < 4 || /^https?/i.test(word)) continue;
      const k = word.toLowerCase();
      const e = freq.get(k) || { word: k, n: 0, caps: 0 };
      e.n += w;
      // nomes próprios / siglas: guarda a forma com maiúscula se ela é a mais comum
      if (word[0] !== word[0].toLowerCase() && m.index > 0) e.caps += w;
      freq.set(k, e);
    }
  };
  all(`SELECT text FROM messages WHERE from_me = 1 AND type = 'text' AND deleted = 0 AND text != ''
       ORDER BY ts DESC LIMIT ?`, messages).forEach((r) => add(r.text));
  all('SELECT text FROM quick_replies').forEach((r) => add(r.text, 3));
  return [...freq.values()]
    .filter((e) => e.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map((e) => (e.caps > e.n / 2 ? e.word[0].toUpperCase() + e.word.slice(1) : e.word));
}

export function markDownloadFailed(chatJid, id) {
  run('UPDATE messages SET dl_failed = dl_failed + 1 WHERE chat_jid = ? AND id = ?', chatJid, id);
}

/** Conversas cujo tipo baixa arquivos automaticamente (opcionalmente só de um tipo). */
export function autoDownloadChats(typeId = null) {
  return all(`SELECT crm.jid FROM crm JOIN contact_types t ON t.id = crm.type_id
              WHERE t.autodownload = 1 AND (? IS NULL OR t.id = ?)`, typeId, typeId).map((r) => r.jid);
}

/** Arquivos ainda não baixados de uma conversa (mais recentes primeiro). */
export function pendingMedia(jid, { since = 0, maxSize = Infinity } = {}) {
  return all(`SELECT id, type, media_size FROM messages
              WHERE chat_jid = ? AND type IN ('image', 'video', 'audio', 'ptt', 'document', 'sticker')
                AND media_file IS NULL AND raw IS NOT NULL AND deleted = 0 AND dl_failed < 2 AND ts >= ?
              ORDER BY ts DESC`, jid, since)
    .filter((m) => (m.media_size || 0) <= maxSize);
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
    run('UPDATE chat_filters SET name = ?, icon = ?, rules = ? WHERE id = ?', name, emojiToIcon(icon), JSON.stringify(rules || {}), id);
    return id;
  }
  const pos = get('SELECT COUNT(*) AS n FROM chat_filters')?.n || 0;
  return Number(run('INSERT INTO chat_filters (name, icon, rules, position) VALUES (?, ?, ?, ?)',
    name, emojiToIcon(icon), JSON.stringify(rules || {}), pos).lastInsertRowid);
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

export function logActivity(jid, kind, detail, userName = null) {
  run('INSERT INTO activity (jid, ts, kind, detail, user_name) VALUES (?, ?, ?, ?, ?)', jid, now(), kind, detail, userName);
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
// tarefas de interessados do comercial usam a chave "lead:<id>"
const TASK_SELECT = `SELECT k.*, c.title AS case_title, c.process_number, u.name AS assignee_name,
    COALESCE(cl.id, ck.id) AS client_id, COALESCE(cl.name, ck.name) AS client_name, ld.id AS lead_id, ld.name AS lead_name
  FROM tasks k LEFT JOIN cases c ON c.id = k.case_id LEFT JOIN users u ON u.id = k.assignee_id
  LEFT JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN clients ck ON c.id IS NULL AND (ck.jid = k.jid OR 'cliente:' || ck.id = k.jid)
  LEFT JOIN leads ld ON k.jid LIKE 'lead:%' AND 'lead:' || ld.id = k.jid`;

/** `assignee`: id de uma pessoa → as dela e as sem responsável. */
export function listTasks({ jid, caseId, includeDone = false, assignee } = {}) {
  const where = [];
  const args = [];
  if (jid) { where.push('k.jid = ?'); args.push(jid); }
  if (caseId) { where.push('k.case_id = ?'); args.push(caseId); }
  if (assignee) { where.push('(k.assignee_id = ? OR k.assignee_id IS NULL)'); args.push(assignee); }
  if (!includeDone) where.push('k.done = 0');
  return all(`${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
              ORDER BY k.done, CASE WHEN k.due_at IS NULL THEN 1 ELSE 0 END, k.due_at, k.id DESC`, ...args);
}

/** Painel do dia: atrasadas, de hoje (abertas e concluídas hoje) e da semana. */
export function tasksForDay({ dayStart, dayEnd, weekStart, weekEnd, assignee }) {
  const mine = assignee ? ' AND (k.assignee_id = ? OR k.assignee_id IS NULL)' : '';
  const a = assignee ? [assignee] : [];
  return {
    overdue: all(`${TASK_SELECT} WHERE k.done = 0 AND k.due_at IS NOT NULL AND k.due_at < ?${mine} ORDER BY k.due_at`, dayStart, ...a),
    today: all(`${TASK_SELECT} WHERE k.due_at >= ? AND k.due_at < ?${mine} ORDER BY k.done, k.due_at`, dayStart, dayEnd, ...a),
    week: all(`${TASK_SELECT} WHERE k.due_at >= ? AND k.due_at < ?${mine} ORDER BY k.due_at`, weekStart, weekEnd, ...a),
    doneToday: get(`SELECT COUNT(*) AS n FROM tasks k WHERE k.done = 1 AND k.done_at >= ? AND k.done_at < ?${mine}`, dayStart, dayEnd, ...a)?.n || 0,
    noDate: get(`SELECT COUNT(*) AS n FROM tasks k WHERE k.done = 0 AND k.due_at IS NULL${mine}`, ...a)?.n || 0,
  };
}

/** Casos abertos sem retorno ao cliente há mais de `ms` (para o painel; não marca aviso). */
export function casesWithoutUpdate(ms, limit = 20) {
  return all(`SELECT id, jid, client_id, (SELECT name FROM clients WHERE id = cases.client_id) AS client_name, title, COALESCE(last_update_at, created_at) AS since FROM cases
              WHERE status = 'aberto' AND COALESCE(last_update_at, created_at) < ? ORDER BY since LIMIT ?`, now() - ms, limit);
}
export function saveTask({ id, jid, title, due_at, done, case_id, kind, end_at, assignee_id }) {
  if (id) {
    const cur = get('SELECT * FROM tasks WHERE id = ?', id);
    if (!cur) return id;
    if (assignee_id !== undefined) run('UPDATE tasks SET assignee_id = ? WHERE id = ?', assignee_id || null, id);
    if (done !== undefined && !!done !== !!cur.done) run('UPDATE tasks SET done_at = ? WHERE id = ?', done ? now() : null, id);
    const newDue = due_at === undefined ? cur.due_at : due_at;
    if (end_at !== undefined || due_at !== undefined) {
      // mantém a duração quando só o início muda
      const dur = cur.end_at && cur.due_at ? cur.end_at - cur.due_at : null;
      const newEnd = end_at !== undefined ? end_at : (dur && newDue ? newDue + dur : cur.end_at);
      run('UPDATE tasks SET end_at = ? WHERE id = ?', newEnd || null, id);
    }
    run('UPDATE tasks SET title = ?, due_at = ?, done = ?, notified = ?, jid = ?, case_id = ?, kind = ? WHERE id = ?',
      title ?? cur.title, newDue, done === undefined ? cur.done : (done ? 1 : 0),
      newDue !== cur.due_at ? 0 : cur.notified,
      jid === undefined ? cur.jid : (jid || null), case_id === undefined ? cur.case_id : (case_id || null),
      kind || cur.kind || 'tarefa', id);
    return id;
  }
  if (case_id && !jid) jid = get('SELECT jid FROM cases WHERE id = ?', case_id)?.jid;
  return Number(run('INSERT INTO tasks (jid, title, due_at, created_at, case_id, kind, end_at, assignee_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    jid || null, title, due_at || null, now(), case_id || null, kind || 'tarefa', end_at || null, assignee_id || null).lastInsertRowid);
}
export function deleteTask(id) { run('DELETE FROM tasks WHERE id = ?', id); }
export function getTask(id) {
  return get(`SELECT k.*, c.title AS case_title, c.process_number, c.court, u.name AS assignee_name
              FROM tasks k LEFT JOIN cases c ON c.id = k.case_id LEFT JOIN users u ON u.id = k.assignee_id WHERE k.id = ?`, id);
}
export function setTaskGcal(id, eventId, calendarId) {
  run('UPDATE tasks SET gcal_event_id = ?, gcal_calendar_id = ?, gcal_synced_at = ? WHERE id = ?', eventId, calendarId, now(), id);
}
/** Tarefas com data que ainda não foram para o Google. */
export function tasksToSync() {
  return all('SELECT id FROM tasks WHERE due_at IS NOT NULL AND gcal_event_id IS NULL AND (done = 0 OR due_at > ?)', now() - 30 * 24 * 3600 * 1000);
}
/** Tarefas com data no intervalo (para mostrar na agenda). */
export function tasksInRange(from, to) {
  return all(`SELECT k.*, c.title AS case_title, c.process_number FROM tasks k LEFT JOIN cases c ON c.id = k.case_id
              WHERE k.due_at IS NOT NULL AND k.due_at >= ? AND k.due_at < ?`, from, to);
}
/**
 * Audiências que já terminaram (fim marcado, ou 2 h depois do início) e ainda
 * não tiveram o acompanhamento marcado como feito: agendar os prazos que saíram
 * e ficar de olho nas intimações (ata, sentença).
 */
const HEARING_END = 'COALESCE(k.end_at, k.due_at + 7200000)';
export function hearingsToFollowUp({ assignee } = {}) {
  return all(`${TASK_SELECT} WHERE k.kind = 'audiencia' AND k.due_at IS NOT NULL AND ${HEARING_END} <= ?
              AND k.followup_done_at IS NULL AND ${HEARING_END} > ?${assignee ? ' AND (k.assignee_id = ? OR k.assignee_id IS NULL)' : ''}
              ORDER BY k.due_at`, now(), now() - 30 * 864e5, ...(assignee ? [assignee] : []));
}
export function hearingsToNotify() {
  return all(`SELECT k.*, c.title AS case_title, c.responsible_id, (SELECT name FROM clients WHERE id = c.client_id) AS client_name
              FROM tasks k LEFT JOIN cases c ON c.id = k.case_id
              WHERE k.kind = 'audiencia' AND k.due_at IS NOT NULL AND k.followup_notified = 0 AND k.followup_done_at IS NULL
                AND ${HEARING_END} <= ?`, now());
}
export function markHearingNotified(id) { run('UPDATE tasks SET followup_notified = 1 WHERE id = ?', id); }
export function setHearingFollowUp(id, done = true) { run("UPDATE tasks SET followup_done_at = ? WHERE id = ? AND kind = 'audiencia'", done ? now() : null, id); }

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


