// Relatórios do escritório por período: Visão geral, Equipe, Comercial,
// Atendimento (WhatsApp) e Financeiro (só para quem vê dinheiro). Cada tabela
// pode ser exportada em CSV (abre no Excel) e a página impressa / salva em PDF.
import { h, fill, fmtMoney, fmtDuration, errToast, downloadBlob } from '../util.js';
import { state, on, api, setView, openLegal } from '../store.js';
import { columnChart, barChart } from '../charts.js';
import { icon } from '../icons.js';

let root;
let tab = 'overview';
let period = 'month';
let custom = { from: '', to: '' };
let loading = 0;

const TABS = [
  ['overview', 'Visão geral'], ['team', 'Equipe'], ['commercial', 'Comercial'], ['whatsapp', 'Atendimento'], ['finance', 'Financeiro'],
];
const PERIODS = [
  ['month', 'Este mês'], ['last', 'Mês passado'], ['quarter', 'Este trimestre'], ['year', 'Este ano'], ['12m', 'Últimos 12 meses'], ['custom', 'Escolher datas'],
];
const ROLES = { socio: 'Sócio', advogado: 'Advogado', estagiario: 'Estagiário(a)' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLabel = (key) => { const [y, m] = key.split('-'); return `${MONTHS[Number(m) - 1]}/${y.slice(2)}`; };
const int = (n) => Number(n || 0).toLocaleString('pt-BR');

export function mountDashboard(el) {
  root = el;
  try { tab = localStorage.getItem('reportsTab') || tab; period = localStorage.getItem('reportsPeriod') || period; } catch { /* ignore */ }
  on('view', (v) => v === 'dashboard' && render());
}

function range() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const first = new Date(d); first.setDate(1);
  const add = (base, months) => { const x = new Date(base); x.setMonth(x.getMonth() + months); return x; };
  switch (period) {
    case 'last': return { from: add(first, -1).getTime(), to: first.getTime() };
    case 'quarter': { const q = new Date(first); q.setMonth(Math.floor(q.getMonth() / 3) * 3); return { from: q.getTime(), to: add(q, 3).getTime() }; }
    case 'year': { const y = new Date(first); y.setMonth(0); return { from: y.getTime(), to: add(y, 12).getTime() }; }
    case '12m': return { from: add(first, -11).getTime(), to: add(first, 1).getTime() };
    case 'custom': {
      const f = custom.from ? new Date(`${custom.from}T00:00`) : first;
      const t = custom.to ? new Date(`${custom.to}T00:00`) : add(first, 1);
      if (custom.to) t.setDate(t.getDate() + 1);
      return { from: f.getTime(), to: t.getTime() };
    }
    default: return { from: first.getTime(), to: add(first, 1).getTime() };
  }
}

const periodText = ({ from, to }) => `${new Date(from).toLocaleDateString('pt-BR')} a ${new Date(to - 1).toLocaleDateString('pt-BR')}`;

function colors() {
  const css = getComputedStyle(document.documentElement);
  return { a: css.getPropertyValue('--viz-1').trim() || '#2a78d6', b: css.getPropertyValue('--viz-2').trim() || '#eb6834' };
}

async function render() {
  const my = ++loading;
  const tabs = TABS.filter(([id]) => id !== 'finance' || state.can.finance);
  if (!tabs.some(([id]) => id === tab)) tab = 'overview';
  const r = range();
  const body = h('div', { class: 'report-body' }, h('p', { class: 'muted' }, 'Carregando…'));
  const save = () => { try { localStorage.setItem('reportsTab', tab); localStorage.setItem('reportsPeriod', period); } catch { /* ignore */ } };
  const dateIn = (key) => h('input', { class: 'input select-sm', type: 'date', value: custom[key], onchange: (e) => { custom[key] = e.target.value; render(); } });
  fill(root,
    h('div', { class: 'page-head' },
      h('div', null, h('h2', null, 'Relatórios'), h('div', { class: 'muted small report-period' }, periodText(r))),
      h('div', { class: 'row wrap no-print' },
        h('select', { class: 'input select-sm', title: 'Período', onchange: (e) => { period = e.target.value; save(); render(); } },
          PERIODS.map(([v, l]) => h('option', { value: v, selected: period === v }, l))),
        period === 'custom' ? [dateIn('from'), h('span', { class: 'muted small' }, 'até'), dateIn('to')] : null,
        h('button', { class: 'btn', onclick: () => window.print() }, [icon('printer', 15), 'Imprimir / PDF']))),
    h('div', { class: 'tabs no-print' }, tabs.map(([id, label]) => h('button', {
      class: `tab ${tab === id ? 'active' : ''}`, onclick: () => { tab = id; save(); render(); },
    }, label))),
    h('h3', { class: 'print-only' }, tabs.find(([id]) => id === tab)?.[1]),
    body);
  let d;
  try { d = await api('reports:get', tab, r); } catch (e) { errToast(e); fill(body, h('p', { class: 'muted' }, 'Não foi possível montar o relatório.')); return; }
  if (my !== loading || state.view !== 'dashboard') return;
  fill(body, ({ overview, team, commercial, whatsapp, finance })[tab](d, r));
}

// ------------------------------------------------------------ peças

function stat(label, value, sub, tone = '', onClick) {
  return h('div', { class: `stat ${tone} ${onClick ? 'clickable' : ''}`, onclick: onClick },
    h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), sub ? h('div', { class: 'muted small' }, sub) : null);
}

function panel(title, content, { wide = false, csv } = {}) {
  return h('section', { class: `panel ${wide ? 'fin-wide' : ''} ${csv ? 'has-csv' : ''}` },
    h('div', { class: 'panel-head' }, h('h3', null, title),
      csv ? h('button', { class: 'link-btn small no-print', title: 'Baixar em CSV (abre no Excel)', onclick: () => exportCsv(csv.name, csv.head, csv.rows) }, [icon('download', 14), ' CSV']) : null),
    content);
}

function bars(items, color, fmt = int, empty = 'Nada no período.') {
  return items?.length ? barChart({ items, color, fmt }) : h('p', { class: 'muted small' }, empty);
}

function table(head, rows, numCols = []) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
    h('thead', null, h('tr', null, head.map((t, i) => h('th', { class: numCols.includes(i) ? 'num' : '' }, t)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((v, i) => h('td', { class: numCols.includes(i) ? 'num' : '' }, v)))))));
}

/** CSV com ";" e BOM (o Excel em português abre direto, com acentos). */
function exportCsv(name, head, rows) {
  const esc = (v) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = [head, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
  downloadBlob(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }), `${name}.csv`);
}
const csvMoney = (v) => Number(v || 0).toFixed(2).replace('.', ',');
const pct = (v) => (v == null ? '—' : `${v}%`);

// ------------------------------------------------------------ visão geral

function overview(d) {
  const c = colors();
  const dl = d.deadlines;
  return [
    h('div', { class: 'stats' },
      stat('Processos abertos no período', int(d.cases.opened), `${int(d.cases.active)} em andamento hoje`, '', () => openLegal('processos', { status: 'aberto' })),
      stat('Processos encerrados', int(d.cases.closed), 'no período'),
      stat('Prazos cumpridos no prazo', pct(dl.rate), `${dl.onTime} no prazo · ${dl.late} com atraso${dl.overdue ? ` · ${dl.overdue} vencido(s) em aberto` : ''}`,
        dl.overdue || dl.late ? 'stat-warn' : ''),
      stat('Audiências', int(d.hearings), 'marcadas no período'),
      stat('Clientes novos', int(d.clients.created), `${int(d.clients.active)} clientes ativos`),
      stat('Intimações recebidas', int(d.intimations.received), d.intimations.pending ? `${d.intimations.pending} para conferir` : 'todas conferidas',
        d.intimations.pending ? 'stat-warn' : '', () => openLegal('intimacoes'))),
    h('div', { class: 'fin-grid' },
      panel('Processos abertos × encerrados (12 meses)', columnChart({
        rows: d.cases.months.map((m) => ({ label: monthLabel(m.month), values: [m.opened, m.closed] })),
        series: [{ name: 'Abertos', color: c.a }, { name: 'Encerrados', color: c.b }], fmt: int,
      }), { wide: true, csv: { name: 'processos-por-mes', head: ['Mês', 'Abertos', 'Encerrados'], rows: d.cases.months.map((m) => [m.month, m.opened, m.closed]) } }),
      panel('Em andamento por área', bars(d.cases.byArea, c.a), { csv: { name: 'processos-por-area', head: ['Área', 'Processos'], rows: d.cases.byArea.map((x) => [x.label, x.value]) } }),
      panel('Em andamento por responsável', bars(d.cases.byResponsible, c.a), { csv: { name: 'processos-por-responsavel', head: ['Responsável', 'Processos'], rows: d.cases.byResponsible.map((x) => [x.label, x.value]) } }),
      panel('Em andamento por etapa', bars(d.cases.byStage, c.a, int, 'Nenhum processo em andamento.'), { wide: true }),
      panel('Prazos que venciam no período', table(['Situação', 'Quantidade'], [
        ['Cumpridos no prazo', dl.onTime], ['Cumpridos com atraso', dl.late], ['Vencidos e ainda em aberto', dl.overdue], ['Ainda a vencer', dl.pending], ['Total', dl.total],
      ], [1]), { csv: { name: 'prazos', head: ['Situação', 'Quantidade'], rows: [['No prazo', dl.onTime], ['Com atraso', dl.late], ['Vencidos em aberto', dl.overdue], ['A vencer', dl.pending]] } }),
      panel('Andamentos dos tribunais', h('p', null, h('b', null, int(d.moves)), ' andamento(s) e publicações registrados pelo DataJud e DJEN no período.'))),
  ];
}

// ------------------------------------------------------------ equipe

function team(d) {
  const head = ['Pessoa', 'Perfil', 'Processos (responsável)', 'Processos novos', 'Tarefas concluídas', 'Atrasadas hoje', 'Prazos no prazo', 'Prazos com atraso', 'Atendimentos registrados', 'Mensagens enviadas', 'Interessados que fecharam'];
  const rows = d.rows.map((u) => [u.name, ROLES[u.role] || u.role, u.casesActive, u.casesOpened, u.tasksDone, u.tasksOverdue, u.deadlinesOnTime, u.deadlinesLate, u.contacts, u.messages, u.leadsWon]);
  const c = colors();
  return [
    h('p', { class: 'muted small' }, 'O que cada pessoa fez no período. Mensagens contam pela assinatura (*Nome:*) no início; as enviadas pelo celular, sem assinatura, ficam de fora',
      d.unsignedMessages ? ` (${int(d.unsignedMessages)} no período)` : '', '.'),
    panel('Equipe no período', table(head, rows.map((r) => r.map((v, i) => (i >= 2 ? int(v) : v))), [2, 3, 4, 5, 6, 7, 8, 9, 10]),
      { wide: true, csv: { name: 'equipe', head, rows } }),
    h('div', { class: 'fin-grid' },
      panel('Tarefas concluídas', bars(d.rows.map((u) => ({ label: u.name, value: u.tasksDone })).filter((x) => x.value), c.a)),
      panel('Processos sob responsabilidade', bars(d.rows.map((u) => ({ label: u.name, value: u.casesActive })).filter((x) => x.value), c.a))),
  ];
}

// ------------------------------------------------------------ comercial

function commercial(d) {
  const c = colors();
  return [
    h('div', { class: 'stats' },
      stat('Interessados novos', int(d.created), 'no período', '', () => setView('commercial')),
      stat('Fecharam', int(d.won), d.daysToClose != null ? `em ${String(d.daysToClose).replace('.', ',')} dia(s), na mediana` : 'no período'),
      stat('Não fecharam', int(d.lost), 'no período'),
      stat('Conversão', pct(d.conversion), 'dos que decidiram, quantos fecharam'),
      state.can.finance && d.proposalsValue != null ? stat('Propostas em aberto', h('span', { class: 'money' }, fmtMoney(d.proposalsValue)), `${d.proposalsOpen} aguardando resposta`) : null),
    h('div', { class: 'fin-grid' },
      panel('Por origem: quantos chegaram e quantos fecharam', table(['Origem', 'Chegaram', 'Fecharam', 'Conversão'],
        d.sourceWon.map((s) => [s.label, int(s.total), int(s.won), s.total ? `${Math.round((s.won / s.total) * 100)}%` : '—']), [1, 2, 3]),
      { wide: true, csv: { name: 'comercial-origem', head: ['Origem', 'Chegaram', 'Fecharam'], rows: d.sourceWon.map((s) => [s.label, s.total, s.won]) } }),
      panel('Motivos de não fechar', bars(d.lostReasons, c.b, int, 'Ninguém deixou de fechar no período.')),
      panel('Interessados por responsável', bars(d.byResponsible, c.a))),
  ];
}

// ------------------------------------------------------------ atendimento

function whatsapp(d) {
  const c = colors();
  const resp = d.medianResponse == null ? '—' : fmtDuration(d.medianResponse);
  return [
    h('div', { class: 'stats' },
      stat('Mensagens recebidas', int(d.received), `${int(d.chats)} conversa(s) de trabalho`, '', () => setView('inbox')),
      stat('Mensagens enviadas', int(d.sent), 'pela equipe e pelo celular'),
      stat('Tempo até responder', resp, 'mediana, depois que o contato escreve'),
      stat('Respondidas em até 1 hora', pct(d.within1h), `${int(d.answered)} resposta(s) no período`),
      stat('Sem resposta no período', int(d.unanswered), 'conversas que terminaram com o contato esperando', d.unanswered ? 'stat-warn' : ''),
      stat('Contatos novos', int(d.newChats), 'primeira mensagem no período')),
    h('p', { class: 'muted small' }, 'Conta só conversas de trabalho (sem grupos e sem contatos do tipo pessoal).'),
    panel('Horário em que os contatos mais escrevem', columnChart({
      rows: d.hours.map((n, i) => ({ label: i % 3 === 0 ? `${i}h` : '', title: `${i}h às ${i + 1}h`, values: [n] })),
      series: [{ name: 'Mensagens recebidas', color: c.a }], fmt: int, height: 200,
    }), { wide: true, csv: { name: 'mensagens-por-hora', head: ['Hora', 'Mensagens recebidas'], rows: d.hours.map((n, i) => [`${i}h`, n]) } }),
  ];
}

// ------------------------------------------------------------ financeiro

function finance(d) {
  const c = colors();
  const money = (v) => h('span', { class: 'money' }, fmtMoney(v));
  return [
    h('div', { class: 'stats finance-body' },
      stat('Recebido', money(d.received), `honorários ${fmtMoney(d.fees)} · avulsas ${fmtMoney(d.avulsa)}${d.reimbursed ? ` · reembolsos ${fmtMoney(d.reimbursed)}` : ''}`, '', () => setView('finance')),
      stat('Despesas pagas', money(d.expenses), 'contas e custas'),
      stat('Resultado', money(d.result), 'recebido menos despesas', d.result < 0 ? 'stat-bad' : ''),
      stat('Recebido do que venceu', pct(d.collection), `do que vencia no período (${fmtMoney(d.billed)})`),
      stat('Em atraso hoje', money(d.overdue), `${d.overdueCount} parcela(s)`, d.overdueCount ? 'stat-bad' : ''),
      stat('Valor médio recebido', d.ticket == null ? '—' : money(d.ticket), 'por parcela ou receita')),
    h('div', { class: 'fin-grid' },
      d.months.length > 1 ? panel('Entradas × saídas por mês', columnChart({
        rows: d.months.map((m) => ({ label: monthLabel(m.month), values: [m.in, m.out] })),
        series: [{ name: 'Entradas', color: c.a }, { name: 'Saídas', color: c.b }], fmt: fmtMoney,
      }), { wide: true, csv: { name: 'financeiro-por-mes', head: ['Mês', 'Entradas', 'Saídas'], rows: d.months.map((m) => [m.month, csvMoney(m.in), csvMoney(m.out)]) } }) : null,
      panel('Clientes que mais pagaram', bars(d.topClients, c.a, fmtMoney), { csv: { name: 'maiores-clientes', head: ['Cliente', 'Recebido'], rows: d.topClients.map((x) => [x.label, csvMoney(x.value)]) } }),
      panel('Recebido por área', bars(d.byArea, c.a, fmtMoney), { csv: { name: 'recebido-por-area', head: ['Área', 'Recebido'], rows: d.byArea.map((x) => [x.label, csvMoney(x.value)]) } }),
      panel('Honorários por responsável do processo', bars(d.byResponsible, c.a, fmtMoney), { csv: { name: 'recebido-por-responsavel', head: ['Responsável', 'Recebido'], rows: d.byResponsible.map((x) => [x.label, csvMoney(x.value)]) } }),
      panel('Despesas por categoria', bars(d.expByCategory, c.b, fmtMoney, 'Nenhuma despesa paga no período.'), { csv: { name: 'despesas-por-categoria', head: ['Categoria', 'Pago'], rows: d.expByCategory.map((x) => [x.label, csvMoney(x.value)]) } })),
  ];
}
