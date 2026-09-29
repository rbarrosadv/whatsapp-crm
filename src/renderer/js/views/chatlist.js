// Lista de conversas (coluna da esquerda da caixa de entrada).
import { h, fill, fmtListTime, normalize, debounce, modal, errToast, toast, popupMenu } from '../util.js';
import { state, on, api, sortedChats, openChat, stageById } from '../store.js';
import { avatarEl, ticks, stagePill, tagDots, stageMenu } from '../components.js';

const filters = { q: '', mode: 'all', stage: '', tag: '', archived: false };
let searchHits = [];

export function mountChatList(root) {
  const listEl = h('div', { class: 'chatlist-items', id: 'chatlist-items' });
  const searchInput = h('input', {
    class: 'input search', placeholder: 'Pesquisar conversa, número ou mensagem…', type: 'search',
    oninput: debounce(async (e) => {
      filters.q = e.target.value.trim();
      searchHits = filters.q.length >= 3 ? await api('messages:search', filters.q).catch(() => []) : [];
      render();
    }, 200),
  });

  const chipsEl = h('div', { class: 'chips' });
  const selectsEl = h('div', { class: 'filter-selects' });

  const header = h('div', { class: 'chatlist-head' },
    h('div', { class: 'row' },
      h('h2', null, 'Conversas'),
      h('button', { class: 'icon-btn', title: 'Nova conversa (por número)', onclick: newChatDialog }, '＋')),
    searchInput, chipsEl, selectsEl);

  root.append(header, listEl);

  function renderFilters() {
    const unreadCount = [...state.chats.values()].filter((c) => c.unread > 0 && !c.archived).length;
    fill(chipsEl, 
      chip('all', 'Todas'),
      chip('unread', `Não lidas${unreadCount ? ` (${unreadCount})` : ''}`),
      chip('nostage', 'Sem etapa'),
      chip('tasks', 'Com tarefa'),
      chip('groups', 'Grupos'),
    );
    const stageSel = h('select', { class: 'input select-sm', onchange: (e) => { filters.stage = e.target.value; render(); } },
      h('option', { value: '' }, 'Etapa: todas'),
      state.pipelines.map((p) => h('optgroup', { label: `${p.icon || ''} ${p.name}` },
        h('option', { value: `p:${p.id}`, selected: filters.stage === `p:${p.id}` }, `Todo o funil ${p.name}`),
        p.stages.map((s) => h('option', { value: s.id, selected: filters.stage === s.id }, s.name)))));
    const tagSel = h('select', { class: 'input select-sm', onchange: (e) => { filters.tag = e.target.value; render(); } },
      h('option', { value: '' }, 'Etiqueta: todas'),
      state.tags.map((t) => h('option', { value: String(t.id), selected: filters.tag === String(t.id) }, t.name)));
    const archBtn = h('button', {
      class: `btn btn-sm ${filters.archived ? 'btn-primary' : ''}`,
      title: 'Mostrar conversas arquivadas',
      onclick: () => { filters.archived = !filters.archived; render(); },
    }, '🗄');
    fill(selectsEl, stageSel, tagSel, archBtn);
  }

  function chip(mode, label) {
    return h('button', {
      class: `chip ${filters.mode === mode ? 'active' : ''}`,
      onclick: () => { filters.mode = mode; render(); },
    }, label);
  }

  function matches(c) {
    if (!!c.archived !== filters.archived && !filters.q) return false;
    if (filters.mode === 'unread' && !(c.unread > 0)) return false;
    if (filters.mode === 'nostage' && (c.stage_id || c.is_group)) return false;
    if (filters.mode === 'tasks' && !(c.open_tasks > 0)) return false;
    if (filters.mode === 'groups' && !c.is_group) return false;
    if (filters.stage) {
      if (filters.stage.startsWith('p:')) { if (c.pipeline_id !== filters.stage.slice(2)) return false; }
      else if (c.stage_id !== filters.stage) return false;
    }
    if (filters.tag && !c.tag_ids.includes(Number(filters.tag))) return false;
    if (filters.q) {
      const q = normalize(filters.q);
      const digits = filters.q.replace(/\D/g, '');
      const hay = normalize(`${c.display_name} ${c.contact_name || ''} ${c.notify || ''} ${c.company || ''} ${c.email || ''}`);
      if (!hay.includes(q) && !(digits.length >= 3 && c.jid.includes(digits))) return false;
    }
    return true;
  }

  function render() {
    renderFilters();
    const chats = sortedChats().filter(matches);
    const frag = document.createDocumentFragment();
    if (!chats.length && !searchHits.length) {
      frag.append(h('div', { class: 'list-empty' },
        state.chats.size ? 'Nenhuma conversa encontrada com esses filtros.' : 'As conversas aparecem aqui assim que o WhatsApp sincronizar.'));
    }
    // limita a quantidade desenhada de uma vez pra ficar leve com milhares de conversas
    const LIMIT = 400;
    chats.slice(0, LIMIT).forEach((c) => frag.append(row(c)));
    if (chats.length > LIMIT) frag.append(h('div', { class: 'list-empty' }, `Mostrando ${LIMIT} de ${chats.length}. Use a pesquisa ou os filtros.`));
    if (searchHits.length) {
      frag.append(h('div', { class: 'list-section' }, 'Mensagens'));
      for (const m of searchHits.slice(0, 60)) {
        const c = state.chats.get(m.chat_jid);
        if (!c) continue;
        frag.append(h('div', {
          class: 'chat-row search-hit',
          onclick: () => openChat(c.jid),
        },
        h('div', { class: 'chat-main' },
          h('div', { class: 'chat-top' }, h('span', { class: 'chat-name' }, c.display_name), h('span', { class: 'chat-time' }, fmtListTime(m.ts))),
          h('div', { class: 'chat-preview' }, highlight(m.text, filters.q)))));
      }
    }
    fill(listEl, frag);
  }

  function row(c) {
    const st = c.stage_id ? stageById(c.stage_id) : null;
    const el = h('div', {
      class: `chat-row ${state.activeJid === c.jid ? 'active' : ''} ${c.unread > 0 ? 'unread' : ''}`,
      dataset: { jid: c.jid },
      style: st ? { '--stage': st.color } : null,
      onclick: () => openChat(c.jid),
      oncontextmenu: (e) => { e.preventDefault(); rowMenu(c, e); },
    },
    avatarEl(c, 46),
    h('div', { class: 'chat-main' },
      h('div', { class: 'chat-top' },
        h('span', { class: 'chat-name' }, c.pinned ? '📌 ' : '', c.display_name),
        h('span', { class: 'chat-time' }, fmtListTime(c.last_ts))),
      h('div', { class: 'chat-bottom' },
        h('span', { class: 'chat-preview' }, c.last_from_me ? ticks(c.last_status) : null, ' ', c.last_preview || ''),
        c.unread > 0 ? h('span', { class: 'badge' }, c.unread > 99 ? '99+' : String(c.unread)) : null),
      (st || c.tag_ids.length || c.open_tasks) ? h('div', { class: 'chat-meta' },
        st ? stagePill(c.stage_id, { small: true }) : null,
        tagDots(c.tag_ids, { max: 2 }),
        c.open_tasks ? h('span', { class: `task-flag ${c.next_due && c.next_due < Date.now() ? 'late' : ''}` }, `⏰ ${c.open_tasks}`) : null) : null));
    return el;
  }

  function rowMenu(c, e) {
    popupMenu(null, [
      { icon: '📊', label: 'Mover para etapa…', onClick: () => stageMenu(null, c, { x: e.clientX, y: e.clientY }) },
      c.unread > 0
        ? { icon: '✔', label: 'Marcar como lida', onClick: () => api('chats:markRead', c.jid) }
        : { icon: '●', label: 'Marcar como não lida', onClick: () => api('chats:markUnread', c.jid) },
    ], { x: e.clientX, y: e.clientY });
  }

  on('chats', debounce(render, 60));
  on('config', render);
  on('active', () => {
    listEl.querySelectorAll('.chat-row.active').forEach((r) => r.classList.remove('active'));
    listEl.querySelector(`.chat-row[data-jid="${CSS.escape(state.activeJid || '')}"]`)?.classList.add('active');
  });
  render();
}

function highlight(text, q) {
  const t = String(text || '');
  const i = normalize(t).indexOf(normalize(q));
  if (i < 0) return t.slice(0, 120);
  const start = Math.max(0, i - 30);
  return h('span', null, start > 0 ? '…' : '', t.slice(start, i), h('mark', null, t.slice(i, i + q.length)), t.slice(i + q.length, i + q.length + 80));
}

export function newChatDialog() {
  const phone = h('input', { class: 'input', placeholder: 'Ex.: 11 98765-4321 ou +55 11 98765-4321' });
  const name = h('input', { class: 'input', placeholder: 'Opcional' });
  modal({
    title: 'Nova conversa',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Número de WhatsApp (com DDD)'), phone),
      h('label', { class: 'field' }, h('span', null, 'Nome do contato'), name),
      h('p', { class: 'muted small' }, 'Se não colocar o código do país, será usado +55 (Brasil).')),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Abrir conversa',
        primary: true,
        onClick: async () => {
          let digits = phone.value.replace(/\D/g, '');
          if (digits.length >= 10 && digits.length <= 11) digits = `55${digits}`;
          if (digits.length < 12) { toast('Número incompleto', 'error'); return false; }
          try {
            const chat = await api('chats:start', digits, name.value.trim());
            state.chats.set(chat.jid, chat);
            openChat(chat.jid);
          } catch (e) { errToast(e); return false; }
          return true;
        },
      },
    ],
  });
}
