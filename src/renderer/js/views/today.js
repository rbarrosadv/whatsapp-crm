// Tela "Hoje": a primeira coisa que cada pessoa vê ao abrir o sistema.
// Meu dia (agenda + próximas ações, cada uma com o botão do que fazer) e
// Minha semana (5 dias em colunas), com o fechamento do dia no rodapé.
import {
  h, fill, fmtMoney, fmtTime, fmtDuration, toast, errToast, confirmDialog, debounce, openExternal,
} from '../util.js';
import { state, on, api, openChat, openClient, openLegal, openLead, isAwaiting, emit, setView } from '../store.js';
import { showTasks } from './tasks.js';
import { taskRow, taskDialog } from './crmpanel.js';
import { openCase, chargeDialog, TASK_KINDS } from './casemodal.js';
import { avatarEl } from '../components.js';
import { icon } from '../icons.js';
import { contactDialog } from './commercial.js';

const DAY = 864e5;
let root;
let mode = 'day'; // 'day' | 'week'
let scope = null; // 'mine' | 'all'
let loading = 0;

export function mountToday(el) {
  root = el;
  try { mode = localStorage.getItem('todayMode') === 'week' ? 'week' : 'day'; } catch { /* ignore */ }
  const refresh = debounce(() => state.view === 'today' && render(), 300);
  on('view', (v) => v === 'today' && render());
  on('tasks', refresh);
  on('cases', refresh);
  on('finance', refresh);
  on('intimations', refresh);
  on('leads', refresh);
  const slow = debounce(() => state.view === 'today' && render(), 5000);
  on('chats', slow);
}

function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

/** Faixas de data no fuso de quem está usando (o servidor pode estar em outro). */
function ranges() {
  const dayStart = startOfDay(Date.now());
  const d = new Date(dayStart);
  const back = (d.getDay() + 6) % 7; // segunda = 0
  const weekStart = startOfDay(dayStart - back * DAY + 12 * 3600e3);
  return { dayStart, dayEnd: startOfDay(dayStart + 36 * 3600e3), weekStart, weekEnd: startOfDay(weekStart + 7 * DAY + 12 * 3600e3) };
}

function greeting() {
  const hr = new Date().getHours();
  return hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite';
}

const kindTag = (kind) => {
  const k = TASK_KINDS[kind];
  return k && kind !== 'tarefa' ? h('span', { class: `kind-tag kind-${kind}` }, `${k.label}`) : null;
};

/** Título do evento sem o "" e sem o ícone do tipo (já aparece na etiqueta). */
function cleanTitle(e) {
  // títulos que vão para o Google trazem um símbolo do tipo na frente: aqui a etiqueta já diz
  let t = String(e.title || '').replace(/^[\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F\s]+/u, '');
  const kindIcon = TASK_KINDS[e.kind]?.icon;
  if (kindIcon && t.startsWith(kindIcon)) t = t.slice(kindIcon.length).trim();
  return t;
}

async function render() {
  const my = ++loading;
  if (!scope) scope = state.me?.role === 'socio' ? 'all' : 'mine';
  const r = ranges();
  const from = mode === 'day' ? r.dayStart : r.weekStart;
  const to = mode === 'day' ? r.dayEnd : r.weekEnd;
  let sum;
  let agenda;
  try {
    [sum, agenda] = await Promise.all([
      api('today:summary', { ...r, scope }),
      api('agenda:events', from, to).catch(() => ({ events: [] })),
    ]);
  } catch (e) { errToast(e); return; }
  if (my !== loading || state.view !== 'today') return;

  const events = (agenda.events || []).filter((e) => e.start < to && (e.end || e.start) >= from).sort((a, b) => a.start - b.start);
  const awaiting = [...state.chats.values()].filter((c) => isAwaiting(c) && !c.archived).sort((a, b) => a.last_ts - b.last_ts);
  const openToday = sum.today.filter((t) => !t.done);
  const prazosHoje = openToday.filter((t) => t.kind === 'prazo').length;
  const audHoje = events.filter((e) => e.kind === 'audiencia' && e.start < r.dayEnd).length;

  // faixa do que é mais urgente
  const alerts = [
    sum.intimations?.length && `${sum.intimations.length} intimação(ões) para conferir`,
    prazosHoje && `${prazosHoje} prazo(s) vencem hoje`,
    audHoje && `${audHoje} audiência(s) hoje`,
    sum.overdue.length && `${sum.overdue.length} compromisso(s) atrasado(s)`,
    sum.payments?.overdue.length && `${sum.payments.overdue.length} parcela(s) vencida(s)`,
  ].filter(Boolean);

  const me = state.me || { name: '' };
  fill(root,
    h('div', { class: 'page-head' },
      h('div', null,
        h('h2', null, `${greeting()}, ${me.name.split(' ')[0]}`),
        h('div', { class: 'muted' }, new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))),
      h('div', { class: 'row wrap' },
        h('div', { class: 'segmented' },
          h('button', { class: `seg ${mode === 'day' ? 'active' : ''}`, onclick: () => setMode('day') }, 'Meu dia'),
          h('button', { class: `seg ${mode === 'week' ? 'active' : ''}`, onclick: () => setMode('week') }, 'Minha semana')),
        h('select', {
          class: 'input select-sm', title: 'De quem são os compromissos mostrados',
          onchange: (e) => { scope = e.target.value; render(); },
        },
        h('option', { value: 'mine', selected: scope === 'mine' }, 'Meus compromissos'),
        h('option', { value: 'all', selected: scope === 'all' }, 'Escritório todo')),
        h('button', { class: 'btn btn-primary', onclick: () => taskDialog({}) }, [icon('plus', 15), 'Novo compromisso']))),

    h('div', { class: `today-alert ${alerts.length ? '' : 'ok'}` },
      alerts.length ? `${alerts.join(' · ')}` : 'Nada atrasado. Bom trabalho!'),

    h('div', { class: 'stats' },
      stat('Compromissos hoje', openToday.length, prazosHoje ? `${prazosHoje} prazo(s)` : 'em aberto', '', () => showTasks({ who: scope === 'mine' ? 'me' : 'all' })),
      stat('Atrasados', sum.overdue.length, sum.overdue.length ? 'resolver primeiro' : 'nenhum', sum.overdue.length ? 'stat-bad' : '', () => showTasks({ who: scope === 'mine' ? 'me' : 'all' })),
      stat('Intimações para conferir', sum.intimations?.length || 0, sum.intimations?.length ? 'DJEN · criar os prazos' : 'nenhuma nova',
        sum.intimations?.length ? 'stat-bad' : '', () => openLegal('intimacoes')),
      stat('Processos sem retorno', sum.staleCases.length, `cliente sem notícia há mais de ${sum.staleDays} dias`, sum.staleCases.length ? 'stat-warn' : '', () => openLegal('processos', { status: 'aberto' })),
      sum.payments ? stat('A receber na semana', h('span', { class: 'money' }, fmtMoney(sum.payments.weekTotal)),
        sum.payments.overdue.length ? `${sum.payments.overdue.length} vencida(s)` : 'nenhuma vencida', sum.payments.overdue.length ? 'stat-bad' : '',
        () => setView('finance')) : null,
      stat('Mensagens aguardando', awaiting.length, awaiting.length ? `Atendimento · a mais antiga há ${fmtDuration(Date.now() - awaiting[0].last_ts)}` : 'Atendimento em dia',
        awaiting.length ? 'stat-warn' : '', () => { setView('inbox'); emit('open-filter', 'awaiting'); })),

    mode === 'day' ? dayView(sum, events, awaiting) : weekView(events, r),

    h('div', { class: 'day-close' },
      h('div', null,
        h('b', null, 'Fechamento do dia'),
        h('div', { class: 'small' }, `Hoje: ${sum.doneToday} concluído(s) · ${openToday.length + sum.overdue.length} pendente(s)`
          + `${sum.noDate ? ` · ${sum.noDate} sem data` : ''}`)),
      openToday.length + sum.overdue.length
        ? h('button', { class: 'btn', onclick: () => postpone([...sum.overdue, ...openToday]) }, 'Passar pendentes para amanhã')
        : h('span', { class: 'small' }, 'Tudo resolvido por hoje')));
}

function stat(label, value, sub, tone = '', onClick) {
  return h('div', { class: `stat ${tone} ${onClick ? 'clickable' : ''}`, onclick: onClick },
    h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), sub ? h('div', { class: 'muted small' }, sub) : null);
}

function setMode(m) {
  mode = m;
  try { localStorage.setItem('todayMode', m); } catch { /* ignore */ }
  render();
}

// ------------------------------------------------------------ meu dia

function dayView(sum, events, awaiting) {
  const groups = [];
  if (sum.overdue.length) groups.push(group('Atrasados', 'Compromissos que já passaram da hora', sum.overdue.map((t) => taskRow(t, { showChat: true }))));
  const todayTasks = sum.today.filter((t) => !t.done);
  if (todayTasks.length) groups.push(group('Para hoje', null, todayTasks.map((t) => taskRow(t, { showChat: true }))));
  if (sum.payments && (sum.payments.overdue.length || sum.payments.dueSoon.length)) {
    const list = [...sum.payments.overdue, ...sum.payments.dueSoon].slice(0, 8);
    groups.push(group('Cobranças', 'Parcelas vencidas e dos próximos 7 dias', list.map((p) => {
      const chat = state.chats.get(p.jid);
      const late = p.due_at < startOfDay(Date.now());
      return actionRow({
        who: p.client_name || chat?.display_name || p.case_title, chat, clientId: p.client_id,
        text: h('span', null, `${p.case_title} · `, h('span', { class: 'money' }, fmtMoney(p.amount))),
        meta: late ? `venceu ${new Date(p.due_at).toLocaleDateString('pt-BR')}` : `vence ${new Date(p.due_at).toLocaleDateString('pt-BR')}`,
        late,
        action: 'Cobrar', onAction: () => chargeDialog(p.id),
      });
    })));
  }
  if (sum.intimations?.length) {
    groups.unshift(group('Intimações para conferir', 'Diário de Justiça Eletrônico (DJEN)', sum.intimations.slice(0, 6).map((i) => actionRow({
      who: i.client_name || i.process_number, clientId: i.client_id,
      text: `${i.tribunal} · ${i.doc_kind || i.kind} · ${String(i.text).slice(0, 110)}`,
      meta: `disponibilizada em ${new Date(i.date).toLocaleDateString('pt-BR')}${i.case_title ? ` · ${i.case_title}` : ' · processo não cadastrado'}`,
      late: true,
      action: 'Conferir', onAction: () => openLegal('intimacoes'),
    })), sum.intimations.length > 6 ? `e mais ${sum.intimations.length - 6}` : null));
  }
  if (sum.hearings?.length) {
    groups.unshift(group('Audiências realizadas: agendar prazos', 'Registre o resultado, agende os prazos que saíram e confira as intimações (ata, sentença)',
      sum.hearings.slice(0, 6).map((t) => actionRow({
        who: t.client_name || t.case_title || 'Audiência', clientId: t.client_id,
        text: `${t.title}${t.case_title && t.client_name ? ` · ${t.case_title}` : ''}`,
        meta: `foi em ${new Date(t.due_at).toLocaleDateString('pt-BR')} às ${fmtTime(t.due_at)}`,
        late: Date.now() - t.due_at > 2 * DAY,
        action: 'Agendar prazo',
        onAction: () => taskDialog({ kind: 'prazo', case_id: t.case_id, jid: t.jid, title: 'Prazo — ' }),
        secondary: { label: 'Feito', onClick: () => api('hearings:followUp', t.id, true).then(render).catch(errToast) },
      })), sum.hearings.length > 6 ? `e mais ${sum.hearings.length - 6}` : null));
  }
  if (sum.docRequests?.length) {
    groups.push(group('Documentos pedidos e não recebidos', 'Pedidos há mais de 3 dias', sum.docRequests.slice(0, 6).map((r) => actionRow({
      who: r.client_name || 'Cliente', clientId: r.client_id,
      text: `${r.title} · ${r.n} documento(s)`,
      meta: `pedido há ${fmtDuration(Date.now() - r.since)}`,
      late: Date.now() - r.since > 7 * DAY,
      action: 'Ver lista', onAction: () => openCase(r.case_id, { tab: 'fluxo' }),
    }))));
  }
  if (sum.staleCases.length) {
    groups.push(group('Processos sem retorno ao cliente', `Sem notícia há mais de ${sum.staleDays} dias`, sum.staleCases.slice(0, 6).map((k) => {
      const chat = state.chats.get(k.jid);
      return actionRow({
        who: k.client_name || chat?.display_name || 'Cliente', chat, clientId: k.client_id,
        text: k.title,
        meta: `último retorno há ${fmtDuration(Date.now() - k.since)}`,
        action: 'Dar notícia', onAction: () => (chat ? openChat(k.jid) : openCase(k.id)),
        secondary: { label: 'Abrir processo', onClick: () => openCase(k.id) },
      });
    })));
  }
  if (sum.leadsIdle?.length) {
    groups.push(group('Interessados sem próximo passo', 'Comercial: marque um retorno para não perder o cliente', sum.leadsIdle.slice(0, 6).map((l) => actionRow({
      who: l.name, onOpen: () => openLead(l.id),
      text: [l.stage_label, l.subject].filter(Boolean).join(' · '),
      meta: `último contato há ${fmtDuration(Date.now() - l.since)}`,
      late: Date.now() - l.since > 3 * DAY,
      action: 'Registrar atendimento', onAction: () => contactDialog({ lead_id: l.id }),
      secondary: { label: 'Abrir', onClick: () => openLead(l.id) },
    })), sum.leadsIdle.length > 6 ? `e mais ${sum.leadsIdle.length - 6}` : null));
  }
  if (awaiting.length) {
    groups.push(group('Mensagens aguardando resposta', 'Atendimento (WhatsApp)', awaiting.slice(0, 8).map((c) => actionRow({
      who: c.display_name, chat: c,
      text: (c.last_preview || '').slice(0, 120),
      meta: `há ${fmtDuration(Date.now() - c.last_ts)}`,
      action: 'Responder', onAction: () => openChat(c.jid),
    })), awaiting.length > 8 ? `e mais ${awaiting.length - 8}` : null));
  }
  return h('div', { class: 'today-grid' },
    h('section', { class: 'panel today-agenda' },
      h('div', { class: 'panel-head' }, h('h3', null, 'Agenda de hoje'), h('span', { class: 'muted small' }, 'com o Google Agenda')),
      events.length ? events.map((e) => agendaRow(e)) : h('p', { class: 'muted' }, 'Nenhum compromisso marcado para hoje.')),
    h('section', { class: 'today-actions' },
      h('h3', { class: 'today-title' }, 'Próximas ações'),
      groups.length ? groups : h('div', { class: 'panel' }, h('p', { class: 'muted' }, 'Nenhuma pendência. Aproveite para adiantar os casos.'))));
}

function group(title, hint, rows, more) {
  return h('div', { class: 'panel today-group' },
    h('div', { class: 'panel-head' }, h('h3', null, title), hint ? h('span', { class: 'muted small' }, hint) : null),
    rows, more ? h('div', { class: 'muted small' }, more) : null);
}

function actionRow({ who, chat, clientId, onOpen, text, meta, late, action, onAction, secondary }) {
  const open = onOpen || (clientId ? () => openClient(clientId) : chat ? () => openChat(chat.jid) : null);
  return h('div', { class: 'action-row' },
    chat ? avatarEl(chat, 34) : null,
    h('div', { class: 'grow action-main', onclick: open, title: clientId ? 'Abrir a ficha do cliente' : null },
      h('div', { class: 'action-who' }, who),
      text ? h('div', { class: 'action-text' }, text) : null,
      meta ? h('div', { class: `small ${late ? 'bad-text' : 'muted'}` }, meta) : null),
    secondary ? h('button', { class: 'btn btn-sm', onclick: secondary.onClick }, secondary.label) : null,
    h('button', { class: 'btn btn-sm btn-primary', onclick: onAction }, action));
}

function agendaRow(e) {
  const chat = e.jid ? state.chats.get(e.jid) : null;
  return h('div', { class: `agenda-row ${e.done ? 'done' : ''}`, onclick: () => openEvent(e) },
    h('div', { class: 'agenda-time' }, e.allDay ? 'Dia todo' : fmtTime(e.start)),
    h('div', { class: 'agenda-bar', style: { '--c': e.color || 'var(--accent)' } }),
    h('div', { class: 'grow' },
      kindTag(e.kind),
      h('div', { class: 'agenda-title' }, cleanTitle(e)),
      h('div', { class: 'muted small' }, [chat?.display_name, e.calendarName].filter(Boolean).join(' · '))));
}

function openEvent(e) {
  if (e.caseId) openCase(e.caseId, { tab: 'prazos' });
  else if (e.jid) openChat(e.jid);
  else if (e.htmlLink) openExternal(e.htmlLink);
}

// ------------------------------------------------------------ minha semana

function weekView(events, r) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const start = startOfDay(r.weekStart + i * DAY + 12 * 3600e3);
    const end = startOfDay(start + 36 * 3600e3);
    const list = events.filter((e) => e.start >= start && e.start < end);
    if (i >= 5 && !list.length) continue; // fim de semana só aparece se tiver algo
    days.push({ start, list, today: start === r.dayStart });
  }
  const total = events.length;
  const byKind = (k) => events.filter((e) => e.kind === k).length;
  return h('div', null,
    h('div', { class: 'chips today-week-sum' },
      h('span', { class: 'chip' }, `${total} compromisso(s)`),
      byKind('prazo') ? h('span', { class: 'chip' }, `${byKind('prazo')} prazo(s)`) : null,
      byKind('audiencia') ? h('span', { class: 'chip' }, `${byKind('audiencia')} audiência(s)`) : null,
      byKind('reuniao') ? h('span', { class: 'chip' }, `${byKind('reuniao')} reunião(ões)`) : null),
    h('div', { class: 'week-cols', style: { '--n': String(days.length) } },
      days.map((d) => h('div', { class: `week-col ${d.today ? 'today' : ''} ${d.start < r.dayStart ? 'past' : ''}` },
        h('div', { class: 'week-head' },
          h('b', null, new Date(d.start).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')),
          h('span', { class: 'muted small' }, `${new Date(d.start).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}${d.today ? ' · hoje' : ''}`)),
        d.list.length ? d.list.map((e) => h('div', { class: `week-ev ${e.done ? 'done' : ''}`, style: { '--c': e.color || 'var(--accent)' }, onclick: () => openEvent(e) },
          kindTag(e.kind),
          h('div', { class: 'small' }, e.allDay ? 'Dia todo' : fmtTime(e.start)),
          h('div', { class: 'week-ev-title' }, cleanTitle(e)),
          e.jid && state.chats.get(e.jid) ? h('div', { class: 'muted small' }, state.chats.get(e.jid).display_name) : null))
          : h('div', { class: 'muted small week-empty' }, 'Livre')))));
}

// ------------------------------------------------------------ fechamento do dia

/** Passa as pendências para amanhã, no mesmo horário (ou 9h, se era de madrugada). */
async function postpone(tasks) {
  const ok = await confirmDialog(`Passar ${tasks.length} compromisso(s) pendente(s) para amanhã, no mesmo horário? `
    + 'Prazos com data marcada pelo tribunal NÃO mudam sozinhos: confira antes.', { okLabel: 'Passar para amanhã' });
  if (!ok) return;
  const tomorrow = startOfDay(startOfDay(Date.now()) + 36 * 3600e3);
  const list = tasks.filter((t) => t.kind !== 'prazo' && t.kind !== 'audiencia').map((t) => {
    const d = new Date(t.due_at);
    const nd = new Date(tomorrow);
    if (d.getHours() < 7) nd.setHours(9, 0, 0, 0); else nd.setHours(d.getHours(), d.getMinutes(), 0, 0);
    return { id: t.id, due_at: nd.getTime() };
  });
  const kept = tasks.length - list.length;
  try {
    await api('tasks:reschedule', list);
    toast(`${list.length} compromisso(s) passado(s) para amanhã${kept ? `; ${kept} prazo(s)/audiência(s) ficaram como estão` : ''}.`, 'success', 6000);
  } catch (e) { errToast(e); }
}
