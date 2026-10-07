// Intimações (DJEN) — Jurídico → Intimações. Cadastro das OABs acompanhadas,
// busca (automática a cada 6 h, ou "Buscar agora"), conferência de cada
// intimação e criação do prazo na Agenda (a data é sugerida em dias úteis e a
// pessoa confere). Processos que aparecem nas intimações e ainda não estão no
// sistema podem ser cadastrados daqui.
import { h, fill, modal, toast, errToast, confirmDialog, fmtDateTime, toLocalInput, fromLocalInput, openExternal, normalize } from '../util.js';
import { state, api, on, openClient, setSetting } from '../store.js';
import { openCase } from './casemodal.js';
import { icon } from '../icons.js';

let filter = 'nova'; // nova | prazo | lida | todas
let scope = null; // 'minhas' | 'todas' (padrão: minhas para quem tem OAB)
const day = (ts) => (ts ? new Date(ts).toLocaleDateString('pt-BR') : '—');

export async function renderIntimations(el, redraw) {
  let st;
  let list;
  let unknown;
  try {
    [st, list, unknown] = await Promise.all([
      api('intimations:status'),
      api('intimations:list', filter === 'todas' ? {} : { status: filter }),
      api('courts:unknown'),
    ]);
  } catch (e) { errToast(e); return; }
  const canEdit = state.me?.role !== 'estagiario';
  const myOabs = st.oabs.filter((o) => o.user_id === state.me?.id).map((o) => String(o.id));
  if (scope == null) scope = myOabs.length && st.oabs.length > 1 ? 'minhas' : 'todas';
  if (scope === 'minhas') {
    list = list.filter((i) => String(i.oab_ids || '').split(',').some((id) => myOabs.includes(id)) || i.responsible_id === state.me?.id);
  }
  const counts = { nova: filter === 'nova' ? list.length : null };

  fill(el,
    oabPanel(st, canEdit, redraw),
    st.oabs.some((o) => o.active) ? historyPanel(st.history, redraw) : null,
    unknown.length ? unknownPanel(unknown, redraw) : null,
    h('div', { class: 'row wrap intim-tools' },
      st.oabs.length > 1 ? h('div', { class: 'segmented' },
        [['minhas', 'Minhas OABs'], ['todas', 'Todas']].map(([id, label]) => h('button', {
          class: `seg ${scope === id ? 'active' : ''}`, title: id === 'minhas' ? 'Intimações das suas OABs e dos processos em que você é responsável' : '',
          onclick: () => { scope = id; redraw(); },
        }, label))) : null,
      h('div', { class: 'segmented' },
        [['nova', `Para conferir${counts.nova != null ? ` (${counts.nova})` : ''}`], ['prazo', 'Com prazo criado'], ['lida', 'Conferidas'], ['todas', 'Todas']]
          .map(([id, label]) => h('button', { class: `seg ${filter === id ? 'active' : ''}`, onclick: () => { filter = id; redraw(); } }, label))),
      h('div', { class: 'grow' }),
      h('span', { class: 'muted small' }, st.running ? 'Buscando…' : st.lastRun ? `Última busca: ${fmtDateTime(st.lastRun)}` : 'Ainda não buscou'),
      h('button', {
        class: 'btn btn-primary', disabled: !st.oabs.some((o) => o.active),
        title: 'Busca no DJEN as publicações dos últimos 10 dias das OABs cadastradas (o sistema também busca sozinho a cada 6 horas)',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          toast('Buscando no Diário de Justiça Eletrônico Nacional…');
          try {
            const r = await api('intimations:check', { days: 10 });
            toast(r.errors.length ? `Busca com problema: ${r.errors[0]}` : `${r.new} intimação(ões) nova(s)`, r.errors.length ? 'error' : 'success', 7000);
          } catch (err) { errToast(err); }
          redraw();
        },
      }, 'Buscar agora')),
    list.length ? h('div', { class: 'intim-list' }, list.map((i) => card(i, redraw)))
      : h('div', { class: 'panel' }, h('p', { class: 'muted' }, filter === 'nova' ? 'Nenhuma intimação para conferir.' : 'Nada aqui.')));
}

// ------------------------------------------------------------ OABs

function oabPanel(st, canEdit, redraw) {
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', null, 'Advogados acompanhados no DJEN'),
      canEdit ? h('button', { class: 'btn btn-sm', onclick: () => oabDialog({}, redraw) }, [icon('plus', 15), state.can.admin ? 'Cadastrar OAB' : 'Cadastrar a minha OAB']) : null),
    st.oabs.length ? h('div', { class: 'oab-list' }, st.oabs.map((o) => h('div', { class: `oab-row ${o.active ? '' : 'off'}` },
      h('div', { class: 'grow' },
        h('b', null, o.name), h('span', { class: 'mono' }, ` · OAB ${Number(o.number).toLocaleString('pt-BR')}/${o.uf}`),
        h('div', { class: 'small' }, o.user_name
          ? [icon('user', 13), ` ${o.user_name}${o.user_id === state.me?.id ? ' (você)' : ''} — recebe os prazos e os avisos dos processos desta OAB`]
          : h('span', { class: 'warn-text' }, 'Sem dono no sistema: escolha quem recebe os prazos (Editar)')),
        h('div', { class: `small ${o.last_error ? 'bad-text' : 'muted'}` },
          o.last_error ? `Erro na última busca: ${o.last_error}` : o.last_check ? `Buscado em ${fmtDateTime(o.last_check)}` : 'Ainda não buscado',
          o.active ? '' : ' · pausado')),
      canEdit && (state.can.admin || !o.user_id || o.user_id === state.me?.id) ? h('button', { class: 'btn btn-sm', onclick: () => oabDialog(o, redraw) }, 'Editar') : null)))
      : h('p', { class: 'muted' }, 'Cadastre a OAB de cada advogado(a) do escritório. O sistema busca as intimações publicadas no DJEN em nome de cada um.'),
    h('div', { class: 'row wrap notify-who' },
      h('span', { class: 'small' }, 'Quem recebe o aviso das intimações:'),
      h('select', {
        class: 'input select-sm', disabled: !state.can.admin, title: state.can.admin ? '' : 'Só sócio muda',
        onchange: (e) => setSetting('courtsNotifyAll', e.target.value === 'all').then(redraw).catch(errToast),
      },
      h('option', { value: 'mine', selected: !state.settings.courtsNotifyAll }, 'O responsável pelo processo'),
      h('option', { value: 'all', selected: !!state.settings.courtsNotifyAll }, 'Toda a equipe'))));
}

async function oabDialog(o, redraw) {
  const team = await api('team:list').catch(() => []);
  const name = h('input', { class: 'input', value: o.name || '', placeholder: 'Nome completo como na OAB' });
  const number = h('input', { class: 'input', value: o.number || '', placeholder: 'Ex.: 14.271', inputmode: 'numeric' });
  const uf = h('input', { class: 'input', value: o.uf || 'MT', maxlength: 2, style: { textTransform: 'uppercase' } });
  const owner = o.id ? o.user_id : state.me?.id;
  const user = h('select', { class: 'input', disabled: !state.can.admin, title: state.can.admin ? '' : 'Cada advogado cadastra a própria OAB; só o sócio escolhe outra pessoa' },
    h('option', { value: '' }, '— nenhum —'), team.map((u) => h('option', { value: String(u.id), selected: u.id === owner }, u.name)));
  const active = h('input', { type: 'checkbox', checked: o.active !== 0 });
  modal({
    title: o.id ? 'Editar OAB' : 'Cadastrar OAB',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Advogado(a)'), name),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'Número da OAB'), number),
        h('label', { class: 'field' }, h('span', null, 'UF'), uf)),
      h('label', { class: 'field' }, h('span', null, 'Usuário no sistema (recebe os prazos dele)'), user),
      o.id ? h('label', { class: 'check' }, active, ' Buscar intimações desta OAB') : null),
    actions: [
      o.id ? { label: 'Excluir', danger: true, onClick: async () => { if (!await confirmDialog(`Parar de acompanhar ${o.name}? As intimações já recebidas continuam.`, { okLabel: 'Excluir', danger: true })) return false; await api('oabs:delete', o.id); redraw(); return true; } } : null,
      { label: 'Cancelar' },
      {
        label: 'Salvar', primary: true,
        onClick: async () => {
          await api('oabs:save', { id: o.id, name: name.value, number: number.value, uf: uf.value, user_id: user.value ? Number(user.value) : null, active: active.checked });
          toast('OAB salva. Clique em “Buscar agora” para trazer as intimações.', 'success', 6000);
          redraw();
          return true;
        },
      },
    ].filter(Boolean),
  });
}

// ------------------------------------------------------------ buscar meus processos (histórico do DJEN)

let historyOff = null;
function historyPanel(hs, redraw) {
  const months = h('select', { class: 'input select-sm' },
    [[6, 'últimos 6 meses'], [12, 'último ano'], [24, 'últimos 2 anos']].map(([v, l]) => h('option', { value: v, selected: v === 12 }, l)));
  const bar = h('div', { class: 'hist-bar' }, h('span'));
  const info = h('span', { class: 'muted small' });
  const btn = h('button', { class: 'btn btn-primary btn-sm' }, [icon('search', 15), 'Buscar meus processos']);
  const show = (x) => {
    const running = !!x?.running;
    btn.disabled = running;
    months.disabled = running;
    bar.style.display = running ? '' : 'none';
    if (running) bar.firstChild.style.width = `${Math.round((x.done / Math.max(1, x.total)) * 100)}%`;
    info.textContent = running ? `Buscando… ${x.done} de ${x.total} meses · ${x.processes} processo(s) até agora`
      : x?.finished ? `Última busca: ${fmtDateTime(x.finished)} · ${x.processes} processo(s) com publicações${x.errors?.length ? ` · ${x.errors.length} mês(es) com erro` : ''}` : '';
  };
  btn.onclick = async () => {
    try { show(await api('courts:history', { months: Number(months.value) })); toast('Buscando no DJEN, mês a mês. Pode continuar usando o sistema; aviso quando terminar.', 'info', 7000); } catch (e) { errToast(e); }
  };
  historyOff?.();
  historyOff = on('courts-history', (x) => { if (!bar.isConnected) return; show(x); if (!x.running) redraw(); });
  show(hs);
  return h('div', { class: 'panel hist-panel' },
    h('div', { class: 'panel-head' }, h('h3', null, 'Buscar meus processos'), h('div', { class: 'row' }, months, btn)),
    h('p', { class: 'muted small' }, 'Procura no Diário de Justiça Eletrônico (DJEN) todas as publicações das OABs acima no período e junta os números dos processos. Os que ainda não estão no sistema aparecem logo abaixo para cadastrar. Processos sem nenhuma publicação no período não aparecem (o DataJud não permite buscar por advogado).'),
    bar, info);
}

// ------------------------------------------------------------ processos encontrados

function unknownPanel(list, redraw) {
  return h('details', { class: 'panel unknown-procs', open: list.length <= 5 },
    h('summary', null, h('b', null, `${list.length} processo(s) nas intimações que ainda não estão no sistema`),
      h('span', { class: 'muted small' }, ' — cadastre para acompanhar os andamentos e ligar as próximas intimações')),
    list.map((p) => h('div', { class: 'unknown-row' },
      h('div', { class: 'grow' },
        h('div', null, h('b', { class: 'mono' }, p.process_number), h('span', { class: 'muted small' }, ` · ${p.tribunal || ''} · ${p.classe || ''}`)),
        h('div', { class: 'small' }, p.parties.map((x) => `${x.name}${x.polo === 'A' ? ' (autor)' : x.polo === 'P' ? ' (réu)' : ''}`).join(' × ') || '—'),
        h('div', { class: 'muted small' }, `${p.orgao || ''} · ${p.n} intimação(ões), última em ${day(p.last)}`)),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => importDialog(p, redraw) }, 'Cadastrar'),
      h('button', { class: 'btn btn-sm', title: 'Não é do escritório / não acompanhar', onclick: async () => { await api('courts:ignore', p.process_digits).catch(errToast); redraw(); } }, 'Ignorar'))));
}

async function importDialog(p, redraw) {
  const clients = await api('clients:list', {}).catch(() => []);
  let chosen = null; // { id } ou { name }
  const box = h('div', { class: 'picker-list short' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Procurar cliente já cadastrado…' });
  const role = h('select', { class: 'input' }, h('option', { value: 'autor' }, 'Autor / requerente'), h('option', { value: 'reu' }, 'Réu / requerido'), h('option', { value: '' }, 'Outro'));
  const title = h('input', { class: 'input', value: p.classe ? p.classe.charAt(0) + p.classe.slice(1).toLowerCase() : '', placeholder: 'Assunto do caso' });
  const draw = () => {
    const q = normalize(search.value);
    const fromParties = p.parties.map((x) => ({ name: x.name, polo: x.polo, existing: clients.find((c) => normalize(c.name) === normalize(x.name)) }));
    fill(box,
      h('div', { class: 'muted small' }, 'Partes da intimação:'),
      fromParties.map((x) => h('div', {
        class: `picker-item ${chosen && (chosen.id ? chosen.id === x.existing?.id : chosen.name === x.name) ? 'active' : ''}`,
        onclick: () => { chosen = x.existing ? { id: x.existing.id } : { name: x.name }; role.value = x.polo === 'P' ? 'reu' : 'autor'; draw(); },
      }, h('div', null, x.name, h('span', { class: 'muted small' }, x.existing ? ' · já é cliente' : ' · cadastrar como cliente')))),
      q ? clients.filter((c) => normalize(`${c.name} ${c.cpf || ''}`).includes(q)).slice(0, 20).map((c) => h('div', {
        class: `picker-item ${chosen?.id === c.id ? 'active' : ''}`, onclick: () => { chosen = { id: c.id }; draw(); },
      }, h('div', null, c.name))) : null);
  };
  search.addEventListener('input', draw);
  draw();
  modal({
    title: `Cadastrar processo ${p.process_number}`,
    wide: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'field' }, h('span', null, 'Quem é o cliente do escritório?'), search, box),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'O cliente é'), role),
        h('label', { class: 'field' }, h('span', null, 'Assunto'), title)),
      h('p', { class: 'muted small' }, 'O sistema cria o processo com tribunal, vara e partes da intimação, liga as intimações dele e busca os andamentos no DataJud.')),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Cadastrar processo', primary: true,
        onClick: async () => {
          if (!chosen) { toast('Escolha o cliente', 'error'); return false; }
          const id = await api('courts:import', p.process_digits, { client_id: chosen.id, client_name: chosen.name, client_role: role.value, title: title.value.trim() || undefined });
          toast('Processo cadastrado', 'success');
          redraw();
          setTimeout(() => openCase(id, { tab: 'andamentos' }), 100);
          return true;
        },
      },
    ],
  });
}

// ------------------------------------------------------------ intimação

function card(i, redraw) {
  const text = h('div', { class: 'intim-text' }, i.text);
  return h('div', { class: `panel intim intim-${i.status}` },
    h('div', { class: 'intim-head' },
      h('span', { class: 'intim-date' }, day(i.date)),
      h('span', { class: 'status-pill muted' }, i.tribunal || '—'),
      h('b', null, `${i.kind}${i.doc_kind ? ` · ${i.doc_kind}` : ''}`),
      h('span', { class: 'muted small grow' }, i.orgao || ''),
      i.status === 'prazo' ? h('span', { class: 'status-pill ok' }, `prazo ${day(i.task_due)}`) : i.status === 'lida' ? h('span', { class: 'status-pill muted' }, 'conferida') : h('span', { class: 'status-pill warn' }, 'para conferir')),
    h('div', { class: 'intim-proc small' },
      h('span', { class: 'mono' }, i.process_number || 's/ nº'),
      i.case_id ? [' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openCase(i.case_id, { tab: 'andamentos' }); } }, `${i.case_title}`),
        i.client_name ? [' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openClient(i.client_id); } }, `${i.client_name}`)] : null]
        : h('span', { class: 'muted' }, ' · processo ainda não cadastrado'),
      i.parties.length ? h('span', { class: 'muted' }, ` · ${i.parties.map((x) => x.name).join(' × ')}`) : null),
    text,
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn btn-sm', onclick: () => text.classList.toggle('open') }, 'Ler tudo'),
      i.link ? h('button', { class: 'btn btn-sm', onclick: () => openExternal(i.link) }, 'Abrir no tribunal') : null,
      h('div', { class: 'grow' }),
      i.status === 'nova' ? h('button', { class: 'btn btn-sm', title: 'Conferida, não gera prazo', onclick: async () => { await api('intimations:set', [i.id], 'lida').catch(errToast); redraw(); } }, 'Conferida, sem prazo') : null,
      i.status !== 'nova' ? h('button', { class: 'btn btn-sm', onclick: async () => { await api('intimations:set', [i.id], 'nova').catch(errToast); redraw(); } }, 'Voltar para conferir') : null,
      i.status !== 'prazo' ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => deadlineDialog(i, redraw) }, 'Criar prazo') : null));
}

async function deadlineDialog(i, redraw) {
  const team = await api('team:list').catch(() => []);
  const days = h('select', { class: 'input' }, [5, 8, 10, 15, 30].map((n) => h('option', { value: String(n), selected: n === 15 }, `${n} dias úteis`)));
  const due = h('input', { class: 'input', type: 'datetime-local' });
  const info = h('div', { class: 'muted small' });
  const title = h('input', { class: 'input', value: `Prazo: ${i.doc_kind || i.kind}${i.case_title ? ` — ${i.case_title}` : ` — ${i.process_number}`}` });
  const who = h('select', { class: 'input' }, team.map((u) => h('option', { value: String(u.id), selected: u.id === (i.responsible_id || state.me?.id) }, u.name)));
  const recalc = async () => {
    const r = await api('intimations:calc', i.id, Number(days.value));
    due.value = toLocalInput(r.due);
    fill(info, `Disponibilizada em ${day(i.date)} · publicada em ${day(r.published)} · prazo começa no dia útil seguinte.`);
  };
  days.addEventListener('change', recalc);
  await recalc();
  // sugestão pelo texto ("prazo de 5 dias", "15 (quinze) dias")
  const m = /(\d{1,2})\s*(?:\([a-zç ]+\)\s*)?dias/i.exec(i.text || '');
  if (m && [5, 8, 10, 15, 30].includes(Number(m[1]))) { days.value = m[1]; await recalc(); }
  modal({
    title: 'Criar prazo a partir da intimação',
    body: h('div', { class: 'form' },
      h('div', { class: 'intim-text open small' }, i.text),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'Prazo'), days),
        h('label', { class: 'field' }, h('span', null, 'Vence em'), due)),
      info,
      h('p', { class: 'bad-text small' }, 'Confira a data: feriados locais e suspensões do tribunal não entram na conta. Prazos em dobro (Fazenda, Defensoria, litisconsortes) ajuste à mão.'),
      h('label', { class: 'field' }, h('span', null, 'O que é'), title),
      h('label', { class: 'field' }, h('span', null, 'Responsável'), who)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Criar prazo na Agenda', primary: true,
        onClick: async () => {
          await api('intimations:deadline', i.id, { due_at: fromLocalInput(due.value), title: title.value, assignee_id: Number(who.value) });
          toast('Prazo criado na Agenda', 'success');
          redraw();
          return true;
        },
      },
    ],
  });
}
