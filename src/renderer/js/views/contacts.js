// Lista de contatos em tabela, com filtros e exportação para planilha (CSV).
import { h, clear, fill, fmtMoney, fmtListTime, formatPhone, phoneOf, normalize, debounce, toast, errToast } from '../util.js';
import { state, on, api, openChat, stageById, tagById } from '../store.js';
import { avatarEl, stagePill, tagDots } from '../components.js';

let root;
const f = { q: '', stage: '', tag: '', sort: 'recent' };

export function mountContacts(el) {
  root = el;
  on('chats', debounce(() => state.view === 'contacts' && renderRows(), 150));
  on('view', (v) => v === 'contacts' && render());
  on('config', () => state.view === 'contacts' && render());
}

let tbody;
let countEl;

function filtered() {
  const nq = normalize(f.q);
  const digits = f.q.replace(/\D/g, '');
  let list = [...state.chats.values()].filter((c) => !c.is_group);
  if (nq) list = list.filter((c) => normalize(`${c.display_name} ${c.company || ''} ${c.email || ''}`).includes(nq) || (digits.length >= 3 && c.jid.includes(digits)));
  if (f.stage === '_none') list = list.filter((c) => !c.stage_id);
  else if (f.stage) list = list.filter((c) => c.stage_id === f.stage);
  if (f.tag) list = list.filter((c) => c.tag_ids.includes(Number(f.tag)));
  const sorters = {
    recent: (a, b) => b.last_ts - a.last_ts,
    name: (a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR'),
    value: (a, b) => (Number(b.value) || 0) - (Number(a.value) || 0),
  };
  return list.sort(sorters[f.sort]);
}

function render() {
  clear(root);
  countEl = h('span', { class: 'muted' });
  tbody = h('tbody');
  root.append(
    h('div', { class: 'page-head' },
      h('h2', null, 'Contatos ', countEl),
      h('div', { class: 'row' },
        h('input', { class: 'input search', type: 'search', placeholder: 'Nome, telefone, empresa…', value: f.q, oninput: debounce((e) => { f.q = e.target.value; renderRows(); }, 150) }),
        h('select', { class: 'input select-sm', onchange: (e) => { f.stage = e.target.value; renderRows(); } },
          h('option', { value: '' }, 'Todas as etapas'),
          h('option', { value: '_none', selected: f.stage === '_none' }, 'Sem etapa'),
          state.pipelines.map((p) => h('optgroup', { label: p.name }, p.stages.map((s) => h('option', { value: s.id, selected: f.stage === s.id }, s.name))))),
        h('select', { class: 'input select-sm', onchange: (e) => { f.tag = e.target.value; renderRows(); } },
          h('option', { value: '' }, 'Todas as etiquetas'),
          state.tags.map((t) => h('option', { value: String(t.id), selected: f.tag === String(t.id) }, t.name))),
        h('select', { class: 'input select-sm', onchange: (e) => { f.sort = e.target.value; renderRows(); } },
          h('option', { value: 'recent', selected: f.sort === 'recent' }, 'Mais recentes'),
          h('option', { value: 'name', selected: f.sort === 'name' }, 'Nome (A-Z)'),
          h('option', { value: 'value', selected: f.sort === 'value' }, 'Maior valor')),
        h('button', { class: 'btn', onclick: exportCsv }, '⬇ Exportar planilha'))),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['', 'Nome', 'Telefone', 'Empresa', 'Etapa', 'Etiquetas', 'Valor', 'Última mensagem'].map((t) => h('th', null, t)))),
        tbody)),
  );
  renderRows();
}

function renderRows() {
  if (!tbody) return;
  const list = filtered();
  countEl.textContent = `(${list.length})`;
  fill(tbody, ...list.slice(0, 1000).map((c) => h('tr', { onclick: () => openChat(c.jid) },
    h('td', null, avatarEl(c, 30)),
    h('td', null, h('b', null, c.display_name), c.email ? h('div', { class: 'muted small' }, c.email) : null),
    h('td', null, formatPhone(phoneOf(c.jid))),
    h('td', null, c.company || ''),
    h('td', null, stagePill(c.stage_id, { small: true })),
    h('td', null, tagDots(c.tag_ids, { max: 3 })),
    h('td', null, c.value ? fmtMoney(c.value) : ''),
    h('td', { class: 'muted' }, fmtListTime(c.last_ts)))));
}

async function exportCsv() {
  const list = filtered();
  const rows = [['Nome', 'Telefone', 'Empresa', 'E-mail', 'Funil', 'Etapa', 'Etiquetas', 'Valor', 'Última mensagem']];
  for (const c of list) {
    const st = stageById(c.stage_id);
    rows.push([c.display_name, phoneOf(c.jid) || '', c.company || '', c.email || '', st?.pipeline.name || '', st?.name || '',
      c.tag_ids.map((t) => tagById(t)?.name).filter(Boolean).join(', '), c.value ?? '',
      c.last_ts ? new Date(c.last_ts).toLocaleString('pt-BR') : '']);
  }
  try {
    const file = await api('contacts:exportCsv', rows);
    if (file) toast(`Planilha salva em ${file}`, 'success', 6000);
  } catch (e) { errToast(e); }
}
