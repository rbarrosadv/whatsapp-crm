// Comercial: interessados (quem procurou o escritório e ainda não é cliente),
// registros de atendimento, proposta de honorários e "virar cliente".
// Tarefas/lembretes de um interessado usam a chave "lead:<id>" na coluna jid;
// ao virar cliente passam para a chave do cliente.
import * as db from './db.js';

const { run, get, all, tx } = db;
const now = () => Date.now();

export const LEAD_STAGES = [
  ['novo', 'Primeiro contato', '#94a3b8'],
  ['consulta', 'Consulta agendada', '#3b82f6'],
  ['proposta', 'Proposta enviada', '#f59e0b'],
  ['ganho', 'Fechou', '#22c55e'],
  ['perdido', 'Não fechou', '#ef4444'],
];
const STAGE_IDS = LEAD_STAGES.map((s) => s[0]);
export const stageLabel = (id) => LEAD_STAGES.find((s) => s[0] === id)?.[1] || id;

export const LEAD_SOURCES = ['Indicação', 'Instagram', 'Google', 'Site', 'WhatsApp', 'Passou no escritório', 'Cliente antigo', 'Outro'];
export const CONTACT_KINDS = { whatsapp: 'WhatsApp', ligacao: 'Ligação', presencial: 'Presencial', email: 'E-mail', video: 'Videochamada' };
export const FEE_KINDS = { fixo: 'Valor fixo', parcelado: 'Parcelado', exito: 'Êxito', fixo_exito: 'Fixo + êxito' };

const FIELDS = ['name', 'phone', 'email', 'jid', 'source', 'referred_by', 'area', 'subject', 'description',
  'responsible_id', 'consult_at', 'fee_kind', 'fee_total', 'fee_count', 'fee_percent', 'client_id', 'lost_reason'];

export const leadKey = (id) => `lead:${id}`;

const num = (v) => {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  return Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s) || 0;
};

function leadRow(l) {
  if (!l) return null;
  const key = leadKey(l.id);
  const next = get('SELECT id, title, due_at FROM tasks WHERE jid = ? AND done = 0 ORDER BY due_at IS NULL, due_at LIMIT 1', key);
  const last = get('SELECT MAX(at) AS t, COUNT(*) AS n FROM lead_contacts WHERE lead_id = ?', l.id);
  return {
    ...l,
    key,
    stage_label: stageLabel(l.stage),
    responsible_name: l.responsible_id ? get('SELECT name FROM users WHERE id = ?', l.responsible_id)?.name || null : null,
    client_name: l.client_id ? get('SELECT name FROM clients WHERE id = ?', l.client_id)?.name || null : null,
    next_task: next || null,
    last_contact_at: last?.t || null,
    contacts_count: last?.n || 0,
  };
}

const fold = (x) => String(x || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Lista de interessados. `open` = só os que ainda estão em negociação. */
export function listLeads({ q, stage, open, responsible, from, to } = {}) {
  const where = [];
  const args = [];
  if (stage) { where.push('stage = ?'); args.push(stage); }
  if (open) where.push("stage NOT IN ('ganho', 'perdido')");
  if (responsible) { where.push('(responsible_id = ? OR responsible_id IS NULL)'); args.push(responsible); }
  if (from) { where.push('created_at >= ?'); args.push(from); }
  if (to) { where.push('created_at < ?'); args.push(to); }
  let rows = all(`SELECT * FROM leads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`, ...args);
  const words = fold(q).split(/\s+/).filter(Boolean);
  const digits = String(q || '').replace(/\D/g, '');
  if (words.length) {
    rows = rows.filter((l) => words.every((w) => fold(`${l.name} ${l.email || ''} ${l.subject || ''} ${l.area || ''} ${l.source || ''} ${l.referred_by || ''}`).includes(w))
      || (digits.length >= 3 && String(l.phone || '').replace(/\D/g, '').includes(digits)));
  }
  return rows.map(leadRow);
}

export const getLead = (id) => leadRow(get('SELECT * FROM leads WHERE id = ?', id));

/** Interessado em aberto ligado a esta conversa do WhatsApp. */
export function leadByJid(jid) {
  if (!jid) return null;
  return leadRow(get("SELECT * FROM leads WHERE jid = ? ORDER BY stage IN ('ganho', 'perdido'), updated_at DESC LIMIT 1", jid));
}

export function saveLead(l, userName = null) {
  return tx(() => {
    let id = l.id;
    if (!id) {
      const name = String(l.name || '').trim();
      if (!name) throw new Error('Informe o nome do interessado.');
      const stage = STAGE_IDS.includes(l.stage) ? l.stage : 'novo';
      id = Number(run('INSERT INTO leads (name, stage, stage_changed_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        name, stage, now(), userName, now(), now()).lastInsertRowid);
    } else if (!get('SELECT 1 AS x FROM leads WHERE id = ?', id)) throw new Error('Interessado não encontrado');
    for (const f of FIELDS) {
      if (l[f] === undefined) continue;
      let v = l[f];
      if (['fee_total', 'fee_percent'].includes(f)) v = num(v);
      else if (['responsible_id', 'client_id', 'fee_count', 'consult_at'].includes(f)) v = v ? Number(v) : null;
      else if (f === 'fee_kind') v = FEE_KINDS[v] ? v : null;
      else v = v == null ? null : String(v).trim() || null;
      if (f === 'name' && !v) continue;
      run(`UPDATE leads SET ${f} = ?, updated_at = ? WHERE id = ?`, v, now(), id);
    }
    return id;
  });
}

/** Muda a etapa do funil. "Fechou" de verdade é pelo `convertLead` (cria cliente e processo). */
export function setLeadStage(id, stage, { lostReason } = {}) {
  if (!STAGE_IDS.includes(stage)) throw new Error('Etapa inválida');
  const l = get('SELECT * FROM leads WHERE id = ?', id);
  if (!l) throw new Error('Interessado não encontrado');
  if (l.stage === stage && lostReason === undefined) return;
  const closed = stage === 'ganho' || stage === 'perdido';
  run('UPDATE leads SET stage = ?, stage_changed_at = ?, closed_at = ?, lost_reason = ?, updated_at = ? WHERE id = ?',
    stage, now(), closed ? now() : null, stage === 'perdido' ? (lostReason ?? l.lost_reason) || null : null, now(), id);
  // quem não fechou não precisa mais de lembrete
  if (stage === 'perdido') run('UPDATE tasks SET done = 1, done_at = ? WHERE jid = ? AND done = 0', now(), leadKey(id));
}

export function deleteLead(id) {
  tx(() => {
    run('DELETE FROM tasks WHERE jid = ?', leadKey(id));
    run('DELETE FROM notes WHERE jid = ?', leadKey(id));
    run('DELETE FROM lead_contacts WHERE lead_id = ? AND client_id IS NULL', id);
    run('UPDATE lead_contacts SET lead_id = NULL WHERE lead_id = ?', id);
    run('DELETE FROM leads WHERE id = ?', id);
  });
}

// ------------------------------------------------------------ atendimentos

export function listContacts({ leadId, clientId } = {}) {
  if (!leadId && !clientId) return [];
  const where = [];
  const args = [];
  if (leadId) { where.push('lead_id = ?'); args.push(leadId); }
  if (clientId) { where.push('client_id = ?'); args.push(clientId); }
  return all(`SELECT * FROM lead_contacts WHERE ${where.join(' OR ')} ORDER BY at DESC, id DESC`, ...args)
    .map((c) => ({ ...c, kind_label: CONTACT_KINDS[c.kind] || c.kind }));
}

/** Registra um atendimento (ligação, reunião…) do interessado ou do cliente. */
export function addContact({ lead_id, client_id, kind, at, summary, next_step }, userName = null) {
  if (!lead_id && !client_id) throw new Error('Atendimento sem interessado nem cliente.');
  if (!CONTACT_KINDS[kind]) throw new Error('Escolha como foi o atendimento.');
  const text = String(summary || '').trim();
  if (!text) throw new Error('Escreva um resumo do atendimento.');
  let cid = client_id || null;
  if (lead_id && !cid) cid = get('SELECT client_id FROM leads WHERE id = ?', lead_id)?.client_id || null;
  const id = Number(run('INSERT INTO lead_contacts (lead_id, client_id, kind, at, summary, next_step, user_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    lead_id || null, cid, kind, Number(at) || now(), text, String(next_step || '').trim() || null, userName, now()).lastInsertRowid);
  if (lead_id) run('UPDATE leads SET updated_at = ? WHERE id = ?', now(), lead_id);
  return id;
}

export function deleteContact(id) { run('DELETE FROM lead_contacts WHERE id = ?', id); }
export const getContact = (id) => get('SELECT * FROM lead_contacts WHERE id = ?', id);

// ------------------------------------------------------------ proposta

const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Honorários da proposta em texto ("R$ 6.000,00 em 6 parcelas de R$ 1.000,00"). */
export function feeText(l) {
  const total = Number(l.fee_total) || 0;
  const n = Math.max(1, Number(l.fee_count) || 1);
  const pct = Number(l.fee_percent) || 0;
  switch (l.fee_kind) {
    case 'fixo': return total ? `${money(total)}${n > 1 ? `, que podem ser pagos em ${n} parcelas de ${money(total / n)}` : ''}` : '';
    case 'parcelado': return total ? `${money(total)}, em ${n} parcelas mensais de ${money(total / n)}` : '';
    case 'exito': return pct ? `${String(pct).replace('.', ',')}% sobre o proveito econômico obtido, pagos somente em caso de êxito` : '';
    case 'fixo_exito': return [total ? `${money(total)}${n > 1 ? ` (em ${n} parcelas de ${money(total / n)})` : ''}` : '',
      pct ? `mais ${String(pct).replace('.', ',')}% sobre o proveito econômico em caso de êxito` : ''].filter(Boolean).join(', ');
    default: return '';
  }
}

export const DEFAULT_PROPOSAL_TEMPLATE = 'Olá, {nome}! Conforme conversamos, segue a nossa proposta de honorários para {assunto}.\n\n'
  + 'Honorários: {honorarios}.\n\nO trabalho inclui o estudo do caso, a elaboração das peças e o acompanhamento do processo até o final, '
  + 'com retorno a você a cada andamento importante.\n\nEsta proposta vale por {validade} dias. Qualquer dúvida, estou à disposição.\n\n{escritorio}';

export function proposalText(l, template, { office = 'Barros Associados', validDays = 15 } = {}) {
  const vars = {
    nome: String(l.name || '').split(/\s+/)[0] || '',
    nome_completo: l.name || '',
    assunto: l.subject || l.area || 'o seu caso',
    area: l.area || '',
    honorarios: feeText(l) || 'a combinar',
    validade: String(validDays),
    escritorio: office,
  };
  return String(template || DEFAULT_PROPOSAL_TEMPLATE).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function markProposalSent(id, text) {
  const l = get('SELECT * FROM leads WHERE id = ?', id);
  if (!l) throw new Error('Interessado não encontrado');
  run('UPDATE leads SET proposal_text = ?, proposal_sent_at = ?, updated_at = ? WHERE id = ?', text || null, now(), now(), id);
  if (['novo', 'consulta'].includes(l.stage)) setLeadStage(id, 'proposta');
}

// ------------------------------------------------------------ virar cliente

/**
 * O interessado fechou: cria (ou usa) o cliente, abre o processo com os
 * honorários da proposta e leva atendimentos, notas e lembretes junto.
 * `firstDue` (data da 1ª parcela) só gera parcelas se informado.
 */
export function convertLead(id, { clientId, stageId, title, firstDue } = {}, userName = null) {
  return tx(() => {
    const l = get('SELECT * FROM leads WHERE id = ?', id);
    if (!l) throw new Error('Interessado não encontrado');
    if (l.case_id && db.getCase(l.case_id)) throw new Error('Este interessado já virou cliente.');
    let cid = clientId || l.client_id || null;
    if (!cid && l.jid) cid = db.clientByJid(l.jid)?.id || null;
    if (!cid) {
      const phone = l.phone || (l.jid?.endsWith('@s.whatsapp.net') ? l.jid.split('@')[0] : null);
      cid = db.saveClient({ name: l.name, jid: l.jid || null, phone, email: l.email,
        origin: [l.source, l.referred_by ? `indicação de ${l.referred_by}` : null].filter(Boolean).join(' — ') || null, userName });
    }
    const cl = db.getClient(cid);
    if (!cl) throw new Error('Cliente não encontrado');
    if (!stageId) {
      const st = get("SELECT s.id FROM stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE p.id = 'casos' ORDER BY s.position LIMIT 1")
        || get('SELECT s.id FROM stages s JOIN pipelines p ON p.id = s.pipeline_id ORDER BY p.position, s.position LIMIT 1');
      stageId = st?.id || null;
    }
    const k = l.fee_kind;
    const caseId = db.saveCase({
      client_id: cid, stage_id: stageId, title: String(title || l.subject || l.area || 'Novo caso').trim(),
      area: l.area, description: l.description, responsible_id: l.responsible_id,
      fee_fixed: k === 'fixo' || k === 'fixo_exito', fee_installments: k === 'parcelado', fee_success: k === 'exito' || k === 'fixo_exito',
      fee_total: l.fee_total, fee_percent: l.fee_percent,
    });
    if (firstDue && Number(l.fee_total) > 0 && k && k !== 'exito') {
      db.generateInstallments(caseId, { total: l.fee_total, count: l.fee_count || 1, firstDue, description: 'Honorários' });
    }
    const to = db.clientKey(cl);
    for (const t of ['tasks', 'notes', 'activity']) run(`UPDATE ${t} SET jid = ? WHERE jid = ?`, to, leadKey(id));
    run('UPDATE lead_contacts SET client_id = ? WHERE lead_id = ?', cid, id);
    run("UPDATE leads SET stage = 'ganho', stage_changed_at = ?, closed_at = ?, client_id = ?, case_id = ?, updated_at = ? WHERE id = ?",
      now(), now(), cid, caseId, now(), id);
    db.logActivity(to, 'client', `Fechou com o escritório (comercial${l.source ? ` · ${l.source}` : ''})`, userName);
    return { clientId: cid, caseId, key: to };
  });
}

// ------------------------------------------------------------ números

/** Resumo do comercial no período (novos, fechados, conversão, origem, propostas em aberto). */
export function leadStats({ from, to } = {}) {
  const f = from || 0;
  const t = to || now() + 1;
  const created = all('SELECT * FROM leads WHERE created_at >= ? AND created_at < ?', f, t);
  const won = get("SELECT COUNT(*) AS n FROM leads WHERE stage = 'ganho' AND closed_at >= ? AND closed_at < ?", f, t)?.n || 0;
  const lost = get("SELECT COUNT(*) AS n FROM leads WHERE stage = 'perdido' AND closed_at >= ? AND closed_at < ?", f, t)?.n || 0;
  const bySource = {};
  for (const l of created) bySource[l.source || 'Não informado'] = (bySource[l.source || 'Não informado'] || 0) + 1;
  const openProposals = all("SELECT fee_total FROM leads WHERE stage = 'proposta'");
  const byStage = Object.fromEntries(LEAD_STAGES.map(([s]) => [s, get('SELECT COUNT(*) AS n FROM leads WHERE stage = ?', s)?.n || 0]));
  const lostReasons = {};
  for (const r of all("SELECT lost_reason FROM leads WHERE stage = 'perdido' AND closed_at >= ? AND closed_at < ?", f, t)) {
    const k = r.lost_reason || 'Não informado';
    lostReasons[k] = (lostReasons[k] || 0) + 1;
  }
  return {
    created: created.length, won, lost,
    conversion: won + lost ? Math.round((won / (won + lost)) * 100) : null,
    bySource: Object.entries(bySource).map(([label, value]) => ({ label, value })),
    lostReasons: Object.entries(lostReasons).map(([label, value]) => ({ label, value })),
    byStage,
    proposalsOpen: openProposals.length,
    proposalsValue: openProposals.reduce((a, x) => a + (Number(x.fee_total) || 0), 0),
  };
}
