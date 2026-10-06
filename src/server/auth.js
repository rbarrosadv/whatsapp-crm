// Equipe: usuários, senhas, sessões e o que cada perfil pode fazer.
import crypto from 'node:crypto';
import * as db from '../main/db.js';

export const ROLES = {
  socio: 'Sócio',
  advogado: 'Advogado',
  estagiario: 'Estagiário(a)',
};

const SESSION_DAYS = 30;
const DAY = 24 * 3600 * 1000;

// ------------------------------------------------------------ senhas

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}

function validPassword(p) {
  if (String(p || '').length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');
}

// ------------------------------------------------------------ usuários

function parsePrefs(s) {
  try { return JSON.parse(s || '{}') || {}; } catch { return {}; }
}

/** Usuário sem o hash da senha (o que pode ir para a interface). */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, login: u.login, role: u.role, roleLabel: ROLES[u.role] || u.role,
    signature: u.signature || defaultSignature(u.name), active: !!u.active, last_login: u.last_login,
  };
}

export function defaultSignature(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

export function countUsers() {
  return db.get('SELECT COUNT(*) AS n FROM users')?.n || 0;
}

export function listUsers() {
  return db.all('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE').map(publicUser);
}

export function getUser(id) {
  return db.get('SELECT * FROM users WHERE id = ?', id) || null;
}

export function userPrefs(id) {
  return parsePrefs(getUser(id)?.prefs);
}

export function setUserPref(id, key, value) {
  const prefs = userPrefs(id);
  prefs[key] = value;
  db.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(prefs), id);
  return prefs;
}

function cleanLogin(login) {
  const l = String(login || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(l)) throw new Error('Login: use de 2 a 40 letras sem acento, números, ponto ou traço.');
  return l;
}

/** Cria ou atualiza um usuário. `password` só é obrigatório na criação. */
export function saveUser({ id, name, login, role, signature, password, active }) {
  name = String(name || '').trim();
  if (!name) throw new Error('Informe o nome.');
  if (role && !ROLES[role]) throw new Error('Perfil inválido.');
  const l = cleanLogin(login);
  const dup = db.get('SELECT id FROM users WHERE login = ? AND id IS NOT ?', l, id || null);
  if (dup) throw new Error('Já existe alguém com esse login.');
  const sig = String(signature ?? '').trim() || null;
  if (id) {
    const cur = getUser(id);
    if (!cur) throw new Error('Usuário não encontrado.');
    const newRole = role || cur.role;
    const newActive = active === undefined ? cur.active : (active ? 1 : 0);
    if (cur.role === 'socio' && (newRole !== 'socio' || !newActive) && activeSocios(id) === 0) {
      throw new Error('O escritório precisa de pelo menos um sócio ativo.');
    }
    db.run('UPDATE users SET name = ?, login = ?, role = ?, signature = ?, active = ? WHERE id = ?',
      name, l, newRole, sig, newActive, id);
    if (password) setPassword(id, password);
    if (!newActive) db.run('DELETE FROM sessions WHERE user_id = ?', id);
    return id;
  }
  validPassword(password);
  return Number(db.run(
    'INSERT INTO users (name, login, role, signature, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    name, l, role || 'advogado', sig, hashPassword(password), Date.now(),
  ).lastInsertRowid);
}

function activeSocios(exceptId) {
  return db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'socio' AND active = 1 AND id != ?", exceptId)?.n || 0;
}

export function setPassword(id, password) {
  validPassword(password);
  db.run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(password), id);
}

/** Primeiro acesso: cria o sócio administrador. Só funciona com o banco sem usuários. */
export function setupFirstUser({ name, login, password }) {
  if (countUsers() > 0) throw new Error('O sistema já tem usuários. Entre com o seu login.');
  return saveUser({ name, login, password, role: 'socio' });
}

/** Confere login e senha; devolve o usuário (ou null). */
export function authenticate(login, password) {
  const u = db.get('SELECT * FROM users WHERE login = ? AND active = 1', String(login || '').trim().toLowerCase());
  if (!u || !checkPassword(password, u.pass_hash)) return null;
  db.run('UPDATE users SET last_login = ? WHERE id = ?', Date.now(), u.id);
  return u;
}

// ------------------------------------------------------------ sessões

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(userId, agent) {
  const token = crypto.randomBytes(32).toString('hex');
  const t = Date.now();
  db.run('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, agent) VALUES (?, ?, ?, ?, ?)',
    sha(token), userId, t, t, String(agent || '').slice(0, 200));
  return token;
}

/** Usuário dono da sessão (ativo e dentro do prazo), ou null. Renova o prazo a cada uso. */
export function sessionUser(token) {
  if (!token) return null;
  const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', sha(token));
  if (!s) return null;
  if (Date.now() - s.last_seen > SESSION_DAYS * DAY) {
    db.run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
    return null;
  }
  const u = getUser(s.user_id);
  if (!u || !u.active) return null;
  if (Date.now() - s.last_seen > 60 * 1000) db.run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', Date.now(), s.token_hash);
  return u;
}

export function endSession(token) {
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
}

// ------------------------------------------------------------ permissões

// Métodos da API que cada perfil NÃO pode chamar. O sócio pode tudo.
const ADMIN_ONLY = [
  /^users:(save|list)$/, 'backup:export', /^wa:(logout|reset)$/, 'legacy:import',
  /^google:(importClient|disconnect)$/, 'cases:delete', 'finance:delete', 'finance:deleteExpense',
];
const DENY = {
  socio: [],
  advogado: ADMIN_ONLY,
  estagiario: [
    ...ADMIN_ONLY,
    /^finance:/, 'stats',
    /^(pipelines|types|filters|tags):(save|delete|reorder)$/,
    'cases:setStatus', 'messages:delete', /^oabs:(save|delete)$/,
  ],
};

export function can(role, method) {
  const rules = DENY[role] || DENY.estagiario;
  return !rules.some((r) => (typeof r === 'string' ? r === method : r.test(method)));
}

/** O que cada perfil vê (a interface esconde o que não pode). */
export function capabilities(role) {
  return {
    finance: can(role, 'finance:list'),
    admin: role === 'socio',
    configure: can(role, 'pipelines:save'),
    deleteCases: can(role, 'cases:delete'),
  };
}

// Campos de dinheiro tirados dos casos para quem não vê o financeiro.
const MONEY_FIELDS = ['fee_fixed', 'fee_installments', 'fee_success', 'fee_total', 'fee_percent',
  'paid_total', 'billed_total', 'payments_count', 'overdue_payments'];

export function stripMoney(v) {
  if (Array.isArray(v)) return v.map(stripMoney);
  if (!v || typeof v !== 'object') return v;
  const out = { ...v };
  for (const k of MONEY_FIELDS) delete out[k];
  return out;
}
