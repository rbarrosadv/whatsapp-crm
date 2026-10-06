// Ficha do contato (coluna da direita): dados, funil, etiquetas, tarefas,
// notas e histórico.
import {
  h, clear, fill, fmtDateTime, fmtDue, fmtMoney, fmtDuration, formatPhone, phoneOf, toLocalInput, fromLocalInput,
  modal, errToast, toast, confirmDialog, debounce,
} from '../util.js';
import { state, on, emit, api, stageById, openChat, openClient, typeById } from '../store.js';
import { avatarEl, typeMenu } from '../components.js';
import { openCase, newCaseDialog, TASK_KINDS, feeLabel } from './casemodal.js';
import { icon, named } from '../icons.js';

let root;
let jid = null;

export function mountCrmPanel(el) {
  root = el;
  on('active', (j) => { jid = j; render(); });
  on('chats', ({ changed }) => { if (jid && (changed === null || changed.includes(jid))) renderTop(); });
  on('config', () => jid && render());
  on('notes', (j) => { if (j === jid) renderNotes(); });
  on('tasks', () => jid && renderTasks());
  on('cases', (j) => { if (jid && (!j || j === jid)) { renderCases(); renderTasks(); } });
}

let sections = {};

function render() {
  clear(root);
  if (!jid) return;
  sections = {
    top: h('div', { class: 'crm-top' }),
    cases: h('div', { class: 'crm-section' }),
    tasks: h('div', { class: 'crm-section' }),
    notes: h('div', { class: 'crm-section' }),
    group: h('div', { class: 'crm-section' }),
    activity: h('div', { class: 'crm-section' }),
  };
  root.append(sections.top, sections.cases, sections.tasks, sections.notes, sections.group, sections.activity);
  renderTop();
  renderCases();
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
      }, typeById(chat.type_id) ? named(typeById(chat.type_id), 14) : 'Não classificado', ' ▾')),
    h('div', { class: 'crm-block' }, h('div', { class: 'crm-label' }, 'Etiquetas'), tagBox),
    h('div', { class: 'crm-block crm-fields' },
      field('Nome no CRM', 'custom_name', chat, { placeholder: chat.contact_name || chat.notify || chat.name || '' }),
      field('Empresa', 'company', chat),
      field('E-mail', 'email', chat, { type: 'email' })),
    chat.is_group ? null : clientBlock(chat),
  );
}

/** O WhatsApp é um canal do cliente: mostra a qual cliente esta conversa pertence. */
function clientBlock(chat) {
  if (chat.client_id) {
    return h('div', { class: 'crm-block client-link' },
      h('div', { class: 'crm-label' }, 'Cliente do escritório'),
      h('button', { class: 'btn wide', onclick: () => openClient(chat.client_id) }, 'Abrir ficha do cliente'));
  }
  return h('div', { class: 'crm-block client-link' },
    h('div', { class: 'crm-label' }, 'Cliente do escritório'),
    h('div', { class: 'muted small' }, 'Esta conversa ainda não é de um cliente.'),
    h('div', { class: 'row wrap' },
      h('button', {
        class: 'btn btn-sm btn-primary',
        onclick: async () => { try { const id = await api('clients:fromChat', chat.jid); toast('Cliente cadastrado', 'success'); openClient(id); } catch (e) { errToast(e); } },
      }, [icon('plus', 15), 'Cadastrar como cliente']),
      h('button', { class: 'btn btn-sm', onclick: () => linkToExisting(chat) }, 'Ligar a cliente existente')));
}

async function linkToExisting(chat) {
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Procurar cliente…' });
  const list = h('div', { class: 'picker-list' });
  const draw = async () => {
    const items = (await api('clients:list', { q: input.value }).catch(() => [])).filter((c) => !c.jid);
    fill(list, items.length ? items.slice(0, 40).map((c) => h('div', {
      class: 'picker-item',
      onclick: async () => { try { await api('clients:linkChat', c.id, chat.jid); m.close(); toast(`Conversa ligada a ${c.name}`, 'success'); } catch (e) { errToast(e); } },
    }, h('div', null, h('b', null, c.name), c.cpf ? h('span', { class: 'muted small' }, ` · ${c.cpf}`) : null)))
      : h('p', { class: 'muted small' }, 'Nenhum cliente sem WhatsApp com esse nome.'));
  };
  input.addEventListener('input', debounce(draw, 200));
  draw();
  const m = modal({ title: `Ligar ${chat.display_name} a um cliente`, body: h('div', { class: 'stack' }, input, list), actions: [{ label: 'Cancelar' }] });
}

// ------------------------------------------------------------------ casos

async function renderCases() {
  const el = sections.cases;
  if (!el) return;
  const myJid = jid;
  const chat = state.chats.get(myJid);
  if (chat?.is_group) { fill(el); return; }
  const cases = await api('cases:list', { jid: myJid }).catch(() => []);
  if (myJid !== jid) return;
  const open = cases.filter((k) => k.status === 'aberto');
  const closed = cases.filter((k) => k.status !== 'aberto');
  fill(el,
    h('div', { class: 'crm-section-head' },
      h('h4', null, `Casos${open.length ? ` (${open.length})` : ''}`),
      h('button', { class: 'btn btn-sm', onclick: () => newCaseDialog(myJid) }, [icon('plus', 15), 'Novo caso'])),
    cases.length ? null : h('div', { class: 'muted small' }, 'Nenhum caso. Crie um para acompanhar processo, prazos, documentos e honorários.'),
    ...open.map(caseCard),
    closed.length ? h('details', { class: 'closed-cases' }, h('summary', { class: 'muted small' }, `${closed.length} caso(s) encerrado(s)`), ...closed.map(caseCard)) : null);
}

function caseCard(k) {
  const st = stageById(k.stage_id);
  return h('div', { class: `case-card ${k.status !== 'aberto' ? 'closed' : ''}`, style: st ? { '--c': st.color } : null, onclick: () => openCase(k.id) },
    h('div', { class: 'case-card-title' }, k.title),
    st ? h('div', { class: 'small' }, h('span', { class: 'stage-pill small', style: { '--c': st.color } }, st.name), h('span', { class: 'muted' }, ` ${st.pipeline.name}`)) : null,
    k.process_number ? h('div', { class: 'muted small mono' }, k.process_number) : null,
    h('div', { class: 'case-card-foot small' },
      k.billed_total ? h('span', null, `${fmtMoney(k.paid_total)} / ${fmtMoney(k.billed_total)}`) : (feeLabel(k) ? h('span', { class: 'muted' }, feeLabel(k)) : null),
      k.overdue_payments ? h('span', { class: 'bad-text' }, `${k.overdue_payments} vencida(s)`) : null,
      k.next_due ? h('span', { class: k.next_due < Date.now() ? 'bad-text' : 'muted' }, `${fmtDue(k.next_due)}`) : null));
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
      h('h4', null, 'Tarefas e lembretes'),
      h('button', { class: 'btn btn-sm', onclick: () => taskDialog({ jid }) }, [icon('plus', 15), 'Nova'])),
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
      h('div', { class: 'task-title' }, t.kind && t.kind !== 'tarefa' ? '' : '', t.title),
      h('div', { class: 'task-sub' }, t.due_at ? `${late ? 'Atrasado · ' : ''}${fmtDue(t.due_at)}` : 'Sem data',
        showChat && t.client_id ? h('a', { class: 'link', onclick: (e) => { e.stopPropagation(); openClient(t.client_id); } }, ` · ${t.client_name}`)
          : showChat && chat ? h('a', { class: 'link', onclick: (e) => { e.stopPropagation(); openChat(chat.jid); } }, ` · ${chat.display_name}`) : null,
        t.case_title ? h('a', { class: 'link', onclick: (e) => { e.stopPropagation(); openCase(t.case_id, { tab: 'prazos' }); } }, ` · ${t.case_title}`) : null,
        t.assignee_name && t.assignee_id !== state.me?.id ? ` · ${t.assignee_name}` : null)),
    h('button', {
      class: 'icon-btn small', title: 'Excluir',
      onclick: async () => { await api('tasks:delete', t.id).catch(errToast); emitTasks(); },
    }, icon('trash', 16)));
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
  // cliente (o valor é a "chave" do cliente: jid do WhatsApp ou cliente:<id>)
  const chatSel = h('select', { class: 'input' }, h('option', { value: '' }, '— Sem cliente (tarefa interna) —'));
  const clientsReady = api('clients:list', {}).then((list) => {
    chatSel.append(...list.map((c) => h('option', { value: c.key, selected: c.key === task.jid }, c.name)));
    // conversa que ainda não é cliente (tarefa criada na ficha do WhatsApp)
    if (task.jid && !list.some((c) => c.key === task.jid)) {
      const chat = state.chats.get(task.jid);
      if (chat) chatSel.append(h('option', { value: task.jid, selected: true }, `${chat.display_name}`));
    }
  }).catch(() => {});
  const kindSel = h('select', { class: 'input' },
    Object.entries(TASK_KINDS).map(([k, v]) => h('option', { value: k, selected: (task.kind || 'tarefa') === k }, `${v.label}`)));
  const caseSel = h('select', { class: 'input' });
  // responsável: quem cria fica como responsável, a não ser que escolha outra pessoa
  const assigneeSel = h('select', { class: 'input' }, h('option', { value: '' }, '— Qualquer pessoa da equipe —'));
  api('team:list').then((team) => {
    const current = task.id ? task.assignee_id : state.me?.id;
    assigneeSel.append(...team.map((u) => h('option', { value: String(u.id), selected: u.id === current }, u.id === state.me?.id ? `${u.name} (eu)` : u.name)));
  }).catch(() => {});
  const loadCases = async () => {
    const list = chatSel.value ? await api('cases:list', { jid: chatSel.value, includeClosed: false }).catch(() => []) : [];
    fill(caseSel, h('option', { value: '' }, list.length ? '— Sem processo —' : '— Cliente sem processos —'),
      ...list.map((k) => h('option', { value: String(k.id), selected: k.id === task.case_id }, k.title)));
  };
  chatSel.addEventListener('change', loadCases);
  clientsReady.then(loadCases);
  modal({
    title: task.id ? 'Editar compromisso' : `Novo(a) ${TASK_KINDS[task.kind || 'tarefa']?.label.toLowerCase() || 'tarefa'}`,
    body: h('div', { class: 'form' },
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', null, 'Tipo'), kindSel),
        h('label', { class: 'field grow' }, h('span', null, 'O que é'), title)),
      h('label', { class: 'field' }, h('span', null, 'Quando (você recebe um aviso na hora)'), due),
      quick,
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, h('span', null, 'Cliente'), chatSel),
        h('label', { class: 'field grow' }, h('span', null, 'Processo'), caseSel)),
      h('label', { class: 'field' }, h('span', null, 'Responsável'), assigneeSel)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Salvar',
        primary: true,
        onClick: async () => {
          if (!title.value.trim()) { toast('Escreva o que precisa ser feito', 'error'); return false; }
          await api('tasks:save', {
            id: task.id, jid: chatSel.value || null, title: title.value.trim(), due_at: fromLocalInput(due.value),
            kind: kindSel.value, case_id: caseSel.value ? Number(caseSel.value) : null,
            assignee_id: assigneeSel.value ? Number(assigneeSel.value) : null,
          });
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
    h('div', { class: 'crm-section-head' }, h('h4', null, 'Notas')),
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
        }, icon('trash', 16))))),
  );
}

// ----------------------------------------------------------------- grupos

async function renderGroup() {
  const el = sections.group;
  const chat = state.chats.get(jid);
  if (!el || !chat?.is_group) { el && clear(el); return; }
  fill(el, h('div', { class: 'crm-section-head' }, h('h4', null, 'Participantes')), h('div', { class: 'muted small' }, 'Carregando…'));
  const myJid = jid;
  try {
    const info = await api('chats:groupInfo', myJid);
    if (myJid !== jid) return;
    fill(el, 
      h('div', { class: 'crm-section-head' }, h('h4', null, `Participantes (${info.participants.length})`)),
      info.desc ? h('div', { class: 'muted small pre' }, info.desc) : null,
      h('div', { class: 'participants' }, info.participants.slice(0, 200).map((p) => h('div', { class: 'participant' },
        h('span', null, p.name || formatPhone(phoneOf(p.jid)) || p.jid),
        p.admin ? h('span', { class: 'muted small' }, 'admin') : null))),
    );
  } catch {
    fill(el, h('div', { class: 'crm-section-head' }, h('h4', null, 'Participantes')), h('div', { class: 'muted small' }, 'Disponível quando o WhatsApp estiver conectado.'));
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
    h('div', { class: 'crm-section-head' }, h('h4', null, 'Histórico')),
    items.length ? null : h('div', { class: 'muted small' }, 'Sem movimentações ainda.'),
    ...items.slice(0, 30).map((a) => h('div', { class: 'activity' },
      h('span', { class: 'muted small' }, fmtDateTime(a.ts)), h('span', null, a.detail))),
  );
}

on('chats', debounce(({ changed } = {}) => {
  if (jid && (changed === null || changed?.includes(jid))) renderActivity();
}, 400));
