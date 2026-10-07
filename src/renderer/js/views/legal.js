// Jurídico: o centro do sistema. Clientes (cadastro próprio, independente do
// WhatsApp), Processos/casos e Intimações, com uma busca só no topo. A ficha
// do cliente reúne processos, dados, documentos, financeiro e histórico; o
// WhatsApp aparece só como um canal ligado a ele.
import {
  h, fill, modal, toast, errToast, confirmDialog, fmtMoney, fmtDateTime, fmtDue, formatPhone, normalize, debounce,
} from '../util.js';
import { state, on, api, openChat, setView, stageById, openClient } from '../store.js';
import { avatarEl } from '../components.js';
import { openCase, newCaseDialog, feeLabel, paymentRow } from './casemodal.js';
import { folderBrowser, clientFolderDialog } from './docs.js';
import { renderIntimations } from './intimations.js';
import { icon } from '../icons.js';
import { contactList, contactDialog } from './commercial.js';
import { clientForm } from './clientform.js';
import { importDialog, importProgress, drawWithoutClient, archiveBadge } from './importcases.js';
import { looksLikeCompany, fmtCnpj, fmtCpf } from '../qualify.js';

let root;
let tab = 'clientes'; // clientes | processos | intimacoes
let clientId = null; // ficha aberta
let clientTab = 'processos';
let q = '';
let caseStatus = 'aberto';
let caseResp = ''; // '' todos | 'me' | id de alguém da equipe
let team = [];
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
  on('intimations', refresh);
  on('leads', refresh);
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
        [['clientes', 'Clientes'], ['processos', 'Processos'], ['intimacoes', 'Intimações']].map(([id, label]) => h('button', {
          class: `seg ${tab === id ? 'active' : ''}`, onclick: () => { tab = id; render(); },
        }, label))),
      h('div', { class: 'row' },
        tab === 'processos' && state.me?.role !== 'estagiario' ? h('button', { class: 'btn', title: 'Importar a lista de processos de outro sistema (LinkLei…), em Excel ou CSV', onclick: () => importDialog() }, [icon('upload', 15), 'Importar lista']) : null,
        tab === 'processos' ? h('button', { class: 'btn', title: 'Ver os processos em colunas por etapa', onclick: () => setView('board') }, 'Funil') : null,
        h('button', { class: 'btn', onclick: () => clientDialog() }, [icon('plus', 15), 'Cliente']),
        h('button', { class: 'btn btn-primary', onclick: () => newCaseDialog(null) }, [icon('plus', 15), 'Processo']))),
    tab === 'intimacoes' ? null : h('div', { class: 'row legal-tools' }, search,
      tab === 'processos' ? h('select', { class: 'input select-sm', onchange: (e) => { caseStatus = e.target.value; drawList(); } },
        CASE_FILTERS.map(([v, l]) => h('option', { value: v, selected: caseStatus === v }, l))) : null,
      tab === 'processos' ? h('select', { class: 'input select-sm', onchange: (e) => { caseResp = e.target.value; drawList(); } },
        [['', 'Toda a equipe'], ['me', 'Meus processos'], ...team.filter((u) => u.id !== state.me?.id).map((u) => [String(u.id), u.name])]
          .map(([v, l]) => h('option', { value: v, selected: caseResp === v }, l))) : null),
    tab === 'processos' ? importProgress() : null,
    body);
  if (!team.length) api('team:list').then((t) => { team = t; if (tab === 'processos' && t.length > 1 && my === loading) render(); }).catch(() => {});
  draw();
}

// ------------------------------------------------------------ clientes

async function drawClients(el, my) {
  let list;
  try { list = await api('clients:list', { q }); } catch (e) { errToast(e); return; }
  if (my !== loading) return;
  if (!list.length) {
    fill(el, h('div', { class: 'panel' }, h('p', { class: 'muted' }, q ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado ainda.'),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', onclick: () => clientDialog({ name: q }) }, `Cadastrar ${q ? `“${q}”` : 'cliente'}`))));
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
        c.overdue_payments && state.can.finance ? h('span', { class: 'bad-text small' }, `${c.overdue_payments} parcela(s)`) : null,
        c.jid ? h('span', { title: 'WhatsApp ligado' }, icon('message', 16)) : null,
        c.folder ? h('span', { title: 'Pasta no OneDrive' }, icon('folder', 16)) : null))))));
}

/** Cadastro rápido de cliente (nome e contato); o resto fica na ficha. */
export function clientDialog(pre = {}) {
  const name = h('input', { class: 'input', value: pre.name || '', placeholder: 'Nome completo ou razão social' });
  const kind = h('select', { class: 'input' }, h('option', { value: 'pf' }, 'Pessoa física'), h('option', { value: 'pj' }, 'Pessoa jurídica'));
  const cpf = h('input', { class: 'input', placeholder: 'CPF ou CNPJ' });
  const phone = h('input', { class: 'input', placeholder: '(65) 99999-0000' });
  const email = h('input', { class: 'input', type: 'email' });
  const dup = h('div', { class: 'dup-box', hidden: true });
  const hint = h('div', { class: 'muted small' });
  if (looksLikeCompany(name.value)) kind.value = 'pj';
  const checkDup = debounce(async () => {
    const list = await api('clients:similar', { name: name.value, cpf: cpf.value }).catch(() => []);
    dup.hidden = !list.length;
    fill(dup, icon('alert', 16), h('span', null, `Já existe: ${list.map((x) => x.name).join(', ')}. `),
      list.length ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); dlg?.close(); openClient(list[0].id); } }, 'Abrir a ficha') : null);
  }, 400);
  name.addEventListener('input', () => { if (looksLikeCompany(name.value)) kind.value = 'pj'; checkDup(); });
  cpf.addEventListener('input', async () => {
    checkDup();
    const d = cpf.value.replace(/\D/g, '');
    if (d.length !== 14) return;
    kind.value = 'pj';
    hint.textContent = 'Buscando o CNPJ na Receita…';
    try {
      const r = await api('clients:lookupCnpj', d);
      if (r?.name) { name.value = r.name; hint.textContent = `Encontrado: ${r.name}${r.city ? ` — ${r.city}/${r.uf}` : ''}. O endereço entra junto.`; cpf.dataset.lookup = JSON.stringify(r); checkDup(); }
      else hint.textContent = 'CNPJ não encontrado na Receita.';
    } catch (e) { hint.textContent = e.message; }
  });
  const mkFolder = h('input', { type: 'checkbox', checked: true });
  const folderRow = h('label', { class: 'inline-check', hidden: true }, mkFolder, ' Criar a pasta do cliente no OneDrive (02 CLIENTES)');
  api('docs:status').then((st) => { folderRow.hidden = !st.ok; }).catch(() => {});
  let dlg = null;
  dlg = modal({
    title: 'Novo cliente',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Nome'), name),
      dup,
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'Tipo'), kind),
        h('label', { class: 'field' }, h('span', null, 'CPF / CNPJ'), cpf),
        h('label', { class: 'field' }, h('span', null, 'Telefone'), phone),
        h('label', { class: 'field' }, h('span', null, 'E-mail'), email)),
      hint,
      folderRow,
      h('p', { class: 'muted small' }, 'Aqui é só o cadastro rápido. Ao clicar em Cadastrar, a ficha do cliente abre na aba Dados para completar a qualificação: endereço com CEP, estado civil, profissão, RG — ou, para empresa, a sede e o representante. O WhatsApp é opcional.')),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Cadastrar e qualificar', primary: true,
        onClick: async () => {
          if (!name.value.trim()) { toast('Informe o nome', 'error'); return false; }
          let found = {};
          try { found = JSON.parse(cpf.dataset.lookup || '{}'); } catch { /* sem busca */ }
          const addr = found.cnpj === cpf.value.replace(/\D/g, '')
            ? { trade_name: found.trade_name, cep: found.cep, street: found.street, number: found.number, complement: found.complement, district: found.district, city: found.city, uf: found.uf }
            : {};
          const id = await api('clients:save', {
            name: name.value, kind: kind.value, cpf: kind.value === 'pj' ? fmtCnpj(cpf.value) : fmtCpf(cpf.value),
            phone: phone.value, email: email.value || found.email || '', origin: 'Cadastro', ...addr,
            rep: found.partners?.length === 1 ? { name: found.partners[0].name, role: found.partners[0].role, same_address: true } : undefined,
          });
          if (!folderRow.hidden && mkFolder.checked) {
            // pasta antiga com o mesmo nome? liga essa; senão cria no padrão
            try {
              const f = await api('docs:clientFolder', id);
              if (f.suggestion?.score >= 3) await api('docs:linkClient', id, f.suggestion.rel);
              else if (!f.folder) await api('docs:createClientFolder', id);
            } catch (e) { errToast(e); }
          }
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
    ['processos', `Processos${c.cases_open ? ` (${c.cases_open})` : ''}`],
    ['dados', 'Dados'],
    ['documentos', 'Documentos'],
    state.can.finance ? ['financeiro', `Financeiro${c.overdue_payments ? ` ${c.overdue_payments}` : ''}`] : null,
    ['atendimentos', 'Atendimentos'],
    ['historico', 'Notas e histórico'],
  ].filter(Boolean);
  if (!tabs.some(([id]) => id === clientTab)) clientTab = 'processos';
  const body = h('div', { class: 'client-body' });
  const chatHint = h('div', { class: 'chat-hint', hidden: true });
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
          ? h('button', { class: 'btn', onclick: () => openChat(c.jid) }, 'WhatsApp', c.chat?.unread ? h('span', { class: 'badge' }, c.chat.unread) : null)
          : h('button', { class: 'btn', title: 'Ligar uma conversa do WhatsApp do escritório a este cliente', onclick: () => linkChatDialog(c) }, 'Ligar WhatsApp'),
        c.jid && state.settings.waSaveContacts ? h('button', {
          class: 'btn', title: 'Salva o nome do cadastro na lista de contatos do WhatsApp do escritório',
          onclick: () => api('clients:saveContact', c.id).then(() => toast('Contato salvo no WhatsApp', 'success')).catch(errToast),
        }, 'Salvar contato') : null,
        h('button', { class: 'btn btn-primary', onclick: () => newCaseDialog(null, { clientId: c.id }) }, [icon('plus', 15), 'Processo']))),
    chatHint,
    h('div', { class: 'tabs' }, tabs.map(([id, label]) => h('button', {
      class: `tab ${clientTab === id ? 'active' : ''}`, onclick: () => { clientTab = id; render(); },
    }, label))),
    body);
  if (!c.jid) {
    api('clients:suggestChats', c.id).then((list) => {
      if (!list.length || !chatHint.isConnected) return;
      chatHint.hidden = false;
      fill(chatHint, icon('message', 16),
        h('span', null, list.length === 1 ? 'Conversa do WhatsApp que parece ser deste cliente: ' : 'Conversas que parecem ser deste cliente: '),
        list.map((x) => h('button', {
          class: 'btn btn-sm',
          title: `Achada pelo ${x.by}`,
          onclick: async () => {
            try { await api('clients:linkChat', c.id, x.jid); toast(`WhatsApp ligado: ${x.name}`, 'success'); } catch (e) { errToast(e); }
          },
        }, `Ligar ${x.name}${x.phone ? ` (${formatPhone(x.phone)})` : ''}`)));
    }).catch(() => {});
  }
  ({ processos: clientCases, dados: clientData, documentos: clientDocs, financeiro: clientFinance, atendimentos: clientContacts, historico: clientHistory })[clientTab](body, c);
}

async function clientContacts(el, c) {
  const list = await api('leads:contacts', { clientId: c.id }).catch(() => []);
  fill(el, h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', null, 'Atendimentos'),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => contactDialog({ client_id: c.id }) }, [icon('plus', 15), 'Registrar atendimento'])),
    h('p', { class: 'muted small' }, 'Ligações, reuniões, e-mails e conversas importantes, com o que ficou combinado. Os do comercial (antes de virar cliente) também aparecem aqui.'),
    contactList(list)));
}

const initialsOf = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

async function clientCases(el, c) {
  const list = await api('cases:list', { clientId: c.id });
  fill(el, list.length ? h('div', { class: 'case-cards' }, list.map(caseCardBig))
    : h('div', { class: 'panel' }, h('p', { class: 'muted' }, 'Nenhum processo deste cliente ainda.'),
      h('div', null, h('button', { class: 'btn btn-primary', onclick: () => newCaseDialog(null, { clientId: c.id }) }, [icon('plus', 15), 'Novo processo']))));
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
      k.next_due ? h('span', { class: k.next_due < Date.now() ? 'bad-text' : 'muted' }, `${fmtDue(k.next_due)}`) : null,
      state.can.finance && k.billed_total ? h('span', { class: 'money' }, `${fmtMoney(k.paid_total)} / ${fmtMoney(k.billed_total)}`) : (state.can.finance && feeLabel(k) ? h('span', { class: 'muted' }, feeLabel(k)) : null),
      k.overdue_payments && state.can.finance ? h('span', { class: 'bad-text' }, `${k.overdue_payments} vencida(s)`) : null));
}

function clientData(el, c) {
  const archive = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const arch = c.status !== 'arquivado';
      if (arch && !await confirmDialog(`Arquivar ${c.name}? Some da lista de clientes ativos (nada é apagado).`, { okLabel: 'Arquivar' })) return;
      await api('clients:save', { id: c.id, status: arch ? 'arquivado' : 'ativo' }).catch(errToast);
    },
  }, c.status === 'arquivado' ? 'Reativar cliente' : 'Arquivar cliente');
  fill(el, h('div', { class: 'panel' }, clientForm(c, { footer: archive })));
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
    h('b', null, 'Este cliente ainda não tem pasta ligada no OneDrive'),
    h('p', { class: 'muted small' }, 'Ligue a pasta que já existe em 02 CLIENTES ou crie uma nova no padrão do escritório.'),
    h('div', null, h('button', { class: 'btn btn-primary', onclick: () => clientFolderDialog(c.id) }, 'Ligar ou criar a pasta…'))));
}

async function clientFinance(el, c) {
  const [all, incomes, fin] = await Promise.all([api('finance:list', {}).catch(() => []), api('finance:incomes', { clientId: c.id }).catch(() => []), import('./finance.js')]);
  const mine = all.filter((p) => p.client_id === c.id);
  const open = mine.filter((p) => !p.paid_at);
  const total = (l) => l.reduce((a, p) => a + p.amount, 0);
  fill(el,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-value money' }, fmtMoney(total(mine))), h('div', { class: 'stat-label' }, 'Honorários lançados')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-value money' }, fmtMoney(total(mine) - total(open))), h('div', { class: 'stat-label' }, 'Recebido')),
      h('div', { class: `stat ${open.some((p) => p.due_at < Date.now()) ? 'stat-bad' : ''}` }, h('div', { class: 'stat-value money' }, fmtMoney(total(open))), h('div', { class: 'stat-label' }, 'A receber'))),
    mine.length ? h('table', { class: 'table' }, h('tbody', null, mine.map((p) => paymentRow(p, { showCase: true }))))
      : h('p', { class: 'muted' }, 'Nenhuma parcela. Os honorários são lançados na ficha de cada processo.'),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', null, 'Receitas avulsas (consultas, pareceres…)'),
        h('button', { class: 'btn btn-sm', onclick: () => fin.incomeDialog({ client_id: c.id, who: c.name }) }, [icon('plus', 15), 'Receita'])),
      incomes.length ? h('table', { class: 'table compact' }, h('tbody', null, incomes.map(fin.incomeRow))) : h('p', { class: 'muted small' }, 'Nenhuma.')));
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

const CASE_FILTERS = [['aberto', 'Em andamento'], ['semcliente', 'Sem cliente (importados)'], ['vigiar', 'Arquivados — vigiar prescrição'],
  ['baixa', 'Baixa definitiva: encerrar?'], ['encerrado', 'Encerrados (arquivo morto)'], ['', 'Todos']];

async function drawCases(el, my) {
  if (caseStatus === 'semcliente') { drawWithoutClient(el, { q, onChange: () => drawList() }); return; }
  let list;
  const status = ['vigiar', 'baixa'].includes(caseStatus) ? 'aberto' : caseStatus;
  try { list = await api('cases:list', { ...(status ? { status } : {}), withFlow: true, responsible: caseResp || undefined }); } catch (e) { errToast(e); return; }
  if (my !== loading) return;
  if (caseStatus === 'vigiar') list = list.filter((k) => k.archive_state === 'provisorio').sort((a, b) => (a.prescription_at || Infinity) - (b.prescription_at || Infinity));
  if (caseStatus === 'baixa') list = list.filter((k) => k.archive_state === 'definitivo' && !k.archive_dismissed);
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
        h('td', null, h('b', null, k.title), k.opposing_party ? h('div', { class: 'muted small' }, `x ${k.opposing_party}`) : null, archiveBadge(k)),
        h('td', null, k.no_client ? h('span', { class: 'pill pill-warn' }, 'a identificar') : k.client_id ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); clientId = k.client_id; clientTab = 'processos'; tab = 'clientes'; render(); } }, k.client_name || 'Cliente') : (k.client_name || '—')),
        h('td', { class: 'mono small' }, k.process_number || '', k.tribunal ? h('div', { class: 'muted small' }, k.tribunal) : null),
        h('td', { class: 'small' }, k.responsible_name || h('span', { class: 'muted' }, '—')),
        h('td', { class: 'small' }, k.next_step ? h('span', null, k.next_step, h('div', { class: 'muted' }, `${k.flow_done}/${k.flow_total} etapas`)) : icon('check', 16),
          st ? h('div', null, h('span', { class: 'stage-pill small', style: { '--c': st.color } }, st.name)) : null),
        h('td', { class: k.next_due && k.next_due < Date.now() ? 'bad-text' : '' }, k.next_due ? fmtDue(k.next_due) : ''),
        state.can.finance ? h('td', { class: 'num' }, k.overdue_payments ? h('span', { class: 'bad-text' }, `${k.overdue_payments} vencida(s)`) : (k.billed_total ? h('span', { class: 'money' }, `${fmtMoney(k.paid_total)} / ${fmtMoney(k.billed_total)}`) : feeLabel(k) || '')) : null);
    }))));
}

// ------------------------------------------------------------ intimações

function drawIntimations(el) {
  renderIntimations(el, () => drawList());
}
