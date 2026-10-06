// Funil em colunas (Kanban): cada cartão é um CASO (um contato pode ter
// vários), arrastado entre as etapas.
import { h, clear, fill, fmtMoney, fmtDuration, fmtDue, normalize, errToast, debounce } from '../util.js';
import { state, on, api, openChat, setSetting } from '../store.js';
import { avatarEl, caseStageMenu, emptyState } from '../components.js';
import { pipelineEditor } from './settings.js';
import { openCase, newCaseDialog, feeLabel } from './casemodal.js';

let root;
let q = '';
let showClosed = false;

export function mountBoard(el) {
  root = el;
  const refresh = debounce(() => state.view === 'board' && render(), 120);
  on('chats', refresh);
  on('cases', refresh);
  on('finance', refresh);
  on('config', () => state.view === 'board' && render());
  on('view', (v) => v === 'board' && render());
}

function currentPipeline() {
  return state.pipelines.find((p) => p.id === state.settings.lastPipeline) || state.pipelines[0];
}

async function render() {
  const scrollLeft = root.querySelector('.board-cols')?.scrollLeft || 0;
  const pipe = currentPipeline();
  if (!pipe) {
    fill(root, emptyState('📊', 'Nenhum funil criado', 'Crie um funil com as etapas do seu trabalho.',
      h('button', { class: 'btn btn-primary', onclick: () => pipelineEditor() }, '＋ Criar funil')));
    return;
  }
  const cases = await api('cases:list', { pipelineId: pipe.id, includeClosed: showClosed }).catch(() => []);
  clear(root);
  const search = h('input', {
    class: 'input search', type: 'search', placeholder: 'Filtrar: cliente, caso, processo…', value: q,
    oninput: debounce((e) => { q = e.target.value; renderCols(); }, 150),
  });
  const head = h('div', { class: 'board-head' },
    h('div', { class: 'tabs' }, state.pipelines.map((p) => h('button', {
      class: `tab ${p.id === pipe.id ? 'active' : ''}`,
      onclick: () => setSetting('lastPipeline', p.id).then(render),
    }, `${p.icon || ''} ${p.name}`)),
    h('button', { class: 'tab add', title: 'Novo funil', onclick: () => pipelineEditor() }, '＋')),
    h('div', { class: 'row' },
      search,
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: showClosed, onchange: (e) => { showClosed = e.target.checked; render(); } }), ' Mostrar encerrados'),
      h('button', { class: 'btn', onclick: () => pipelineEditor(pipe) }, '✎ Editar etapas'),
      h('button', { class: 'btn btn-primary', onclick: () => newCaseDialog(null, { stageId: pipe.stages[0]?.id }) }, '＋ Novo caso')));
  const cols = h('div', { class: 'board-cols' });
  root.append(head, cols);

  function renderCols() {
    const nq = normalize(q);
    const visible = nq ? cases.filter((k) => {
      const c = state.chats.get(k.jid);
      return normalize(`${k.client_name || c?.display_name || ''} ${c?.company || ''} ${k.title} ${k.process_number || ''} ${k.area || ''} ${k.opposing_party || ''}`).includes(nq);
    }) : cases;
    fill(cols, ...pipe.stages.map((s) => column(pipe, s, visible.filter((k) => k.stage_id === s.id))));
  }
  renderCols();
  cols.scrollLeft = scrollLeft;
}

function column(pipe, stage, cases) {
  cases.sort((a, b) => (b.overdue_payments - a.overdue_payments) || (b.updated_at - a.updated_at));
  const total = cases.reduce((s, k) => s + (Number(k.fee_total) || 0), 0);
  const col = h('div', {
    class: 'col', style: { '--c': stage.color || '#94a3b8' },
    ondragover: (e) => { e.preventDefault(); col.classList.add('drop'); },
    ondragleave: (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); },
    ondrop: async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const id = Number(e.dataTransfer.getData('text/crm-case'));
      if (!id) return;
      try { await api('cases:setStage', id, stage.id); } catch (err) { errToast(err); }
    },
  },
  h('div', { class: 'col-head' },
    h('div', { class: 'col-title' }, h('span', { class: 'dot' }), stage.name, h('span', { class: 'count' }, cases.length)),
    total ? h('div', { class: 'col-total' }, fmtMoney(total)) : null),
  h('div', { class: 'col-cards' }, cases.map(card)),
  h('button', { class: 'col-add', onclick: () => newCaseDialog(null, { stageId: stage.id }) }, '＋ Novo caso'));
  return col;
}

function card(k) {
  const c = state.chats.get(k.jid) || { jid: k.jid, display_name: k.client_name || 'Cliente' };
  const clientName = k.client_name || c.display_name;
  const late = k.next_due && k.next_due < Date.now();
  return h('div', {
    class: `card ${c.unread > 0 ? 'unread' : ''} ${k.status !== 'aberto' ? 'closed' : ''}`,
    draggable: true,
    dataset: { case: String(k.id) },
    ondragstart: (e) => { e.dataTransfer.setData('text/crm-case', String(k.id)); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); },
    ondragend: (e) => e.currentTarget.classList.remove('dragging'),
    onclick: () => openCase(k.id),
    oncontextmenu: (e) => { e.preventDefault(); caseStageMenu(null, k, { x: e.clientX, y: e.clientY }); },
  },
  h('div', { class: 'card-top' },
    avatarEl(c, 30),
    h('div', { class: 'card-name' }, clientName, h('div', { class: 'card-case' }, k.title)),
    h('button', {
      class: 'icon-btn small', title: c.unread ? `${c.unread} mensagem(ns) não lida(s) — abrir conversa` : 'Abrir conversa',
      onclick: (e) => { e.stopPropagation(); openChat(k.jid); },
    }, c.unread ? h('span', { class: 'badge' }, c.unread) : '💬')),
  k.process_number ? h('div', { class: 'muted small mono ellipsis' }, k.process_number) : null,
  k.area || k.court ? h('div', { class: 'muted small ellipsis' }, [k.area, k.court].filter(Boolean).join(' · ')) : null,
  h('div', { class: 'card-foot' },
    k.billed_total
      ? h('span', { class: k.overdue_payments ? 'bad-text small' : 'money' }, k.overdue_payments ? `⚠ ${k.overdue_payments} vencida(s)` : `${fmtMoney(k.paid_total)} / ${fmtMoney(k.billed_total)}`)
      : k.fee_total ? h('span', { class: 'money' }, fmtMoney(k.fee_total)) : h('span', { class: 'muted small' }, feeLabel(k)),
    k.next_due ? h('span', { class: `task-flag ${late ? 'late' : ''}`, title: 'Próximo prazo/compromisso' }, `📅 ${fmtDue(k.next_due)}`) : null,
    h('span', { class: 'muted small', title: 'Tempo nesta etapa' }, `⏱ ${fmtDuration(Date.now() - (k.stage_changed_at || k.created_at))}`)));
}
