// Jurídico → "Por cliente" (três colunas: clientes · processos do cliente ·
// processo em detalhe), "Quadro por fase" (arrastar muda a fase) e
// "Atividade da equipe". Semáforo: vermelho = compromisso em até 3 dias,
// laranja = novidade/prescrição, cinza = parado, verde = em dia.
import { h, fill, toast, errToast, fmtDateTime, normalize, formatPhone } from '../util.js';
import { state, api, openClient } from '../store.js';
import { icon } from '../icons.js';
import { phaseList } from '../phases.js';
import { caseDetail, dueText } from './casepanel.js';
import { openCase } from './casemodal.js';

export const STATUS = {
  red: 'Compromisso em até 3 dias',
  orange: 'Novidade para conferir',
  gray: 'Parado',
  green: 'Em dia',
};
const ORDER = { red: 0, orange: 1, gray: 2, green: 3, closed: 4 };
const NO_CLIENT = -1;
const initials = (n) => String(n || '?').split(/\s+/).filter((w) => w.length > 2 || /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

const ui = { filter: null, clientId: null, caseId: null, show: 'clientes', q: '' };

/** Números do topo (clicar filtra). */
export function counters(cases, onChange) {
  const n = { red: 0, orange: 0, gray: 0, green: 0 };
  for (const k of cases) if (n[k.status] != null) n[k.status]++;
  return h('div', { class: 'lv-counters' }, Object.keys(n).map((s) => h('button', {
    class: `lv-counter ${ui.filter === s ? 'active' : ''}`, type: 'button',
    title: ui.filter === s ? 'Mostrar todos' : `Mostrar só: ${STATUS[s].toLowerCase()}`,
    onclick: () => { ui.filter = ui.filter === s ? null : s; onChange(); },
  }, h('span', { class: `lv-dot ${s}` }), h('b', null, String(n[s])), STATUS[s])));
}

/** Cartão de um processo (lista do cliente e quadro por fase). */
export function caseCard(k, { withClient = false, active = false, onClick, draggable = false } = {}) {
  const t = k.next_task;
  const slow = k.days_in_phase != null && k.phase_avg && k.days_in_phase > k.phase_avg * 1.5;
  const card = h('button', {
    class: `lv-card ${active ? 'active' : ''}`, type: 'button', draggable: draggable || null, dataset: { case: String(k.id) },
    onclick: () => onClick?.(k),
  },
    h('div', { class: 'lv-card-t' }, h('span', { class: `lv-dot ${k.status}`, title: STATUS[k.status] || 'Encerrado' }), h('span', null, k.title)),
    withClient ? h('div', { class: 'lv-card-client' }, k.client_name || 'Sem cliente') : null,
    h('div', { class: 'lv-card-num' }, `${k.process_number || 'sem nº ainda'}${k.opposing_party ? ` · x ${k.opposing_party}` : ''}`),
    h('div', { class: 'lv-card-phase' },
      h('span', { class: 'lv-phase' }, k.phase_label || '—'),
      k.days_in_phase != null ? h('span', { class: `lv-inphase ${slow ? 'slow' : ''}`, title: k.phase_avg ? `Média do escritório nesta fase: ${k.phase_avg} dias` : 'Ainda sem média do escritório' }, (k.days_in_phase === 0 ? 'nesta fase desde hoje' : k.days_in_phase === 1 ? 'há 1 dia nesta fase' : `há ${k.days_in_phase} dias nesta fase`)) : null),
    t ? h('div', { class: `lv-due ${k.status === 'red' ? 'red' : ''}` }, `${t.title} · ${dueText(t.due_at)}`) : null,
    k.novelty ? h('div', { class: 'lv-nov' }, 'Novidade: ', h('b', null, k.novelty.source === 'intimation' ? `${k.novelty.kind || 'Intimação'}${k.novelty.doc_kind ? ` (${k.novelty.doc_kind})` : ''}` : k.novelty.title)) : null,
    k.prescription_soon ? h('div', { class: 'lv-nov' }, h('b', null, `Prescrição em ${new Date(k.prescription_at).toLocaleDateString('pt-BR')}`)) : null);
  return card;
}

// ------------------------------------------------------------ por cliente

/** Três colunas. `onFull(caseId, tab)` abre a ficha completa. */
export async function renderByClient(el, { onChanged } = {}) {
  let cases;
  let clients;
  try {
    [cases, clients] = await Promise.all([api('cases:overview', {}), api('clients:list', {})]);
  } catch (e) { fill(el, h('p', { class: 'muted' }, e.message)); return; }
  const byClient = new Map();
  for (const k of cases) {
    const key = k.client_id || NO_CLIENT;
    if (!byClient.has(key)) byClient.set(key, []);
    byClient.get(key).push(k);
  }
  for (const list of byClient.values()) list.sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.next_task?.due_at || 9e15) - (b.next_task?.due_at || 9e15));
  const worst = (id) => Math.min(...(byClient.get(id) || []).map((k) => ORDER[k.status]), 9);
  // clientes com processo primeiro (os que pedem atenção no topo), depois os demais
  const rows = clients.map((c) => ({ ...c, cases: byClient.get(c.id) || [] }));
  if (byClient.has(NO_CLIENT)) rows.unshift({ id: NO_CLIENT, name: 'Processos sem cliente', cases: byClient.get(NO_CLIENT), special: true });
  rows.sort((a, b) => (b.special ? 1 : 0) - (a.special ? 1 : 0) || worst(a.id) - worst(b.id) || a.name.localeCompare(b.name, 'pt-BR'));
  if (ui.clientId == null || !rows.some((r) => r.id === ui.clientId)) {
    const firstWith = rows.find((r) => r.cases.length && !r.special) || rows[0];
    ui.clientId = firstWith?.id ?? null;
    ui.caseId = firstWith?.cases[0]?.id ?? null;
  }

  const col1 = h('section', { class: 'lv-col lv-c1' });
  const col2 = h('section', { class: 'lv-col lv-c2' });
  const col3 = h('section', { class: 'lv-col lv-c3' });
  const cols = h('div', { class: 'lv-cols', dataset: { show: ui.show } }, col1, col2, col3);
  const go = (show) => { ui.show = show; cols.dataset.show = show; if (show !== 'clientes') history.pushState?.({ lv: show }, ''); };

  const search = h('input', { class: 'input lv-search', type: 'search', value: ui.q, placeholder: 'Cliente, CPF ou nº do processo' });
  const list = h('div', { class: 'lv-scroll' });
  const drawClients = () => {
    const q = normalize(ui.q.trim());
    const digits = ui.q.replace(/\D/g, '');
    const shown = rows.filter((r) => {
      if (ui.filter && !r.cases.some((k) => k.status === ui.filter)) return false;
      if (!q) return r.cases.length || !ui.filter;
      return normalize(r.name).includes(q)
        || (digits.length >= 3 && (String(r.cpf || '').replace(/\D/g, '').includes(digits) || r.cases.some((k) => String(k.process_number || '').replace(/\D/g, '').includes(digits))));
    });
    fill(list, shown.length ? shown.map((r) => h('button', {
      class: `lv-client ${r.id === ui.clientId ? 'active' : ''} ${r.special ? 'special' : ''}`, type: 'button',
      onclick: () => {
        ui.clientId = r.id;
        ui.caseId = r.cases[0]?.id ?? null;
        drawClients(); drawClient(); drawCase(); go('cliente');
      },
    },
      h('span', { class: 'lv-avatar' }, r.special ? icon('alert', 15) : initials(r.name)),
      h('span', { class: 'grow' }, h('span', { class: 'lv-name' }, r.name,
        r.dup_ids?.length ? h('span', { class: 'status-pill warn dup-pill', title: 'Há outro cadastro com o mesmo nome ou CPF/CNPJ' }, 'Repetido') : null),
      h('span', { class: 'lv-sub' }, r.cases.length ? `${r.cases.length} processo(s) em andamento` : 'sem processo em andamento')),
      h('span', { class: 'lv-dots' }, r.cases.slice(0, 6).map((k) => h('span', { class: `lv-dot ${k.status}` })))))
      : h('p', { class: 'muted small lv-empty' }, ui.filter ? 'Nenhum cliente com processo nessa situação.' : 'Nenhum cliente encontrado.'));
  };
  search.addEventListener('input', () => { ui.q = search.value; drawClients(); });
  fill(col1, h('div', { class: 'lv-head' }, h('span', { class: 'lv-label' }, 'Clientes'), search), list);

  const drawClient = () => {
    const r = rows.find((x) => x.id === ui.clientId);
    if (!r) { fill(col2, h('p', { class: 'muted small lv-empty' }, 'Escolha um cliente.')); return; }
    const ks = r.cases.filter((k) => !ui.filter || k.status === ui.filter);
    const card = (k) => caseCard(k, { active: k.id === ui.caseId, onClick: () => { ui.caseId = k.id; drawClient(); drawCase(); go('processo'); } });
    fill(col2,
      h('div', { class: 'lv-head' }, h('button', { class: 'lv-back', type: 'button', onclick: () => go('clientes') }, '← Clientes'), h('span', { class: 'lv-label' }, r.special ? 'Processos' : 'Cliente')),
      r.special ? h('div', { class: 'lv-chead' }, h('div', null, h('h3', null, 'Processos sem cliente'), h('div', { class: 'muted small' }, 'Importados ou vindos das intimações. Abra o processo para escolher o cliente.')))
        : h('div', { class: 'lv-chead' },
          h('span', { class: 'lv-avatar big' }, initials(r.name)),
          h('div', { class: 'grow' }, h('h3', null, r.name),
            h('div', { class: 'muted small' }, [r.cpf, r.phone ? formatPhone(String(r.phone).replace(/\D/g, '')) : null].filter(Boolean).join(' · ') || 'Sem documento cadastrado')),
          h('button', { class: 'btn btn-sm', onclick: () => openClient(r.id) }, 'Ficha do cliente')),
      r.dup_ids?.length && state.me?.role !== 'estagiario' ? h('div', { class: 'chat-hint lv-dup' }, icon('alert', 15), h('span', { class: 'grow' }, 'Há outro cadastro com o mesmo nome ou CPF/CNPJ.'),
        h('button', { class: 'btn btn-sm dup-btn', onclick: () => import('./legal.js').then((m) => m.mergeDialog(r, clients)) }, 'Juntar')) : null,
      r.special ? null : h('div', { class: 'lv-chips' },
        r.jid ? h('span', { class: 'lv-chip ok' }, 'WhatsApp ligado') : h('span', { class: 'lv-chip' }, 'Sem WhatsApp'),
        r.folder ? h('span', { class: 'lv-chip' }, 'Pasta no OneDrive') : null,
        r.overdue_payments && state.can.finance ? h('span', { class: 'lv-chip bad' }, `${r.overdue_payments} parcela(s) atrasada(s)`) : null),
      h('div', { class: 'lv-list-title' }, h('span', null, `Processos em andamento (${r.cases.length})`), ui.filter ? h('span', null, `filtro: ${STATUS[ui.filter]}`) : null),
      h('div', { class: 'lv-scroll lv-cards' }, ks.length ? ks.map(card) : h('p', { class: 'muted small lv-empty' }, r.cases.length ? 'Nenhum processo nessa situação.' : 'Nenhum processo em andamento.'),
        r.special ? null : h('button', { class: 'btn btn-sm lv-newcase', onclick: () => import('./casemodal.js').then((x) => x.newCaseDialog(null, { clientId: r.id })) }, icon('plus', 14), 'Novo processo')));
  };

  const drawCase = () => {
    if (!ui.caseId) { fill(col3, h('div', { class: 'lv-empty big' }, icon('scale', 28), h('p', null, 'Escolha um processo para ver os detalhes.'))); return; }
    const row = cases.find((k) => k.id === ui.caseId);
    const inner = col3.querySelector('.lv-detail') || h('div', { class: 'lv-detail' });
    if (!inner.isConnected) {
      fill(col3, h('div', { class: 'lv-head lv-head-back' }, h('button', { class: 'lv-back', type: 'button', onclick: () => go('cliente') }, '← Processos do cliente')), inner);
    }
    caseDetail(inner, ui.caseId, { row, onOpenFull: (tab) => openCase(ui.caseId, tab ? { tab } : undefined) });
  };

  const top = h('div');
  const drawTop = () => fill(top, counters(cases, () => { drawTop(); drawClients(); drawClient(); onChanged?.(); }));
  fill(el, top, cols);
  drawTop();
  drawClients();
  drawClient();
  drawCase();
}

/** Botão voltar do celular: volta uma coluna. */
export function backColumn() {
  const cols = document.querySelector('.lv-cols');
  if (!cols || window.innerWidth > 860) return false;
  if (ui.show === 'processo') { ui.show = 'cliente'; cols.dataset.show = 'cliente'; return true; }
  if (ui.show === 'cliente') { ui.show = 'clientes'; cols.dataset.show = 'clientes'; return true; }
  return false;
}

/** Entrando na aba: no celular começa pela lista de clientes. */
export function resetColumns() { ui.show = 'clientes'; }

/** Abre um processo na visão por cliente (ex.: vindo da atividade da equipe). */
export function focusCase(clientId, caseId) {
  ui.clientId = clientId ?? NO_CLIENT;
  ui.caseId = caseId ?? null;
  ui.show = caseId ? 'processo' : 'cliente';
}

// ------------------------------------------------------------ quadro por fase

export async function renderPhaseBoard(el, { onOpen } = {}) {
  let cases;
  try { cases = await api('cases:overview', {}); } catch (e) { fill(el, h('p', { class: 'muted' }, e.message)); return; }
  const cfg = state.settings.phaseConfig;
  const avg = (await api('cases:phaseInfo').catch(() => ({ averages: {} }))).averages;
  const team = await api('team:list').catch(() => []);
  const judicial = phaseList(cfg).filter((p) => !p.hidden && p.id !== 'encerrado');
  const inss = phaseList(cfg, 'inss').filter((p) => p.id !== 'encerrado');
  const hasInss = cases.some((k) => k.kind === 'inss');
  const draw = () => {
    const shown = cases.filter((k) => !ui.filter || k.status === ui.filter);
    const col = (p, kind) => {
      const ks = shown.filter((k) => k.phase === p.id && (kind === 'inss') === (k.kind === 'inss'));
      const who = p.resp ? team.find((u) => u.id === Number(p.resp))?.name : null;
      const c = h('div', { class: 'lv-bcol', dataset: { phase: p.id, kind } },
        h('header', null, h('span', { class: 'lv-bname' }, p.label), h('span', { class: 'lv-bn' }, String(ks.length)),
          avg[p.id] || who ? h('small', null, [avg[p.id] ? `média ${avg[p.id]} dias` : null, who ? `cuida: ${who.split(' ')[0]}` : null].filter(Boolean).join(' · ')) : null),
        h('div', { class: 'lv-bscroll' }, ks.length ? ks.map((k) => caseCard(k, { withClient: true, draggable: true, onClick: () => onOpen?.(k) })) : h('p', { class: 'muted small lv-empty' }, '—')));
      c.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/case') && c.dataset.kind === dragKind) { e.preventDefault(); c.classList.add('drop'); } });
      c.addEventListener('dragleave', () => c.classList.remove('drop'));
      c.addEventListener('drop', async (e) => {
        e.preventDefault();
        c.classList.remove('drop');
        const id = Number(e.dataTransfer.getData('text/case'));
        const k = cases.find((x) => x.id === id);
        if (!k || k.phase === p.id) return;
        try {
          await api('cases:setPhase', id, p.id);
          k.phase = p.id; k.phase_label = p.label; k.days_in_phase = 0;
          toast(`${k.title}: ${p.label}`, 'success');
          draw();
        } catch (err) { errToast(err); }
      });
      return c;
    };
    let dragKind = null;
    const board = h('div', { class: 'lv-board' }, judicial.map((p) => col(p, 'judicial')));
    const boardInss = hasInss ? h('div', null, h('p', { class: 'lv-label lv-board-title' }, 'INSS (administrativo)'), h('div', { class: 'lv-board' }, inss.map((p) => col(p, 'inss')))) : null;
    for (const b of [board, boardInss].filter(Boolean)) {
      b.addEventListener('dragstart', (e) => {
        const card = e.target.closest('.lv-card');
        if (!card) return;
        const k = cases.find((x) => x.id === Number(card.dataset.case));
        dragKind = k?.kind === 'inss' ? 'inss' : 'judicial';
        e.dataTransfer.setData('text/case', card.dataset.case);
        e.dataTransfer.effectAllowed = 'move';
      });
    }
    fill(el, counters(cases, draw), h('p', { class: 'muted small' }, 'Arraste o cartão para mudar a fase. A fase também muda sozinha pelos andamentos do tribunal.'), board, boardInss);
  };
  draw();
}

// ------------------------------------------------------------ atividade da equipe

export async function renderFeed(el, { onOpen } = {}) {
  let rows;
  try { rows = await api('activity:feed', {}); } catch (e) { fill(el, h('p', { class: 'muted' }, e.message)); return; }
  fill(el, h('div', { class: 'panel lv-feed' },
    h('div', { class: 'panel-head' }, h('h3', null, 'Atividade da equipe'), h('span', { class: 'muted small' }, 'Quem fez o quê, em qual cliente/processo. Clique para abrir.')),
    rows.length ? h('ul', { class: 'lv-feed-list' }, rows.map((r) => h('li', null, h('button', {
      class: 'lv-feed-row', type: 'button', disabled: !r.client_id && !r.case_id,
      onclick: () => onOpen?.(r),
    },
      h('span', { class: `lv-avatar sm ${r.auto ? 'auto' : ''}` }, r.auto ? icon('zap', 13) : initials(r.who || 'Sistema')),
      h('span', { class: 'grow' }, h('b', null, r.auto ? 'Automático' : r.who || 'Sistema'), ' ', r.what,
        r.client_name ? h('span', { class: 'lv-sub' }, r.client_name) : null),
      h('span', { class: 'lv-when' }, fmtDateTime(r.at))))))
      : h('p', { class: 'muted' }, 'Nada registrado ainda.')));
}
