// Financeiro: todas as parcelas de honorários, com cobrança pelo WhatsApp.
import { h, fill, fmtMoney, normalize, debounce, errToast, toast, confirmDialog, modal } from '../util.js';
import { state, on, api } from '../store.js';
import { emptyState } from '../components.js';
import { paymentRow, newCaseDialog } from './casemodal.js';

let root;
let filter = 'open';
let q = '';

export function mountFinance(el) {
  root = el;
  const refresh = () => state.view === 'finance' && render();
  on('view', (v) => v === 'finance' && render());
  on('finance', refresh);
  on('cases', refresh);
}

function stat(label, value, cls, sub, onClick) {
  return h('div', { class: `stat ${cls || ''} ${onClick ? 'clickable' : ''}`, onclick: onClick },
    h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), sub ? h('div', { class: 'muted small' }, sub) : null);
}

async function render() {
  const [sum, pays] = await Promise.all([api('finance:summary'), api('finance:list', { status: filter === 'all' ? undefined : filter })]);
  const nq = normalize(q);
  const list = nq ? pays.filter((p) => normalize(`${state.chats.get(p.jid)?.display_name || ''} ${p.case_title} ${p.description || ''} ${p.process_number || ''}`).includes(nq)) : pays;
  const total = list.reduce((a, p) => a + p.amount, 0);
  const chip = (key, label) => h('button', { class: `chip ${filter === key ? 'active' : ''}`, onclick: () => { filter = key; render(); } }, label);

  fill(root,
    h('div', { class: 'page-head' },
      h('h2', null, '💰 Financeiro'),
      h('div', { class: 'row' },
        h('input', { class: 'input search', type: 'search', placeholder: 'Cliente, caso, processo…', value: q, oninput: debounce((e) => { q = e.target.value; render(); }, 200) }),
        h('button', { class: 'btn', onclick: () => newCaseDialog(null) }, '＋ Novo caso'))),
    h('div', { class: 'stats' },
      stat('Vencido', fmtMoney(sum.overdue), sum.overdue ? 'stat-bad' : '', `${sum.overdueCount} parcela(s)`, () => { filter = 'overdue'; render(); }),
      stat('A receber este mês', fmtMoney(sum.dueMonth), '', null, () => { filter = 'upcoming'; render(); }),
      stat('Recebido este mês', fmtMoney(sum.receivedMonth), 'stat-ok', null, () => { filter = 'paid'; render(); }),
      stat('Total em aberto', fmtMoney(sum.openTotal), '', null, () => { filter = 'open'; render(); })),
    h('div', { class: 'row wrap finance-bar' },
      h('div', { class: 'chips' }, chip('overdue', '⚠ Vencidas'), chip('upcoming', '📅 A vencer'), chip('open', 'Em aberto'), chip('paid', '✔ Pagas'), chip('all', 'Todas')),
      h('div', { class: 'grow' }),
      h('span', { class: 'muted' }, `${list.length} parcela(s) · ${fmtMoney(total)}`),
      filter === 'overdue' && list.length > 1 ? h('button', { class: 'btn btn-primary btn-sm', onclick: () => chargeMany(list) }, `📤 Cobrar as ${list.length} vencidas`) : null),
    list.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Situação', 'Cliente / Caso', 'Descrição', 'Vencimento', 'Valor', ''].map((t) => h('th', null, t)))),
        h('tbody', null, list.map((p) => paymentRow(p, { showCase: true })))))
      : emptyState('💰', filter === 'overdue' ? 'Nenhuma parcela vencida 🎉' : 'Nenhuma parcela aqui',
        'Os honorários são lançados dentro de cada caso (aba 💰 Honorários da ficha do caso).'));
}

/** Envia a cobrança padrão para várias parcelas, uma de cada vez, com intervalo. */
async function chargeMany(list) {
  const names = [...new Set(list.map((p) => state.chats.get(p.jid)?.display_name || 'contato'))];
  if (!await confirmDialog(`Enviar a mensagem de cobrança padrão para ${list.length} parcela(s) vencida(s) (${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''})? As mensagens saem uma de cada vez, com alguns segundos de intervalo.`, { okLabel: 'Enviar cobranças' })) return;
  const progress = h('div', null, 'Preparando…');
  let stop = false;
  const m = modal({ title: 'Enviando cobranças', body: progress, actions: [{ label: 'Parar', onClick: () => { stop = true; } }] });
  let ok = 0;
  for (let i = 0; i < list.length && !stop; i++) {
    const p = list[i];
    fill(progress, `Enviando ${i + 1} de ${list.length}: ${state.chats.get(p.jid)?.display_name || ''} — ${fmtMoney(p.amount)}`);
    try { await api('finance:sendCharge', p.id); ok++; } catch (e) { errToast(e); }
    if (i < list.length - 1) await new Promise((r) => setTimeout(r, 6000 + Math.random() * 4000));
  }
  m.close();
  toast(`${ok} cobrança(s) enviada(s)`, 'success');
}
