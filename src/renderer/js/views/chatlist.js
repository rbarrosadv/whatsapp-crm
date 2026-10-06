// Lista de conversas (coluna da esquerda da caixa de entrada).
import { h, fill, fmtListTime, fmtDuration, normalize, debounce, modal, errToast, toast, popupMenu } from '../util.js';
import {
  state, on, api, sortedChats, openChat, stageById, typeById, chatMatchesRules, isAwaiting, setSetting, setView,
} from '../store.js';
import { avatarEl, ticks, stagePill, tagDots, typeMenu } from '../components.js';
import { newCaseDialog } from './casemodal.js';
import { filterEditor } from './settings.js';

const filters = { q: '', filterId: null, stage: '', tag: '', archived: false };
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
      h('h2', null, 'WhatsApp'),
      h('div', { class: 'row' },
        h('button', { class: 'icon-btn', title: 'Contatos do WhatsApp (tabela)', onclick: () => setView('contacts') }, '👥'),
        h('button', { class: 'icon-btn', title: 'Nova conversa (por número)', onclick: newChatDialog }, '＋'))),
    searchInput, chipsEl, selectsEl);

  root.append(header, listEl);

  function activeFilter() {
    return state.filters.find((f) => f.id === filters.filterId) || state.filters[0] || { rules: {} };
  }

  function renderFilters() {
    if (filters.filterId == null) filters.filterId = state.settings.lastFilter ?? state.filters[0]?.id ?? null;
    const all = [...state.chats.values()].filter((c) => !c.archived);
    fill(chipsEl,
      ...state.filters.map((f) => {
        const unread = all.filter((c) => c.unread > 0 && chatMatchesRules(c, f.rules)).length;
        return h('button', {
          class: `chip ${activeFilter().id === f.id ? 'active' : ''}`,
          title: unread ? `${unread} conversa(s) não lida(s) neste filtro` : f.name,
          onclick: () => { filters.filterId = f.id; setSetting('lastFilter', f.id).catch(() => {}); render(); },
          oncontextmenu: (e) => {
            e.preventDefault();
            popupMenu(null, [{ icon: '✎', label: 'Editar filtro', onClick: () => filterEditor(f) },
              { icon: '＋', label: 'Novo filtro', onClick: () => filterEditor() }], { x: e.clientX, y: e.clientY });
          },
        }, f.icon ? `${f.icon} ` : '', f.name, unread ? h('span', { class: 'chip-count' }, unread) : null);
      }),
      h('button', { class: 'chip chip-edit', title: 'Criar ou editar filtros', onclick: () => filterEditor() }, '＋'));
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

  function matches(c) {
    if (!!c.archived !== filters.archived && !filters.q) return false;
    // a pesquisa procura em todas as conversas, ignorando o filtro escolhido
    if (!filters.q && !chatMatchesRules(c, activeFilter().rules)) return false;
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
        h('span', { class: 'chat-name' }, c.pinned ? '📌 ' : '',
          typeById(c.type_id) ? h('span', { class: 'type-icon', title: typeById(c.type_id).name }, typeById(c.type_id).icon, ' ') : null,
          c.display_name),
        h('span', { class: 'chat-time' }, fmtListTime(c.last_ts))),
      h('div', { class: 'chat-bottom' },
        h('span', { class: 'chat-preview' }, c.last_from_me ? ticks(c.last_status) : null, ' ', c.last_preview || ''),
        c.unread > 0 ? h('span', { class: 'badge' }, c.unread > 99 ? '99+' : String(c.unread)) : null),
      (st || c.tag_ids.length || c.open_tasks || waitingMs(c) || c.overdue_payments) ? h('div', { class: 'chat-meta' },
        waitingMs(c) ? h('span', { class: `waiting ${waitingMs(c) > 24 * 3600e3 ? 'late' : ''}`, title: 'Aguardando sua resposta' },
          `⏳ ${fmtDuration(waitingMs(c))}`) : null,
        st ? stagePill(c.stage_id, { small: true }) : null,
        c.open_cases > 1 ? h('span', { class: 'tag-more' }, `+${c.open_cases - 1} caso(s)`) : null,
        c.overdue_payments ? h('span', { class: 'fee-late', title: 'Honorários vencidos' }, `💰 ${c.overdue_payments} vencida(s)`) : null,
        tagDots(c.tag_ids, { max: 2 }),
        c.open_tasks ? h('span', { class: `task-flag ${c.next_due && c.next_due < Date.now() ? 'late' : ''}` }, `⏰ ${c.open_tasks}`) : null) : null));
    return el;
  }

  function rowMenu(c, e) {
    popupMenu(null, [
      { icon: '🏷', label: 'Classificar contato…', onClick: () => typeMenu(null, c, { x: e.clientX, y: e.clientY }) },
      c.is_group ? null : { icon: '📁', label: 'Novo caso…', onClick: () => newCaseDialog(c.jid) },
      c.unread > 0
        ? { icon: '✔', label: 'Marcar como lida', onClick: () => api('chats:markRead', c.jid) }
        : { icon: '●', label: 'Marcar como não lida', onClick: () => api('chats:markUnread', c.jid) },
    ], { x: e.clientX, y: e.clientY });
  }

  on('chats', debounce(render, 60));
  on('config', render);
  on('open-filter', (kind) => {
    const f = state.filters.find((x) => (kind === 'awaiting' ? x.rules.awaiting : false));
    if (f) { filters.filterId = f.id; filters.q = ''; searchInput.value = ''; render(); }
  });
  // atualiza o tempo de espera de vez em quando
  setInterval(() => { if (state.view === 'inbox') render(); }, 60000);
  on('active', () => {
    listEl.querySelectorAll('.chat-row.active').forEach((r) => r.classList.remove('active'));
    listEl.querySelector(`.chat-row[data-jid="${CSS.escape(state.activeJid || '')}"]`)?.classList.add('active');
  });
  render();
}

/** Há quanto tempo o contato espera resposta (só conta a partir de 1 h). */
function waitingMs(c) {
  if (!isAwaiting(c)) return 0;
  const ms = Date.now() - c.last_ts;
  return ms >= 3600e3 ? ms : 0;
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
