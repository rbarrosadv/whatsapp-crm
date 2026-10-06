// Comercial (dentro do Atendimento): interessados que ainda não são clientes,
// num funil Primeiro contato → Consulta → Proposta → Fechou / Não fechou.
// Ficha do interessado com atendimentos, próximos passos, proposta de
// honorários (modelo revisado → WhatsApp, copiar ou PDF) e "Virar cliente",
// que cria o cliente e o processo com os honorários já preenchidos.
import {
  h, fill, modal, toast, errToast, confirmDialog, fmtMoney, fmtDateTime, fmtDuration, toLocalInput, fromLocalInput,
  normalize, debounce,
} from '../util.js';
import { state, on, emit, api, openChat, openClient, setView } from '../store.js';
import { openCase } from './casemodal.js';
import { taskRow } from './crmpanel.js';
import { icon } from '../icons.js';

let root;
let mode = 'funil'; // funil | lista
let q = '';
let who = ''; // '' todos | 'me'
let meta = null;
let loading = 0;

const DAY = 864e5;
const isClosed = (l) => l.stage === 'ganho' || l.stage === 'perdido';

async function loadMeta() {
  if (!meta) meta = await api('leads:meta');
  return meta;
}
const stageColor = (id) => meta?.stages.find((s) => s[0] === id)?.[2] || '#94a3b8';
const stageName = (id) => meta?.stages.find((s) => s[0] === id)?.[1] || id;

export function mountCommercial(el) {
  root = el;
  try { mode = localStorage.getItem('commercialMode') || 'funil'; } catch { /* ignore */ }
  const refresh = debounce(() => { if (state.view === 'commercial') render(); }, 250);
  on('view', (v) => v === 'commercial' && render());
  on('leads', refresh);
  on('tasks', refresh);
  on('open-lead', (id) => openLead(id));
}

/** Botões para alternar entre as conversas do WhatsApp e o Comercial (as duas telas do Atendimento). */
export function atendimentoSwitch(current) {
  return h('div', { class: 'segmented atend-switch' },
    [['inbox', 'Conversas'], ['commercial', 'Comercial']].map(([v, label]) => h('button', {
      class: `seg ${current === v ? 'active' : ''}`, onclick: () => { if (current !== v) setView(v); },
    }, label)));
}

async function render() {
  const my = ++loading;
  let list;
  let stats;
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  try {
    await loadMeta();
    [list, stats] = await Promise.all([
      api('leads:list', { responsible: who || undefined }),
      api('leads:stats', { from: month.getTime() }),
    ]);
  } catch (e) { errToast(e); return; }
  if (my !== loading || state.view !== 'commercial') return;

  const search = h('input', { class: 'input search', type: 'search', placeholder: 'Buscar: nome, telefone, assunto, origem…', value: q });
  const body = h('div', { class: `comm-body ${mode === 'funil' ? 'board-cols' : ''}` });
  const draw = () => {
    const nq = normalize(q);
    const digits = q.replace(/\D/g, '');
    const vis = nq ? list.filter((l) => normalize(`${l.name} ${l.subject || ''} ${l.area || ''} ${l.source || ''} ${l.email || ''}`).includes(nq)
      || (digits.length >= 3 && String(l.phone || '').replace(/\D/g, '').includes(digits))) : list;
    if (mode === 'funil') fill(body, meta.stages.map(([id, name, color]) => column(id, name, color, vis.filter((l) => l.stage === id))));
    else fill(body, leadTable(vis));
  };
  search.addEventListener('input', debounce(() => { q = search.value; draw(); }, 150));

  const open = list.filter((l) => !isClosed(l));
  const noNext = open.filter((l) => !l.next_task);
  fill(root,
    h('div', { class: 'page-head' },
      h('div', { class: 'row' }, h('h2', null, 'Atendimento'), atendimentoSwitch('commercial')),
      h('div', { class: 'row wrap' },
        h('div', { class: 'segmented' },
          [['funil', 'Funil'], ['lista', 'Lista']].map(([m, label]) => h('button', {
            class: `seg ${mode === m ? 'active' : ''}`,
            onclick: () => { mode = m; try { localStorage.setItem('commercialMode', m); } catch { /* ignore */ } render(); },
          }, label))),
        h('button', { class: 'btn btn-primary', onclick: () => leadDialog() }, [icon('plus', 15), 'Novo interessado']))),
    h('div', { class: 'stats comm-stats' },
      stat('Em negociação', open.length, noNext.length ? `${noNext.length} sem próximo passo marcado` : 'todos com próximo passo', noNext.length ? 'stat-warn' : ''),
      stat('Novos no mês', stats.created, Object.keys(stats.bySource).length ? topSource(stats.bySource) : 'nenhum ainda'),
      stat('Fecharam no mês', stats.won, stats.lost ? `${stats.lost} não fecharam` : 'nenhum perdido'),
      stat('Conversão no mês', stats.conversion == null ? '—' : `${stats.conversion}%`, 'dos que decidiram, quantos fecharam'),
      state.can.finance ? stat('Propostas em aberto', h('span', { class: 'money' }, fmtMoney(stats.proposalsValue || 0)), `${stats.proposalsOpen} proposta(s) aguardando resposta`) : null),
    h('div', { class: 'row legal-tools' }, search,
      h('select', { class: 'input select-sm', onchange: (e) => { who = e.target.value; render(); } },
        [['', 'Toda a equipe'], ['me', 'Meus atendimentos']].map(([v, l]) => h('option', { value: v, selected: who === v }, l)))),
    body);
  draw();
}

function topSource(bySource) {
  const top = [...bySource].sort((a, b) => b.value - a.value)[0];
  return top ? `mais vindos de ${top.label} (${top.value})` : '';
}

function stat(label, value, sub, tone = '') {
  return h('div', { class: `stat ${tone}` },
    h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), sub ? h('div', { class: 'muted small' }, sub) : null);
}

function column(stage, name, color, leads) {
  // fechados e perdidos: só os dos últimos 60 dias (o resto fica na lista)
  if (stage === 'ganho' || stage === 'perdido') leads = leads.filter((l) => (l.closed_at || l.updated_at) > Date.now() - 60 * DAY);
  leads.sort((a, b) => (a.next_task?.due_at || Infinity) - (b.next_task?.due_at || Infinity) || b.updated_at - a.updated_at);
  const total = leads.reduce((s, l) => s + (Number(l.fee_total) || 0), 0);
  const col = h('div', {
    class: 'col', style: { '--c': color }, dataset: { stage },
    ondragover: (e) => { e.preventDefault(); col.classList.add('drop'); },
    ondragleave: (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); },
    ondrop: async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const id = Number(e.dataTransfer.getData('text/crm-lead'));
      if (id) moveTo(id, stage);
    },
  },
  h('div', { class: 'col-head' },
    h('div', { class: 'col-title' }, h('span', { class: 'dot' }), name, h('span', { class: 'count' }, leads.length)),
    total && state.can.finance && stage !== 'perdido' ? h('div', { class: 'col-total money' }, fmtMoney(total)) : null),
  h('div', { class: 'col-cards' }, leads.map(card)),
  stage === 'novo' ? h('button', { class: 'col-add', onclick: () => leadDialog() }, [icon('plus', 15), 'Novo interessado']) : null);
  return col;
}

function card(l) {
  const late = l.next_task?.due_at && l.next_task.due_at < Date.now();
  return h('div', {
    class: `card lead-card ${isClosed(l) ? 'closed' : ''}`,
    draggable: true,
    dataset: { lead: String(l.id) },
    ondragstart: (e) => { e.dataTransfer.setData('text/crm-lead', String(l.id)); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); },
    ondragend: (e) => e.currentTarget.classList.remove('dragging'),
    onclick: () => openLead(l.id),
  },
  h('div', { class: 'card-top' },
    h('div', { class: 'card-name' }, l.name, h('div', { class: 'card-case' }, l.subject || l.area || 'Assunto a definir')),
    l.jid ? h('button', { class: 'icon-btn small', title: 'Abrir conversa', onclick: (e) => { e.stopPropagation(); openChat(l.jid); } }, icon('message', 16)) : null),
  h('div', { class: 'muted small ellipsis' }, [l.source, l.referred_by ? `indicação de ${l.referred_by}` : null, l.responsible_name].filter(Boolean).join(' · ') || 'Origem não informada'),
  h('div', { class: 'card-foot' },
    l.fee_total && state.can.finance ? h('span', { class: 'money' }, fmtMoney(l.fee_total)) : h('span', { class: 'muted small' }, l.stage === 'perdido' ? (l.lost_reason || 'Não fechou') : ''),
    l.next_task ? h('span', { class: `task-flag ${late ? 'late' : ''}`, title: l.next_task.title }, icon('bell', 12, 'inline'), l.next_task.due_at ? fmtDateTime(l.next_task.due_at) : 'sem data')
      : !isClosed(l) ? h('span', { class: 'bad-text small', title: 'Marque o próximo passo para não esquecer este atendimento' }, 'sem próximo passo') : null));
}

function leadTable(list) {
  if (!list.length) return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('users', 28)), h('h3', null, 'Nenhum interessado'), h('p', null, 'Cadastre quem procurou o escritório para acompanhar até fechar.'));
  return h('table', { class: 'table' },
    h('thead', null, h('tr', null, ['Nome', 'Origem', 'Assunto', 'Etapa', 'Responsável', 'Último atendimento', 'Próximo passo'].map((t) => h('th', null, t)))),
    h('tbody', null, list.map((l) => h('tr', { class: 'clickable', onclick: () => openLead(l.id) },
      h('td', null, h('b', null, l.name), l.phone ? h('div', { class: 'muted small' }, l.phone) : null),
      h('td', null, l.source || '—'),
      h('td', null, l.subject || l.area || '—'),
      h('td', null, h('span', { class: 'stage-pill small', style: { '--c': stageColor(l.stage) } }, stageName(l.stage))),
      h('td', null, l.responsible_name || '—'),
      h('td', null, l.last_contact_at ? `há ${fmtDuration(Date.now() - l.last_contact_at)}` : '—'),
      h('td', { class: l.next_task?.due_at < Date.now() ? 'bad-text' : '' }, l.next_task ? `${l.next_task.title}${l.next_task.due_at ? ` · ${fmtDateTime(l.next_task.due_at)}` : ''}` : '—')))));
}

async function moveTo(id, stage) {
  if (stage === 'ganho') return convertDialog(await api('leads:get', id));
  if (stage === 'perdido') return lostDialog(id);
  try { await api('leads:setStage', id, stage); } catch (e) { errToast(e); }
}

function lostDialog(id) {
  const reasons = ['Preço', 'Fechou com outro advogado', 'Desistiu de entrar com a ação', 'Sem retorno', 'Caso sem viabilidade', 'Fora da nossa área'];
  const sel = h('select', { class: 'input' }, reasons.map((r) => h('option', { value: r }, r)), h('option', { value: '' }, 'Outro (escrever)'));
  const other = h('input', { class: 'input', placeholder: 'Motivo', style: { display: 'none' } });
  sel.addEventListener('change', () => { other.style.display = sel.value ? 'none' : ''; });
  modal({
    title: 'Não fechou',
    body: h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', null, 'Motivo (ajuda a entender onde melhorar)'), sel, other),
      h('p', { class: 'muted small' }, 'Os lembretes deste interessado são encerrados. Ele continua na lista, se voltar a procurar.')),
    actions: [{ label: 'Cancelar' }, {
      label: 'Marcar como não fechou', primary: true,
      onClick: () => api('leads:setStage', id, 'perdido', { lostReason: sel.value || other.value.trim() || null }),
    }],
  });
}

// ------------------------------------------------------------ cadastro

const field = (label, input, cls = '') => h('label', { class: `field ${cls}` }, h('span', null, label), input);

/** Novo interessado (ou edição dos dados). `preset`: { jid, name, phone } vindo de uma conversa. */
export async function leadDialog(l = null, preset = {}) {
  await loadMeta();
  const team = await api('team:list').catch(() => []);
  const v = { ...preset, ...(l || {}) };
  const name = h('input', { class: 'input', value: v.name || '', placeholder: 'Nome de quem procurou' });
  const phone = h('input', { class: 'input', value: v.phone || '', placeholder: '(65) 99999-0000' });
  const email = h('input', { class: 'input', type: 'email', value: v.email || '' });
  const source = h('select', { class: 'input' }, h('option', { value: '' }, '—'), meta.sources.map((s) => h('option', { value: s, selected: v.source === s }, s)));
  const referred = h('input', { class: 'input', value: v.referred_by || '', placeholder: 'Quem indicou' });
  const area = h('input', { class: 'input', value: v.area || '', placeholder: 'Ex.: Família, Trabalhista, Previdenciário', list: 'area-list' });
  const areas = h('datalist', { id: 'area-list' }, ['Família', 'Cível', 'Trabalhista', 'Previdenciário', 'Consumidor', 'Criminal', 'Empresarial', 'Tributário', 'Imobiliário'].map((a) => h('option', { value: a })));
  const subject = h('input', { class: 'input', value: v.subject || '', placeholder: 'Ex.: Divórcio consensual' });
  const desc = h('textarea', { class: 'input', rows: 3, placeholder: 'O que a pessoa contou, documentos que tem, urgência…' }, v.description || '');
  const resp = h('select', { class: 'input' }, h('option', { value: '' }, 'Sem responsável'),
    team.map((u) => h('option', { value: u.id, selected: (v.responsible_id ?? (l ? null : state.me?.id)) === u.id }, u.name)));
  const consult = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(v.consult_at) });
  const fee = state.can.finance ? feeFields(v) : null;
  modal({
    title: l ? `Editar ${l.name}` : 'Novo interessado',
    wide: true,
    body: h('div', { class: 'form' }, areas,
      h('div', { class: 'row wrap' }, field('Nome', name, 'grow'), field('Telefone', phone), field('E-mail', email)),
      h('div', { class: 'row wrap' }, field('Como chegou', source), field('Indicação de', referred, 'grow'), field('Responsável', resp)),
      h('div', { class: 'row wrap' }, field('Área', area), field('Assunto', subject, 'grow')),
      field('Resumo do caso', desc),
      h('div', { class: 'row wrap' }, field('Consulta marcada para', consult), h('p', { class: 'muted small grow' }, 'A consulta entra na Agenda de quem é responsável.')),
      fee ? fee.el : null,
      v.jid && !l ? h('p', { class: 'muted small' }, icon('message', 13, 'inline'), 'Ligado à conversa do WhatsApp.') : null),
    actions: [{ label: 'Cancelar' }, {
      label: 'Salvar', primary: true,
      onClick: async () => {
        if (!name.value.trim()) { toast('Informe o nome', 'error'); return false; }
        const id = await api('leads:save', {
          id: l?.id, name: name.value, phone: phone.value, email: email.value, source: source.value, referred_by: referred.value,
          area: area.value, subject: subject.value, description: desc.value, responsible_id: resp.value || null,
          consult_at: fromLocalInput(consult.value), ...(l ? {} : { jid: v.jid || null }), ...(fee ? fee.values() : {}),
        });
        emit('leads');
        if (!l) openLead(id);
        return true;
      },
    }],
  });
}

function feeFields(v) {
  const kind = h('select', { class: 'input' }, h('option', { value: '' }, 'A definir'),
    Object.entries(meta.feeKinds).map(([k, label]) => h('option', { value: k, selected: v.fee_kind === k }, label)));
  const total = h('input', { class: 'input', type: 'number', step: '0.01', min: 0, value: v.fee_total ?? '' });
  const count = h('input', { class: 'input', type: 'number', min: 1, max: 120, value: v.fee_count || 1 });
  const pct = h('input', { class: 'input', type: 'number', step: '0.5', min: 0, max: 100, value: v.fee_percent ?? '' });
  const fTotal = field('Valor total (R$)', total);
  const fCount = field('Parcelas', count);
  const fPct = field('Êxito (%)', pct);
  const sync = () => {
    const k = kind.value;
    fTotal.style.display = k && k !== 'exito' ? '' : 'none';
    fCount.style.display = k && k !== 'exito' ? '' : 'none';
    fPct.style.display = k === 'exito' || k === 'fixo_exito' ? '' : 'none';
  };
  kind.addEventListener('change', sync);
  sync();
  return {
    el: h('div', { class: 'field' }, h('span', null, 'Honorários da proposta'), h('div', { class: 'row wrap' }, field('Tipo', kind), fTotal, fCount, fPct)),
    values: () => ({ fee_kind: kind.value || null, fee_total: total.value || null, fee_count: Number(count.value) || 1, fee_percent: pct.value || null }),
  };
}

// ------------------------------------------------------------ ficha

export async function openLead(id) {
  let l;
  try { l = await api('leads:get', id); await loadMeta(); } catch (e) { errToast(e); return; }
  const body = h('div', { class: 'lead-sheet' });
  const m = modal({ title: l.name, wide: true, body });
  const off = [on('leads', () => reload()), on('tasks', () => reload())];
  const box = m.box;
  // fecha os ouvintes junto com a janela
  new MutationObserver((_, obs) => { if (!box.isConnected) { off.forEach((f) => f?.()); obs.disconnect(); } }).observe(document.body, { childList: true });
  async function reload() {
    if (!box.isConnected) return;
    try { l = await api('leads:get', id); } catch { return; }
    draw();
  }
  function draw() {
    box.querySelector('.modal-head h3').textContent = l.name;
    const closed = isClosed(l);
    fill(body,
      h('div', { class: 'lead-head' },
        h('span', { class: 'stage-pill', style: { '--c': stageColor(l.stage) } }, stageName(l.stage)),
        l.stage === 'perdido' && l.lost_reason ? h('span', { class: 'muted small' }, `Motivo: ${l.lost_reason}`) : null,
        h('div', { class: 'grow' }),
        l.jid ? h('button', { class: 'btn btn-sm', onclick: () => { m.close(); openChat(l.jid); } }, [icon('message', 15), 'Conversa']) : null,
        h('button', { class: 'btn btn-sm', onclick: () => contactDialog({ lead_id: l.id }) }, [icon('phone', 15), 'Registrar atendimento']),
        state.can.finance && !closed ? h('button', { class: 'btn btn-sm', onclick: () => proposalDialog(l) }, [icon('file', 15), l.proposal_sent_at ? 'Proposta de novo' : 'Proposta']) : null,
        l.case_id ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => { m.close(); openClient(l.client_id); } }, [icon('user', 15), 'Ficha do cliente'])
          : h('button', { class: 'btn btn-sm btn-primary', onclick: () => convertDialog(l, m) }, [icon('check', 15), 'Virar cliente'])),
      h('div', { class: 'lead-cols' },
        h('div', { class: 'stack' },
          h('div', { class: 'panel' },
            h('div', { class: 'panel-head' }, h('h3', null, 'Dados'), h('button', { class: 'btn btn-sm', onclick: () => leadDialog(l) }, [icon('edit', 14), 'Editar'])),
            dl([
              ['Telefone', l.phone], ['E-mail', l.email], ['Como chegou', [l.source, l.referred_by ? `indicação de ${l.referred_by}` : null].filter(Boolean).join(' · ')],
              ['Área', l.area], ['Assunto', l.subject], ['Responsável', l.responsible_name],
              ['Consulta', l.consult_at ? fmtDateTime(l.consult_at) : null],
              state.can.finance ? ['Honorários', feeSummary(l)] : null,
              ['Proposta', l.proposal_sent_at ? `enviada em ${new Date(l.proposal_sent_at).toLocaleDateString('pt-BR')}` : null],
              ['Cadastro', `${new Date(l.created_at).toLocaleDateString('pt-BR')}${l.created_by ? ` por ${l.created_by}` : ''}`],
            ]),
            l.description ? h('p', { class: 'lead-desc' }, l.description) : null),
          h('div', { class: 'panel' },
            h('div', { class: 'panel-head' }, h('h3', null, 'Próximos passos')),
            l.tasks.filter((t) => !t.done).length ? l.tasks.filter((t) => !t.done).map((t) => taskRow(t)) : h('p', { class: 'muted small' }, closed ? 'Nenhum.' : 'Nenhum marcado. Registre um atendimento com o próximo passo para não esquecer.'))),
        h('div', { class: 'panel' },
          h('div', { class: 'panel-head' }, h('h3', null, 'Atendimentos'), h('span', { class: 'muted small' }, `${l.contacts.length}`)),
          contactList(l.contacts))),
      h('div', { class: 'row lead-foot' },
        !closed ? h('button', { class: 'btn btn-sm', onclick: () => lostDialog(l.id) }, 'Não fechou') : null,
        l.stage === 'perdido' ? h('button', { class: 'btn btn-sm', onclick: () => api('leads:setStage', l.id, 'novo').catch(errToast) }, [icon('undo', 14), 'Voltou a procurar']) : null,
        !closed ? h('select', { class: 'input select-sm', title: 'Mudar a etapa', onchange: (e) => api('leads:setStage', l.id, e.target.value).catch(errToast) },
          meta.stages.filter(([s]) => !['ganho', 'perdido'].includes(s)).map(([s, n]) => h('option', { value: s, selected: l.stage === s }, n))) : null,
        h('div', { class: 'grow' }),
        state.can.admin ? h('button', {
          class: 'btn btn-sm btn-danger',
          onclick: async () => {
            if (!await confirmDialog(`Excluir ${l.name} do comercial? Os atendimentos e lembretes dele também saem.`, { okLabel: 'Excluir', danger: true })) return;
            try { await api('leads:delete', l.id); m.close(); } catch (e) { errToast(e); }
          },
        }, 'Excluir') : null));
  }
  draw();
}

function dl(rows) {
  return h('dl', { class: 'lead-dl' }, rows.filter((r) => r && r[1]).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}

function feeSummary(l) {
  const n = Math.max(1, Number(l.fee_count) || 1);
  const t = Number(l.fee_total) || 0;
  switch (l.fee_kind) {
    case 'fixo': return t ? h('span', { class: 'money' }, `${fmtMoney(t)}${n > 1 ? ` em ${n}×` : ''}`) : null;
    case 'parcelado': return t ? h('span', { class: 'money' }, `${fmtMoney(t)} em ${n}×`) : null;
    case 'exito': return l.fee_percent ? `${l.fee_percent}% no êxito` : null;
    case 'fixo_exito': return h('span', { class: 'money' }, `${t ? fmtMoney(t) : ''}${l.fee_percent ? ` + ${l.fee_percent}% no êxito` : ''}`);
    default: return null;
  }
}

/** Linha do tempo dos atendimentos (também usada na ficha do cliente). */
export function contactList(contacts, { empty = 'Nenhum atendimento registrado ainda.' } = {}) {
  if (!contacts.length) return h('p', { class: 'muted small' }, empty);
  const kindIcon = { whatsapp: 'message', ligacao: 'phone', presencial: 'users', email: 'mail', video: 'video' };
  return h('div', { class: 'att-list' }, contacts.map((c) => h('div', { class: 'att-item' },
    h('span', { class: 'att-ico' }, icon(kindIcon[c.kind] || 'message', 16)),
    h('div', { class: 'grow' },
      h('div', { class: 'small muted' }, `${c.kind_label} · ${fmtDateTime(c.at)}${c.user_name ? ` · ${c.user_name}` : ''}`),
      h('div', { class: 'att-summary' }, c.summary),
      c.next_step ? h('div', { class: 'small' }, h('b', null, 'Próximo passo: '), c.next_step) : null),
    h('button', {
      class: 'icon-btn small', title: 'Apagar este registro',
      onclick: async () => { if (await confirmDialog('Apagar este registro de atendimento?', { okLabel: 'Apagar', danger: true })) api('leads:deleteContact', c.id).catch(errToast); },
    }, icon('trash', 15)))));
}

/** Registrar atendimento (de um interessado ou de um cliente). */
export async function contactDialog(target) {
  await loadMeta();
  let kind = 'ligacao';
  const kinds = h('div', { class: 'segmented' });
  const drawKinds = () => fill(kinds, Object.entries(meta.contactKinds).map(([k, label]) => h('button', {
    type: 'button', class: `seg ${kind === k ? 'active' : ''}`, onclick: () => { kind = k; drawKinds(); },
  }, label)));
  drawKinds();
  const at = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(Date.now()) });
  const summary = h('textarea', { class: 'input', rows: 4, placeholder: 'O que foi conversado, o que ficou combinado…' });
  const next = h('input', { class: 'input', placeholder: 'Ex.: Ligar para saber se aceitou a proposta' });
  const nextAt = h('input', { class: 'input', type: 'datetime-local' });
  const quick = h('div', { class: 'chips' }, [['Amanhã', 1], ['Em 3 dias', 3], ['Em 1 semana', 7]].map(([label, d]) => h('button', {
    type: 'button', class: 'chip',
    onclick: () => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(9, 0, 0, 0); nextAt.value = toLocalInput(x.getTime()); if (!next.value) next.value = 'Retomar contato'; },
  }, label)));
  modal({
    title: 'Registrar atendimento',
    wide: true,
    body: h('div', { class: 'form' },
      field('Como foi', kinds), field('Quando', at),
      field('Resumo', summary),
      h('div', { class: 'row wrap' }, field('Próximo passo', next, 'grow'), field('Para quando', nextAt)), quick,
      h('p', { class: 'muted small' }, 'Com data, o próximo passo vira um lembrete na sua Agenda.')),
    actions: [{ label: 'Cancelar' }, {
      label: 'Registrar', primary: true,
      onClick: async () => {
        if (!summary.value.trim()) { toast('Escreva um resumo', 'error'); return false; }
        await api('leads:addContact', { ...target, kind, at: fromLocalInput(at.value), summary: summary.value, next_step: next.value, next_at: fromLocalInput(nextAt.value) });
        toast('Atendimento registrado', 'success');
        return true;
      },
    }],
  });
}

// ------------------------------------------------------------ proposta

async function proposalDialog(l) {
  if (!l.fee_kind) toast('Dica: preencha os honorários em Editar para entrarem no texto.', 'info', 5000);
  let text;
  try { text = await api('leads:proposalText', l.id); } catch (e) { errToast(e); return; }
  const ta = h('textarea', { class: 'input', rows: 14 }, text);
  const go = async (send) => {
    await api('leads:proposal', l.id, { text: ta.value, send });
    toast(send ? 'Proposta enviada pelo WhatsApp. Lembrete para retomar em 3 dias úteis.' : 'Proposta marcada como enviada. Lembrete para retomar em 3 dias úteis.', 'success', 6000);
    return true;
  };
  modal({
    title: `Proposta de honorários — ${l.name}`,
    wide: true,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Revise o texto. Nada é enviado sem você confirmar. O modelo fica em Ajustes → Proposta de honorários.'), ta,
      l.jid ? null : h('p', { class: 'muted small' }, 'Sem WhatsApp: imprima/salve em PDF ou copie o texto e mande por e-mail.')),
    actions: [
      { label: 'Cancelar' },
      { label: 'Imprimir / PDF', onClick: async () => { await printProposal(l, ta.value); return false; } },
      { label: 'Copiar e marcar enviada', onClick: async () => { try { await navigator.clipboard.writeText(ta.value); } catch { /* sem área de transferência */ } return go(false); } },
      l.jid ? { label: 'Enviar pelo WhatsApp', primary: true, onClick: () => go(true) } : null,
    ].filter(Boolean),
  });
}

async function printProposal(l, text) {
  let r;
  try { r = await api('leads:proposalHtml', l.id, text); } catch (e) { errToast(e); return; }
  const frame = h('iframe', { class: 'receipt-frame', title: 'Proposta de honorários' });
  frame.srcdoc = r.html;
  modal({
    title: 'Proposta para imprimir',
    wide: true,
    body: h('div', { class: 'stack' }, frame, h('p', { class: 'muted small' }, 'Para salvar em PDF: Imprimir → “Salvar como PDF” (ou “Microsoft Print to PDF”).')),
    actions: [
      { label: 'Fechar' },
      { label: 'Marcar como enviada', onClick: async () => { await api('leads:proposal', l.id, { text, send: false }); toast('Proposta marcada como enviada', 'success'); return true; } },
      { label: 'Imprimir / salvar PDF', primary: true, onClick: () => { frame.contentWindow.focus(); frame.contentWindow.print(); return false; } },
    ],
  });
}

// ------------------------------------------------------------ virar cliente

async function convertDialog(l, parent) {
  const [clients] = await Promise.all([api('clients:list', {}).catch(() => [])]);
  const first = normalize(l.name.split(/\s+/)[0] || '');
  const digits = String(l.phone || '').replace(/\D/g, '').slice(-8);
  const similar = clients.filter((c) => (first && normalize(c.name).includes(first)) || (digits && String(c.phone || '').replace(/\D/g, '').endsWith(digits)));
  const pick = h('select', { class: 'input' },
    h('option', { value: '' }, `Cadastrar cliente novo: ${l.name}`),
    similar.length ? h('optgroup', { label: 'Já é cliente (nome ou telefone parecido)' }, similar.slice(0, 30).map((c) => h('option', { value: c.id }, `${c.name}${c.cpf ? ` · ${c.cpf}` : ''}`))) : null);
  const title = h('input', { class: 'input', value: l.subject || l.area || '' , placeholder: 'Ex.: Divórcio consensual' });
  const stages = state.pipelines.flatMap((p) => p.stages.map((s) => [s.id, `${p.name} → ${s.name}`, p.id]));
  const firstCase = stages.find((s) => s[2] === 'casos')?.[0] || stages[0]?.[0];
  const stage = h('select', { class: 'input' }, stages.map(([sid, label]) => h('option', { value: sid, selected: sid === firstCase }, label)));
  const canInstall = state.can.finance && l.fee_total > 0 && l.fee_kind && l.fee_kind !== 'exito';
  const next = new Date(); next.setMonth(next.getMonth() + 1); next.setHours(12, 0, 0, 0);
  const due = h('input', { class: 'input', type: 'date', value: next.toISOString().slice(0, 10) });
  const gen = h('input', { type: 'checkbox', checked: true });
  modal({
    title: `${l.name} fechou com o escritório`,
    wide: true,
    body: h('div', { class: 'form' },
      field('Cliente', pick),
      h('div', { class: 'row wrap' }, field('Assunto do processo', title, 'grow'), field('Começa em', stage)),
      canInstall ? h('div', { class: 'field' },
        h('label', { class: 'check' }, gen, ` Gerar as parcelas dos honorários (${fmtMoney(l.fee_total)} em ${l.fee_count || 1}×)`),
        h('div', { class: 'row' }, field('1ª parcela vence em', due))) : null,
      h('p', { class: 'muted small' }, 'O processo já nasce com a área, o resumo, o responsável e os honorários da proposta. Os atendimentos e lembretes vão para a ficha do cliente.')),
    actions: [{ label: 'Cancelar' }, {
      label: 'Virar cliente', primary: true,
      onClick: async () => {
        const r = await api('leads:convert', l.id, {
          clientId: pick.value ? Number(pick.value) : null, stageId: stage.value, title: title.value,
          firstDue: canInstall && gen.checked && due.value ? new Date(`${due.value}T12:00`).getTime() : null,
        });
        toast(`${l.name} agora é cliente. Processo aberto.`, 'success', 5000);
        parent?.close();
        openCase(r.caseId);
        return true;
      },
    }],
  });
}
