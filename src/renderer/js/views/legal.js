// Jurídico: o centro do sistema. Clientes (cadastro próprio, independente do
// WhatsApp), Processos/casos e Intimações, com uma busca só no topo. A ficha
// do cliente reúne processos, dados, documentos, financeiro e histórico; o
// WhatsApp aparece só como um canal ligado a ele.
import {
  h, fill, modal, toast, errToast, confirmDialog, fmtMoney, fmtDateTime, fmtDue, formatPhone, normalize, debounce,
} from '../util.js';
import { state, on, api, openChat, setView, stageById } from '../store.js';
import { avatarEl } from '../components.js';
import { openCase, newCaseDialog, feeLabel, paymentRow } from './casemodal.js';
import { folderBrowser, clientFolderDialog } from './docs.js';

let root;
let tab = 'clientes'; // clientes | processos | intimacoes
let clientId = null; // ficha aberta
let clientTab = 'processos';
let q = '';
let caseStatus = 'aberto';
let caseResp = ''; // '' todos | 'me'
let loading = 0;
let listBody = null;

function drawList(my = loading) {
  if (!listBody?.isConnected) return;
  if (tab === 'clientes') drawClients(listBody, my);
  else if (tab === 'processos') drawCases(listBody, my);
  else drawIntimations(listBody);
}
const redrawList = debounce(() => drawList(), 200);

export function mountLegal(el) {
  root = el;
  // dados mudaram: na lista só redesenha a lista (não tira o foco da busca)
  const refresh = debounce(() => {
    if (state.view !== 'legal') return;
    if (clientId || !listBody?.isConnected) render(); else drawList();
  }, 250);
  on('view', (v) => v === 'legal' && render());
  on('open-client', (id) => { clientId = id; clientTab = 'processos'; tab = 'clientes'; render(); });
  on('open-legal', (o) => { tab = o.tab || tab; clientId = null; if (o.status) caseStatus = o.status; render(); });
  on('clients', refresh);
  on('cases', refresh);
  on('finance', refresh);
  on('tasks', refresh);
}

async function render() {
  const my = ++loading;
  if (clientId) return renderClient(my);
  const search = h('input', {
    class: 'input legal-search', type: 'search', value: q,
    placeholder: tab === 'processos' ? 'Buscar processo: assunto, cliente, nº do processo, parte contrária…' : 'Buscar cliente: nome, CPF/CNPJ ou telefone…',
  });
  const body = h('div', { class: 'legal-body' });
  listBody = body;
  // o texto vale na hora (se a tela se atualizar no meio, a busca não se perde)
  search.addEventListener('input', () => { q = search.value; redrawList(); });
  const draw = () => drawList(my);
  fill(root,
    h('div', { class: 'page-head' },
      h('h2', null, 'Jurídico'),
      h('div', { class: 'segmented' },
        [['clientes', '👥 Clientes'], ['processos', '⚖️ Processos'], ['intimacoes', '📣 Intimações']].map(([id, label]) => h('button', {
          class: `seg ${tab === id ? 'active' : ''}`, onclick: () => { tab = id; render(); },
        }, label))),
      h('div', { class: 'row' },
        tab === 'processos' ? h('button', { class: 'btn', title: 'Ver os processos em colunas por etapa', onclick: () => setView('board') }, '📊 Funil') : null,
        h('button', { class: 'btn', onclick: () => clientDialog() }, '＋ Cliente'),
        h('button', { class: 'btn btn-primary', onclick: () => newCaseDialog(null) }, '＋ Processo'))),
    tab === 'intimacoes' ? null : h('div', { class: 'row legal-tools' }, search,
      tab === 'processos' ? h('select', { class: 'input select-sm', onchange: (e) => { caseStatus = e.target.value; drawList(); } },
        [['aberto', 'Em andamento'], ['encerrado', 'Encerrados'], ['', 'Todos']].map(([v, l]) => h('option', { value: v, selected: caseStatus === v }, l))) : null,
      tab === 'processos' ? h('select', { class: 'input select-sm', onchange: (e) => { caseResp = e.target.value; drawList(); } },
        [['', 'Toda a equipe'], ['me', 'Meus processos']].map(([v, l]) => h('option', { value: v, selected: caseResp === v }, l))) : null),
    body);
  draw();
}

// ------------------------------------------------------------ clientes

async function drawClients(el, my) {
  let list;
  try { list = await api('clients:list', { q }); } catch (e) { errToast(e); return; }
  if (my !== loading) return;
  if (!list.length) {
    fill(el, h('div', { class: 'panel' }, h('p', { class: 'muted' }, q ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado ainda.'),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', onclick: () => clientDialog({ name: q }) }, `＋ Cadastrar ${q ? `“${q}”` : 'cliente'}`))));
    return;
  }
  fill(el, h('table', { class: 'table clients-table' },
    h('thead', null, h('tr', null, ['Cliente', 'Telefone', 'Processos', 'Próximo prazo', ''].map((t) => h('th', null, t)))),
    h('tbody', null, list.map((c) => h('tr', { class: 'clickable', onclick: () => { clientId = c.id; clientTab = 'processos'; render(); } },
      h('td', null, h('b', null, c.name), c.cpf ? h('div', { class: 'muted small mono' }, c.cpf) : null),
      h('td', null, c.phone ? formatPhone(String(c.phone).replace(/\D/g, '')) : h('span', { class: 'muted' }, '—')),
      h('td', null, c.cases_open ? `${c.cases_open} em andamento` : h('span', { class: 'muted' }, c.cases_total ? 'encerrados' : '—')),
      h('td', { class: c.next_due && c.next_due < Date.now() ? 'bad-text' : '' }, c.next_due ? fmtDue(c.next_due) : ''),
      h('td', { class: 'row end' },
        c.overdue_payments && state.can.finance ? h('span', { class: 'bad-text small' }, `⚠ ${c.overdue_payments} parcela(s)`) : null,
        c.jid ? h('span', { title: 'WhatsApp ligado' }, '💬') : null,
        c.folder ? h('span', { title: 'Pasta no OneDrive' }, '📁') : null))))));
}

/** Cadastro rápido de cliente (nome e contato); o resto fica na ficha. */
export function clientDialog(pre = {}) {
  const name = h('input', { class: 'input', value: pre.name || '', placeholder: 'Nome completo ou razão social' });
  const kind = h('select', { class: 'input' }, h('option', { value: 'pf' }, 'Pessoa física'), h('option', { value: 'pj' }, 'Pessoa jurídica'));
  const cpf = h('input', { class: 'input', placeholder: 'CPF ou CNPJ' });
  const phone = h('input', { class: 'input', placeholder: '(65) 99999-0000' });
  const email = h('input', { class: 'input', type: 'email' });
  modal({
    title: 'Novo cliente',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Nome'), name),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'Tipo'), kind),
        h('label', { class: 'field' }, h('span', null, 'CPF / CNPJ'), cpf),
        h('label', { class: 'field' }, h('span', null, 'Telefone'), phone),
        h('label', { class: 'field' }, h('span', null, 'E-mail'), email)),
      h('p', { class: 'muted small' }, 'O WhatsApp é opcional: dá para ligar depois, na ficha do cliente.')),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Cadastrar', primary: true,
        onClick: async () => {
          if (!name.value.trim()) { toast('Informe o nome', 'error'); return false; }
          const id = await api('clients:save', { name: name.value, kind: kind.value, cpf: cpf.value, phone: phone.value, email: email.value, origin: 'Cadastro' });
          clientId = id; clientTab = 'dados';
          setView('legal');
          render();
          return true;
        },
      },
    ],
  });
}

// ------------------------------------------------------------ ficha do cliente

async function renderClient(my) {
  let c;
  try { c = await api('clients:get', clientId); } catch (e) { errToast(e); clientId = null; render(); return; }
  if (my !== loading) return;
  const tabs = [
    ['processos', `⚖️ Processos${c.cases_open ? ` (${c.cases_open})` : ''}`],
    ['dados', '📋 Dados'],
    ['documentos', '📂 Documentos'],
    state.can.finance ? ['financeiro', `💰 Financeiro${c.overdue_payments ? ` ⚠${c.overdue_payments}` : ''}`] : null,
    ['historico', '📝 Notas e histórico'],
  ].filter(Boolean);
  if (!tabs.some(([id]) => id === clientTab)) clientTab = 'processos';
  const body = h('div', { class: 'client-body' });
  const chat = c.jid ? state.chats.get(c.jid) : null;
  fill(root,
    h('button', { class: 'btn btn-sm back-btn', onclick: () => { clientId = null; render(); } }, '← Clientes'),
    h('div', { class: 'client-head panel' },
      chat ? avatarEl(chat, 56) : h('div', { class: 'avatar client-avatar', style: { width: '56px', height: '56px' } }, initialsOf(c.name)),
      h('div', { class: 'grow' },
        h('h2', null, c.name, c.status === 'arquivado' ? h('span', { class: 'muted small' }, ' (arquivado)') : null),
        h('div', { class: 'muted small client-meta' },
          [c.kind === 'pj' ? 'Pessoa jurídica' : null, c.cpf, c.phone ? formatPhone(String(c.phone).replace(/\D/g, '')) : null, c.email].filter(Boolean).join(' · ') || 'Complete os dados na aba Dados')),
      h('div', { class: 'row wrap' },
        c.jid
          ? h('button', { class: 'btn', onclick: () => openChat(c.jid) }, '💬 WhatsApp', c.chat?.unread ? h('span', { class: 'badge' }, c.chat.unread) : null)
          : h('button', { class: 'btn', title: 'Ligar uma conversa do WhatsApp do escritório a este cliente', onclick: () => linkChatDialog(c) }, '💬 Ligar WhatsApp'),
        h('button', { class: 'btn btn-primary', onclick: () => newCaseDialog(null, { clientId: c.id }) }, '＋ Processo'))),
    h('div', { class: 'tabs' }, tabs.map(([id, label]) => h('button', {
      class: `tab ${clientTab === id ? 'active' : ''}`, onclick: () => { clientTab = id; render(); },
    }, label))),
    body);
  ({ processos: clientCases, dados: clientData, documentos: clientDocs, financeiro: clientFinance, historico: clientHistory })[clientTab](body, c);
}

const initialsOf = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

async function clientCases(el, c) {
  const list = await api('cases:list', { clientId: c.id });
  fill(el, list.length ? h('div', { class: 'case-cards' }, list.map(caseCardBig))
    : h('div', { class: 'panel' }, h('p', { class: 'muted' }, 'Nenhum processo deste cliente ainda.'),
      h('div', null, h('button', { class: 'btn btn-primary', onclick: () => newCaseDialog(null, { clientId: c.id }) }, '＋ Novo processo'))));
}

function caseCardBig(k) {
  const st = stageById(k.stage_id);
  return h('div', { class: `case-card ${k.status !== 'aberto' ? 'closed' : ''}`, style: st ? { '--c': st.color } : null, onclick: () => openCase(k.id) },
    h('div', { class: 'case-card-title' }, k.title),
    k.opposing_party ? h('div', { class: 'small' }, `x ${k.opposing_party}`) : null,
    k.process_number ? h('div', { class: 'muted small mono' }, k.process_number) : null,
    h('div', { class: 'small row wrap' },
      st ? h('span', { class: 'stage-pill small', style: { '--c': st.color } }, st.name) : null,
      k.status !== 'aberto' ? h('span', { class: 'muted' }, 'encerrado') : null),
    h('div', { class: 'case-card-foot small' },
      k.next_due ? h('span', { class: k.next_due < Date.now() ? 'bad-text' : 'muted' }, `📅 ${fmtDue(k.next_due)}`) : null,
      state.can.finance && k.billed_total ? h('span', { class: 'money' }, `💰 ${fmtMoney(k.paid_total)} / ${fmtMoney(k.billed_total)}`) : (state.can.finance && feeLabel(k) ? h('span', { class: 'muted' }, feeLabel(k)) : null),
      k.overdue_payments && state.can.finance ? h('span', { class: 'bad-text' }, `⚠ ${k.overdue_payments} vencida(s)`) : null));
}

function clientData(el, c) {
  const fields = [
    ['name', 'Nome completo / razão social', { wide: true }],
    ['kind', 'Tipo', { options: [['pf', 'Pessoa física'], ['pj', 'Pessoa jurídica']] }],
    ['cpf', c.kind === 'pj' ? 'CNPJ' : 'CPF'],
    ['rg', 'RG'],
    ['birth', 'Nascimento', { placeholder: 'dd/mm/aaaa' }],
    ['nationality', 'Nacionalidade', { placeholder: 'brasileiro(a)' }],
    ['marital', 'Estado civil'],
    ['profession', 'Profissão'],
    ['address', 'Endereço completo', { wide: true, placeholder: 'Rua, nº, bairro, cidade-UF, CEP' }],
    ['phone', 'Telefone'],
    ['phone2', 'Outro telefone'],
    ['email', 'E-mail'],
    ['origin', 'Como chegou (indicação, Instagram…)'],
    ['notes', 'Observações', { wide: true, multiline: true }],
  ];
  const inputs = {};
  fill(el, h('div', { class: 'panel' },
    h('div', { class: 'client-form' }, fields.map(([key, label, o = {}]) => {
      const input = o.options
        ? h('select', { class: 'input' }, o.options.map(([v, l]) => h('option', { value: v, selected: (c[key] || 'pf') === v }, l)))
        : o.multiline ? h('textarea', { class: 'input', rows: 3 }, c[key] || '')
          : h('input', { class: 'input', value: c[key] || '', placeholder: o.placeholder || '' });
      inputs[key] = input;
      return h('label', { class: `field ${o.wide ? 'wide' : ''}` }, h('span', null, label), input);
    })),
    h('p', { class: 'muted small' }, 'Estes dados preenchem procurações, contratos e petições dos modelos ({nome}, {cpf}, {endereco}…).'),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const data = { id: c.id };
          for (const [k, i] of Object.entries(inputs)) data[k] = i.value;
          try { await api('clients:save', data); toast('Dados salvos', 'success'); } catch (e) { errToast(e); }
        },
      }, 'Salvar'),
      h('div', { class: 'grow' }),
      h('button', {
        class: 'btn',
        onclick: async () => {
          const arch = c.status !== 'arquivado';
          if (arch && !await confirmDialog(`Arquivar ${c.name}? Some da lista de clientes ativos (nada é apagado).`, { okLabel: 'Arquivar' })) return;
          await api('clients:save', { id: c.id, status: arch ? 'arquivado' : 'ativo' }).catch(errToast);
        },
      }, c.status === 'arquivado' ? 'Reativar cliente' : 'Arquivar cliente'))));
}

function clientDocs(el, c) {
  if (c.folder) {
    const box = h('div');
    fill(el, h('div', { class: 'panel' }, box,
      h('div', { class: 'row' }, h('button', { class: 'btn btn-sm', onclick: () => clientFolderDialog(c.id) }, 'Trocar a pasta do cliente…'))));
    folderBrowser(box, { top: c.folder, clientId: c.id });
    return;
  }
  fill(el, h('div', { class: 'panel docs-empty' },
    h('b', null, '📁 Este cliente ainda não tem pasta ligada no OneDrive'),
    h('p', { class: 'muted small' }, 'Ligue a pasta que já existe em 02 CLIENTES ou crie uma nova no padrão do escritório.'),
    h('div', null, h('button', { class: 'btn btn-primary', onclick: () => clientFolderDialog(c.id) }, 'Ligar ou criar a pasta…'))));
}

async function clientFinance(el, c) {
  const all = await api('finance:list', {}).catch(() => []);
  const mine = all.filter((p) => p.client_id === c.id);
  const open = mine.filter((p) => !p.paid_at);
  const total = (l) => l.reduce((a, p) => a + p.amount, 0);
  fill(el,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-value money' }, fmtMoney(total(mine))), h('div', { class: 'stat-label' }, 'Honorários lançados')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-value money' }, fmtMoney(total(mine) - total(open))), h('div', { class: 'stat-label' }, 'Recebido')),
      h('div', { class: `stat ${open.some((p) => p.due_at < Date.now()) ? 'stat-bad' : ''}` }, h('div', { class: 'stat-value money' }, fmtMoney(total(open))), h('div', { class: 'stat-label' }, 'A receber'))),
    mine.length ? h('table', { class: 'table' }, h('tbody', null, mine.map((p) => paymentRow(p, { showCase: true }))))
      : h('p', { class: 'muted' }, 'Nenhuma parcela. Os honorários são lançados na ficha de cada processo.'));
}

async function clientHistory(el, c) {
  const [notes, acts] = await Promise.all([api('notes:list', c.key), api('clients:activity', c.id)]);
  const ta = h('textarea', { class: 'input', rows: 3, placeholder: 'Anotação sobre o cliente (a equipe vê; o cliente não)…' });
  fill(el,
    h('div', { class: 'panel' }, ta, h('div', { class: 'row end' }, h('button', {
      class: 'btn btn-sm btn-primary',
      onclick: async () => { if (!ta.value.trim()) return; await api('notes:add', c.key, ta.value.trim()); render(); },
    }, 'Salvar nota')),
    notes.map((n) => h('div', { class: 'note' }, h('div', { class: 'note-text' }, n.text), h('div', { class: 'note-foot' }, h('span', null, fmtDateTime(n.created_at)))))),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', null, 'Histórico')),
      acts.length ? acts.map((a) => h('div', { class: 'activity-row small' },
        h('span', { class: 'muted' }, fmtDateTime(a.ts)), ' ', a.detail, a.user_name ? h('span', { class: 'muted' }, ` — ${a.user_name}`) : null))
        : h('p', { class: 'muted small' }, 'Sem registros.')));
}

/** Escolher a conversa do WhatsApp do escritório que é deste cliente. */
function linkChatDialog(c) {
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Procurar conversa pelo nome ou número…' });
  const list = h('div', { class: 'picker-list' });
  const digits = String(c.phone || '').replace(/\D/g, '').slice(-8);
  const draw = () => {
    const nq = normalize(input.value);
    const items = [...state.chats.values()].filter((x) => !x.is_group && !x.client_id)
      .filter((x) => (nq ? normalize(`${x.display_name} ${x.jid}`).includes(nq) : true))
      .sort((a, b) => (digits && b.jid.includes(digits)) - (digits && a.jid.includes(digits)) || b.last_ts - a.last_ts).slice(0, 40);
    fill(list, items.length ? items.map((x) => h('div', {
      class: 'picker-item',
      onclick: async () => {
        try { await api('clients:linkChat', c.id, x.jid); m.close(); toast('WhatsApp ligado ao cliente', 'success'); } catch (e) { errToast(e); }
      },
    }, avatarEl(x, 28), h('div', null, x.display_name, h('div', { class: 'muted small' }, formatPhone(x.jid.split('@')[0])))))
      : h('p', { class: 'muted small' }, 'Nenhuma conversa livre encontrada.'));
  };
  input.addEventListener('input', draw);
  draw();
  const m = modal({ title: `Ligar WhatsApp a ${c.name}`, body: h('div', { class: 'stack' }, input, list), actions: [{ label: 'Cancelar' }] });
}

// ------------------------------------------------------------ processos

async function drawCases(el, my) {
  let list;
  try { list = await api('cases:list', { ...(caseStatus ? { status: caseStatus } : {}), withFlow: true, responsible: caseResp || undefined }); } catch (e) { errToast(e); return; }
  if (my !== loading) return;
  const nq = normalize(q);
  const items = list.filter((k) => !nq || normalize(`${k.title} ${k.client_name || ''} ${k.process_number || ''} ${k.opposing_party || ''} ${k.area || ''}`).includes(nq));
  if (!items.length) {
    fill(el, h('div', { class: 'panel' }, h('p', { class: 'muted' }, q ? 'Nenhum processo encontrado.' : 'Nenhum processo aqui.')));
    return;
  }
  fill(el, h('table', { class: 'table cases-table' },
    h('thead', null, h('tr', null, ['Processo / assunto', 'Cliente', 'Nº do processo', 'Responsável', 'Próximo passo', 'Próximo prazo', state.can.finance ? 'Honorários' : null].filter(Boolean).map((t) => h('th', null, t)))),
    h('tbody', null, items.map((k) => {
      const st = stageById(k.stage_id);
      return h('tr', { class: 'clickable', onclick: () => openCase(k.id) },
        h('td', null, h('b', null, k.title), k.opposing_party ? h('div', { class: 'muted small' }, `x ${k.opposing_party}`) : null),
        h('td', null, k.client_id ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); clientId = k.client_id; clientTab = 'processos'; tab = 'clientes'; render(); } }, k.client_name || 'Cliente') : (k.client_name || '—')),
        h('td', { class: 'mono small' }, k.process_number || '', k.tribunal ? h('div', { class: 'muted small' }, k.tribunal) : null),
        h('td', { class: 'small' }, k.responsible_name || h('span', { class: 'muted' }, '—')),
        h('td', { class: 'small' }, k.next_step ? h('span', null, k.next_step, h('div', { class: 'muted' }, `${k.flow_done}/${k.flow_total} etapas`)) : '✓',
          st ? h('div', null, h('span', { class: 'stage-pill small', style: { '--c': st.color } }, st.name)) : null),
        h('td', { class: k.next_due && k.next_due < Date.now() ? 'bad-text' : '' }, k.next_due ? fmtDue(k.next_due) : ''),
        state.can.finance ? h('td', { class: 'num' }, k.overdue_payments ? h('span', { class: 'bad-text' }, `⚠ ${k.overdue_payments} vencida(s)`) : (k.billed_total ? h('span', { class: 'money' }, `${fmtMoney(k.paid_total)} / ${fmtMoney(k.billed_total)}`) : feeLabel(k) || '')) : null);
    }))));
}

// ------------------------------------------------------------ intimações

function drawIntimations(el) {
  fill(el, h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', null, '📣 Intimações e andamentos')),
    h('p', null, 'Aqui vão chegar as intimações do Diário de Justiça Eletrônico Nacional (DJEN), pela OAB de cada advogado, e os andamentos dos processos (DataJud do CNJ).'),
    h('p', null, 'Cada intimação vai aparecer para ser conferida e virar prazo na Agenda com um clique.'),
    h('p', { class: 'muted small' }, 'Em construção (próxima etapa). Para ligar, o escritório precisa informar o número de OAB (com UF) de cada advogado.')));
}
