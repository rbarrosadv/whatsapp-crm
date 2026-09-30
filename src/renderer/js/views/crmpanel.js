// Ficha do contato (coluna da direita): dados, funil, etiquetas, tarefas,
// notas e histórico.
import {
  h, clear, fill, fmtDateTime, fmtDue, fmtDuration, formatPhone, phoneOf, toLocalInput, fromLocalInput,
  modal, errToast, toast, confirmDialog, debounce,
} from '../util.js';
import { state, on, emit, api, stageById, openChat, typeById } from '../store.js';
import { avatarEl, stageMenu, typeMenu } from '../components.js';

let root;
let jid = null;

export function mountCrmPanel(el) {
  root = el;
  on('active', (j) => { jid = j; render(); });
  on('chats', ({ changed }) => { if (jid && (changed === null || changed.includes(jid))) renderTop(); });
  on('config', () => jid && render());
  on('notes', (j) => { if (j === jid) renderNotes(); });
  on('tasks', () => jid && renderTasks());
}

let sections = {};

function render() {
  clear(root);
  if (!jid) return;
  sections = {
    top: h('div', { class: 'crm-top' }),
    tasks: h('div', { class: 'crm-section' }),
    notes: h('div', { class: 'crm-section' }),
    group: h('div', { class: 'crm-section' }),
    activity: h('div', { class: 'crm-section' }),
  };
  root.append(sections.top, sections.tasks, sections.notes, sections.group, sections.activity);
  renderTop();
  renderTasks();
  renderNotes();
  renderGroup();
  renderActivity();
}

function field(label, key, chat, { type = 'text', placeholder = '' } = {}) {
  const input = h('input', {
    class: 'input input-sm', type, placeholder,
    value: chat[key] ?? '',
    onchange: async (e) => {
      try { await api('crm:update', chat.jid, { [key]: e.target.value }); } catch (err) { errToast(err); }
    },
  });
  return h('label', { class: 'crm-field' }, h('span', null, label), input);
}

function renderTop() {
  const chat = state.chats.get(jid);
  const el = sections.top;
  if (!chat || !el) return;
  // não redesenha enquanto o usuário digita num campo da ficha
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const phone = phoneOf(chat.jid);
  const st = chat.stage_id ? stageById(chat.stage_id) : null;

  const tagBox = h('div', { class: 'tag-select' }, state.tags.map((t) => {
    const on_ = chat.tag_ids.includes(t.id);
    return h('button', {
      class: `tag-chip toggle ${on_ ? 'on' : ''}`,
      style: { '--c': t.color },
      onclick: async () => {
        const next = on_ ? chat.tag_ids.filter((x) => x !== t.id) : [...chat.tag_ids, t.id];
        try { await api('crm:setTags', chat.jid, next); } catch (e) { errToast(e); }
      },
    }, t.name);
  }), state.tags.length ? null : h('span', { class: 'muted small' }, 'Crie etiquetas em Configurações.'));

  fill(el, 
    h('div', { class: 'crm-id' },
      avatarEl(chat, 72),
      h('div', { class: 'crm-name' }, chat.display_name),
      phone ? h('div', { class: 'muted' }, formatPhone(phone)) : null,
      chat.notify && chat.notify !== chat.display_name ? h('div', { class: 'muted small' }, `~${chat.notify}`) : null),
    h('div', { class: 'crm-block' },
      h('div', { class: 'crm-label' }, 'Tipo de contato'),
      h('button', {
        class: `stage-btn wide ${typeById(chat.type_id) ? '' : 'unset'}`,
        style: typeById(chat.type_id) ? { '--c': typeById(chat.type_id).color } : null,
        onclick: (e) => typeMenu(e.currentTarget, chat),
      }, typeById(chat.type_id) ? `${typeById(chat.type_id).icon || ''} ${typeById(chat.type_id).name}` : '❓ Não classificado', ' ▾')),
    h('div', { class: 'crm-block' },
      h('div', { class: 'crm-label' }, 'Etapa no funil'),
      h('button', {
        class: `stage-btn wide ${st ? '' : 'unset'}`,
        style: st ? { '--c': st.color } : null,
        onclick: (e) => stageMenu(e.currentTarget, chat),
      }, st ? `${st.pipeline.icon || ''} ${st.pipeline.name} → ${st.name}` : '＋ Adicionar ao funil', ' ▾'),
      st && chat.stage_changed_at ? h('div', { class: 'muted small' }, `Nesta etapa há ${fmtDuration(Date.now() - chat.stage_changed_at)}`) : null),
    h('div', { class: 'crm-block' }, h('div', { class: 'crm-label' }, 'Etiquetas'), tagBox),
    h('div', { class: 'crm-block crm-fields' },
      field('Nome no CRM', 'custom_name', chat, { placeholder: chat.contact_name || chat.notify || chat.name || '' }),
      field('Empresa', 'company', chat),
      field('E-mail', 'email', chat, { type: 'email' }),
      field('Valor (R$)', 'value', chat, { type: 'number', placeholder: '0,00' })),
  );
}

// ---------------------------------------------------------------- tarefas

async function renderTasks() {
  const el = sections.tasks;
  if (!el) return;
  const myJid = jid;
  const tasks = await api('tasks:list', { jid: myJid, includeDone: true }).catch(() => []);
  if (myJid !== jid) return;
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done).slice(0, 5);
  fill(el, 
    h('div', { class: 'crm-section-head' },
      h('h4', null, '⏰ Tarefas e lembretes'),
      h('button', { class: 'btn btn-sm', onclick: () => taskDialog({ jid }) }, '＋ Nova')),
    open.length || done.length ? null : h('div', { class: 'muted small' }, 'Nenhuma tarefa. Crie lembretes para retornar ao contato.'),
    ...open.map(taskRow),
    ...done.map(taskRow),
  );
}

export function taskRow(t, { showChat = false } = {}) {
  const late = !t.done && t.due_at && t.due_at < Date.now();
  const chat = t.jid ? state.chats.get(t.jid) : null;
  return h('div', { class: `task ${t.done ? 'done' : ''} ${late ? 'late' : ''}` },
    h('input', {
      type: 'checkbox', checked: !!t.done,
      onchange: async (e) => {
        try { await api('tasks:save', { id: t.id, done: e.target.checked }); emitTasks(); } catch (err) { errToast(err); }
      },
    }),
    h('div', { class: 'task-main', onclick: () => taskDialog(t) },
      h('div', { class: 'task-title' }, t.title),
      h('div', { class: 'task-sub' }, t.due_at ? `${late ? '⚠ ' : ''}${fmtDue(t.due_at)}` : 'Sem data',
        showChat && chat ? h('a', { class: 'link', onclick: (e) => { e.stopPropagation(); openChat(chat.jid); } }, ` · ${chat.display_name}`) : null)),
    h('button', {
      class: 'icon-btn small', title: 'Excluir',
      onclick: async () => { await api('tasks:delete', t.id).catch(errToast); emitTasks(); },
    }, '🗑'));
}

function emitTasks() {
  emit('tasks');
}

export function taskDialog(task = {}) {
  const title = h('input', { class: 'input', value: task.title || '', placeholder: 'Ex.: Ligar para enviar proposta' });
  const due = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(task.due_at) });
  const quick = h('div', { class: 'chips' },
    [['Em 1 hora', 3600e3], ['Amanhã 9h', 'tomorrow'], ['Em 3 dias', 3 * 864e5], ['Em 1 semana', 7 * 864e5]].map(([label, v]) =>
      h('button', {
        class: 'chip',
        onclick: () => {
          let ts;
          if (v === 'tomorrow') { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); ts = d.getTime(); }
          else ts = Date.now() + v;
          due.value = toLocalInput(ts);
        },
      }, label)));
  const chats = [...state.chats.values()].filter((c) => !c.is_group).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const chatSel = h('select', { class: 'input' },
    h('option', { value: '' }, '— Sem contato —'),
    chats.map((c) => h('option', { value: c.jid, selected: c.jid === task.jid }, c.display_name)));
  modal({
    title: task.id ? 'Editar tarefa' : 'Nova tarefa',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'O que fazer'), title),
      h('label', { class: 'field' }, h('span', null, 'Quando (você recebe um aviso na hora)'), due),
      quick,
      h('label', { class: 'field' }, h('span', null, 'Contato'), chatSel)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Salvar',
        primary: true,
        onClick: async () => {
          if (!title.value.trim()) { toast('Escreva o que precisa ser feito', 'error'); return false; }
          await api('tasks:save', { id: task.id, jid: chatSel.value || null, title: title.value.trim(), due_at: fromLocalInput(due.value) });
          emitTasks();
          return true;
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ notas

async function renderNotes() {
  const el = sections.notes;
  if (!el) return;
  const myJid = jid;
  const notes = await api('notes:list', myJid).catch(() => []);
  if (myJid !== jid) return;
  const ta = h('textarea', { class: 'input', rows: 2, placeholder: 'Escreva uma anotação sobre este contato…' });
  const add = async () => {
    const text = ta.value.trim();
    if (!text) return;
    try { await api('notes:add', myJid, text); renderNotes(); renderActivity(); } catch (e) { errToast(e); }
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) add(); });
  fill(el, 
    h('div', { class: 'crm-section-head' }, h('h4', null, '📝 Notas')),
    ta,
    h('div', { class: 'row end' }, h('button', { class: 'btn btn-sm btn-primary', onclick: add }, 'Salvar nota')),
    ...notes.map((n) => h('div', { class: 'note' },
      h('div', { class: 'note-text' }, n.text),
      h('div', { class: 'note-foot' },
        h('span', null, fmtDateTime(n.created_at)),
        h('button', {
          class: 'icon-btn small', title: 'Apagar nota',
          onclick: async () => {
            if (!await confirmDialog('Apagar esta nota?', { okLabel: 'Apagar', danger: true })) return;
            await api('notes:delete', n.id); renderNotes();
          },
        }, '🗑')))),
  );
}

// ----------------------------------------------------------------- grupos

async function renderGroup() {
  const el = sections.group;
  const chat = state.chats.get(jid);
  if (!el || !chat?.is_group) { el && clear(el); return; }
  fill(el, h('div', { class: 'crm-section-head' }, h('h4', null, '👥 Participantes')), h('div', { class: 'muted small' }, 'Carregando…'));
  const myJid = jid;
  try {
    const info = await api('chats:groupInfo', myJid);
    if (myJid !== jid) return;
    fill(el, 
      h('div', { class: 'crm-section-head' }, h('h4', null, `👥 Participantes (${info.participants.length})`)),
      info.desc ? h('div', { class: 'muted small pre' }, info.desc) : null,
      h('div', { class: 'participants' }, info.participants.slice(0, 200).map((p) => h('div', { class: 'participant' },
        h('span', null, p.name || formatPhone(phoneOf(p.jid)) || p.jid),
        p.admin ? h('span', { class: 'muted small' }, 'admin') : null))),
    );
  } catch {
    fill(el, h('div', { class: 'crm-section-head' }, h('h4', null, '👥 Participantes')), h('div', { class: 'muted small' }, 'Disponível quando o WhatsApp estiver conectado.'));
  }
}

// -------------------------------------------------------------- histórico

async function renderActivity() {
  const el = sections.activity;
  if (!el) return;
  const myJid = jid;
  const items = await api('crm:activity', myJid).catch(() => []);
  if (myJid !== jid) return;
  fill(el, 
    h('div', { class: 'crm-section-head' }, h('h4', null, '🕘 Histórico')),
    items.length ? null : h('div', { class: 'muted small' }, 'Sem movimentações ainda.'),
    ...items.slice(0, 30).map((a) => h('div', { class: 'activity' },
      h('span', { class: 'muted small' }, fmtDateTime(a.ts)), h('span', null, a.detail))),
  );
}

on('chats', debounce(({ changed } = {}) => {
  if (jid && (changed === null || changed?.includes(jid))) renderActivity();
}, 400));
