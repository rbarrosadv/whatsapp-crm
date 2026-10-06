// Financeiro: Painel (destaques e gráficos), A receber (parcelas de
// honorários, cobrança e recibo), A pagar (despesas do escritório e custas
// dos processos), Fluxo de caixa (entradas e saídas do mês) e Inadimplência.
import { h, fill, fmtMoney, normalize, debounce, errToast, toast, confirmDialog, modal, toLocalInput } from '../util.js';
import { state, on, api, openClient } from '../store.js';
import { emptyState } from '../components.js';
import { paymentRow, newCaseDialog, openCase } from './casemodal.js';
import { columnChart, barChart } from '../charts.js';

let root;
let tab = 'painel'; // painel | receber | pagar | caixa | inadimplencia
let filter = 'open';
let payFilter = 'open';
let q = '';
let cashMonth = (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); })();
let loading = 0;

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLabel = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]}/${String(y).slice(2)}`; };
const day = (ts) => (ts ? new Date(ts).toLocaleDateString('pt-BR') : '—');
export const EXPENSE_CATEGORIES = ['Aluguel', 'Condomínio', 'Energia', 'Água', 'Internet e telefone', 'Sistemas e assinaturas', 'Material de escritório',
  'Contador', 'Impostos', 'Salários e encargos', 'Pró-labore', 'OAB e anuidades', 'Marketing', 'Deslocamento', 'Outras'];
export const COST_CATEGORIES = ['Custas judiciais', 'Diligência de oficial', 'Perícia', 'Cópias e autenticações', 'Cartório', 'Correios', 'Deslocamento', 'Outras'];
export const METHODS = [['pix', 'Pix'], ['transferencia', 'Transferência'], ['dinheiro', 'Dinheiro'], ['boleto', 'Boleto'], ['cartao', 'Cartão'], ['cheque', 'Cheque']];

export function mountFinance(el) {
  root = el;
  const refresh = debounce(() => state.view === 'finance' && render(), 200);
  on('view', (v) => v === 'finance' && render());
  on('finance', refresh);
  on('cases', refresh);
}

/** Abre o Financeiro numa aba (ex.: pelo painel Hoje). */
export function openFinance(t) { tab = t; import('../store.js').then((m) => { m.setView('finance'); render(); }); }

function stat(label, value, cls, sub, onClick) {
  return h('div', { class: `stat ${cls || ''} ${onClick ? 'clickable' : ''}`, onclick: onClick },
    h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), sub ? h('div', { class: 'muted small' }, sub) : null);
}

async function render() {
  const my = ++loading;
  const body = h('div', { class: 'finance-body' });
  fill(root,
    h('div', { class: 'page-head' },
      h('h2', null, '💰 Financeiro'),
      h('div', { class: 'segmented' },
        [['painel', '📊 Painel'], ['receber', '⬇ A receber'], ['pagar', '⬆ A pagar'], ['caixa', '💵 Fluxo de caixa'], ['inadimplencia', '⚠ Inadimplência']]
          .map(([id, label]) => h('button', { class: `seg ${tab === id ? 'active' : ''}`, onclick: () => { tab = id; render(); } }, label))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => expenseDialog({}) }, '＋ Despesa'),
        h('button', { class: 'btn', onclick: () => newCaseDialog(null) }, '＋ Processo'))),
    body);
  ({ painel: renderDashboard, receber: renderReceivables, pagar: renderPayables, caixa: renderCash, inadimplencia: renderDefaulters })[tab](body, my);
}

// ------------------------------------------------------------ painel

async function renderDashboard(el, my) {
  const from = new Date(); from.setDate(1); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setMonth(to.getMonth() + 1);
  const y = new Date(from); y.setMonth(y.getMonth() - 11);
  let d;
  try { d = await api('finance:dashboard', { monthFrom: from.getTime(), monthTo: to.getTime(), yearFrom: y.getTime() }); } catch (e) { errToast(e); return; }
  if (my !== loading) return;
  const css = getComputedStyle(document.documentElement);
  const cIn = css.getPropertyValue('--viz-1').trim() || '#2a78d6';
  const cOut = css.getPropertyValue('--viz-2').trim() || '#eb6834';
  const s = d.summary;
  const balance = d.month.in - d.month.out;
  const delta = d.prevMonth.in ? Math.round(((d.month.in - d.prevMonth.in) / d.prevMonth.in) * 100) : null;
  const year = d.months.reduce((a, m) => ({ in: a.in + m.in, out: a.out + m.out }), { in: 0, out: 0 });
  const monthName = from.toLocaleDateString('pt-BR', { month: 'long' });

  // destaques: o que pede ação primeiro
  const alerts = [
    s.overdue ? { cls: 'bad', text: `${s.overdueCount} parcela(s) vencida(s) — ${fmtMoney(s.overdue)} para cobrar`, go: () => { tab = 'inadimplencia'; render(); } } : null,
    s.payableOverdue ? { cls: 'bad', text: `${s.payableOverdue} conta(s) a pagar vencida(s)`, go: () => { tab = 'pagar'; payFilter = 'overdue'; render(); } } : null,
    s.reimbursePending ? { cls: 'warn', text: `${fmtMoney(s.reimbursePending)} em custas pagas aguardando reembolso dos clientes`, go: () => { tab = 'pagar'; payFilter = 'reimburse'; render(); } } : null,
    d.forecast[0].in < d.forecast[0].out ? { cls: 'warn', text: `Previsto para ${monthName}: entra ${fmtMoney(d.forecast[0].in)}, sai ${fmtMoney(d.forecast[0].out)}`, go: () => { tab = 'caixa'; render(); } } : null,
  ].filter(Boolean);

  fill(el,
    alerts.length ? h('div', { class: 'fin-alerts' }, alerts.map((a) => h('button', { class: `fin-alert ${a.cls}`, onclick: a.go }, `${a.cls === 'bad' ? '⚠' : '•'} ${a.text}`, h('span', { class: 'muted' }, ' →')))) : null,
    h('div', { class: 'stats' },
      stat(`Recebido em ${monthName}`, h('span', { class: 'money plain' }, fmtMoney(d.month.in)), 'stat-ok',
        delta == null ? 'mês anterior sem recebimentos' : `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% em relação ao mês anterior`, () => { tab = 'caixa'; render(); }),
      stat('A receber neste mês', h('span', { class: 'money plain' }, fmtMoney(s.dueMonth)), '', `vencido: ${fmtMoney(s.overdue)}`, () => { tab = 'receber'; filter = 'upcoming'; render(); }),
      stat(`Saídas em ${monthName}`, h('span', { class: 'money plain' }, fmtMoney(d.month.out)), '', `a pagar até o fim do mês: ${fmtMoney(s.payableMonth)}`, () => { tab = 'pagar'; payFilter = 'open'; render(); }),
      stat('Saldo do mês', h('span', { class: 'money plain' }, fmtMoney(balance)), balance < 0 ? 'stat-bad' : 'stat-ok', 'entradas − saídas já realizadas', () => { tab = 'caixa'; render(); }),
      stat('Em aberto (todas as parcelas)', h('span', { class: 'money plain' }, fmtMoney(s.openTotal)), '', null, () => { tab = 'receber'; filter = 'open'; render(); })),
    h('div', { class: 'fin-grid' },
      h('section', { class: 'panel fin-wide' },
        h('div', { class: 'panel-head' }, h('h3', null, 'Entradas e saídas — últimos 12 meses'),
          h('span', { class: 'muted small' }, 'Entradas ', h('b', { class: 'money plain' }, fmtMoney(year.in)), ' · saídas ', h('b', { class: 'money plain' }, fmtMoney(year.out)))),
        columnChart({
          rows: d.months.map((m) => ({ label: monthLabel(m.month), title: monthLabel(m.month), values: [m.in, m.out], extra: [[null, 'saldo', fmtMoney(m.in - m.out)]] })),
          series: [{ name: 'Entradas', color: cIn }, { name: 'Saídas', color: cOut }],
          fmt: fmtMoney,
        })),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', null, 'Próximos 3 meses (previsto)')),
        h('table', { class: 'table compact' },
          h('thead', null, h('tr', null, h('th', null, ''), h('th', { class: 'num' }, 'A receber'), h('th', { class: 'num' }, 'A pagar'), h('th', { class: 'num' }, 'Saldo'))),
          h('tbody', null, d.forecast.map((f, i) => h('tr', null, h('td', null, `${monthLabel(f.month)}${i === 0 ? ' (inclui vencidos)' : ''}`),
            h('td', { class: 'num' }, fmtMoney(f.in)), h('td', { class: 'num' }, fmtMoney(f.out)),
            h('td', { class: `num ${f.in - f.out < 0 ? 'bad-text' : ''}` }, fmtMoney(f.in - f.out))))))),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', null, `Despesas de ${monthName} por categoria`)),
        d.byCategory.length ? barChart({ items: d.byCategory, color: cOut, fmt: fmtMoney }) : h('p', { class: 'muted small' }, 'Nenhuma despesa lançada neste mês.')),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', null, 'Recebido por área — 12 meses')),
        d.byArea.length ? barChart({ items: d.byArea, color: cIn, fmt: fmtMoney }) : h('p', { class: 'muted small' }, 'Nenhum recebimento nos últimos 12 meses.')),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', null, '⚠ Maiores inadimplentes'), h('button', { class: 'link-btn small', onclick: () => { tab = 'inadimplencia'; render(); } }, 'ver todos')),
        d.defaulters.length ? d.defaulters.map((x) => h('div', { class: 'fin-line' },
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); if (x.client_id) openClient(x.client_id); } }, x.client_name || 'Cliente'),
          h('span', { class: 'muted small grow' }, ` · ${x.n} parcela(s) · desde ${day(x.oldest)}`),
          h('b', { class: 'money bad-text' }, fmtMoney(x.total)))) : h('p', { class: 'muted small' }, '✓ Ninguém em atraso.')),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', null, 'Vencimentos dos próximos 15 dias')),
        d.receivables.length || d.payables.length ? [
          ...d.receivables.map((p) => h('div', { class: 'fin-line' }, h('span', { class: 'fin-dir in' }, '⬇'), h('span', null, day(p.due_at)),
            h('span', { class: 'grow ellipsis' }, ` ${p.who || ''} · ${p.case_title}`), h('b', { class: 'money plain' }, fmtMoney(p.amount)))),
          ...d.payables.map((e) => h('div', { class: 'fin-line' }, h('span', { class: 'fin-dir out' }, '⬆'), h('span', { class: e.due_at < Date.now() ? 'bad-text' : '' }, day(e.due_at)),
            h('span', { class: 'grow ellipsis' }, ` ${e.description}${e.category ? ` · ${e.category}` : ''}`), h('b', { class: 'money plain' }, fmtMoney(e.amount)))),
        ] : h('p', { class: 'muted small' }, 'Nada vencendo nos próximos 15 dias.'))));
}

// ------------------------------------------------------------ a receber

async function renderReceivables(el, my) {
  const [sum, pays] = await Promise.all([api('finance:summary'), api('finance:list', { status: filter === 'all' ? undefined : filter })]);
  if (my !== loading) return;
  const nq = normalize(q);
  const list = nq ? pays.filter((p) => normalize(`${p.client_name || state.chats.get(p.jid)?.display_name || ''} ${p.case_title} ${p.description || ''} ${p.process_number || ''}`).includes(nq)) : pays;
  const total = list.reduce((a, p) => a + p.amount, 0);
  const chip = (key, label) => h('button', { class: `chip ${filter === key ? 'active' : ''}`, onclick: () => { filter = key; render(); } }, label);
  fill(el,
    h('div', { class: 'stats' },
      stat('Vencido', fmtMoney(sum.overdue), sum.overdue ? 'stat-bad' : '', `${sum.overdueCount} parcela(s)`, () => { filter = 'overdue'; render(); }),
      stat('A receber este mês', fmtMoney(sum.dueMonth), '', null, () => { filter = 'upcoming'; render(); }),
      stat('Recebido este mês', fmtMoney(sum.receivedMonth), 'stat-ok', null, () => { filter = 'paid'; render(); }),
      stat('Total em aberto', fmtMoney(sum.openTotal), '', null, () => { filter = 'open'; render(); })),
    h('div', { class: 'row wrap finance-bar' },
      h('div', { class: 'chips' }, chip('overdue', '⚠ Vencidas'), chip('upcoming', '📅 A vencer'), chip('open', 'Em aberto'), chip('paid', '✔ Pagas'), chip('all', 'Todas')),
      h('input', { class: 'input search', type: 'search', placeholder: 'Cliente, processo…', value: q, oninput: debounce((e) => { q = e.target.value; render(); }, 250) }),
      h('div', { class: 'grow' }),
      h('span', { class: 'muted' }, `${list.length} parcela(s) · `, h('span', { class: 'money-total' }, fmtMoney(total))),
      filter === 'overdue' && list.length > 1 ? h('button', { class: 'btn btn-primary btn-sm', onclick: () => chargeMany(list) }, `📤 Cobrar as ${list.length} vencidas`) : null),
    list.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Situação', 'Cliente / Caso', 'Descrição', 'Vencimento', 'Valor', ''].map((t) => h('th', null, t)))),
        h('tbody', null, list.map((p) => paymentRow(p, { showCase: true })))))
      : emptyState('💰', filter === 'overdue' ? 'Nenhuma parcela vencida 🎉' : 'Nenhuma parcela aqui',
        'Os honorários são lançados dentro de cada processo (aba 💰 Honorários da ficha).'));
}

// ------------------------------------------------------------ a pagar

async function renderPayables(el, my) {
  const list = await api('finance:expenses', { status: payFilter === 'all' ? undefined : payFilter }).catch((e) => { errToast(e); return []; });
  if (my !== loading) return;
  const chip = (key, label) => h('button', { class: `chip ${payFilter === key ? 'active' : ''}`, onclick: () => { payFilter = key; render(); } }, label);
  const total = list.reduce((a, e) => a + e.amount, 0);
  fill(el,
    h('div', { class: 'row wrap finance-bar' },
      h('div', { class: 'chips' }, chip('overdue', '⚠ Vencidas'), chip('open', 'Em aberto'), chip('paid', '✔ Pagas'), chip('reimburse', '↩ Reembolso pendente'), chip('all', 'Todas')),
      h('div', { class: 'grow' }),
      h('span', { class: 'muted' }, `${list.length} lançamento(s) · `, h('span', { class: 'money-total' }, fmtMoney(total))),
      h('button', { class: 'btn btn-primary btn-sm', onclick: () => expenseDialog({}) }, '＋ Despesa do escritório'),
      h('button', { class: 'btn btn-sm', onclick: () => expenseDialog({ kind: 'custa' }) }, '＋ Custa de processo')),
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Situação', 'Descrição', 'Categoria', 'Vencimento', 'Valor', ''].map((t) => h('th', null, t)))),
      h('tbody', null, list.map(expenseRow))))
      : emptyState('🧾', 'Nenhuma despesa aqui', 'Lance as contas do escritório (aluguel, sistemas, impostos…) e as custas pagas nos processos.'));
}

export function expenseRow(e) {
  const late = !e.paid_at && e.due_at && e.due_at < Date.now();
  const st = e.paid_at ? (e.kind === 'custa' && e.reimbursable && !e.reimbursed_at ? ['warn', 'paga · reembolso pendente'] : ['ok', `paga ${day(e.paid_at)}`])
    : late ? ['bad', 'vencida'] : ['muted', 'em aberto'];
  return h('tr', null,
    h('td', null, h('span', { class: `status-pill ${st[0]}` }, st[1])),
    h('td', null, e.description, e.case_title ? h('div', { class: 'muted small' }, h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); openCase(e.case_id, { tab: 'honorarios' }); } }, `📁 ${e.client_name ? `${e.client_name} · ` : ''}${e.case_title}`)) : null),
    h('td', { class: 'small' }, e.kind === 'custa' ? `Custa · ${e.category || ''}` : (e.category || '')),
    h('td', null, day(e.due_at)),
    h('td', { class: 'num' }, h('b', null, fmtMoney(e.amount))),
    h('td', { class: 'actions' },
      e.paid_at ? null : h('button', { class: 'btn btn-sm btn-ok', onclick: () => api('finance:expensePaid', e.id, true).then(() => toast('Despesa paga', 'success')).catch(errToast) }, '✔ Paguei'),
      e.paid_at && e.kind === 'custa' && e.reimbursable && !e.reimbursed_at ? h('button', { class: 'btn btn-sm', title: 'O cliente devolveu este valor', onclick: () => api('finance:reimbursed', e.id, true).catch(errToast) }, '↩ Reembolsado') : null,
      h('button', { class: 'icon-btn small', title: 'Editar', onclick: () => expenseDialog(e) }, '✎'),
      state.can.admin ? h('button', {
        class: 'icon-btn small', title: 'Excluir',
        onclick: async () => {
          if (!await confirmDialog(`Excluir “${e.description}”?${e.series ? ' (as próximas parcelas em aberto desta conta fixa também)' : ''}`, { okLabel: 'Excluir', danger: true })) return;
          api('finance:deleteExpense', e.id, { series: !!e.series }).catch(errToast);
        },
      }, '🗑') : null));
}

/** Lançar/editar despesa do escritório ou custa de processo. */
export async function expenseDialog(e = {}) {
  const kind = e.kind === 'custa' ? 'custa' : 'escritorio';
  const cats = kind === 'custa' ? COST_CATEGORIES : EXPENSE_CATEGORIES;
  const desc = h('input', { class: 'input', value: e.description || '', placeholder: kind === 'custa' ? 'Ex.: Guia de custas iniciais' : 'Ex.: Aluguel da sala' });
  const cat = h('select', { class: 'input' }, cats.map((c) => h('option', { value: c, selected: c === e.category }, c)));
  const amount = h('input', { class: 'input', value: e.amount != null ? Number(e.amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '', placeholder: '0,00', inputmode: 'decimal' });
  const due = h('input', { class: 'input', type: 'date', value: e.due_at ? toLocalInput(e.due_at).slice(0, 10) : new Date().toISOString().slice(0, 10) });
  const paid = h('input', { type: 'checkbox', checked: !!e.paid_at || (!e.id && kind === 'custa') });
  const repeat = h('select', { class: 'input' }, [[1, 'Não repete'], [3, 'Todo mês, 3 meses'], [6, 'Todo mês, 6 meses'], [12, 'Todo mês, 12 meses']].map(([v, l]) => h('option', { value: String(v) }, l)));
  const reimb = h('input', { type: 'checkbox', checked: e.id ? !!e.reimbursable : true });
  let caseSel = null;
  if (kind === 'custa') {
    const cases = await api('cases:list', { status: 'aberto' }).catch(() => []);
    caseSel = h('select', { class: 'input' }, h('option', { value: '' }, '— escolher processo —'),
      cases.map((k) => h('option', { value: String(k.id), selected: k.id === e.case_id }, `${k.client_name ? `${k.client_name} · ` : ''}${k.title}`)));
  }
  modal({
    title: e.id ? 'Editar lançamento' : kind === 'custa' ? 'Custa de processo' : 'Despesa do escritório',
    body: h('div', { class: 'form' },
      caseSel ? h('label', { class: 'field' }, h('span', null, 'Processo'), caseSel) : null,
      h('label', { class: 'field' }, h('span', null, 'Descrição'), desc),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'Categoria'), cat),
        h('label', { class: 'field' }, h('span', null, 'Valor (R$)'), amount),
        h('label', { class: 'field' }, h('span', null, 'Vencimento'), due),
        e.id || kind === 'custa' ? h('span') : h('label', { class: 'field' }, h('span', null, 'Conta fixa?'), repeat)),
      h('label', { class: 'check' }, paid, ' Já está paga'),
      kind === 'custa' ? h('label', { class: 'check' }, reimb, ' O cliente vai reembolsar (aparece em “reembolso pendente”)') : null),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Salvar', primary: true,
        onClick: async () => {
          if (caseSel && !caseSel.value) { toast('Escolha o processo', 'error'); return false; }
          const dueTs = due.value ? new Date(`${due.value}T12:00`).getTime() : null;
          await api('finance:saveExpense', {
            id: e.id, kind, case_id: caseSel ? Number(caseSel.value) : e.case_id || null, description: desc.value, category: cat.value,
            amount: amount.value, due_at: dueTs, paid_at: paid.checked ? (e.paid_at || Date.now()) : null, repeat: Number(repeat.value), reimbursable: reimb.checked,
          });
          toast('Lançamento salvo', 'success');
          return true;
        },
      },
    ],
  });
}

// ------------------------------------------------------------ fluxo de caixa

async function renderCash(el, my) {
  const from = cashMonth;
  const toD = new Date(from); toD.setMonth(toD.getMonth() + 1);
  const cf = await api('finance:cashflow', { from, to: toD.getTime() }).catch((e) => { errToast(e); return null; });
  if (!cf || my !== loading) return;
  const move = (n) => { const d = new Date(cashMonth); d.setMonth(d.getMonth() + n); cashMonth = d.getTime(); render(); };
  let running = 0;
  const methods = Object.fromEntries(METHODS);
  fill(el,
    h('div', { class: 'row finance-bar' },
      h('button', { class: 'icon-btn', onclick: () => move(-1) }, '‹'),
      h('h3', { class: 'cash-month' }, new Date(from).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })),
      h('button', { class: 'icon-btn', onclick: () => move(1) }, '›')),
    h('div', { class: 'stats' },
      stat('Entradas', h('span', { class: 'money plain' }, fmtMoney(cf.totalIn)), 'stat-ok'),
      stat('Saídas', h('span', { class: 'money plain' }, fmtMoney(cf.totalOut))),
      stat('Saldo', h('span', { class: 'money plain' }, fmtMoney(cf.totalIn - cf.totalOut)), cf.totalIn - cf.totalOut < 0 ? 'stat-bad' : 'stat-ok'),
      stat('Ainda previsto no mês', h('span', { class: 'money plain' }, fmtMoney(cf.toReceive - cf.toPay)), '', `a receber ${fmtMoney(cf.toReceive)} · a pagar ${fmtMoney(cf.toPay)}`)),
    cf.entries.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Data', 'Descrição', 'Forma', 'Entrada', 'Saída', 'Saldo'].map((t) => h('th', { class: ['Entrada', 'Saída', 'Saldo'].includes(t) ? 'num' : '' }, t)))),
      h('tbody', null, cf.entries.map((x) => {
        running += x.dir === 'in' ? x.amount : -x.amount;
        return h('tr', null,
          h('td', null, day(x.ts)),
          h('td', null, x.description, h('div', { class: 'muted small' }, [x.who, x.case_title, x.category].filter(Boolean).join(' · '))),
          h('td', { class: 'small' }, methods[x.method] || x.method || ''),
          h('td', { class: 'num' }, x.dir === 'in' ? fmtMoney(x.amount) : ''),
          h('td', { class: 'num' }, x.dir === 'out' ? fmtMoney(x.amount) : ''),
          h('td', { class: `num ${running < 0 ? 'bad-text' : ''}` }, fmtMoney(running)));
      }))))
      : emptyState('💵', 'Nenhuma movimentação neste mês', 'Entram aqui as parcelas recebidas, os reembolsos de custas e as despesas pagas.'));
}

// ------------------------------------------------------------ inadimplência

async function renderDefaulters(el, my) {
  const list = await api('finance:defaulters').catch((e) => { errToast(e); return []; });
  if (my !== loading) return;
  const total = list.reduce((a, x) => a + x.total, 0);
  const daysLate = (ts) => Math.floor((Date.now() - ts) / 864e5);
  fill(el,
    h('div', { class: 'stats' },
      stat('Total em atraso', h('span', { class: 'money plain' }, fmtMoney(total)), total ? 'stat-bad' : 'stat-ok'),
      stat('Clientes em atraso', list.length),
      stat('Atraso mais antigo', list.length ? `${Math.max(...list.map((x) => daysLate(x.oldest)))} dias` : '—')),
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Cliente', 'Processos', 'Parcelas', 'Atraso', 'Última cobrança', 'Total', ''].map((t) => h('th', null, t)))),
      h('tbody', null, list.map((x) => h('tr', null,
        h('td', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); if (x.client_id) openClient(x.client_id); } }, x.client_name || 'Cliente')),
        h('td', { class: 'small' }, x.cases || ''),
        h('td', null, x.n),
        h('td', { class: daysLate(x.oldest) > 30 ? 'bad-text' : '' }, `${daysLate(x.oldest)} dias`),
        h('td', { class: 'small' }, x.last_charge ? day(x.last_charge) : h('span', { class: 'muted' }, 'nunca')),
        h('td', { class: 'num' }, h('b', { class: 'bad-text' }, fmtMoney(x.total))),
        h('td', null, h('button', { class: 'btn btn-sm', onclick: () => { tab = 'receber'; filter = 'overdue'; q = x.client_name || ''; render(); } }, 'Ver parcelas')))))))
      : emptyState('🎉', 'Ninguém em atraso', 'Quando uma parcela vencer sem pagamento, o cliente aparece aqui.'));
}

/** Envia a cobrança padrão para várias parcelas, uma de cada vez, com intervalo. */
async function chargeMany(list) {
  const names = [...new Set(list.map((p) => p.client_name || state.chats.get(p.jid)?.display_name || 'cliente'))];
  if (!await confirmDialog(`Enviar a mensagem de cobrança padrão para ${list.length} parcela(s) vencida(s) (${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''})? As mensagens saem uma de cada vez, com alguns segundos de intervalo.`, { okLabel: 'Enviar cobranças' })) return;
  const progress = h('div', null, 'Preparando…');
  let stop = false;
  const m = modal({ title: 'Enviando cobranças', body: progress, actions: [{ label: 'Parar', onClick: () => { stop = true; } }] });
  let ok = 0;
  for (let i = 0; i < list.length && !stop; i++) {
    const p = list[i];
    fill(progress, `Enviando ${i + 1} de ${list.length}: ${p.client_name || state.chats.get(p.jid)?.display_name || ''} — ${fmtMoney(p.amount)}`);
    try { await api('finance:sendCharge', p.id); ok++; } catch (e) { errToast(e); }
    if (i < list.length - 1) await new Promise((r) => setTimeout(r, 6000 + Math.random() * 4000));
  }
  m.close();
  toast(`${ok} cobrança(s) enviada(s)`, 'success');
}
