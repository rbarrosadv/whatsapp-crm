// Agenda: todas as agendas do Google + prazos/audiências/reuniões do CRM,
// em dia, semana ou mês — para enxergar os horários livres.
import {
  h, fill, modal, toast, errToast, confirmDialog, fmtTime, toLocalInput, fromLocalInput, debounce, pickFiles, openExternal,
} from '../util.js';
import { state, on, api, openChat, setSetting, setView } from '../store.js';
import { openCase, TASK_KINDS } from './casemodal.js';
import { icon } from '../icons.js';

const HOUR_PX = 48;
const DAY = 864e5;
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

let root;
let view = 'week';
let anchor = startOfDay(Date.now());
let gstatus = { configured: false, connected: false };
let calendars = [];
let loading = false;
let lastData = { events: [], error: null };
let connecting = false;

function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); }
function startOfWeek(ts) { const d = new Date(startOfDay(ts)); d.setDate(d.getDate() - d.getDay()); return d.getTime(); }
function startOfMonth(ts) { const d = new Date(startOfDay(ts)); d.setDate(1); return d.getTime(); }

export function mountAgenda(el) {
  root = el;
  view = state.settings.agendaView || 'week';
  const refresh = debounce(() => state.view === 'agenda' && load(), 250);
  on('view', (v) => { if (v === 'agenda') load(true); });
  on('tasks', refresh);
  on('cases', refresh);
  window.api.on('google:status', (st) => { gstatus = st; if (state.view === 'agenda') load(true); });
  setInterval(() => { if (state.view === 'agenda') render(); }, 60000); // linha do "agora"
}

function range() {
  if (view === 'day') return [anchor, addDays(anchor, 1)];
  if (view === 'week') { const s = startOfWeek(anchor); return [s, addDays(s, 7)]; }
  const s = startOfWeek(startOfMonth(anchor));
  return [s, addDays(s, 42)];
}

function hidden() { return new Set(state.settings.agendaHidden || []); }

async function load(refreshCalendars = false) {
  if (loading) return;
  loading = true;
  try {
    gstatus = await api('google:status');
    if (gstatus.connected && (refreshCalendars || !calendars.length)) {
      calendars = await api('google:calendars', refreshCalendars).catch((e) => { errToast(e); return []; });
    }
    if (!gstatus.connected) calendars = [];
    const [from, to] = range();
    const ids = calendars.map((c) => c.id);
    lastData = await api('agenda:events', from, to, ids.length ? ids : null);
    gstatus = lastData.status || gstatus;
  } catch (e) {
    lastData = { events: [], error: e.message };
  } finally {
    loading = false;
  }
  render();
}

function visibleEvents() {
  const hid = hidden();
  return lastData.events.filter((e) => !hid.has(e.calendarId));
}

// ---------------------------------------------------------------- tela

function render() {
  if (!root) return;
  const [from] = range();
  const title = view === 'month'
    ? new Date(anchor).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
    : view === 'day'
      ? new Date(anchor).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
      : `${new Date(from).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} – ${new Date(addDays(from, 6)).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  const titleText = title.charAt(0).toUpperCase() + title.slice(1);
  const step = view === 'day' ? 1 : view === 'week' ? 7 : null;
  const move = (dir) => {
    if (step) anchor = addDays(anchor, dir * step);
    else { const d = new Date(anchor); d.setMonth(d.getMonth() + dir); anchor = startOfDay(d.getTime()); }
    load();
  };
  const seg = (v, label) => h('button', { class: `seg ${view === v ? 'active' : ''}`, onclick: () => { view = v; setSetting('agendaView', v).catch(() => {}); load(); } }, label);

  const main = h('div', { class: 'agenda-main' });
  fill(root,
    h('div', { class: 'agenda' },
      h('aside', { class: 'agenda-side' },
        h('button', { class: 'btn btn-primary wide', onclick: () => eventDialog({ start: nextSlot() }) }, [icon('plus', 15), 'Novo compromisso']),
        googleCard(),
        calendarLegend()),
      h('section', { class: 'agenda-body' },
        h('div', { class: 'agenda-toolbar' },
          h('button', { class: 'btn', onclick: () => { anchor = startOfDay(Date.now()); load(); } }, 'Hoje'),
          h('button', { class: 'icon-btn', title: 'Anterior', onclick: () => move(-1) }, '‹'),
          h('button', { class: 'icon-btn', title: 'Próximo', onclick: () => move(1) }, '›'),
          h('h2', { class: 'agenda-title' }, titleText),
          loading ? h('span', { class: 'spinner small' }) : null,
          h('div', { class: 'grow' }),
          h('div', { class: 'segmented' }, seg('day', 'Dia'), seg('week', 'Semana'), seg('month', 'Mês'),
            h('button', { class: 'seg', title: 'Tarefas, prazos e audiências em lista, com filtros', onclick: () => setView('tasks') }, 'Lista'))),
        lastData.error ? h('div', { class: 'banner warn' }, icon('alert', 16), lastData.error) : null,
        main)));
  if (view === 'month') renderMonth(main); else renderTimeGrid(main, view === 'day' ? 1 : 7);
}

function nextSlot() {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  if (startOfDay(anchor) !== startOfDay(Date.now())) {
    const a = new Date(anchor); a.setHours(9, 0, 0, 0);
    return a.getTime();
  }
  return d.getTime();
}

// ------------------------------------------------------------ Google

async function importKey() {
  const [file] = await pickFiles({ multiple: false, accept: '.json,application/json' });
  if (!file) return;
  try {
    gstatus = await api('google:importClient', await window.api.upload(file, file.name));
    render();
  } catch (e) { errToast(e); }
}

function googleCard() {
  const st = gstatus;
  if (!st.configured) {
    return h('div', { class: 'gcard' },
      h('b', null, 'Google Agenda'),
      h('p', { class: 'muted small' }, 'Conecte para ver todas as suas agendas aqui e enviar prazos e audiências para o Google automaticamente.'),
      h('button', { class: 'btn btn-sm wide', onclick: importKey }, '1. Escolher a chave (.json)'),
      h('button', { class: 'btn btn-sm wide', disabled: true }, '2. Entrar com o Google'),
      h('p', { class: 'muted small' }, 'A chave é o arquivo client_secret….json que você baixou no Google Cloud.'));
  }
  if (!st.connected) {
    return h('div', { class: `gcard ${st.needsReconnect ? 'bad' : ''}` },
      h('b', null, st.needsReconnect ? 'Google Agenda desconectado' : 'Google Agenda'),
      h('p', { class: 'muted small' }, st.needsReconnect
        ? 'A autorização do Google venceu (no modo de teste isso acontece a cada 7 dias). É só reconectar — nada se perde.'
        : 'Chave carregada. Agora entre com a sua conta Google. O navegador vai abrir; se aparecer “O Google não verificou este app”, clique em Avançado → Acessar.'),
      h('button', {
        class: 'btn btn-primary btn-sm wide', disabled: connecting,
        onclick: async () => {
          connecting = true; render();
          try { gstatus = await api('google:connect'); toast('Google Agenda conectado!', 'success'); } catch (e) { errToast(e); }
          connecting = false; load(true);
        },
      }, connecting ? 'Aguardando o navegador…' : st.needsReconnect ? 'Reconectar Google' : '2. Entrar com o Google'),
      h('button', { class: 'btn btn-sm wide', onclick: importKey }, 'Trocar arquivo da chave'));
  }
  const writable = calendars.filter((c) => c.writable);
  return h('div', { class: 'gcard ok' },
    h('b', null, 'Google Agenda conectado'),
    st.email ? h('div', { class: 'muted small ellipsis' }, st.email) : null,
    h('label', { class: 'check small' },
      h('input', { type: 'checkbox', checked: state.settings.googleSync !== false, onchange: (e) => setSetting('googleSync', e.target.checked).then(() => e.target.checked && api('google:syncAll')).catch(errToast) }),
      ' Enviar prazos, audiências e reuniões do CRM para o Google'),
    h('label', { class: 'field small' }, h('span', null, 'Agenda usada pelo CRM'),
      h('select', { class: 'input select-sm', onchange: (e) => setSetting('googleCalendarId', e.target.value || null).catch(errToast) },
        h('option', { value: '' }, 'Agenda principal'),
        writable.map((c) => h('option', { value: c.id, selected: state.settings.googleCalendarId === c.id }, c.name)))),
    h('button', {
      class: 'btn btn-sm', onclick: async () => {
        if (!await confirmDialog('Desconectar o Google Agenda? Os eventos continuam no Google; o app só para de mostrar e sincronizar.', { okLabel: 'Desconectar', danger: true })) return;
        await api('google:disconnect'); calendars = []; load();
      },
    }, 'Desconectar'));
}

function calendarLegend() {
  const hid = hidden();
  const items = [...calendars, { id: 'crm', name: 'Compromissos do CRM (ainda não no Google)', color: '#00a884' }];
  const toggle = async (id, show) => {
    const set = new Set(state.settings.agendaHidden || []);
    if (show) set.delete(id); else set.add(id);
    await setSetting('agendaHidden', [...set]);
    render();
  };
  return h('div', { class: 'cal-legend' },
    h('div', { class: 'crm-label' }, 'Agendas'),
    items.map((c) => h('label', { class: 'cal-item' },
      h('input', { type: 'checkbox', checked: !hid.has(c.id), style: { accentColor: c.color }, onchange: (e) => toggle(c.id, e.target.checked) }),
      h('span', { class: 'cal-dot', style: { background: c.color } }),
      h('span', { class: 'ellipsis' }, c.name))),
    h('div', { class: 'cal-kinds muted small' }, Object.values(TASK_KINDS).map((k) => `${k.label}`).join('  ·  ')));
}

// ---------------------------------------------------------- dia/semana

function layoutDay(evs) {
  // distribui eventos sobrepostos lado a lado
  const sorted = [...evs].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let cluster = [];
  let clusterEnd = 0;
  const flush = () => {
    const cols = [];
    for (const e of cluster) {
      let i = cols.findIndex((end) => end <= e.start);
      if (i < 0) { i = cols.length; cols.push(0); }
      cols[i] = e.end;
      e._col = i;
    }
    for (const e of cluster) out.push({ ...e, _cols: cols.length });
    cluster = [];
  };
  for (const e of sorted) {
    if (cluster.length && e.start >= clusterEnd) flush();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  if (cluster.length) flush();
  return out;
}

function renderTimeGrid(el, days) {
  const [from] = range();
  const evs = visibleEvents();
  const today = startOfDay(Date.now());
  const dayList = Array.from({ length: days }, (_, i) => addDays(from, i));
  const multi = (e) => e.allDay || e.end - e.start >= DAY;

  const head = h('div', { class: 'tg-head', style: { gridTemplateColumns: `56px repeat(${days}, 1fr)` } },
    h('div'),
    ...dayList.map((d) => h('div', { class: `tg-day ${d === today ? 'today' : ''}`, onclick: () => { anchor = d; view = 'day'; load(); } },
      h('span', null, WEEKDAYS[new Date(d).getDay()]), h('b', null, new Date(d).getDate()))));
  const allDay = h('div', { class: 'tg-allday', style: { gridTemplateColumns: `56px repeat(${days}, 1fr)` } },
    h('div', { class: 'muted small' }, 'dia todo'),
    ...dayList.map((d) => h('div', { class: 'tg-allday-cell' },
      evs.filter((e) => multi(e) && e.start < addDays(d, 1) && e.end > d).map((e) => eventChip(e)))));

  const hours = h('div', { class: 'tg-hours' }, Array.from({ length: 24 }, (_, i) => h('div', { class: 'tg-hour' }, `${String(i).padStart(2, '0')}:00`)));
  const cols = dayList.map((d) => {
    const col = h('div', {
      class: `tg-col ${d === today ? 'today' : ''}`,
      ondblclick: (e) => {
        const y = e.offsetY + (e.target === col ? 0 : 0);
        if (e.target !== col) return;
        const mins = Math.floor((y / HOUR_PX) * 2) * 30;
        eventDialog({ start: d + mins * 60000 });
      },
      title: 'Clique duas vezes para criar um compromisso',
    });
    for (const e of layoutDay(evs.filter((x) => !multi(x) && x.start < addDays(d, 1) && x.end > d))) {
      const s = Math.max(e.start, d);
      const en = Math.min(e.end, addDays(d, 1));
      const top = ((s - d) / 3600e3) * HOUR_PX;
      const height = Math.max(20, ((en - s) / 3600e3) * HOUR_PX - 2);
      col.append(h('div', {
        class: `tg-event ${e.done ? 'done' : ''} ${e.source === 'crm' ? 'crm' : ''}`,
        style: {
          top: `${top}px`, height: `${height}px`, '--c': e.color,
          left: `calc(${(e._col / e._cols) * 100}% + 2px)`, width: `calc(${100 / e._cols}% - 4px)`,
        },
        title: `${e.title}\n${fmtTime(e.start)}–${fmtTime(e.end)} · ${e.calendarName}`,
        onclick: (ev) => { ev.stopPropagation(); eventDetails(e); },
      }, h('b', null, e.title), height > 34 ? h('div', { class: 'small' }, `${fmtTime(e.start)}–${fmtTime(e.end)}`) : null));
    }
    if (d === today) {
      const now = new Date();
      col.append(h('div', { class: 'tg-now', style: { top: `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px` } }));
    }
    return col;
  });
  const body = h('div', { class: 'tg-body', style: { gridTemplateColumns: `56px repeat(${days}, 1fr)` } }, hours, ...cols);
  const scroller = h('div', { class: 'tg-scroll' }, body);
  fill(el, h('div', { class: 'tg' }, head, allDay, scroller));
  requestAnimationFrame(() => { scroller.scrollTop = Number(state.settings.agendaHours ?? 7) * HOUR_PX; });
}

function eventChip(e) {
  return h('div', {
    class: `ev-chip ${e.done ? 'done' : ''}`, style: { '--c': e.color }, title: e.title,
    onclick: (ev) => { ev.stopPropagation(); eventDetails(e); },
  }, e.allDay ? '' : `${fmtTime(e.start)} `, e.title);
}

// ------------------------------------------------------------------ mês

function renderMonth(el) {
  const [from] = range();
  const month = new Date(anchor).getMonth();
  const evs = visibleEvents().sort((a, b) => (b.allDay - a.allDay) || a.start - b.start);
  const today = startOfDay(Date.now());
  const cells = Array.from({ length: 42 }, (_, i) => addDays(from, i)).map((d) => {
    const dayEvs = evs.filter((e) => e.start < addDays(d, 1) && e.end > d && !(e.allDay && e.end <= d));
    return h('div', {
      class: `mo-cell ${new Date(d).getMonth() !== month ? 'other' : ''} ${d === today ? 'today' : ''}`,
      ondblclick: () => { const x = new Date(d); x.setHours(9, 0, 0, 0); eventDialog({ start: x.getTime() }); },
    },
    h('div', { class: 'mo-date', onclick: () => { anchor = d; view = 'day'; load(); } }, new Date(d).getDate()),
    ...dayEvs.slice(0, 4).map(eventChip),
    dayEvs.length > 4 ? h('div', { class: 'mo-more', onclick: () => { anchor = d; view = 'day'; load(); } }, `+${dayEvs.length - 4} mais`) : null);
  });
  fill(el, h('div', { class: 'mo' },
    h('div', { class: 'mo-head' }, WEEKDAYS.map((w) => h('div', null, w))),
    h('div', { class: 'mo-grid' }, cells)));
}

// ------------------------------------------------------- detalhes/edição

function whenText(e) {
  const d = new Date(e.start).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  if (e.allDay) return `${d} · dia todo`;
  return `${d} · ${fmtTime(e.start)} às ${fmtTime(e.end)}`;
}

function eventDetails(e) {
  const chat = e.jid ? state.chats.get(e.jid) : null;
  const m = modal({
    title: e.title,
    body: h('div', { class: 'form' },
      h('div', null, icon('clock', 16), whenText(e)),
      h('div', null, h('span', { class: 'cal-dot', style: { background: e.color } }), ' ', e.calendarName),
      e.location ? h('div', null, icon('compass', 16), e.location) : null,
      e.description ? h('div', { class: 'muted small pre' }, e.description) : null,
      h('div', { class: 'row wrap' },
        chat ? h('button', { class: 'btn btn-sm', onclick: () => { m.close(); openChat(chat.jid); } }, `${chat.display_name}`) : null,
        e.caseId ? h('button', { class: 'btn btn-sm', onclick: () => { m.close(); openCase(e.caseId, { tab: 'prazos' }); } }, 'Abrir caso') : null,
        e.htmlLink ? h('button', { class: 'btn btn-sm', onclick: () => openExternal(e.htmlLink) }, 'Abrir no Google') : null)),
    actions: [
      ...(e.writable ? [{
        label: 'Excluir', danger: true,
        onClick: async () => {
          if (!await confirmDialog(`Excluir “${e.title}”${e.taskId ? ' (do CRM e do Google)' : ' do Google Agenda'}?`, { okLabel: 'Excluir', danger: true })) return false;
          if (e.taskId) await api('tasks:delete', e.taskId);
          else await api('agenda:deleteEvent', e.calendarId, e.id);
          load();
          return true;
        },
      }, { label: 'Editar', onClick: () => { setTimeout(() => eventDialog(e), 30); } }] : []),
      { label: 'Fechar', primary: true },
    ],
  });
}

/** Criar/editar: compromisso só no Google, ou prazo/audiência/reunião/tarefa do CRM (vai para o Google também). */
export async function eventDialog(e = {}) {
  const isEdit = !!e.id;
  const task = e.taskId ? (await api('tasks:list', { includeDone: true })).find((t) => t.id === e.taskId) : null;
  const canGoogle = gstatus.connected;
  let kind = task?.kind || (isEdit ? 'evento' : (canGoogle ? 'evento' : 'reuniao'));
  const start = e.start || nextSlot();
  const end = e.end || start + 3600e3;

  const title = h('input', { class: 'input', value: task?.title || (isEdit ? e.title : ''), placeholder: 'Ex.: Audiência — João x Empresa' });
  const startIn = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(start) });
  const endIn = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(end) });
  const allDay = h('input', { type: 'checkbox', checked: !!e.allDay });
  startIn.addEventListener('change', () => {
    const s = fromLocalInput(startIn.value);
    const dur = (fromLocalInput(endIn.value) || end) - start;
    if (s) endIn.value = toLocalInput(s + Math.max(dur, 15 * 60000));
  });
  const writable = calendars.filter((c) => c.writable);
  const calSel = h('select', { class: 'input' }, writable.map((c) => h('option', {
    value: c.id,
    selected: (e.calendarId && e.calendarId !== 'crm' ? e.calendarId : state.settings.googleCalendarId || writable.find((x) => x.primary)?.id) === c.id,
  }, c.name)));
  const chats = [...state.chats.values()].filter((c) => !c.is_group).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const chatSel = h('select', { class: 'input' }, h('option', { value: '' }, '— Nenhum —'),
    chats.map((c) => h('option', { value: c.jid, selected: c.jid === (task?.jid || e.jid) }, c.display_name)));
  const caseSel = h('select', { class: 'input' });
  const loadCases = async () => {
    const list = chatSel.value ? await api('cases:list', { jid: chatSel.value, includeClosed: false }).catch(() => []) : [];
    fill(caseSel, h('option', { value: '' }, list.length ? '— Nenhum —' : '— Sem casos —'),
      ...list.map((k) => h('option', { value: String(k.id), selected: k.id === (task?.case_id || e.caseId) }, k.title)));
  };
  chatSel.addEventListener('change', loadCases);
  loadCases();

  const crmFields = h('div', { class: 'row' },
    h('label', { class: 'field grow' }, h('span', null, 'Cliente'), chatSel),
    h('label', { class: 'field grow' }, h('span', null, 'Caso'), caseSel));
  const allDayRow = h('label', { class: 'check' }, allDay, ' Dia todo');
  const kinds = h('div', { class: 'segmented wrap' });
  const drawKinds = () => {
    const opts = [['evento', 'Compromisso'], ...Object.entries(TASK_KINDS).map(([k, v]) => [k, `${v.label}`])];
    fill(kinds, ...opts.filter(([k]) => !(isEdit && ((task && k === 'evento') || (!task && k !== 'evento'))))
      .map(([k, label]) => h('button', {
        class: `seg ${kind === k ? 'active' : ''}`, disabled: k === 'evento' && !canGoogle,
        title: k === 'evento' ? 'Compromisso comum, só no Google Agenda (pessoal ou do escritório)' : 'Fica no CRM (com aviso) e vai também para o Google',
        onclick: () => { kind = k; drawKinds(); },
      }, label)));
    crmFields.classList.toggle('hidden', kind === 'evento');
    allDayRow.classList.toggle('hidden', kind !== 'evento');
  };
  drawKinds();

  modal({
    title: isEdit ? 'Editar compromisso' : 'Novo compromisso',
    body: h('div', { class: 'form' },
      kinds,
      h('label', { class: 'field' }, h('span', null, 'Título'), title),
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, h('span', null, 'Início'), startIn),
        h('label', { class: 'field grow' }, h('span', null, 'Fim'), endIn)),
      allDayRow,
      canGoogle && writable.length ? h('label', { class: 'field' }, h('span', null, 'Agenda do Google'), calSel)
        : h('p', { class: 'muted small' }, 'Conecte o Google Agenda para o compromisso aparecer também no Google e no celular.'),
      crmFields),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Salvar', primary: true,
        onClick: async () => {
          const t = title.value.trim();
          const s = fromLocalInput(startIn.value);
          let en = fromLocalInput(endIn.value);
          if (!t) { toast('Escreva um título', 'error'); return false; }
          if (!s) { toast('Escolha a data e a hora', 'error'); return false; }
          if (!en || en <= s) en = s + 3600e3;
          if (kind === 'evento') {
            const day0 = allDay.checked ? startOfDay(s) : s;
            const day1 = allDay.checked ? addDays(startOfDay(en - 1), 1) : en;
            await api('agenda:saveEvent', calSel.value, { title: t, start: day0, end: day1, allDay: allDay.checked }, isEdit && !task ? e.id : undefined);
          } else {
            await api('tasks:save', {
              id: task?.id, title: t, due_at: s, end_at: en, kind,
              jid: chatSel.value || null, case_id: caseSel.value ? Number(caseSel.value) : null,
              calendar_id: canGoogle ? calSel.value : undefined,
            });
          }
          toast('Compromisso salvo', 'success');
          setTimeout(load, 400);
          return true;
        },
      },
    ],
  });
}
