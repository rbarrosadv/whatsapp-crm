// Processo em detalhe (Jurídico → por cliente, e a aba "Visão geral" da ficha):
// régua das fases, "o que fazer agora" (próximo prazo, novidade, último
// retorno ao cliente), linha do tempo única (tribunal, prazos, equipe,
// cliente) com "Explicar ao cliente" nos andamentos importantes, e ao lado
// partes, honorários e documentos.
import { h, fill, toast, errToast, popupMenu, fmtDateTime, fmtMoney } from '../util.js';
import { state, api, openChat, openClient } from '../store.js';
import { icon } from '../icons.js';
import { phaseList, rulerPhases, phaseLabel, SIDE } from '../phases.js';
import { hintLabel, runHint } from './hints.js';

const DAY = 864e5;
let teamCache = [];
const fmtD = (ts) => (ts ? new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '');
const first = (n) => String(n || '').split(/\s+/)[0];
const daysTo = (ts) => Math.ceil((new Date(ts).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY);
export const dueText = (ts) => {
  const n = daysTo(ts);
  return n < 0 ? `venceu há ${-n} dia(s)` : n === 0 ? 'hoje' : n === 1 ? 'amanhã' : `em ${n} dias`;
};

const TL_FILTERS = [['tudo', 'Tudo'], ['trib', 'Tribunal'], ['prazos', 'Prazos'], ['equipe', 'Equipe'], ['cliente', 'Cliente']];
const TL_MATCH = {
  tudo: () => true,
  trib: (x) => x.type === 'move',
  prazos: (x) => x.type === 'task' || x.type === 'done',
  equipe: (x) => ['note', 'doc', 'phase'].includes(x.type) || (x.type === 'move' && !x.auto),
  cliente: (x) => x.type === 'client' || !!x.notified,
};
const TL_ICON = { move: 'landmark', task: 'clock', done: 'check', note: 'note', doc: 'file', phase: 'flag', client: 'message' };

/** Menu "Mudar fase" (escolha à mão; vale até um andamento levar adiante). */
export function phaseMenu(anchor, k, onDone) {
  const list = phaseList(state.settings.phaseConfig, k.kind).filter((p) => !p.hidden && p.id !== 'encerrado');
  popupMenu(anchor, list.map((p) => ({
    label: p.label, active: p.id === k.phase,
    onClick: () => api('cases:setPhase', k.id, p.id).then(() => { toast(`Fase: ${p.label}`, 'success'); onDone?.(); }).catch(errToast),
  })));
}

/**
 * Desenha o processo em `el`. `opts.row` = linha do `cases:overview` (se já
 * carregada); `opts.onOpenFull` abre a ficha completa.
 */
export async function caseDetail(el, caseId, opts = {}) {
  const ui = el.__ui || (el.__ui = { filter: 'tudo', routine: false, explain: null, caseId });
  if (ui.caseId !== caseId) Object.assign(ui, { filter: 'tudo', routine: false, explain: null, caseId });
  if (!el.childElementCount) fill(el, h('p', { class: 'muted small cp-loading' }, 'Carregando…'));
  let full;
  let tl;
  let tasks;
  try {
    [full, tl, tasks] = await Promise.all([api('cases:full', caseId), api('cases:timeline', caseId), api('tasks:list', { caseId })]);
    if (!teamCache.length) teamCache = await api('team:list').catch(() => []);
  } catch (e) { fill(el, h('p', { class: 'muted' }, e.message)); return; }
  if (ui.caseId !== caseId) return;
  const k = full.case;
  const redraw = () => caseDetail(el, caseId, opts);
  const cfg = state.settings.phaseConfig;
  const closed = k.status !== 'aberto';

  // ------------------------------------------------ régua das fases
  const when = {};
  for (const p of tl.phases) when[p.phase] = p.at; // a última entrada em cada fase
  const visited = tl.phases.map((p) => p.phase);
  const ruler = rulerPhases(cfg, k.kind, k.phase, visited);
  const curIdx = ruler.findIndex((p) => p.id === k.phase);
  const respName = (p) => {
    if (p.resp) return teamCache.find((u) => u.id === Number(p.resp))?.name || null;
    return k.responsible_name || null;
  };
  const seen = new Set(visited);
  const rulerEl = h('div', { class: 'cp-ruler' }, ruler.map((p, i) => {
    const cur = p.id === k.phase;
    const before = curIdx >= 0 && i < curIdx;
    const done = before && seen.has(p.id);
    const skipped = before && !seen.has(p.id); // o processo não passou por ela (ou não ficou registrado)
    const who = !before ? respName(p) : null;
    return h('div', { class: `cp-step ${before ? 'past' : ''} ${done ? 'done' : ''} ${skipped ? 'skipped' : ''} ${cur ? 'cur' : ''} ${SIDE.includes(p.id) ? 'side' : ''}`, title: skipped ? 'Sem registro desta fase' : null },
      h('span', { class: 'cp-dot' }, done ? icon('check', 11) : null),
      h('span', { class: 'cp-name' }, p.label),
      h('span', { class: 'cp-when' }, when[p.id] && (done || cur) ? fmtD(when[p.id]) : '\u00a0'),
      who ? h('span', { class: 'cp-who', title: 'Quem cuida desta fase' }, first(who)) : null);
  }));
  // a fase atual à vista (no celular a régua rola de lado)
  requestAnimationFrame(() => {
    const curEl = rulerEl.querySelector('.cp-step.cur');
    if (curEl && rulerEl.scrollWidth > rulerEl.clientWidth) rulerEl.scrollLeft = Math.max(0, curEl.offsetLeft - rulerEl.clientWidth / 2 + curEl.offsetWidth / 2);
  });

  // ------------------------------------------------ o que fazer agora
  const open = tasks.filter((t) => !t.done && t.due_at).sort((a, b) => a.due_at - b.due_at);
  const next = open[0];
  const hint = (full.hints || [])[0];
  const lastClient = k.last_update_at || k.created_at;
  const lastDays = Math.floor((Date.now() - lastClient) / DAY);
  const box = (cls, label, value, sub, ...actions) => h('div', { class: `cp-box ${cls || ''}` },
    h('span', { class: 'cp-k' }, label), h('span', { class: 'cp-v' }, value), sub ? h('span', { class: 'cp-s' }, sub) : null,
    actions.length ? h('div', { class: 'row wrap' }, actions) : null);
  const nextBox = next
    ? box(daysTo(next.due_at) <= 3 ? 'red' : '', 'Próximo compromisso', next.title, `${fmtDateTime(next.due_at)} · ${dueText(next.due_at)}${next.assignee_name ? ` · ${first(next.assignee_name)}` : ''}`,
      h('button', {
        class: 'btn btn-sm btn-primary',
        onclick: () => (next.kind === 'prazo' ? import('./crmpanel.js').then((x) => x.completeDialog({ ...next, case_id: next.case_id || caseId }, redraw))
          : api('tasks:save', { id: next.id, done: true }).then(() => { toast('Concluído', 'success'); redraw(); }).catch(errToast)),
      }, 'Concluir'))
    : box('', 'Próximo compromisso', closed ? 'Processo encerrado' : 'Nenhum prazo aberto', null,
      closed ? null : h('button', { class: 'btn btn-sm', onclick: () => import('./crmpanel.js').then((x) => x.taskDialog({ jid: k.jid, case_id: k.id, kind: 'prazo' })) }, 'Criar prazo'));
  let novBox;
  if (hint) {
    const l = hintLabel(hint);
    novBox = box('orange', 'Novidade', l.title, l.meta, h('button', { class: 'btn btn-sm', onclick: () => runHint(hint, redraw) }, l.action));
  } else if (opts.row?.novelty?.source === 'intimation') {
    const n = opts.row.novelty;
    novBox = box('orange', 'Intimação para conferir', `${n.kind || 'Intimação'}${n.doc_kind ? ` (${n.doc_kind})` : ''}`, n.text ? `${fmtD(n.date)} · ${n.text.slice(0, 90)}…` : fmtD(n.date),
      h('button', { class: 'btn btn-sm', onclick: () => import('../store.js').then((s) => s.openLegal('intimacoes')) }, 'Conferir e criar prazo'));
  } else if (k.prescription_at && k.prescription_at - Date.now() < 90 * DAY && !closed) {
    novBox = box('orange', 'Atenção', `Prescrição em ${fmtD(k.prescription_at)}`, 'Arquivado provisoriamente: confira se dá para movimentar.');
  } else {
    const lastMove = tl.items.find((x) => x.type === 'move');
    novBox = box('', 'Última movimentação', lastMove ? lastMove.title : 'Sem andamentos ainda', lastMove ? `${fmtD(lastMove.at)} · ${lastMove.auto ? 'tribunal' : 'equipe'}` : null);
  }
  const cliBox = k.no_client ? box('orange', 'Cliente', 'Processo sem cliente', 'Escolha quem é o cliente na ficha.')
    : box(!closed && lastDays >= (state.settings.staleCaseDays ?? 15) ? 'orange' : '', 'Último retorno ao cliente', lastDays <= 0 ? 'hoje' : `há ${lastDays} dia(s)`, k.client_jid ? 'pelo WhatsApp' : 'sem WhatsApp ligado',
      k.client_jid ? h('button', { class: 'btn btn-sm', onclick: () => openChat(k.client_jid) }, 'Abrir conversa') : null,
      h('button', { class: 'btn btn-sm', onclick: () => api('cases:touch', k.id).then(() => { toast('Retorno registrado', 'success'); redraw(); }).catch(errToast) }, 'Registrar retorno'));

  // ------------------------------------------------ linha do tempo
  const items = tl.items.filter(TL_MATCH[ui.filter]);
  const routine = items.filter((x) => x.routine);
  const shown = items.filter((x) => !x.routine || ui.routine);
  const tlEl = h('ul', { class: 'cp-tl' }, shown.length ? shown.map((x) => tlItem(x)) : h('li', { class: 'muted small cp-empty' }, 'Nada nesta categoria ainda.'));

  function tlItem(x) {
    const by = x.by ? `por ${first(x.by)}` : x.type === 'move' && x.auto ? `automático · ${x.src === 'djen' ? 'DJEN' : 'DataJud'}` : x.type === 'task' && x.auto ? 'pelo sistema' : '';
    const canExplain = x.type === 'move' && x.big && !x.notified && !closed && !k.no_client;
    const li = h('li', { class: `cp-item t-${x.type} ${x.big ? 'big' : ''}` },
      h('span', { class: 'cp-at' }, fmtD(x.at)),
      h('span', { class: 'cp-ic' }, icon(TL_ICON[x.type] || 'dot', 13)),
      h('div', { class: 'cp-what' },
        h('div', null, h('b', null, x.title), by ? h('span', { class: 'cp-by' }, ` · ${by}`) : null),
        x.text ? h('p', null, x.text) : null,
        x.due_at && x.type === 'task' ? h('p', null, `Para ${fmtDateTime(x.due_at)}`) : null,
        x.notified ? h('span', { class: 'cp-sent' }, icon('check', 12), ` Cliente avisado (${x.notified.via === 'whatsapp' ? 'WhatsApp' : 'outro meio'}${x.notified.by ? `, por ${first(x.notified.by)}` : ''})`) : null,
        canExplain && ui.explain !== x.id ? h('button', { class: 'btn btn-sm cp-explain-btn', onclick: () => { ui.explain = x.id; redraw(); } }, icon('message', 13), 'Explicar ao cliente') : null,
        ui.explain === x.id ? explainPanel(x) : null));
    return li;
  }

  function explainPanel(x) {
    const wrap = h('div', { class: 'cp-explain' }, h('p', { class: 'muted small' }, 'Preparando a mensagem…'));
    api('moves:clientText', x.id).then((r) => {
      const ta = h('textarea', { class: 'input', rows: 5 }, r.text);
      const send = async (via) => {
        try {
          if (via === 'copy') { try { await navigator.clipboard.writeText(ta.value); } catch { /* sem área de transferência */ } }
          await api('moves:notifyClient', x.id, ta.value, { via: via === 'whatsapp' ? 'whatsapp' : 'outro' });
          toast(via === 'whatsapp' ? 'Mensagem enviada ao cliente' : 'Marcado como avisado', 'success');
          ui.explain = null;
          redraw();
        } catch (e) { errToast(e); }
      };
      fill(wrap,
        h('span', { class: 'cp-k' }, `Mensagem para ${first(r.client_name) || 'o cliente'} · revise antes de enviar`),
        ta,
        h('div', { class: 'row wrap' },
          r.jid ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => send('whatsapp') }, 'Enviar pelo WhatsApp') : null,
          h('button', { class: 'btn btn-sm', onclick: () => send('copy') }, 'Copiar e marcar avisado'),
          h('button', { class: 'btn btn-sm', onclick: () => send('outro') }, 'Avisei por outro meio'),
          h('button', { class: 'btn btn-sm btn-link', onclick: () => { ui.explain = null; redraw(); } }, 'Cancelar')),
        r.jid ? null : h('p', { class: 'muted small' }, 'O cliente não tem WhatsApp ligado: copie o texto e envie por outro meio.'));
    }).catch((e) => fill(wrap, h('p', { class: 'muted small' }, e.message)));
    return wrap;
  }

  // ------------------------------------------------ ao lado
  const parties = full.parties || [];
  const side = h('div', { class: 'cp-side' },
    h('div', { class: 'cp-card' }, h('p', { class: 'cp-k' }, 'Partes'),
      h('dl', null,
        h('dt', null, 'Cliente'), h('dd', null, k.client_name ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); if (k.client_id) openClient(k.client_id); } }, k.client_name) : '—'),
        k.opposing_party ? [h('dt', null, 'Contrária'), h('dd', null, k.opposing_party)] : null,
        ...parties.filter((p) => !k.opposing_party || !String(k.opposing_party).includes(p.name)).slice(0, 4).map((p) => [h('dt', null, p.role || 'Parte'), h('dd', null, p.name)]))),
    state.can.finance && (k.billed_total || k.fee_total || k.fee_percent) ? h('div', { class: 'cp-card' }, h('p', { class: 'cp-k' }, 'Honorários'),
      k.billed_total ? [h('div', { class: 'cp-bar' }, h('i', { style: { width: `${Math.min(100, Math.round(((k.paid_total || 0) / k.billed_total) * 100))}%` } })),
        h('div', { class: 'small money' }, `${fmtMoney(k.paid_total || 0)} recebidos de ${fmtMoney(k.billed_total)}`)] : null,
      k.fee_percent ? h('div', { class: 'small' }, `Êxito: ${k.fee_percent}%`) : null,
      k.overdue_payments ? h('div', { class: 'small bad-text' }, `${k.overdue_payments} parcela(s) atrasada(s)`) : null) : null,
    h('div', { class: 'cp-card' }, h('p', { class: 'cp-k' }, 'Documentos'),
      h('div', { class: 'small' }, k.folder ? 'Pasta no OneDrive ligada' : 'Ainda sem pasta no OneDrive'),
      h('button', { class: 'btn btn-sm', onclick: () => opts.onOpenFull ? opts.onOpenFull('docs') : null }, k.folder ? 'Abrir pasta' : 'Criar pasta')));

  fill(el,
    opts.inModal ? null : h('div', { class: 'cp-head' },
      h('div', { class: 'grow' },
        h('h3', null, k.title, k.opposing_party ? h('span', { class: 'cp-vs' }, ` x ${k.opposing_party}`) : null),
        h('div', { class: 'cp-meta' },
          k.process_number ? h('span', { class: 'mono' }, k.process_number) : h('span', null, 'sem nº ainda'),
          k.court || k.tribunal ? h('span', null, k.court || k.tribunal) : null,
          k.area ? h('span', null, k.area) : null,
          h('span', null, `Resp.: ${k.responsible_name || '—'}`),
          k.datajud_updated_at ? h('span', { title: 'O DataJud recebe os dados dos tribunais com atraso: o que aconteceu depois disso pode não aparecer ainda' },
            `Tribunal atualizado até ${new Date(k.datajud_updated_at).toLocaleDateString('pt-BR')}`) : null)),
      opts.onOpenFull ? h('button', { class: 'btn btn-sm', onclick: () => opts.onOpenFull() }, 'Abrir ficha completa') : null),
    h('div', { class: 'cp-body' },
      h('section', null,
        h('div', { class: 'cp-sec' }, h('span', null, 'Fase do processo'),
          h('span', { class: 'muted small' }, k.phase_manual ? 'escolhida à mão' : 'pelos andamentos'),
          closed ? null : h('button', { class: 'btn btn-sm', onclick: (e) => phaseMenu(e.currentTarget, k, redraw) }, 'Mudar fase ▾')),
        rulerEl),
      h('section', null, h('div', { class: 'cp-sec' }, h('span', null, 'O que fazer agora')), h('div', { class: 'cp-now' }, nextBox, novBox, cliBox)),
      h('div', { class: 'cp-split' },
        h('section', null,
          h('div', { class: 'cp-sec' }, h('span', null, 'Linha do tempo'),
            h('div', { class: 'cp-filters' }, TL_FILTERS.map(([v, l]) => h('button', { class: `cp-chip ${ui.filter === v ? 'active' : ''}`, onclick: () => { ui.filter = v; redraw(); } }, l)))),
          tlEl,
          routine.length ? h('button', { class: 'btn btn-sm btn-link cp-routine', onclick: () => { ui.routine = !ui.routine; redraw(); } },
            ui.routine ? 'Esconder movimentos de rotina' : `+ ${routine.length} movimento(s) de rotina`) : null),
        side)));
}

export { phaseLabel };
