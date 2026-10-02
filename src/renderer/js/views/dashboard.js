// Painel com números gerais do atendimento.
import { h, fill, fmtMoney } from '../util.js';
import { state, on, api, setView } from '../store.js';

let root;

export function mountDashboard(el) {
  root = el;
  on('view', (v) => v === 'dashboard' && render());
}

function card(label, value, sub, onClick) {
  return h('div', { class: `stat ${onClick ? 'clickable' : ''}`, onclick: onClick },
    h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), sub ? h('div', { class: 'muted small' }, sub) : null);
}

async function render() {
  const s = await api('stats');
  const byStage = new Map(s.byStage.map((r) => [r.stage_id, r]));
  fill(root, 
    h('div', { class: 'page-head' }, h('h2', null, 'Painel')),
    h('div', { class: 'stats' },
      card('Conversas', s.chats.toLocaleString('pt-BR'), null, () => setView('inbox')),
      card('Não lidas', s.unreadChats, 'conversas aguardando', () => setView('inbox')),
      card('Recebidas (7 dias)', s.inWeek.toLocaleString('pt-BR'), 'mensagens'),
      card('Enviadas (7 dias)', s.outWeek.toLocaleString('pt-BR'), 'mensagens'),
      card('Tarefas abertas', s.openTasks, s.overdueTasks ? `${s.overdueTasks} atrasada(s)` : 'nenhuma atrasada', () => setView('tasks')),
      card('Mensagens salvas', s.messages.toLocaleString('pt-BR'), 'no seu computador')),
    ...state.pipelines.map((p) => {
      const rows = p.stages.map((st) => ({ st, n: byStage.get(st.id)?.n || 0, total: byStage.get(st.id)?.total || 0 }));
      const max = Math.max(1, ...rows.map((r) => r.n));
      const total = rows.reduce((a, r) => a + r.total, 0);
      return h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', null, `${p.icon || ''} ${p.name}`), total ? h('span', { class: 'money' }, fmtMoney(total)) : null),
        rows.map((r) => h('div', { class: 'funnel-row' },
          h('div', { class: 'funnel-label' }, r.st.name),
          h('div', { class: 'funnel-bar' }, h('div', { style: { width: `${(r.n / max) * 100}%`, background: r.st.color } })),
          h('div', { class: 'funnel-n' }, r.n, r.total ? h('span', { class: 'muted small' }, ` · ${fmtMoney(r.total)}`) : null))));
    }),
  );
}
