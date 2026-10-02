// Todas as tarefas e lembretes, agrupados por prazo.
import { h, fill } from '../util.js';
import { state, on, api } from '../store.js';
import { taskRow, taskDialog } from './crmpanel.js';
import { emptyState } from '../components.js';

let root;
let showDone = false;

export function mountTasks(el) {
  root = el;
  on('view', (v) => v === 'tasks' && render());
  on('tasks', () => state.view === 'tasks' && render());
  on('chats', () => state.view === 'tasks' && render());
}

async function render() {
  const tasks = await api('tasks:list', { includeDone: showDone }).catch(() => []);
  const now = Date.now();
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const groups = [
    ['⚠ Atrasadas', tasks.filter((t) => !t.done && t.due_at && t.due_at < now)],
    ['📅 Hoje', tasks.filter((t) => !t.done && t.due_at && t.due_at >= now && t.due_at <= endToday.getTime())],
    ['🗓 Próximas', tasks.filter((t) => !t.done && t.due_at && t.due_at > endToday.getTime())],
    ['📌 Sem data', tasks.filter((t) => !t.done && !t.due_at)],
    ['✔ Concluídas', tasks.filter((t) => t.done)],
  ];
  fill(root, 
    h('div', { class: 'page-head' },
      h('h2', null, 'Tarefas e lembretes'),
      h('div', { class: 'row' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: showDone, onchange: (e) => { showDone = e.target.checked; render(); } }), ' Mostrar concluídas'),
        h('button', { class: 'btn btn-primary', onclick: () => taskDialog({}) }, '＋ Nova tarefa'))),
    tasks.length ? h('div', { class: 'task-groups' }, groups.filter(([, l]) => l.length).map(([title, list]) =>
      h('div', { class: 'task-group' }, h('h3', null, `${title} (${list.length})`), list.map((t) => taskRow(t, { showChat: true })))))
      : emptyState('✅', 'Nenhuma tarefa pendente', 'Crie lembretes para retornar aos contatos — você recebe um aviso na hora marcada.'),
  );
}
