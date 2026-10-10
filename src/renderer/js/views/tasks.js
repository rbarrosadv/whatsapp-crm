// Agenda em lista: tarefas, prazos, audiências e reuniões juntos, agrupados por
// data, com filtro por tipo e por responsável. (O calendário é a outra visão.)
import { h, fill, debounce } from '../util.js';
import { state, on, api, setView } from '../store.js';
import { taskRow, taskDialog } from './crmpanel.js';
import { TASK_KINDS } from './casemodal.js';
import { emptyState } from '../components.js';
import { icon } from '../icons.js';

let root;
let showDone = false;
let kind = '';
let who = 'all'; // all | me | <id>
let team = [];
let showLoad = false;

export function mountTasks(el) {
  root = el;
  on('view', (v) => v === 'tasks' && render());
  const refresh = debounce(() => state.view === 'tasks' && render(), 300);
  on('tasks', refresh);
  on('chats', debounce(() => state.view === 'tasks' && render(), 3000));
}

/** Abre a lista já filtrada (ex.: pelo painel Hoje). */
export function showTasks({ kind: k = '', who: w } = {}) {
  kind = k;
  if (w) who = w;
  setView('tasks');
  render();
}

async function render() {
  if (!team.length) team = await api('team:list').catch(() => []);
  const assignee = who === 'me' ? state.me?.id : who === 'all' ? undefined : Number(who);
  let tasks = await api('tasks:list', { includeDone: showDone, assignee }).catch(() => []);
  if (kind) tasks = tasks.filter((t) => (t.kind || 'tarefa') === kind);
  const now = Date.now();
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const endWeek = endToday.getTime() + 6 * 864e5;
  const groups = [
    ['Atrasados', tasks.filter((t) => !t.done && t.due_at && t.due_at < now)],
    ['Hoje', tasks.filter((t) => !t.done && t.due_at && t.due_at >= now && t.due_at <= endToday.getTime())],
    ['Próximos 7 dias', tasks.filter((t) => !t.done && t.due_at && t.due_at > endToday.getTime() && t.due_at <= endWeek)],
    ['Depois', tasks.filter((t) => !t.done && t.due_at && t.due_at > endWeek)],
    ['Sem data', tasks.filter((t) => !t.done && !t.due_at)],
    ['Concluídos', tasks.filter((t) => t.done)],
  ];
  fill(root,
    h('div', { class: 'page-head' },
      h('h2', null, 'Agenda'),
      h('div', { class: 'segmented' },
        h('button', { class: 'seg', onclick: () => setView('agenda') }, 'Calendário'),
        h('button', { class: 'seg active' }, 'Lista')),
      h('div', { class: 'row wrap' },
        h('select', { class: 'input select-sm', onchange: (e) => { kind = e.target.value; render(); } },
          h('option', { value: '' }, 'Todos os tipos'),
          Object.entries(TASK_KINDS).map(([k, v]) => h('option', { value: k, selected: kind === k }, `${v.label}`))),
        h('select', { class: 'input select-sm', onchange: (e) => { who = e.target.value; render(); } },
          h('option', { value: 'all', selected: who === 'all' }, 'Toda a equipe'),
          h('option', { value: 'me', selected: who === 'me' }, 'Só os meus'),
          team.filter((u) => u.id !== state.me?.id).map((u) => h('option', { value: String(u.id), selected: who === String(u.id) }, u.name))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: showDone, onchange: (e) => { showDone = e.target.checked; render(); } }), ' Concluídos'),
        h('button', { class: `btn ${showLoad ? 'active' : ''}`, title: 'Prazos de cada pessoa: atrasados, esta semana, próxima, 30 dias', onclick: () => { showLoad = !showLoad; render(); } }, [icon('users', 15), 'Carga por pessoa']),
        h('button', { class: 'btn btn-primary', onclick: () => taskDialog({ kind: kind || undefined }) }, [icon('plus', 15), 'Novo']))),
    showLoad ? await loadPanel() : null,
    tasks.length ? h('div', { class: 'task-groups' }, groups.filter(([, l]) => l.length).map(([title, list]) =>
      h('div', { class: 'task-group' }, h('h3', null, `${title} (${list.length})`), list.map((t) => taskRow(t, { showChat: true })))))
      : emptyState(icon('check', 16), 'Nada por aqui', 'Prazos, audiências, reuniões e tarefas aparecem aqui e no calendário. Cada um com responsável e aviso na hora.'),
  );
}

/** Carga de prazos por pessoa (clicar no nome filtra a lista pelos prazos dela). */
async function loadPanel() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const rows = await api('tasks:load', { weekStart: d.getTime() }).catch(() => []);
  const max = Math.max(1, ...rows.map((r) => r.week + r.next));
  const cell = (n, cls = '') => h('td', { class: `num ${n && cls ? cls : ''}` }, n || '—');
  return h('div', { class: 'panel load-panel' },
    h('div', { class: 'panel-head' }, h('h3', null, 'Carga de prazos por pessoa'),
      h('span', { class: 'muted small' }, 'Prazos em aberto (audiências à parte). Clique no nome para ver os prazos dela.')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Pessoa', 'Atrasados', 'Esta semana', 'Próxima semana', 'Próximos 30 dias', 'Audiências (30 dias)', ''].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((r) => h('tr', null,
        h('td', null, r.id ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); who = r.id === state.me?.id ? 'me' : String(r.id); kind = 'prazo'; showLoad = false; render(); } }, r.name) : h('span', { class: 'warn-text' }, r.name)),
        cell(r.late, 'bad-text'), cell(r.week), cell(r.next), cell(r.month), cell(r.hearings),
        h('td', { class: 'load-bar-cell' }, h('div', { class: 'load-bar' }, h('span', { style: { width: `${Math.round(((r.week + r.next) / max) * 100)}%` } })))))))));
}
