// Ficha do caso: dados do processo, honorários (parcelas e cobrança),
// prazos/audiências, documentos e notas — tudo numa janela com abas.
import {
  h, fill, modal, toast, errToast, confirmDialog, promptDialog, popupMenu, fmtMoney, fmtDateTime, fmtDuration,
  fmtSize, toLocalInput, fromLocalInput, normalize, openMedia, saveMedia, pickFiles, uploadFiles, downloadBlob,
} from '../util.js';
import { state, on, api, stageById, openChat, openClient } from '../store.js';
import { avatarEl, caseStageMenu, stagePicker } from '../components.js';
import { taskRow, taskDialog } from './crmpanel.js';
import { caseFolderPanel } from './docs.js';
import { icon, dataIcon } from '../icons.js';
import { caseBanners } from './importcases.js';

export const TASK_KINDS = {
  prazo: { icon: '', label: 'Prazo' },
  audiencia: { icon: '', label: 'Audiência' },
  reuniao: { icon: '', label: 'Reunião' },
  tarefa: { icon: '', label: 'Tarefa' },
};

const TRIBUNAIS = ['TJMT', 'TRT23', 'TRF1', 'JEF', 'JEC', 'STJ', 'STF', 'TST', 'TRE-MT', 'INSS (administrativo)', 'PROCON'];
const AREAS = ['Cível', 'Trabalhista', 'Família e Sucessões', 'Previdenciário', 'Consumidor', 'Tributário', 'Empresarial',
  'Criminal', 'Imobiliário', 'Administrativo', 'Contratos', 'Consultoria'];

/** Situação de uma parcela, para mostrar com cor. */
export function paymentStatus(p) {
  if (p.paid_at) return { key: 'paid', label: 'Paga', cls: 'ok' };
  if (p.due_at && p.due_at < Date.now()) return { key: 'overdue', label: 'Vencida', cls: 'bad' };
  if (p.due_at && p.due_at < Date.now() + 3 * 864e5) return { key: 'soon', label: 'Vence logo', cls: 'warn' };
  return { key: 'open', label: 'A vencer', cls: 'muted' };
}

export function feeLabel(k) {
  const parts = [];
  if (k.fee_fixed) parts.push('Fixo');
  if (k.fee_installments) parts.push('Parcelado');
  if (k.fee_success) parts.push(`Êxito${k.fee_percent ? ` ${k.fee_percent}%` : ''}`);
  return parts.join(' + ');
}

// ------------------------------------------------------------ novo caso

/**
 * Novo processo/caso. Sempre de um cliente: vindo de uma conversa (jid), o
 * cliente é o dela (criado na hora se preciso); senão escolhe-se o cliente.
 */
export function newCaseDialog(jid, { stageId, clientId } = {}) {
  let chosen = clientId || null;
  let stage = stageId || state.pipelines[0]?.stages[0]?.id;
  const title = h('input', { class: 'input', placeholder: 'Ex.: Reclamação trabalhista, Inventário, Revisional de aluguel…' });
  const opposing = h('input', { class: 'input', placeholder: 'Parte contrária (opcional)' });
  const stageBtn = h('button', { class: 'stage-btn wide' });
  const drawStage = () => {
    const st = stageById(stage);
    stageBtn.style.setProperty('--c', st?.color || '#94a3b8');
    fill(stageBtn, st ? [dataIcon(st.pipeline.icon, 14), `${st.pipeline.name} → ${st.name}`] : 'Escolher etapa', ' ▾');
  };
  stageBtn.onclick = (e) => stagePicker(e.currentTarget, stage, (sid) => { stage = sid; drawStage(); });
  drawStage();

  let clientField = null;
  if (!jid && !clientId) {
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Pesquisar cliente pelo nome ou CPF…' });
    const list = h('div', { class: 'picker-list short' });
    let clients = [];
    const draw = async () => {
      clients = await api('clients:list', { q: input.value }).catch(() => []);
      fill(list, clients.slice(0, 40).map((c) => h('div', {
        class: `picker-item ${chosen === c.id ? 'active' : ''}`,
        onclick: () => { chosen = c.id; draw(); },
      }, h('div', null, h('b', null, c.name), c.cpf ? h('span', { class: 'muted small' }, ` · ${c.cpf}`) : null))),
      input.value.trim() ? h('div', {
        class: 'picker-item',
        onclick: async () => { chosen = await api('clients:save', { name: input.value.trim(), origin: 'Cadastro' }); input.value = ''; draw(); },
      }, h('div', null, `Cadastrar novo cliente “${input.value.trim()}”`)) : null);
    };
    input.addEventListener('input', debounceLocal(draw, 200));
    draw();
    clientField = h('div', { class: 'field' }, h('span', null, 'Cliente'), input, list);
  }

  modal({
    title: 'Novo processo / caso',
    body: h('div', { class: 'form' },
      clientField,
      h('label', { class: 'field' }, h('span', null, 'Assunto'), title),
      h('label', { class: 'field' }, h('span', null, 'Parte contrária'), opposing),
      h('div', { class: 'field' }, h('span', null, 'Funil e etapa'), stageBtn)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Criar',
        primary: true,
        onClick: async () => {
          if (!jid && !chosen) { toast('Escolha o cliente', 'error'); return false; }
          const id = await api('cases:save', {
            jid: chosen ? undefined : jid, client_id: chosen || undefined,
            title: title.value.trim() || undefined, stage_id: stage, opposing_party: opposing.value.trim() || undefined,
          });
          setTimeout(() => openCase(id, { tab: 'dados' }), 50);
          return true;
        },
      },
    ],
  });
}

function debounceLocal(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------- ficha do caso

export async function openCase(id, { tab = 'dados' } = {}) {
  let current = tab;
  const body = h('div', { class: 'case' });
  let k = null;
  const m = modal({ title: 'Caso', body, wide: true, onClose: () => { off1(); off2(); } });
  m.box.classList.add('modal-case');

  let full = null;
  let team = [];
  const reload = async () => {
    try { full = await api('cases:full', id); } catch { m.close(); return; }
    // não redesenha no meio da digitação de um campo do resumo (perderia o foco)
    const a = document.activeElement;
    if (k && current === 'dados' && body.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { k = full.case; return; }
    k = full.case;
    if (!team.length) team = await api('team:list').catch(() => []);
    render();
  };
  const off1 = on('cases', () => reload());
  const off2 = on('tasks', () => reload());

  function render() {
    const chat = (k.client_jid && state.chats.get(k.client_jid)) || { jid: k.jid, display_name: k.client_name || (k.no_client ? 'Cliente a identificar' : 'Cliente') };
    const st = stageById(k.stage_id);
    const closed = k.status !== 'aberto';
    const since = Date.now() - (k.last_update_at || k.created_at);
    m.box.querySelector('.modal-head h3').textContent = `${k.title}`;

    const pend = full.checklist.filter((i) => i.status !== 'recebido').length;
    const tabs = [
      ['dados', 'Resumo'],
      ['fluxo', `Fluxo ${full.flow.done}/${full.flow.total}${pend ? ` · ${pend} doc.` : ''}`],
      ['andamentos', `Andamentos${full.moves.length ? ` (${full.moves.length})` : ''}`],
      ['prazos', `Prazos${k.open_tasks ? ` (${k.open_tasks})` : ''}`],
      ['docs', `Documentos${k.docs_count ? ` (${k.docs_count})` : ''}`],
      state.can.finance ? ['honorarios', `Honorários${k.overdue_payments ? ` ${k.overdue_payments}` : ''}`] : null,
      ['notas', 'Notas'],
    ].filter(Boolean);
    if (current === 'honorarios' && !state.can.finance) current = 'dados';
    const content = h('div', { class: 'case-content' });
    fill(body,
      h('div', { class: 'case-head' },
        h('div', { class: 'case-client', onclick: () => { m.close(); if (k.client_id) openClient(k.client_id); }, title: 'Abrir a ficha do cliente' },
          avatarEl(chat, 36), h('div', null, h('b', null, k.client_name || chat.display_name),
            h('div', { class: 'muted small' }, 'ficha do cliente',
              k.client_jid ? h('a', { href: '#', class: 'case-wa', onclick: (e) => { e.preventDefault(); e.stopPropagation(); m.close(); openChat(k.client_jid); } }, ' · WhatsApp') : null))),
        h('button', {
          class: `stage-btn ${st ? '' : 'unset'}`, style: st ? { '--c': st.color } : null,
          onclick: (e) => caseStageMenu(e.currentTarget, k),
        }, st ? [dataIcon(st.pipeline.icon, 14), `${st.pipeline.name} → ${st.name}`] : 'Escolher etapa', ' ▾'),
        closed ? h('span', { class: 'status-pill muted' }, 'Encerrado') : null,
        h('div', { class: 'case-next', title: 'Próximo passo do fluxo do caso', onclick: () => { current = 'fluxo'; render(); } },
          h('span', { class: 'muted small' }, 'Próximo passo'), h('b', null, full.flow.next || 'Fluxo concluído')),
        h('div', { class: 'case-resp' }, h('span', { class: 'muted small' }, 'Responsável'), h('b', null, k.responsible_name || '—')),
        h('button', {
          class: 'icon-btn', title: 'Mais opções',
          onclick: (e) => popupMenu(e.currentTarget, [
            { icon: '', label: 'Renomear caso', onClick: async () => { const t = await promptDialog('Nome do caso', { value: k.title }); if (t) api('cases:save', { id, title: t }).catch(errToast); } },
            closed
              ? { icon: '↺', label: 'Reabrir caso', onClick: () => api('cases:setStatus', id, 'aberto').catch(errToast) }
              : { icon: '', label: 'Encerrar caso', onClick: () => api('cases:setStatus', id, 'encerrado').catch(errToast) },
            '-',
            { icon: '', label: 'Excluir caso', danger: true, onClick: async () => {
              if (!await confirmDialog(`Excluir o caso “${k.title}”? As parcelas e a lista de documentos dele também serão apagadas (os arquivos e as mensagens continuam).`, { okLabel: 'Excluir', danger: true })) return;
              await api('cases:delete', id).catch(errToast);
              m.close();
            } },
          ]),
        }, icon('more', 16))),
      caseBanners(k, { reload }),
      closed || k.no_client ? null : h('div', { class: `case-return ${since > (state.settings.staleCaseDays ?? 15) * 864e5 ? 'late' : ''}` },
        `Último retorno ao cliente: há ${fmtDuration(since)}`,
        h('button', { class: 'btn btn-sm', onclick: () => api('cases:touch', id).then(() => toast('Retorno registrado', 'success')).catch(errToast) }, 'Registrar retorno agora'),
        h('span', { class: 'muted small' }, '(atualiza sozinho quando você manda mensagem para o cliente)')),
      h('div', { class: 'tabs' }, tabs.map(([key, label]) => h('button', {
        class: `tab ${current === key ? 'active' : ''}`,
        onclick: () => { current = key; render(); },
      }, label))),
      content);
    ({ dados: renderDados, fluxo: renderFluxo, andamentos: renderMoves, honorarios: renderHonorarios, prazos: renderPrazos, docs: renderDocs, notas: renderNotas })[current](content);
  }

  // ------------------------------------------------------------- resumo
  function renderDados(el) {
    const save = (field) => (e) => api('cases:save', { id, [field]: e.target.value }).catch(errToast);
    const areaList = h('datalist', { id: 'areas-list' }, AREAS.map((a) => h('option', { value: a })));
    const tribList = h('datalist', { id: 'trib-list' }, TRIBUNAIS.map((a) => h('option', { value: a })));
    const sel = (field, options, value) => h('select', { class: 'input', onchange: save(field) },
      options.map(([v, l]) => h('option', { value: v, selected: String(value ?? '') === String(v) }, l)));
    fill(el,
      h('div', { class: 'case-grid' },
        h('label', { class: 'field' }, h('span', null, 'Tipo'), sel('kind', [['judicial', 'Processo judicial'], ['extrajudicial', 'Extrajudicial / administrativo'], ['consultivo', 'Consultivo (sem processo)']], k.kind || 'judicial')),
        h('label', { class: 'field' }, h('span', null, 'Advogado(a) responsável'),
          sel('responsible_id', [['', '— escolher —'], ...team.map((u) => [u.id, u.name])], k.responsible_id || '')),
        h('label', { class: 'field wide' }, h('span', null, 'Nº do processo (CNJ) / procedimento'),
          h('input', { class: 'input mono', value: k.process_number || '', placeholder: '0000000-00.0000.0.00.0000', onchange: save('process_number') })),
        h('label', { class: 'field' }, h('span', null, 'Tribunal'),
          h('input', { class: 'input', value: k.tribunal || '', list: 'trib-list', placeholder: 'Ex.: TJMT, TRT23', onchange: save('tribunal') }), tribList),
        h('label', { class: 'field' }, h('span', null, 'Vara / comarca / órgão'),
          h('input', { class: 'input', value: k.court || '', placeholder: 'Ex.: 3ª Vara do Trabalho de Cuiabá', onchange: save('court') })),
        h('label', { class: 'field' }, h('span', null, 'Área'),
          h('input', { class: 'input', value: k.area || '', list: 'areas-list', placeholder: 'Ex.: Trabalhista', onchange: save('area') }), areaList),
        h('label', { class: 'field' }, h('span', null, 'O cliente é'), sel('client_role', [['', '—'], ['autor', 'Autor / requerente'], ['reu', 'Réu / requerido'], ['terceiro', 'Terceiro']], k.client_role || '')),
        h('label', { class: 'field' }, h('span', null, 'Parte contrária (principal)'),
          h('input', { class: 'input', value: k.opposing_party || '', onchange: save('opposing_party') })),
        h('label', { class: 'field' }, h('span', null, 'Distribuído em'),
          h('input', { class: 'input', type: 'date', value: k.filed_at || '', onchange: save('filed_at') })),
        state.can.finance ? h('label', { class: 'field' }, h('span', null, 'Valor da causa (R$)'),
          h('input', { class: 'input money', value: k.claim_value != null ? Number(k.claim_value).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '', placeholder: '0,00', onchange: save('claim_value') })) : null,
        h('label', { class: 'field wide' }, h('span', null, 'Resumo do caso'),
          h('textarea', { class: 'input', rows: 3, placeholder: 'Em poucas linhas: o que aconteceu e o que o cliente quer.', onchange: save('description') }, k.description || ''))),
      partiesBlock(),
      h('p', { class: 'muted small' }, `Aberto em ${fmtDateTime(k.created_at)}. As alterações são salvas sozinhas.`));
  }

  function partiesBlock() {
    const roles = new Map(full.roles);
    const role = h('select', { class: 'input select-sm' }, full.roles.map(([v, l]) => h('option', { value: v }, l)));
    const name = h('input', { class: 'input input-sm', placeholder: 'Nome da parte' });
    const doc = h('input', { class: 'input input-sm', placeholder: 'CPF/CNPJ (opcional)' });
    const add = async () => {
      if (!name.value.trim()) return;
      try { await api('parties:save', { case_id: id, role: role.value, name: name.value, doc: doc.value }); } catch (e) { errToast(e); }
    };
    return h('div', { class: 'panel parties' },
      h('div', { class: 'panel-head' }, h('h3', null, 'Partes')),
      full.parties.length ? h('table', { class: 'table compact' }, h('tbody', null, full.parties.map((p) => h('tr', null,
        h('td', { class: 'muted small' }, roles.get(p.role) || p.role), h('td', null, h('b', null, p.name)), h('td', { class: 'mono small' }, p.doc || ''),
        h('td', { class: 'num' }, h('button', { class: 'icon-btn small', title: 'Tirar', onclick: () => api('parties:delete', p.id, id).catch(errToast) }, icon('trash', 16)))))))
        : h('p', { class: 'muted small' }, 'Nenhuma parte cadastrada além do cliente.'),
      h('div', { class: 'row wrap' }, role, name, doc, h('button', { class: 'btn btn-sm', onclick: add }, [icon('plus', 15), 'Adicionar'])));
  }

  // --------------------------------------------------------------- fluxo
  function renderFluxo(el) {
    const stepIcon = (s) => (s.status === 'done' ? icon('check', 16) : s.status === 'na' ? icon('x', 16) : icon('clock', 16));
    const steps = h('div', { class: 'flow' }, full.flow.steps.map((s, i) => h('div', { class: `flow-step ${s.status} ${full.flow.next === s.label ? 'next' : ''}` },
      h('span', { class: 'flow-icon' }, stepIcon(s)),
      h('div', { class: 'grow' },
        h('div', null, h('b', null, `${i + 1}. ${s.label}`), s.progress ? h('span', { class: 'muted small' }, ` · ${s.progress}`) : null),
        h('div', { class: 'muted small' }, s.status === 'done' ? (s.auto ? 'concluída automaticamente' : `concluída${s.by ? ` por ${s.by}` : ''}${s.at ? ` em ${new Date(s.at).toLocaleDateString('pt-BR')}` : ''}`)
          : s.status === 'na' ? 'não se aplica' : s.hint)),
      s.status === 'open'
        ? h('div', { class: 'row' },
          h('button', { class: 'btn btn-sm', onclick: () => api('cases:setStep', id, s.key, 'done').catch(errToast) }, 'Concluir'),
          h('button', { class: 'btn btn-sm', title: 'Esta etapa não se aplica a este caso', onclick: () => api('cases:setStep', id, s.key, 'na').catch(errToast) }, 'N/A'))
        : s.auto ? null : h('button', { class: 'btn btn-sm', onclick: () => api('cases:setStep', id, s.key, null).catch(errToast) }, 'Desfazer'))));
    fill(el,
      h('div', { class: 'flow-wrap' },
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', null, 'Etapas do caso'), h('span', { class: 'muted small' }, `${full.flow.done} de ${full.flow.total}`)), steps),
        checklistPanel()));
  }

  function checklistPanel() {
    const selected = new Set(full.checklist.filter((i) => i.status === 'pendente').map((i) => i.id));
    const statusPill = (i) => h('span', { class: `status-pill ${i.status === 'recebido' ? 'ok' : i.status === 'solicitado' ? 'warn' : 'muted'}` },
      i.status === 'recebido' ? `recebido ${new Date(i.received_at).toLocaleDateString('pt-BR')}` : i.status === 'solicitado' ? `pedido ${new Date(i.requested_at).toLocaleDateString('pt-BR')}` : 'falta pedir');
    const newItem = h('input', { class: 'input input-sm grow', placeholder: 'Outro documento…' });
    const addItem = async () => { if (newItem.value.trim()) await api('checklist:add', id, [newItem.value]).catch(errToast); };
    newItem.addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(); });
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', null, 'Documentos do cliente'),
        full.checklist.length ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => requestDocs([...selected]) }, 'Solicitar selecionados') : null),
      !full.checklist.length && full.suggested ? h('div', { class: 'docs-empty' },
        h('p', { class: 'small' }, `Lista sugerida${full.suggested.area ? ` para ${full.suggested.area}` : ''}:`),
        h('ul', { class: 'small' }, full.suggested.items.map((i) => h('li', null, i))),
        h('div', null, h('button', { class: 'btn btn-sm btn-primary', onclick: () => api('checklist:add', id, full.suggested.items).catch(errToast) }, 'Usar esta lista'))) : null,
      full.checklist.map((i) => h('div', { class: `check-row ${i.status}` },
        h('input', { type: 'checkbox', checked: selected.has(i.id), disabled: i.status === 'recebido', onchange: (e) => (e.target.checked ? selected.add(i.id) : selected.delete(i.id)) }),
        h('span', { class: 'grow' }, i.label),
        statusPill(i),
        i.status !== 'recebido'
          ? h('button', { class: 'btn btn-sm', title: 'Marcar como recebido (e guardar o arquivo, se quiser)', onclick: () => receiveDocDialog(i) }, 'Recebido')
          : h('button', { class: 'btn btn-sm', onclick: () => api('checklist:set', [i.id], 'pendente').catch(errToast) }, 'Desfazer'),
        h('button', { class: 'icon-btn small', title: 'Tirar da lista', onclick: () => api('checklist:delete', i.id).catch(errToast) }, icon('trash', 16)))),
      h('div', { class: 'row' }, newItem, h('button', { class: 'btn btn-sm', onclick: addItem }, icon('plus', 16))));
  }

  async function requestDocs(ids) {
    if (!ids.length) { toast('Marque os documentos que vai pedir', 'error'); return; }
    const text = await api('checklist:requestText', id, ids).catch((e) => { errToast(e); return null; });
    if (text == null) return;
    const ta = h('textarea', { class: 'input', rows: 10 }, text);
    const go = async (send) => {
      try {
        await api('checklist:request', id, ids, { text: ta.value, send });
        toast(send ? 'Pedido enviado pelo WhatsApp. Lembrete para conferir em 3 dias úteis.' : 'Marcados como pedidos. Lembrete para conferir em 3 dias úteis.', 'success', 6000);
      } catch (e) { errToast(e); return false; }
      return true;
    };
    modal({
      title: 'Solicitar documentos ao cliente',
      wide: true,
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, 'Revise o texto. Nada é enviado sem você confirmar.'), ta,
        k.client_jid ? null : h('p', { class: 'muted small' }, 'Este cliente não tem WhatsApp ligado: copie o texto e mande por e-mail ou outro meio.')),
      actions: [
        { label: 'Cancelar' },
        { label: 'Copiar e marcar como pedido', onClick: async () => { try { await navigator.clipboard.writeText(ta.value); } catch { /* sem área de transferência */ } return go(false); } },
        k.client_jid ? { label: 'Enviar pelo WhatsApp', primary: true, onClick: () => go(true) } : null,
      ].filter(Boolean),
    });
  }

  async function receiveDocDialog(item) {
    let files = [];
    const info = h('div', { class: 'muted small' }, 'Nenhum arquivo escolhido (opcional).');
    modal({
      title: `Recebido: ${item.label}`,
      body: h('div', { class: 'stack' },
        h('p', { class: 'small' }, k.folder ? 'O arquivo vai para a pasta do caso no OneDrive, com o nome do documento.' : 'O arquivo fica nos anexos do caso.'),
        h('div', { class: 'row' }, h('button', { class: 'btn btn-sm', onclick: async () => { files = await pickFiles(); info.textContent = files.length ? files.map((f) => f.name).join(', ') : 'Nenhum arquivo escolhido (opcional).'; } }, 'Escolher arquivo'), info)),
      actions: [
        { label: 'Cancelar' },
        { label: 'Marcar como recebido', primary: true, onClick: async () => {
          try { await api('checklist:set', [item.id], 'recebido', files.length ? await uploadFiles(files) : null); } catch (e) { errToast(e); return false; }
          return true;
        } },
      ],
    });
  }

  // ----------------------------------------------------------- andamentos
  function renderMoves(el) {
    const date = h('input', { class: 'input input-sm', type: 'date', value: new Date().toISOString().slice(0, 10) });
    const text = h('textarea', { class: 'input', rows: 2, placeholder: 'Ex.: Juntada de contestação; audiência designada para 10/11 às 14h.' });
    fill(el,
      h('div', { class: 'panel' },
        h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', null, 'Data'), date)),
        text,
        h('div', { class: 'row end' }, h('button', {
          class: 'btn btn-sm btn-primary',
          onclick: async () => {
            if (!text.value.trim()) return;
            const ts = date.value ? new Date(`${date.value}T12:00:00`).getTime() : Date.now();
            try { await api('moves:add', { case_id: id, text: text.value, ts }); } catch (e) { errToast(e); }
          },
        }, [icon('plus', 15), 'Registrar andamento'])),
        h('div', { class: 'row wrap datajud-row' },
          h('button', {
            class: 'btn btn-sm', disabled: !k.process_number,
            title: k.process_number ? 'Busca os andamentos no DataJud (CNJ). O sistema também atualiza sozinho uma vez por dia.' : 'Informe o nº do processo no Resumo',
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              try {
                const r = await api('cases:datajud', id);
                toast(r.found ? `${r.newMoves} andamento(s) novo(s)` : 'Processo não encontrado no DataJud (pode estar em segredo de justiça ou ainda não indexado).', r.found ? 'success' : 'info', 6000);
              } catch (err) { errToast(err); }
              reload();
            },
          }, 'Atualizar do tribunal (DataJud)'),
          h('span', { class: `small ${k.datajud_error ? 'bad-text' : 'muted'}` },
            k.datajud_checked_at ? `Consultado em ${fmtDateTime(k.datajud_checked_at)}${k.datajud_error ? ` — ${k.datajud_error}` : ''}` : 'Andamentos do DataJud e intimações do DJEN entram aqui sozinhos.'))),
      full.moves.length ? h('div', { class: 'timeline' }, full.moves.map((mv) => h('div', { class: `tl-item src-${mv.source}` },
        h('div', { class: 'tl-date' }, new Date(mv.ts).toLocaleDateString('pt-BR')),
        h('div', { class: 'grow' }, h('div', { class: 'tl-text' }, mv.text),
          h('div', { class: 'muted small' }, mv.source === 'manual' ? `registrado por ${mv.user_name || 'equipe'}` : mv.source.toUpperCase())),
        mv.source === 'manual' ? h('button', { class: 'icon-btn small', title: 'Apagar', onclick: async () => { if (await confirmDialog('Apagar este andamento?', { okLabel: 'Apagar', danger: true })) api('moves:delete', mv.id, id).catch(errToast); } }, icon('trash', 16)) : null)))
        : h('p', { class: 'muted small' }, 'Nenhum andamento registrado.'));
  }

  // ----------------------------------------------------------- honorários
  async function renderHonorarios(el) {
    const pays = await api('finance:list', { caseId: id });
    const toggle = (field, label, hint) => h('label', { class: `fee-type ${k[field] ? 'on' : ''}` },
      h('input', { type: 'checkbox', checked: k[field], onchange: (e) => api('cases:save', { id, [field]: e.target.checked }).catch(errToast) }),
      h('div', null, h('b', null, label), h('div', { class: 'muted small' }, hint)));
    const pct = k.billed_total ? Math.min(100, Math.round((k.paid_total / k.billed_total) * 100)) : 0;
    const overdue = pays.filter((p) => paymentStatus(p).key === 'overdue').reduce((a, p) => a + p.amount, 0);

    fill(el,
      h('div', { class: 'fee-types' },
        toggle('fee_fixed', 'Valor fixo', 'um valor combinado'),
        toggle('fee_installments', 'Parcelado', 'dividido em parcelas'),
        toggle('fee_success', 'Êxito', '% sobre o resultado')),
      h('div', { class: 'case-grid' },
        h('label', { class: 'field' }, h('span', null, 'Valor contratado (R$)'),
          h('input', { class: 'input', type: 'number', step: '0.01', value: k.fee_total ?? '', placeholder: '0,00', onchange: (e) => api('cases:save', { id, fee_total: e.target.value }).catch(errToast) })),
        k.fee_success ? h('label', { class: 'field' }, h('span', null, 'Percentual de êxito (%)'),
          h('input', { class: 'input', type: 'number', step: '0.5', value: k.fee_percent ?? '', placeholder: '30', onchange: (e) => api('cases:save', { id, fee_percent: e.target.value }).catch(errToast) })) : null),
      h('div', { class: 'fee-summary' },
        h('div', null, h('div', { class: 'muted small' }, 'Recebido'), h('b', { class: 'money' }, fmtMoney(k.paid_total))),
        h('div', null, h('div', { class: 'muted small' }, 'Lançado em parcelas'), h('b', null, fmtMoney(k.billed_total))),
        h('div', null, h('div', { class: 'muted small' }, 'Em aberto'), h('b', null, fmtMoney(k.billed_total - k.paid_total))),
        overdue ? h('div', null, h('div', { class: 'muted small' }, 'Vencido'), h('b', { class: 'bad-text' }, fmtMoney(overdue))) : null,
        h('div', { class: 'progress', title: `${pct}% recebido` }, h('div', { style: { width: `${pct}%` } }))),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn btn-primary btn-sm', onclick: async () => installmentsDialog((await api('cases:get', id).catch(() => null)) || k) }, [icon('plus', 15), 'Gerar parcelas']),
        h('button', { class: 'btn btn-sm', onclick: () => paymentDialog({ case_id: id }) }, [icon('plus', 15), 'Lançar valor avulso']),
        k.fee_success ? h('button', { class: 'btn btn-sm', onclick: () => successDialog(k) }, 'Lançar êxito') : null),
      pays.length
        ? h('table', { class: 'table compact' },
          h('thead', null, h('tr', null, ['Situação', 'Descrição', 'Vencimento', 'Valor', ''].map((t) => h('th', null, t)))),
          h('tbody', null, pays.map((p) => paymentRow(p))))
        : h('p', { class: 'muted small' }, 'Nenhuma parcela lançada. Use “Gerar parcelas” para dividir o valor com vencimentos mensais.'),
      costsBlock());
  }

  function costsBlock() {
    const box = h('div', { class: 'panel case-costs' }, h('p', { class: 'muted small' }, 'Carregando custas…'));
    Promise.all([api('finance:expenses', { caseId: id }), import('./finance.js')]).then(([list, fin]) => {
      const paid = list.filter((e) => e.paid_at).reduce((a, e) => a + e.amount, 0);
      const pending = list.filter((e) => e.paid_at && e.reimbursable && !e.reimbursed_at).reduce((a, e) => a + e.amount, 0);
      fill(box,
        h('div', { class: 'panel-head' }, h('h3', null, 'Custas e despesas do processo'),
          h('button', { class: 'btn btn-sm', onclick: () => fin.expenseDialog({ kind: 'custa', case_id: id }) }, [icon('plus', 15), 'Lançar custa'])),
        list.length ? [
          h('div', { class: 'muted small' }, `Pagas pelo escritório: `, h('b', { class: 'money' }, fmtMoney(paid)), pending ? [' · a reembolsar pelo cliente: ', h('b', { class: 'money bad-text' }, fmtMoney(pending))] : null),
          h('table', { class: 'table compact' }, h('tbody', null, list.map(fin.expenseRow))),
        ] : h('p', { class: 'muted small' }, 'Nenhuma custa lançada. Guias, diligências e perícias pagas pelo escritório entram aqui e no fluxo de caixa.'));
    }).catch((e) => fill(box, h('p', { class: 'muted small' }, e.message)));
    return box;
  }

  // --------------------------------------------------------------- prazos
  async function renderPrazos(el) {
    const tasks = await api('tasks:list', { caseId: id, includeDone: true });
    fill(el,
      h('div', { class: 'row wrap' }, Object.entries(TASK_KINDS).map(([kind, v]) => h('button', {
        class: 'btn btn-sm', onclick: () => taskDialog({ jid: k.jid, case_id: id, kind }),
      }, `${v.label}`))),
      tasks.length ? h('div', { class: 'task-list' }, tasks.map((t) => taskRow(t)))
        : h('p', { class: 'muted small' }, 'Nenhum prazo ou compromisso. Você recebe um aviso na hora marcada (e, com a agenda do Google conectada, eles aparecem lá também).'));
  }

  // ----------------------------------------------------------- documentos
  async function renderDocs(el) {
    const docs = await api('cases:docs', id);
    const folderBox = h('div', { class: 'case-folder' });
    caseFolderPanel(folderBox, k);
    fill(el,
      h('div', { class: 'crm-label' }, 'Pasta do caso no OneDrive'),
      folderBox,
      h('div', { class: 'crm-label', style: { marginTop: '14px' } }, 'Anexos guardados no sistema'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
          const files = await pickFiles();
          if (!files.length) return;
          try { toast('Enviando…'); await api('cases:addFiles', id, await uploadFiles(files)); } catch (e) { errToast(e); }
        } }, [icon('plus', 15), 'Adicionar do computador']),
        h('span', { class: 'muted small' }, 'Para guardar um arquivo que o cliente mandou no WhatsApp: na conversa, clique em ▾ na mensagem → “Anexar ao caso” (vai também para a pasta do caso).')),
      docs.length ? h('div', { class: 'doc-list' }, docs.map((d) => h('div', { class: 'doc-row' },
        h('span', { class: 'doc-icon' }, /image/.test(d.mime || d.name) || /\.(jpe?g|png|webp)$/i.test(d.name) ? icon('file', 16) : /pdf/i.test(d.mime || d.name) ? icon('file', 16) : /audio|ogg|mp3/i.test(d.mime || '') ? icon('file', 16) : icon('file', 16)),
        h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, d.name), h('div', { class: 'muted small' }, [fmtDateTime(d.created_at), fmtSize(d.size), d.msg_id ? 'do WhatsApp' : 'do computador'].filter(Boolean).join(' · '))),
        h('button', { class: 'btn btn-sm', onclick: () => openMedia(d.file, d.name).catch(errToast) }, 'Abrir'),
        h('button', { class: 'btn btn-sm', onclick: () => saveMedia(d.file, d.name) }, 'Salvar como…'),
        h('button', {
          class: 'icon-btn small', title: 'Tirar da lista do caso',
          onclick: async () => { if (await confirmDialog(`Tirar “${d.name}” dos documentos do caso?`, { okLabel: 'Tirar', danger: true })) api('cases:deleteDoc', d.id); },
        }, icon('trash', 16)))))
        : h('p', { class: 'muted small' }, 'Nenhum documento neste caso ainda.'));
  }

  // ---------------------------------------------------------------- notas
  async function renderNotas(el) {
    const notes = await api('notes:list', k.jid, id);
    const ta = h('textarea', { class: 'input', rows: 3, placeholder: 'Anotação sobre este caso…' });
    fill(el, ta,
      h('div', { class: 'row end' }, h('button', {
        class: 'btn btn-sm btn-primary',
        onclick: async () => { if (!ta.value.trim()) return; await api('notes:add', k.jid, ta.value.trim(), id); reload(); },
      }, 'Salvar nota')),
      ...notes.map((n) => h('div', { class: 'note' }, h('div', { class: 'note-text' }, n.text),
        h('div', { class: 'note-foot' }, h('span', null, fmtDateTime(n.created_at)),
          h('button', { class: 'icon-btn small', onclick: async () => { if (await confirmDialog('Apagar esta nota?', { okLabel: 'Apagar', danger: true })) { await api('notes:delete', n.id); reload(); } } }, icon('trash', 16))))));
  }

  await reload();
}

// ------------------------------------------------------------- parcelas

export function paymentRow(p, { showCase = false } = {}) {
  const st = paymentStatus(p);
  const chat = state.chats.get(p.jid);
  return h('tr', { class: `pay-${st.key}` },
    h('td', null, h('span', { class: `status-pill ${st.cls}` }, st.label)),
    showCase ? h('td', null, h('a', { class: 'link', onclick: () => (p.client_id ? openClient(p.client_id) : openChat(p.jid)) }, p.client_name || chat?.display_name || 'Cliente'),
      h('div', { class: 'muted small ellipsis' }, h('a', { class: 'link', onclick: () => openCase(p.case_id, { tab: 'honorarios' }) }, p.case_title))) : null,
    h('td', null, p.description || 'Honorários', p.charged_at ? h('div', { class: 'muted small' }, `cobrado em ${new Date(p.charged_at).toLocaleDateString('pt-BR')}`) : null),
    h('td', null, p.due_at ? new Date(p.due_at).toLocaleDateString('pt-BR') : '—',
      p.paid_at ? h('div', { class: 'muted small' }, `paga em ${new Date(p.paid_at).toLocaleDateString('pt-BR')}`) : null),
    h('td', { class: 'num' }, h('b', null, fmtMoney(p.amount))),
    h('td', { class: 'actions' },
      p.paid_at
        ? h('button', { class: 'btn btn-sm', title: 'Desfazer pagamento', onclick: () => api('finance:setPaid', p.id, false).catch(errToast) }, icon('undo', 16))
        : h('button', { class: 'btn btn-sm btn-ok', onclick: () => receiveDialog(p) }, 'Recebi'),
      p.paid_at ? null : h('button', { class: 'btn btn-sm', onclick: () => chargeDialog(p.id) }, 'Cobrar'),
      h('button', {
        class: 'icon-btn small', title: 'Mais',
        onclick: (e) => popupMenu(e.currentTarget, [
          p.paid_at ? { icon: '', label: p.receipt_no ? `Recibo nº ${p.receipt_no}` : 'Emitir recibo', onClick: () => showReceipt(p.id) } : null,
          { icon: '', label: 'Editar parcela', onClick: () => paymentDialog(p) },
          { icon: '', label: 'Excluir parcela', danger: true, onClick: async () => { if (await confirmDialog('Excluir esta parcela?', { okLabel: 'Excluir', danger: true })) api('finance:delete', p.id).catch(errToast); } },
        ]),
      }, icon('more', 16))));
}

/** Registrar o recebimento: data, valor recebido e forma; depois, o recibo. */
export function receiveDialog(p) {
  const date = h('input', { class: 'input', type: 'date', value: new Date().toISOString().slice(0, 10) });
  const value = h('input', { class: 'input', value: Number(p.amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 }), inputmode: 'decimal' });
  const method = h('select', { class: 'input' }, [['pix', 'Pix'], ['transferencia', 'Transferência'], ['dinheiro', 'Dinheiro'], ['boleto', 'Boleto'], ['cartao', 'Cartão'], ['cheque', 'Cheque']]
    .map(([v, l]) => h('option', { value: v }, l)));
  const save = async (thenReceipt) => {
    const amount = Number(value.value.replace(/\./g, '').replace(',', '.'));
    try {
      await api('finance:register', p.id, { paid_at: new Date(`${date.value}T12:00`).getTime(), paid_amount: amount, method: method.value });
    } catch (e) { errToast(e); return false; }
    toast('Recebimento registrado', 'success');
    if (thenReceipt) setTimeout(() => showReceipt(p.id), 50);
    return true;
  };
  modal({
    title: `Recebimento — ${p.description || 'Honorários'}`,
    body: h('div', { class: 'form' },
      h('p', { class: 'muted small' }, `${p.client_name || ''} · ${p.case_title || ''} · parcela de ${fmtMoney(p.amount)}`),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'Data do recebimento'), date),
        h('label', { class: 'field' }, h('span', null, 'Valor recebido (R$)'), value)),
      h('label', { class: 'field' }, h('span', null, 'Forma de pagamento'), method)),
    actions: [
      { label: 'Cancelar' },
      { label: 'Registrar', onClick: () => save(false) },
      { label: 'Registrar e emitir recibo', primary: true, onClick: () => save(true) },
    ],
  });
}

/** Recibo para imprimir ou salvar em PDF (pela janela de impressão). */
export async function showReceipt(id, { income = false } = {}) {
  let r;
  try { r = await api(income ? 'finance:incomeReceipt' : 'finance:receipt', id); } catch (e) { errToast(e); return; }
  const frame = h('iframe', { class: 'receipt-frame', title: `Recibo nº ${r.number}` });
  frame.srcdoc = r.html;
  const no = String(r.number).padStart(4, '0');
  modal({
    title: `Recibo nº ${no}`,
    wide: true,
    body: h('div', { class: 'stack' }, frame,
      h('p', { class: 'muted small' }, r.signMode === 'a3' ? 'O PDF sai assinado com o seu certificado A3 (o token pede o PIN). ' : '',
      'Baixe o PDF ou envie direto ao cliente pelo WhatsApp.')),
    actions: [
      { label: 'Fechar' },
      { label: 'Imprimir', onClick: () => { frame.contentWindow.focus(); frame.contentWindow.print(); return false; } },
      { label: 'Baixar PDF', onClick: async () => {
        const pdf = await makeReceiptPdf(id, income);
        downloadBlob(new Blob([Uint8Array.from(atob(pdf.pdf), (ch) => ch.charCodeAt(0))], { type: 'application/pdf' }), pdf.name);
        return false;
      } },
      r.canSend ? { label: 'Enviar pelo WhatsApp', primary: true, onClick: async () => { sendReceiptDialog(id, income, r); return false; } } : null,
    ].filter(Boolean),
  });
}

/** Gera o PDF do recibo; com o modo A3, o app de desktop assina com o token (pede o PIN). */
export async function makeReceiptPdf(id, income) {
  if (state.settings.receiptSignMode === 'a3') {
    const cert = await window.desktop?.certs?.get?.().catch(() => null);
    if (cert) {
      const ph = await api('finance:receiptPdf', id, { income, a3: { name: cert.name, issuer: cert.issuer } });
      toast('Digite o PIN do certificado na janela do token…', 'info', 8000);
      try {
        const cms = await window.desktop.certs.sign(ph.data);
        return await api('finance:receiptSign', ph.pending, cms);
      } catch (e) {
        api('finance:receiptCancel', ph.pending).catch(() => {});
        throw e;
      }
    }
    toast(window.desktop?.certs ? 'Escolha o certificado A3 em Ajustes → Recibos. Por enquanto o PDF sai só com a imagem da assinatura.'
      : 'O certificado A3 assina só no app de desktop do Windows, com o token conectado. Aqui o PDF sai só com a imagem da assinatura.', 'info', 8000);
  }
  return api('finance:receiptPdf', id, { income });
}

function sendReceiptDialog(id, income, r) {
  const first = String(r.who || '').split(/\s+/)[0];
  const ta = h('textarea', { class: 'input', rows: 4 }, `Olá${first ? `, ${first}` : ''}! Segue o recibo nº ${String(r.number).padStart(4, '0')}. Obrigado!`);
  modal({
    title: `Enviar recibo a ${r.who}`,
    body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'O PDF vai como documento, com esta mensagem:'), ta),
    actions: [{ label: 'Cancelar' }, {
      label: 'Enviar', primary: true,
      onClick: async () => {
        const pdf = await makeReceiptPdf(id, income);
        await api('finance:sendReceipt', pdf.token, ta.value);
        toast(`Recibo enviado a ${r.who} pelo WhatsApp${pdf.signed ? ' (assinado digitalmente)' : ''}.`, 'success', 6000);
        return true;
      },
    }],
  });
}

function installmentsDialog(k) {
  const total = h('input', { class: 'input', type: 'number', step: '0.01', value: k.fee_total ? Math.max(0, k.fee_total - k.billed_total).toFixed(2) : '' });
  const count = h('input', { class: 'input', type: 'number', min: 1, max: 120, value: 1 });
  const next = new Date(); next.setMonth(next.getMonth() + 1); next.setHours(12, 0, 0, 0);
  const first = h('input', { class: 'input', type: 'date', value: next.toISOString().slice(0, 10) });
  const desc = h('input', { class: 'input', value: 'Honorários' });
  const preview = h('div', { class: 'muted small' });
  const upd = () => {
    const t = Number(total.value) || 0;
    const n = Math.max(1, Number(count.value) || 1);
    preview.textContent = t ? `${n}× de ${fmtMoney(t / n)} — vencimentos todo mês a partir de ${first.value ? new Date(`${first.value}T12:00`).toLocaleDateString('pt-BR') : '…'}` : '';
  };
  [total, count, first].forEach((i) => i.addEventListener('input', upd));
  upd();
  modal({
    title: 'Gerar parcelas',
    body: h('div', { class: 'form' },
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, h('span', null, 'Valor total (R$)'), total),
        h('label', { class: 'field' }, h('span', null, 'Nº de parcelas'), count)),
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, h('span', null, '1º vencimento'), first),
        h('label', { class: 'field grow' }, h('span', null, 'Descrição'), desc)),
      preview),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Gerar', primary: true,
        onClick: async () => {
          await api('finance:generate', k.id, { total: total.value, count: count.value, firstDue: first.value ? new Date(`${first.value}T12:00`).getTime() : null, description: desc.value.trim() });
          toast('Parcelas criadas', 'success');
          return true;
        },
      },
    ],
  });
}

function successDialog(k) {
  const base = h('input', { class: 'input', type: 'number', step: '0.01', placeholder: 'Valor obtido para o cliente' });
  const val = h('input', { class: 'input', type: 'number', step: '0.01' });
  const due = h('input', { class: 'input', type: 'date', value: new Date().toISOString().slice(0, 10) });
  base.addEventListener('input', () => { val.value = ((Number(base.value) || 0) * (k.fee_percent || 0) / 100).toFixed(2); });
  modal({
    title: `Lançar êxito (${k.fee_percent || 0}%)`,
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Valor do resultado (R$)'), base),
      h('label', { class: 'field' }, h('span', null, 'Honorários de êxito (R$)'), val),
      h('label', { class: 'field' }, h('span', null, 'Vencimento'), due)),
    actions: [
      { label: 'Cancelar' },
      { label: 'Lançar', primary: true, onClick: async () => {
        await api('finance:save', { case_id: k.id, amount: val.value, due_at: due.value ? new Date(`${due.value}T12:00`).getTime() : null, description: `Honorários de êxito (${k.fee_percent || 0}%)` });
        return true;
      } },
    ],
  });
}

export function paymentDialog(p) {
  const desc = h('input', { class: 'input', value: p.description || '', placeholder: 'Ex.: Entrada, Custas, Parcela…' });
  const amount = h('input', { class: 'input', type: 'number', step: '0.01', value: p.amount ?? '' });
  const due = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(p.due_at) });
  modal({
    title: p.id ? 'Editar parcela' : 'Lançar valor',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Descrição'), desc),
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, h('span', null, 'Valor (R$)'), amount),
        h('label', { class: 'field grow' }, h('span', null, 'Vencimento'), due))),
    actions: [
      { label: 'Cancelar' },
      { label: 'Salvar', primary: true, onClick: async () => {
        await api('finance:save', { id: p.id, case_id: p.case_id, description: desc.value.trim(), amount: amount.value, due_at: fromLocalInput(due.value) });
        return true;
      } },
    ],
  });
}

/** Mostra a mensagem de cobrança (editável) e envia pelo WhatsApp. */
export async function chargeDialog(paymentId) {
  let text;
  try { text = await api('finance:chargeText', paymentId); } catch (e) { errToast(e); return; }
  const ta = h('textarea', { class: 'input', rows: 7 }, text);
  modal({
    title: 'Enviar cobrança pelo WhatsApp',
    body: h('div', { class: 'form' },
      h('p', { class: 'muted small' }, 'Confira a mensagem antes de enviar. O modelo e a chave PIX ficam em Configurações → Honorários e cobrança.'),
      ta),
    actions: [
      { label: 'Cancelar' },
      { label: 'Enviar', primary: true, onClick: async () => {
        await api('finance:sendCharge', paymentId, ta.value.trim());
        toast('Cobrança enviada', 'success');
        return true;
      } },
    ],
  });
}
