// Funil de vendas / atendimento em colunas (Kanban), com arrastar e soltar.
import { h, clear, fill, fmtMoney, fmtListTime, fmtDuration, normalize, modal, errToast, debounce } from '../util.js';
import { state, on, api, openChat, setSetting } from '../store.js';
import { avatarEl, tagDots, stageMenu, emptyState } from '../components.js';
import { pipelineEditor } from './settings.js';

let root;
let q = '';

export function mountBoard(el) {
  root = el;
  on('chats', debounce(() => state.view === 'board' && render(), 80));
  on('config', () => state.view === 'board' && render());
  on('view', (v) => v === 'board' && render());
}

function currentPipeline() {
  return state.pipelines.find((p) => p.id === state.settings.lastPipeline) || state.pipelines[0];
}

function render() {
  const scrollLeft = root.querySelector('.board-cols')?.scrollLeft || 0;
  const pipe = currentPipeline();
  clear(root);
  if (!pipe) {
    root.append(emptyState('📊', 'Nenhum funil criado', 'Crie um funil com as etapas do seu atendimento.',
      h('button', { class: 'btn btn-primary', onclick: () => pipelineEditor() }, '＋ Criar funil')));
    return;
  }
  const search = h('input', {
    class: 'input search', type: 'search', placeholder: 'Filtrar cartões…', value: q,
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
      h('button', { class: 'btn', onclick: () => pipelineEditor(pipe) }, '✎ Editar etapas'),
      h('button', { class: 'btn btn-primary', onclick: () => addChatDialog(pipe, pipe.stages[0]) }, '＋ Adicionar conversa')));
  const cols = h('div', { class: 'board-cols' });
  root.append(head, cols);

  function renderCols() {
    const chats = [...state.chats.values()].filter((c) => c.pipeline_id === pipe.id);
    const nq = normalize(q);
    const visible = nq ? chats.filter((c) => normalize(`${c.display_name} ${c.company || ''} ${c.last_preview || ''}`).includes(nq)) : chats;
    fill(cols, ...pipe.stages.map((s) => column(pipe, s, visible.filter((c) => c.stage_id === s.id))));
  }
  renderCols();
  cols.scrollLeft = scrollLeft;
}

function column(pipe, stage, chats) {
  chats.sort((a, b) => (b.unread > 0) - (a.unread > 0) || b.last_ts - a.last_ts);
  const total = chats.reduce((s, c) => s + (Number(c.value) || 0), 0);
  const list = h('div', { class: 'col-cards' }, chats.map(card));
  const col = h('div', {
    class: 'col', style: { '--c': stage.color || '#94a3b8' },
    ondragover: (e) => { e.preventDefault(); col.classList.add('drop'); },
    ondragleave: (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); },
    ondrop: async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const jid = e.dataTransfer.getData('text/crm-jid');
      if (!jid) return;
      const c = state.chats.get(jid);
      if (c?.stage_id === stage.id) return;
      if (c) { c.stage_id = stage.id; c.pipeline_id = pipe.id; }
      try { await api('crm:setStage', jid, stage.id); } catch (err) { errToast(err); }
    },
  },
  h('div', { class: 'col-head' },
    h('div', { class: 'col-title' }, h('span', { class: 'dot' }), stage.name, h('span', { class: 'count' }, chats.length)),
    total ? h('div', { class: 'col-total' }, fmtMoney(total)) : null),
  list,
  h('button', { class: 'col-add', onclick: () => addChatDialog(pipe, stage) }, '＋ Adicionar'));
  return col;
}

function card(c) {
  const late = c.next_due && c.next_due < Date.now();
  return h('div', {
    class: `card ${c.unread > 0 ? 'unread' : ''}`,
    draggable: true,
    dataset: { jid: c.jid },
    ondragstart: (e) => { e.dataTransfer.setData('text/crm-jid', c.jid); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); },
    ondragend: (e) => e.currentTarget.classList.remove('dragging'),
    onclick: () => openChat(c.jid),
    oncontextmenu: (e) => { e.preventDefault(); stageMenu(null, c, { x: e.clientX, y: e.clientY }); },
  },
  h('div', { class: 'card-top' },
    avatarEl(c, 32),
    h('div', { class: 'card-name' }, c.display_name, c.company ? h('div', { class: 'muted small' }, c.company) : null),
    c.unread > 0 ? h('span', { class: 'badge' }, c.unread) : null),
  c.last_preview ? h('div', { class: 'card-preview' }, c.last_from_me ? 'Você: ' : '', c.last_preview) : null,
  tagDots(c.tag_ids, { max: 3 }),
  h('div', { class: 'card-foot' },
    c.value ? h('span', { class: 'money' }, fmtMoney(c.value)) : h('span'),
    c.open_tasks ? h('span', { class: `task-flag ${late ? 'late' : ''}` }, `⏰ ${c.open_tasks}`) : null,
    h('span', { class: 'muted small', title: 'Tempo nesta etapa / última mensagem' },
      c.stage_changed_at ? `⏱ ${fmtDuration(Date.now() - c.stage_changed_at)}` : fmtListTime(c.last_ts))));
}

export function addChatDialog(pipe, stage) {
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Pesquisar contato…' });
  const list = h('div', { class: 'picker-list' });
  const stageSel = h('select', { class: 'input' }, pipe.stages.map((s) => h('option', { value: s.id, selected: s.id === stage?.id }, s.name)));
  const draw = () => {
    const nq = normalize(input.value);
    const items = [...state.chats.values()]
      .filter((c) => c.pipeline_id !== pipe.id && !c.is_group)
      .filter((c) => !nq || normalize(`${c.display_name} ${c.jid}`).includes(nq))
      .sort((a, b) => b.last_ts - a.last_ts)
      .slice(0, 60);
    fill(list, ...items.map((c) => h('div', {
      class: 'picker-item',
      onclick: async () => {
        try {
          await api('crm:setStage', c.jid, stageSel.value);
          m.close();
        } catch (e) { errToast(e); }
      },
    }, avatarEl(c, 32), h('div', null, h('div', null, c.display_name), h('div', { class: 'muted small ellipsis' }, c.last_preview || '')))),
    items.length ? null : h('div', { class: 'muted small' }, 'Nenhuma conversa encontrada.'));
  };
  input.addEventListener('input', draw);
  const m = modal({
    title: `Adicionar ao funil “${pipe.name}”`,
    body: h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', null, 'Etapa'), stageSel), input, list),
  });
  draw();
}
