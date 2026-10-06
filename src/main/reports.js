// Relatórios do escritório por período: visão geral (processos, prazos,
// clientes, intimações), equipe (o que cada pessoa fez), comercial,
// atendimento pelo WhatsApp e financeiro. Só leitura; tudo em milissegundos.
import * as db from './db.js';
import * as leads from './leads.js';

const { get, all } = db;
const DAY = 864e5;

const endOfDay = (ts) => { const d = new Date(ts); d.setHours(23, 59, 59, 999); return d.getTime(); };
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Meses (início de cada um) que cobrem o período, no máximo 24. */
function monthsOf(from, to) {
  const out = [];
  const d = new Date(from); d.setDate(1); d.setHours(0, 0, 0, 0);
  while (d.getTime() < to && out.length < 24) {
    const start = d.getTime();
    d.setMonth(d.getMonth() + 1);
    out.push({ key: `${new Date(start).getFullYear()}-${String(new Date(start).getMonth() + 1).padStart(2, '0')}`, start, end: d.getTime() });
  }
  return out;
}

/** Prazos (tarefas `prazo`) que venciam no período: cumpridos no prazo, com atraso, vencidos em aberto, a vencer. */
function deadlines(from, to, assignee) {
  const rows = all(`SELECT id, due_at, done, done_at, assignee_id FROM tasks WHERE kind = 'prazo' AND due_at >= ? AND due_at < ?${assignee ? ' AND assignee_id = ?' : ''}`,
    from, to, ...(assignee ? [assignee] : []));
  const now = Date.now();
  const r = { total: rows.length, onTime: 0, late: 0, overdue: 0, pending: 0 };
  for (const t of rows) {
    if (t.done) {
      if (!t.done_at || t.done_at <= endOfDay(t.due_at)) r.onTime++; else r.late++;
    } else if (t.due_at < now) r.overdue++;
    else r.pending++;
  }
  const decided = r.onTime + r.late + r.overdue;
  r.rate = decided ? Math.round((r.onTime / decided) * 100) : null;
  return r;
}

export function overview({ from, to }) {
  const opened = get('SELECT COUNT(*) AS n FROM cases WHERE created_at >= ? AND created_at < ?', from, to).n;
  const closed = get("SELECT COUNT(*) AS n FROM cases WHERE status <> 'aberto' AND closed_at >= ? AND closed_at < ?", from, to).n;
  const active = get("SELECT COUNT(*) AS n FROM cases WHERE status = 'aberto'").n;
  const byArea = all(`SELECT COALESCE(NULLIF(TRIM(area), ''), 'Sem área') AS label, COUNT(*) AS value FROM cases
                      WHERE status = 'aberto' GROUP BY label ORDER BY value DESC`);
  const byResponsible = all(`SELECT COALESCE(u.name, 'Sem responsável') AS label, COUNT(*) AS value FROM cases c
                             LEFT JOIN users u ON u.id = c.responsible_id WHERE c.status = 'aberto' GROUP BY label ORDER BY value DESC`);
  const byStage = all(`SELECT p.name || ' → ' || s.name AS label, COUNT(c.id) AS value FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
                       LEFT JOIN cases c ON c.stage_id = s.id AND c.status = 'aberto'
                       GROUP BY s.id ORDER BY p.position, s.position`);
  const months = monthsOf(Math.min(from, to - 365 * DAY + DAY), to).slice(-12).map((m) => ({
    month: m.key,
    opened: get('SELECT COUNT(*) AS n FROM cases WHERE created_at >= ? AND created_at < ?', m.start, m.end).n,
    closed: get("SELECT COUNT(*) AS n FROM cases WHERE status <> 'aberto' AND closed_at >= ? AND closed_at < ?", m.start, m.end).n,
  }));
  return {
    cases: { opened, closed, active, byArea, byResponsible, byStage: byStage.filter((x) => x.value), months },
    clients: {
      created: get('SELECT COUNT(*) AS n FROM clients WHERE created_at >= ? AND created_at < ?', from, to).n,
      active: get("SELECT COUNT(*) AS n FROM clients WHERE status = 'ativo'").n,
    },
    deadlines: deadlines(from, to),
    hearings: get("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'audiencia' AND due_at >= ? AND due_at < ?", from, to).n,
    intimations: {
      received: get('SELECT COUNT(*) AS n FROM intimations WHERE COALESCE(date, created_at) >= ? AND COALESCE(date, created_at) < ?', from, to).n,
      pending: get("SELECT COUNT(*) AS n FROM intimations WHERE status = 'nova'").n,
    },
    moves: get("SELECT COUNT(*) AS n FROM case_moves WHERE ts >= ? AND ts < ? AND source <> 'manual'", from, to).n,
  };
}

/** Quem mandou cada mensagem enviada: pela assinatura "*Nome:*" na 1ª linha. */
function sentBySignature(from, to, users) {
  const bySig = new Map(users.map((u) => [String(u.signature || u.name.split(/\s+/)[0]).trim().toLowerCase(), u.id]));
  const out = new Map();
  let unsigned = 0;
  for (const m of all("SELECT text FROM messages WHERE from_me = 1 AND ts >= ? AND ts < ? AND type NOT IN ('system', 'call')", from, to)) {
    const sig = /^\*([^*\n]{1,40}):\*/.exec(m.text || '')?.[1]?.trim().toLowerCase();
    const id = sig ? bySig.get(sig) : null;
    if (id) out.set(id, (out.get(id) || 0) + 1); else unsigned++;
  }
  return { out, unsigned };
}

/** Uma linha por pessoa ativa da equipe. */
export function team({ from, to }) {
  const users = all('SELECT id, name, role, signature FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE');
  const sent = sentBySignature(from, to, users);
  const rows = users.map((u) => {
    const dl = deadlines(from, to, u.id);
    return {
      id: u.id,
      name: u.name,
      role: u.role,
      casesActive: get("SELECT COUNT(*) AS n FROM cases WHERE status = 'aberto' AND responsible_id = ?", u.id).n,
      casesOpened: get('SELECT COUNT(*) AS n FROM cases WHERE responsible_id = ? AND created_at >= ? AND created_at < ?', u.id, from, to).n,
      tasksDone: get('SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND done = 1 AND done_at >= ? AND done_at < ?', u.id, from, to).n,
      tasksOverdue: get('SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND done = 0 AND due_at IS NOT NULL AND due_at < ?', u.id, Date.now()).n,
      deadlinesOnTime: dl.onTime,
      deadlinesLate: dl.late + dl.overdue,
      contacts: get('SELECT COUNT(*) AS n FROM lead_contacts WHERE user_name = ? AND at >= ? AND at < ?', u.name, from, to).n,
      messages: sent.out.get(u.id) || 0,
      leadsWon: get("SELECT COUNT(*) AS n FROM leads WHERE responsible_id = ? AND stage = 'ganho' AND closed_at >= ? AND closed_at < ?", u.id, from, to).n,
    };
  });
  return { rows, unsignedMessages: sent.unsigned };
}

export function commercial({ from, to }) {
  const s = leads.leadStats({ from, to });
  const won = all("SELECT created_at, closed_at FROM leads WHERE stage = 'ganho' AND closed_at >= ? AND closed_at < ?", from, to);
  const byResponsible = all(`SELECT COALESCE(u.name, 'Sem responsável') AS label, COUNT(*) AS value FROM leads l
                             LEFT JOIN users u ON u.id = l.responsible_id WHERE l.created_at >= ? AND l.created_at < ?
                             GROUP BY label ORDER BY value DESC`, from, to);
  const sourceWon = all(`SELECT COALESCE(source, 'Não informado') AS label, SUM(stage = 'ganho') AS won, COUNT(*) AS total
                         FROM leads WHERE created_at >= ? AND created_at < ? GROUP BY label ORDER BY total DESC`, from, to);
  return {
    ...s,
    daysToClose: won.length ? Math.round(median(won.map((l) => (l.closed_at - l.created_at) / DAY)) * 10) / 10 : null,
    byResponsible,
    sourceWon,
  };
}

/**
 * Atendimento pelo WhatsApp (conversas de trabalho, sem grupos): mensagens
 * recebidas/enviadas e o tempo até a 1ª resposta depois que o contato escreve.
 */
export function whatsapp({ from, to }) {
  const rows = all(`SELECT m.chat_jid, m.ts, m.from_me FROM messages m JOIN chats c ON c.jid = m.chat_jid
                    LEFT JOIN crm ON crm.jid = m.chat_jid LEFT JOIN contact_types t ON t.id = crm.type_id
                    WHERE c.is_group = 0 AND COALESCE(t.personal, 0) = 0 AND m.type NOT IN ('system', 'call')
                      AND m.ts >= ? AND m.ts < ? ORDER BY m.chat_jid, m.ts`, from, to);
  let received = 0;
  let sent = 0;
  const waits = [];
  const chats = new Set();
  let unanswered = 0;
  let cur = null;
  let waitingSince = null;
  const close = () => { if (waitingSince != null) unanswered++; };
  for (const m of rows) {
    if (m.chat_jid !== cur) { close(); cur = m.chat_jid; waitingSince = null; }
    chats.add(m.chat_jid);
    if (m.from_me) {
      sent++;
      if (waitingSince != null) { const w = m.ts - waitingSince; if (w <= 7 * DAY) waits.push(w); waitingSince = null; }
    } else {
      received++;
      if (waitingSince == null) waitingSince = m.ts;
    }
  }
  close();
  const firstMsg = all(`SELECT m.chat_jid, MIN(m.ts) AS first FROM messages m JOIN chats c ON c.jid = m.chat_jid
                        WHERE c.is_group = 0 GROUP BY m.chat_jid HAVING first >= ? AND first < ?`, from, to);
  // horário em que os contatos mais escrevem (0–23 h)
  const hours = Array.from({ length: 24 }, () => 0);
  for (const m of rows) if (!m.from_me) hours[new Date(m.ts).getHours()]++;
  return {
    received, sent, chats: chats.size, newChats: firstMsg.length,
    medianResponse: median(waits),
    within1h: waits.length ? Math.round((waits.filter((w) => w <= 3600e3).length / waits.length) * 100) : null,
    answered: waits.length, unanswered,
    hours,
  };
}

export function finance({ from, to }) {
  const paid = get(`SELECT COALESCE(SUM(COALESCE(paid_amount, amount)), 0) AS v, COUNT(*) AS n FROM payments WHERE paid_at >= ? AND paid_at < ?`, from, to);
  const avulsa = get('SELECT COALESCE(SUM(amount), 0) AS v, COUNT(*) AS n FROM incomes WHERE received_at >= ? AND received_at < ?', from, to);
  const reimb = get('SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE reimbursed_at >= ? AND reimbursed_at < ?', from, to).v;
  const expenses = get('SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE paid_at >= ? AND paid_at < ?', from, to).v;
  const billed = get('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE due_at >= ? AND due_at < ?', from, to).v;
  const billedPaid = get('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE due_at >= ? AND due_at < ? AND paid_at IS NOT NULL', from, to).v;
  const overdue = get('SELECT COALESCE(SUM(amount), 0) AS v, COUNT(*) AS n FROM payments WHERE paid_at IS NULL AND due_at < ?', Date.now());
  const received = paid.v + avulsa.v + reimb;
  const topClients = all(`SELECT label, SUM(value) AS value FROM (
      SELECT COALESCE(cl.name, 'Sem cliente') AS label, COALESCE(p.paid_amount, p.amount) AS value
      FROM payments p JOIN cases c ON c.id = p.case_id LEFT JOIN clients cl ON cl.id = c.client_id WHERE p.paid_at >= ? AND p.paid_at < ?
      UNION ALL
      SELECT COALESCE(cl.name, i.payer_name, 'Avulsa') AS label, i.amount AS value FROM incomes i LEFT JOIN clients cl ON cl.id = i.client_id
      WHERE i.received_at >= ? AND i.received_at < ?
    ) GROUP BY label ORDER BY value DESC LIMIT 10`, from, to, from, to);
  const byArea = all(`SELECT label, SUM(value) AS value FROM (
      SELECT COALESCE(NULLIF(TRIM(c.area), ''), 'Sem área') AS label, COALESCE(p.paid_amount, p.amount) AS value
      FROM payments p JOIN cases c ON c.id = p.case_id WHERE p.paid_at >= ? AND p.paid_at < ?
      UNION ALL
      SELECT 'Avulsa: ' || COALESCE(category, 'outras') AS label, amount AS value FROM incomes WHERE received_at >= ? AND received_at < ?
    ) GROUP BY label ORDER BY value DESC`, from, to, from, to);
  const byResponsible = all(`SELECT COALESCE(u.name, 'Sem responsável') AS label, SUM(COALESCE(p.paid_amount, p.amount)) AS value
      FROM payments p JOIN cases c ON c.id = p.case_id LEFT JOIN users u ON u.id = c.responsible_id
      WHERE p.paid_at >= ? AND p.paid_at < ? GROUP BY label ORDER BY value DESC`, from, to);
  const expByCategory = all(`SELECT COALESCE(category, CASE kind WHEN 'custa' THEN 'Custas de processo' ELSE 'Outras' END) AS label, SUM(amount) AS value
      FROM expenses WHERE paid_at >= ? AND paid_at < ? GROUP BY label ORDER BY value DESC`, from, to);
  const months = monthsOf(from, to).map((m) => ({
    month: m.key,
    in: get('SELECT COALESCE(SUM(COALESCE(paid_amount, amount)), 0) AS v FROM payments WHERE paid_at >= ? AND paid_at < ?', m.start, m.end).v
      + get('SELECT COALESCE(SUM(amount), 0) AS v FROM incomes WHERE received_at >= ? AND received_at < ?', m.start, m.end).v
      + get('SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE reimbursed_at >= ? AND reimbursed_at < ?', m.start, m.end).v,
    out: get('SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE paid_at >= ? AND paid_at < ?', m.start, m.end).v,
  }));
  return {
    received, fees: paid.v, avulsa: avulsa.v, reimbursed: reimb, expenses, result: received - expenses,
    billed, collection: billed ? Math.round((billedPaid / billed) * 100) : null,
    overdue: overdue.v, overdueCount: overdue.n,
    ticket: paid.n + avulsa.n ? (paid.v + avulsa.v) / (paid.n + avulsa.n) : null,
    topClients, byArea, byResponsible, expByCategory, months,
  };
}
