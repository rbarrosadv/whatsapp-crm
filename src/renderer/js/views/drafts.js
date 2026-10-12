// Iniciais a distribuir (Jurídico → Iniciais): processos ainda sem número, em
// colunas pela situação — aguardando documentos → em redação → em revisão (o
// revisor aprova ou devolve) → pronta para protocolar → protocolar (nº + comprovante).
// Data meta (combinada com o cliente) e prazo fatal (prescrição/decadência) à vista.
import { h, fill, modal, toast, errToast, pickFiles, uploadFiles, toLocalInput, fromLocalInput } from '../util.js';
import { state, api } from '../store.js';
import { icon } from '../icons.js';

const COLS = [
  ['documentos', 'Aguardando documentos', '#f59e0b'],
  ['redacao', 'Em redação', '#3b82f6'],
  ['revisao', 'Em revisão', '#8b5cf6'],
  ['pronta', 'Pronta para protocolar', '#10b981'],
];
const DAY = 864e5;
let who = 'me'; // me | all
const day = (ts) => new Date(ts).toLocaleDateString('pt-BR');

export async function renderDrafts(el, { onOpen } = {}) {
  let list;
  let team;
  try { [list, team] = await Promise.all([api('drafts:list'), api('team:list').catch(() => [])]); } catch (e) { errToast(e); return; }
  const redraw = () => renderDrafts(el, { onOpen });
  const me = state.me?.id;
  const mine = (d) => d.responsible_id === me || d.draft_reviewer_id === me || !d.responsible_id;
  const vis = who === 'me' ? list.filter(mine) : list;
  const late = vis.filter((d) => d.draft_target && d.draft_target < new Date().setHours(0, 0, 0, 0)).length;
  fill(el,
    h('div', { class: 'row wrap drafts-tools' },
      h('div', { class: 'segmented' }, [['me', 'Minhas'], ['all', 'Todas']].map(([v, l]) => h('button', { class: `seg ${who === v ? 'active' : ''}`, onclick: () => { who = v; redraw(); } }, l))),
      h('span', { class: 'muted small' }, `${vis.length} inicial(is) a distribuir${late ? ` · ${late} com a data meta vencida` : ''}. Ao informar o nº do processo, ela sai daqui e segue no acompanhamento.`)),
    h('div', { class: 'board-cols drafts-board' }, COLS.map(([id, label, color]) => {
      const items = vis.filter((d) => d.status === id);
      return h('div', { class: 'col', style: { '--c': color }, dataset: { status: id } },
        h('div', { class: 'col-head' }, h('div', { class: 'col-title' }, h('span', { class: 'dot' }), label, h('span', { class: 'count' }, items.length))),
        h('div', { class: 'col-cards' }, items.map((d) => card(d, team, redraw, onOpen))));
    })));
}

function card(d, team, redraw, onOpen) {
  const now = Date.now();
  const days = Math.floor((now - d.since) / DAY);
  const targetLate = d.draft_target && d.draft_target < new Date().setHours(0, 0, 0, 0);
  const canReview = state.me?.role === 'socio' || state.me?.id === d.draft_reviewer_id;
  const go = (status, extra = {}) => api('drafts:set', d.id, { status, ...extra }).then(redraw).catch(errToast);
  const actions = {
    documentos: [h('button', { class: 'btn btn-sm btn-primary', onclick: () => go('redacao') }, 'Documentos ok → redação')],
    redacao: [
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => reviewDialog(d, team, redraw) }, 'Enviar para revisão'),
      h('button', { class: 'btn btn-sm', title: 'Sem revisão: já pode protocolar', onclick: () => go('pronta') }, 'Pronta'),
    ],
    revisao: canReview ? [
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => go('pronta', { note: null }) }, 'Aprovar'),
      h('button', { class: 'btn btn-sm', onclick: () => returnDialog(d, redraw) }, 'Devolver'),
    ] : [h('span', { class: 'muted small' }, `Com ${d.reviewer_name || 'o revisor'}`)],
    pronta: [h('button', { class: 'btn btn-sm btn-primary', onclick: () => protocolDialog(d, redraw) }, 'Protocolar')],
  }[d.status] || [];
  return h('div', { class: `card draft-card ${targetLate ? 'late' : ''}` },
    h('div', { class: 'card-title', onclick: () => onOpen?.(d) }, h('b', null, d.client_name || '—'), h('div', { class: 'small' }, d.title)),
    h('div', { class: 'muted small' }, [d.area, d.responsible_name ? `com ${d.responsible_name.split(' ')[0]}` : 'sem responsável', d.status === 'revisao' && d.reviewer_name ? `revisa ${d.reviewer_name.split(' ')[0]}` : null].filter(Boolean).join(' · ')),
    h('div', { class: 'draft-meta small' },
      h('span', { class: days > 7 ? 'warn-text' : 'muted' }, `há ${days} dia(s) nesta situação`),
      d.docs_pending ? h('span', { class: 'warn-text' }, `${d.docs_pending} documento(s) pendente(s)`) : null,
      d.draft_target ? h('span', { class: targetLate ? 'bad-text' : '' }, `meta ${day(d.draft_target)}`) : null,
      d.deadline ? h('span', { class: d.deadline - now < 10 * DAY ? 'bad-text' : '' }, `prazo fatal ${day(d.deadline)}`) : null),
    d.draft_note ? h('div', { class: 'draft-note small' }, icon('note', 13), ` ${d.draft_note}`) : null,
    h('div', { class: 'row wrap' }, ...actions,
      h('button', { class: 'icon-btn small', title: 'Data meta e prazo fatal', onclick: () => datesDialog(d, redraw) }, icon('calendar', 15))));
}

function reviewDialog(d, team, redraw) {
  const sel = h('select', { class: 'input' }, team.filter((u) => u.id !== state.me?.id || state.me?.role === 'socio')
    .map((u) => h('option', { value: String(u.id), selected: u.id === d.draft_reviewer_id || (!d.draft_reviewer_id && u.role === 'socio') }, `${u.name}${u.role === 'socio' ? ' (sócio)' : ''}`)));
  modal({
    title: 'Enviar para revisão',
    body: h('div', { class: 'form' }, h('p', null, h('b', null, d.client_name), ` · ${d.title}`),
      h('label', { class: 'field' }, h('span', null, 'Quem revisa'), sel),
      h('p', { class: 'muted small' }, 'A pessoa recebe um aviso e aprova ou devolve com observações.')),
    actions: [{ label: 'Cancelar' }, {
      label: 'Enviar', primary: true,
      onClick: async () => { await api('drafts:set', d.id, { status: 'revisao', reviewer_id: Number(sel.value) }); toast('Enviada para revisão', 'success'); redraw(); return true; },
    }],
  });
}

function returnDialog(d, redraw) {
  const note = h('textarea', { class: 'input', rows: 4, placeholder: 'O que ajustar na inicial…' });
  modal({
    title: 'Devolver para ajustes',
    body: h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', null, 'Observações para quem redigiu'), note)),
    actions: [{ label: 'Cancelar' }, {
      label: 'Devolver', primary: true,
      onClick: async () => {
        if (!note.value.trim()) { toast('Escreva o que ajustar', 'error'); return false; }
        await api('drafts:set', d.id, { status: 'redacao', note: note.value.trim() });
        redraw();
        return true;
      },
    }],
  });
}

function protocolDialog(d, redraw) {
  const num = h('input', { class: 'input', placeholder: 'NNNNNNN-DD.AAAA.J.TR.OOOO' });
  let files = [];
  const list = h('div', { class: 'muted small' }, 'Nenhum arquivo escolhido.');
  modal({
    title: 'Protocolar a inicial',
    body: h('div', { class: 'form' },
      h('p', null, h('b', null, d.client_name), ` · ${d.title}`),
      h('label', { class: 'field' }, h('span', null, 'Nº do processo'), num),
      h('div', { class: 'row' }, h('button', {
        class: 'btn', onclick: async () => { const f = await pickFiles({ multiple: true }); if (f?.length) { files = [...f]; fill(list, files.map((x) => h('div', null, x.name))); } },
      }, [icon('plus', 15), 'Comprovante de protocolo / petição'])), list,
      h('p', { class: 'muted small' }, 'O processo passa para a fase "Inicial / distribuído", o sistema busca os andamentos no DataJud e liga as intimações que chegarem.')),
    actions: [{ label: 'Cancelar' }, {
      label: 'Protocolada', primary: true,
      onClick: async () => {
        if (String(num.value).replace(/\D/g, '').length < 15) { toast('Confira o nº do processo', 'error'); return false; }
        const tokens = files.length ? await uploadFiles(files) : [];
        await api('drafts:protocol', d.id, { process_number: num.value, tokens });
        toast('Inicial distribuída', 'success');
        redraw();
        return true;
      },
    }],
  });
}

function datesDialog(d, redraw) {
  const target = h('input', { class: 'input', type: 'date', value: d.draft_target ? new Date(d.draft_target).toISOString().slice(0, 10) : '' });
  const fatal = h('input', { class: 'input', type: 'datetime-local', value: d.deadline ? toLocalInput(d.deadline) : '' });
  const why = h('input', { class: 'input', value: 'Prazo fatal para distribuir (prescrição/decadência)' });
  modal({
    title: 'Datas da inicial',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Data meta de protocolo (combinada com o cliente)'), target),
      d.deadline ? h('p', { class: 'small' }, `Prazo fatal já cadastrado: ${day(d.deadline)} (mude na aba Prazos do processo).`)
        : [h('label', { class: 'field' }, h('span', null, 'Prazo fatal (prescrição, decadência) — opcional'), fatal), h('label', { class: 'field' }, h('span', null, 'Descrição'), why)],
      h('p', { class: 'muted small' }, 'A data meta avisa 2 dias úteis antes e, se passar, avisa também os sócios. O prazo fatal entra na Agenda com os avisos de prazo.')),
    actions: [{ label: 'Cancelar' }, {
      label: 'Salvar', primary: true,
      onClick: async () => {
        await api('drafts:set', d.id, { target: target.value ? new Date(`${target.value}T12:00:00`).getTime() : null });
        if (!d.deadline && fatal.value) await api('tasks:save', { case_id: d.id, kind: 'prazo', title: why.value || 'Prazo fatal para distribuir', due_at: fromLocalInput(fatal.value), assignee_id: d.responsible_id || undefined });
        redraw();
        return true;
      },
    }],
  });
}
