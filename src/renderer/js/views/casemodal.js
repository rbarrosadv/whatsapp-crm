// Ficha do caso: dados do processo, honorários (parcelas e cobrança),
// prazos/audiências, documentos e notas — tudo numa janela com abas.
import {
  h, fill, modal, toast, errToast, confirmDialog, promptDialog, popupMenu, fmtMoney, fmtDateTime, fmtDuration,
  fmtSize, toLocalInput, fromLocalInput, normalize,
} from '../util.js';
import { state, on, api, stageById, openChat } from '../store.js';
import { avatarEl, caseStageMenu, stagePicker } from '../components.js';
import { taskRow, taskDialog } from './crmpanel.js';

export const TASK_KINDS = {
  prazo: { icon: '⚠️', label: 'Prazo' },
  audiencia: { icon: '⚖️', label: 'Audiência' },
  reuniao: { icon: '🤝', label: 'Reunião' },
  tarefa: { icon: '✅', label: 'Tarefa' },
};

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

export function newCaseDialog(jid, { stageId } = {}) {
  let chosenJid = jid;
  let stage = stageId || state.pipelines[0]?.stages[0]?.id;
  const title = h('input', { class: 'input', placeholder: 'Ex.: Reclamação trabalhista, Inventário, Consulta contrato…' });
  const stageBtn = h('button', { class: 'stage-btn wide' });
  const drawStage = () => {
    const st = stageById(stage);
    stageBtn.style.setProperty('--c', st?.color || '#94a3b8');
    fill(stageBtn, st ? `${st.pipeline.icon || ''} ${st.pipeline.name} → ${st.name}` : 'Escolher etapa', ' ▾');
  };
  stageBtn.onclick = (e) => stagePicker(e.currentTarget, stage, (sid) => { stage = sid; drawStage(); });
  drawStage();

  let contactField = null;
  if (!jid) {
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Pesquisar contato…' });
    const list = h('div', { class: 'picker-list short' });
    const draw = () => {
      const nq = normalize(input.value);
      const items = [...state.chats.values()].filter((c) => !c.is_group)
        .filter((c) => !nq || normalize(`${c.display_name} ${c.jid}`).includes(nq))
        .sort((a, b) => b.last_ts - a.last_ts).slice(0, 40);
      fill(list, ...items.map((c) => h('div', {
        class: `picker-item ${chosenJid === c.jid ? 'active' : ''}`,
        onclick: () => { chosenJid = c.jid; draw(); },
      }, avatarEl(c, 28), h('div', null, c.display_name))));
    };
    input.addEventListener('input', draw);
    draw();
    contactField = h('div', { class: 'field' }, h('span', null, 'Cliente'), input, list);
  }

  modal({
    title: 'Novo caso',
    body: h('div', { class: 'form' },
      contactField,
      h('label', { class: 'field' }, h('span', null, 'Nome do caso'), title),
      h('div', { class: 'field' }, h('span', null, 'Funil e etapa'), stageBtn)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Criar caso',
        primary: true,
        onClick: async () => {
          if (!chosenJid) { toast('Escolha o cliente', 'error'); return false; }
          const id = await api('cases:save', { jid: chosenJid, title: title.value.trim() || undefined, stage_id: stage });
          setTimeout(() => openCase(id, { tab: 'dados' }), 50);
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------- ficha do caso

export async function openCase(id, { tab = 'dados' } = {}) {
  let current = tab;
  const body = h('div', { class: 'case' });
  let k = null;
  const m = modal({ title: 'Caso', body, wide: true, onClose: () => { off1(); off2(); } });
  m.box.classList.add('modal-case');

  const reload = async () => {
    k = await api('cases:get', id);
    if (!k) { m.close(); return; }
    render();
  };
  const off1 = on('cases', () => reload());
  const off2 = on('tasks', () => reload());

  function render() {
    const chat = state.chats.get(k.jid) || { jid: k.jid, display_name: 'Contato' };
    const st = stageById(k.stage_id);
    const closed = k.status !== 'aberto';
    const since = Date.now() - (k.last_update_at || k.created_at);
    m.box.querySelector('.modal-head h3').textContent = `📁 ${k.title}`;

    const tabs = [
      ['dados', '📋 Dados'],
      ['honorarios', `💰 Honorários${k.overdue_payments ? ` ⚠${k.overdue_payments}` : ''}`],
      ['prazos', `📅 Prazos${k.open_tasks ? ` (${k.open_tasks})` : ''}`],
      ['docs', `📎 Documentos${k.docs_count ? ` (${k.docs_count})` : ''}`],
      ['notas', '📝 Notas'],
    ];
    const content = h('div', { class: 'case-content' });
    fill(body,
      h('div', { class: 'case-head' },
        h('div', { class: 'case-client', onclick: () => { m.close(); openChat(k.jid); }, title: 'Abrir conversa' },
          avatarEl(chat, 36), h('div', null, h('b', null, chat.display_name), h('div', { class: 'muted small' }, '💬 abrir conversa'))),
        h('button', {
          class: `stage-btn ${st ? '' : 'unset'}`, style: st ? { '--c': st.color } : null,
          onclick: (e) => caseStageMenu(e.currentTarget, k),
        }, st ? `${st.pipeline.icon || ''} ${st.pipeline.name} → ${st.name}` : 'Escolher etapa', ' ▾'),
        closed ? h('span', { class: 'status-pill muted' }, 'Encerrado') : null,
        h('button', {
          class: 'icon-btn', title: 'Mais opções',
          onclick: (e) => popupMenu(e.currentTarget, [
            { icon: '✎', label: 'Renomear caso', onClick: async () => { const t = await promptDialog('Nome do caso', { value: k.title }); if (t) api('cases:save', { id, title: t }).catch(errToast); } },
            closed
              ? { icon: '↺', label: 'Reabrir caso', onClick: () => api('cases:setStatus', id, 'aberto').catch(errToast) }
              : { icon: '✔', label: 'Encerrar caso', onClick: () => api('cases:setStatus', id, 'encerrado').catch(errToast) },
            '-',
            { icon: '🗑', label: 'Excluir caso', danger: true, onClick: async () => {
              if (!await confirmDialog(`Excluir o caso “${k.title}”? As parcelas e a lista de documentos dele também serão apagadas (os arquivos e as mensagens continuam).`, { okLabel: 'Excluir', danger: true })) return;
              await api('cases:delete', id).catch(errToast);
              m.close();
            } },
          ]),
        }, '⋮')),
      closed ? null : h('div', { class: `case-return ${since > (state.settings.staleCaseDays ?? 15) * 864e5 ? 'late' : ''}` },
        `📣 Último retorno ao cliente: há ${fmtDuration(since)}`,
        h('button', { class: 'btn btn-sm', onclick: () => api('cases:touch', id).then(() => toast('Retorno registrado', 'success')).catch(errToast) }, 'Registrar retorno agora'),
        h('span', { class: 'muted small' }, '(atualiza sozinho quando você manda mensagem para o cliente)')),
      h('div', { class: 'tabs' }, tabs.map(([key, label]) => h('button', {
        class: `tab ${current === key ? 'active' : ''}`,
        onclick: () => { current = key; render(); },
      }, label))),
      content);
    ({ dados: renderDados, honorarios: renderHonorarios, prazos: renderPrazos, docs: renderDocs, notas: renderNotas })[current](content);
  }

  // ---------------------------------------------------------------- dados
  function renderDados(el) {
    const save = (field) => (e) => api('cases:save', { id, [field]: e.target.value }).catch(errToast);
    const areaList = h('datalist', { id: 'areas-list' }, AREAS.map((a) => h('option', { value: a })));
    fill(el, h('div', { class: 'case-grid' },
      h('label', { class: 'field wide' }, h('span', null, 'Nº do processo / procedimento'),
        h('input', { class: 'input mono', value: k.process_number || '', placeholder: '0000000-00.0000.0.00.0000', onchange: save('process_number') })),
      h('label', { class: 'field' }, h('span', null, 'Área'),
        h('input', { class: 'input', value: k.area || '', list: 'areas-list', placeholder: 'Ex.: Trabalhista', onchange: save('area') }), areaList),
      h('label', { class: 'field' }, h('span', null, 'Vara / Comarca / Órgão'),
        h('input', { class: 'input', value: k.court || '', placeholder: 'Ex.: 2ª Vara do Trabalho de SP', onchange: save('court') })),
      h('label', { class: 'field wide' }, h('span', null, 'Parte contrária'),
        h('input', { class: 'input', value: k.opposing_party || '', onchange: save('opposing_party') }))),
    h('p', { class: 'muted small' }, `Caso aberto em ${fmtDateTime(k.created_at)}. As alterações são salvas automaticamente.`));
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
        h('button', { class: 'btn btn-primary btn-sm', onclick: () => installmentsDialog(k) }, '＋ Gerar parcelas'),
        h('button', { class: 'btn btn-sm', onclick: () => paymentDialog({ case_id: id }) }, '＋ Lançar valor avulso'),
        k.fee_success ? h('button', { class: 'btn btn-sm', onclick: () => successDialog(k) }, '🏆 Lançar êxito') : null),
      pays.length
        ? h('table', { class: 'table compact' },
          h('thead', null, h('tr', null, ['Situação', 'Descrição', 'Vencimento', 'Valor', ''].map((t) => h('th', null, t)))),
          h('tbody', null, pays.map((p) => paymentRow(p))))
        : h('p', { class: 'muted small' }, 'Nenhuma parcela lançada. Use “Gerar parcelas” para dividir o valor com vencimentos mensais.'));
  }

  // --------------------------------------------------------------- prazos
  async function renderPrazos(el) {
    const tasks = await api('tasks:list', { caseId: id, includeDone: true });
    fill(el,
      h('div', { class: 'row wrap' }, Object.entries(TASK_KINDS).map(([kind, v]) => h('button', {
        class: 'btn btn-sm', onclick: () => taskDialog({ jid: k.jid, case_id: id, kind }),
      }, `＋ ${v.icon} ${v.label}`))),
      tasks.length ? h('div', { class: 'task-list' }, tasks.map((t) => taskRow(t)))
        : h('p', { class: 'muted small' }, 'Nenhum prazo ou compromisso. Você recebe um aviso na hora marcada (e, com a agenda do Google conectada, eles aparecem lá também).'));
  }

  // ----------------------------------------------------------- documentos
  async function renderDocs(el) {
    const docs = await api('cases:docs', id);
    fill(el,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => api('cases:addFiles', id).catch(errToast) }, '＋ Adicionar do computador'),
        h('span', { class: 'muted small' }, 'Para guardar um arquivo que o cliente mandou no WhatsApp: na conversa, clique em ▾ na mensagem → “Anexar ao caso”.')),
      docs.length ? h('div', { class: 'doc-list' }, docs.map((d) => h('div', { class: 'doc-row' },
        h('span', { class: 'doc-icon' }, /image/.test(d.mime || d.name) || /\.(jpe?g|png|webp)$/i.test(d.name) ? '🖼' : /pdf/i.test(d.mime || d.name) ? '📕' : /audio|ogg|mp3/i.test(d.mime || '') ? '🎤' : '📄'),
        h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, d.name), h('div', { class: 'muted small' }, [fmtDateTime(d.created_at), fmtSize(d.size), d.msg_id ? 'do WhatsApp' : 'do computador'].filter(Boolean).join(' · '))),
        h('button', { class: 'btn btn-sm', onclick: () => api('media:open', d.file).catch(errToast) }, 'Abrir'),
        h('button', { class: 'btn btn-sm', onclick: () => api('media:saveAs', d.file, d.name).catch(errToast) }, 'Salvar como…'),
        h('button', { class: 'icon-btn small', title: 'Mostrar na pasta', onclick: () => api('media:showInFolder', d.file) }, '📂'),
        h('button', {
          class: 'icon-btn small', title: 'Tirar da lista do caso',
          onclick: async () => { if (await confirmDialog(`Tirar “${d.name}” dos documentos do caso?`, { okLabel: 'Tirar', danger: true })) api('cases:deleteDoc', d.id); },
        }, '🗑'))))
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
          h('button', { class: 'icon-btn small', onclick: async () => { if (await confirmDialog('Apagar esta nota?', { okLabel: 'Apagar', danger: true })) { await api('notes:delete', n.id); reload(); } } }, '🗑')))));
  }

  await reload();
}

// ------------------------------------------------------------- parcelas

export function paymentRow(p, { showCase = false } = {}) {
  const st = paymentStatus(p);
  const chat = state.chats.get(p.jid);
  return h('tr', { class: `pay-${st.key}` },
    h('td', null, h('span', { class: `status-pill ${st.cls}` }, st.label)),
    showCase ? h('td', null, h('a', { class: 'link', onclick: () => openChat(p.jid) }, chat?.display_name || 'Contato'),
      h('div', { class: 'muted small ellipsis' }, h('a', { class: 'link', onclick: () => openCase(p.case_id, { tab: 'honorarios' }) }, p.case_title))) : null,
    h('td', null, p.description || 'Honorários', p.charged_at ? h('div', { class: 'muted small' }, `📤 cobrado em ${new Date(p.charged_at).toLocaleDateString('pt-BR')}`) : null),
    h('td', null, p.due_at ? new Date(p.due_at).toLocaleDateString('pt-BR') : '—',
      p.paid_at ? h('div', { class: 'muted small' }, `paga em ${new Date(p.paid_at).toLocaleDateString('pt-BR')}`) : null),
    h('td', { class: 'num' }, h('b', null, fmtMoney(p.amount))),
    h('td', { class: 'actions' },
      p.paid_at
        ? h('button', { class: 'btn btn-sm', title: 'Desfazer pagamento', onclick: () => api('finance:setPaid', p.id, false).catch(errToast) }, '↺')
        : h('button', { class: 'btn btn-sm btn-ok', onclick: () => api('finance:setPaid', p.id, true).then(() => toast('Parcela marcada como paga', 'success')).catch(errToast) }, '✔ Recebi'),
      p.paid_at ? null : h('button', { class: 'btn btn-sm', onclick: () => chargeDialog(p.id) }, '📤 Cobrar'),
      h('button', {
        class: 'icon-btn small', title: 'Mais',
        onclick: (e) => popupMenu(e.currentTarget, [
          { icon: '✎', label: 'Editar parcela', onClick: () => paymentDialog(p) },
          { icon: '🗑', label: 'Excluir parcela', danger: true, onClick: async () => { if (await confirmDialog('Excluir esta parcela?', { okLabel: 'Excluir', danger: true })) api('finance:delete', p.id).catch(errToast); } },
        ]),
      }, '⋮')));
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
    title: '📤 Enviar cobrança pelo WhatsApp',
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
