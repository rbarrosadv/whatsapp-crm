// Ponto de entrada da interface.
import './bridge.js';
import { h, debounce, toast } from './util.js';
import { setupNotifications } from './notify.js';
import { state, on, bootstrap, setView, openChat, forgetAvatar, setSetting } from './store.js';
import { mountChatList } from './views/chatlist.js';
import { mountChatView } from './views/chatview.js';
import { mountCrmPanel } from './views/crmpanel.js';
import { mountBoard } from './views/board.js';
import { mountContacts } from './views/contacts.js';
import { mountTasks } from './views/tasks.js';
import { mountDashboard } from './views/dashboard.js';
import { mountFinance } from './views/finance.js';
import { mountAgenda } from './views/agenda.js';
import { mountSettings, applyTheme } from './views/settings.js';
import { mountConnect } from './views/connect.js';
import { mountToday } from './views/today.js';
import { mountDocs } from './views/docs.js';
import { mountLegal } from './views/legal.js';
import { mountCommercial } from './views/commercial.js';
import { icon } from './icons.js';

// O escritório no centro; o WhatsApp é o módulo de Atendimento (um canal).
// `also`: outras telas que acendem o mesmo botão (sub-telas do módulo).
const NAV = [
  ['today', 'home', 'Hoje'],
  ['agenda', 'calendar', 'Agenda', ['tasks']],
  ['legal', 'scale', 'Jurídico', ['board']],
  ['inbox', 'message', 'Atendimento', ['contacts', 'commercial']],
  ['docs', 'folder', 'Documentos'],
  ['finance', 'wallet', 'Financeiro'],
  ['dashboard', 'chart', 'Relatórios'],
]

async function main() {
  await bootstrap();
  setupNotifications();
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  const views = {
    today: h('div', { class: 'view view-page view-today' }),
    inbox: h('div', { class: 'view view-inbox' }),
    board: h('div', { class: 'view view-board' }),
    contacts: h('div', { class: 'view view-page' }),
    docs: h('div', { class: 'view view-page view-docs' }),
    legal: h('div', { class: 'view view-page view-legal' }),
    commercial: h('div', { class: 'view view-commercial' }),
    tasks: h('div', { class: 'view view-page' }),
    dashboard: h('div', { class: 'view view-page' }),
    finance: h('div', { class: 'view view-page' }),
    agenda: h('div', { class: 'view view-agenda' }),
    settings: h('div', { class: 'view view-page' }),
  };

  // estagiário(a) não vê dinheiro: sem Financeiro e sem Painel de números
  const nav_ = NAV.filter(([id]) => state.can.finance || !['finance', 'dashboard'].includes(id));
  const navBtns = {};
  let discreetBtn;
  const unreadBadge = h('span', { class: 'nav-badge hidden' });
  const statusDot = h('span', { class: 'status-dot' });
  const nav = h('nav', { class: 'rail' },
    h('img', { class: 'rail-logo', src: '/assets/icon.png', alt: 'Barros Associados', title: `Barros Associados${state.demo ? ' — demonstração' : ''} · ${state.me.name}` }),
    ...nav_.map(([id, ico, label]) => {
      navBtns[id] = h('button', { class: 'rail-btn', title: label, onclick: () => setView(id) },
        h('span', { class: 'rail-icon' }, icon(ico, 20)), h('span', { class: 'rail-label' }, label), id === 'inbox' ? unreadBadge : null);
      return navBtns[id];
    }),
    h('div', { class: 'grow' }),
    discreetBtn = h('button', { class: 'rail-btn', title: 'Modo discreto (Ctrl+Shift+D): esconde valores e prévias das mensagens', onclick: () => toggleDiscreet() },
      h('span', { class: 'rail-icon' }, icon('eyeOff', 20)), h('span', { class: 'rail-label' }, 'Discreto')),
    navBtns.settings = h('button', { class: 'rail-btn', title: 'Configurações', onclick: () => setView('settings') },
      h('span', { class: 'rail-icon' }, icon('settings', 20)), h('span', { class: 'rail-label' }, 'Ajustes')),
    h('div', { class: 'rail-status', title: 'Status da conexão' }, statusDot));

  // caixa de entrada: lista | conversa | ficha
  const listCol = h('aside', { class: 'chatlist' });
  const chatCol = h('section', { class: 'chatview' });
  const crmCol = h('aside', { class: `crm-panel ${state.settings.crmPanelHidden ? 'hidden' : ''}` });
  views.inbox.append(listCol, chatCol, crmCol);
  const togglePanel = (force) => {
    const hide = force === true ? false : !crmCol.classList.contains('hidden');
    crmCol.classList.toggle('hidden', hide);
    try { localStorage.setItem('crmPanelHidden', hide ? '1' : '0'); } catch { /* ignore */ }
  };
  try { if (localStorage.getItem('crmPanelHidden') === '1') crmCol.classList.add('hidden'); } catch { /* ignore */ }
  // celular: a ficha do contato abre por cima da conversa, então começa fechada
  const phone = window.matchMedia('(max-width: 760px)');
  if (phone.matches) crmCol.classList.add('hidden');
  on('active', () => { if (phone.matches) crmCol.classList.add('hidden'); });
  // celular: barra "← Voltar à conversa" por cima da ficha do contato
  const crmClose = h('button', { class: 'crm-close', onclick: () => crmCol.classList.add('hidden') }, icon('back', 20), 'Voltar à conversa');
  views.inbox.append(crmClose);
  // botão "voltar" do Android/gesto do iPhone: fecha a ficha, depois a conversa (não sai do app)
  let stacked = 0;
  const pushStep = () => { if (phone.matches) { history.pushState({ crm: ++stacked }, ''); } };
  on('active', (jid) => { if (jid) pushStep(); });
  new MutationObserver(() => { if (phone.matches && !crmCol.classList.contains('hidden')) pushStep(); })
    .observe(crmCol, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('popstate', () => {
    if (!phone.matches) return;
    if (!crmCol.classList.contains('hidden')) crmCol.classList.add('hidden');
    else if (document.body.classList.contains('chat-open')) openChat(null);
  });

  const banner = h('div', { class: 'banner-wrap hidden' });
  const overlay = h('div', { class: 'connect-overlay hidden' });
  const main_ = h('main', { class: 'main' }, banner, ...Object.values(views));
  document.getElementById('app').append(nav, main_, overlay);

  mountToday(views.today);
  mountDocs(views.docs);
  mountLegal(views.legal);
  mountCommercial(views.commercial);
  mountChatList(listCol);
  mountChatView(chatCol, { onTogglePanel: togglePanel });
  mountCrmPanel(crmCol);
  mountBoard(views.board);
  mountContacts(views.contacts);
  mountTasks(views.tasks);
  mountDashboard(views.dashboard);
  mountFinance(views.finance);
  mountAgenda(views.agenda);
  mountSettings(views.settings);
  mountConnect(overlay, banner);

  const showView = (v) => {
    for (const [id, el] of Object.entries(views)) el.classList.toggle('active', id === v);
    const owner = NAV.find(([id, , , also]) => id === v || also?.includes(v))?.[0] || v;
    for (const [id, b] of Object.entries(navBtns)) b.classList.toggle('active', id === owner);
    document.body.dataset.view = v;
  };
  on('view', showView);
  // celular: com uma conversa aberta, ela ocupa a tela (a lista volta pelo botão ←)
  on('active', (jid) => document.body.classList.toggle('chat-open', !!jid));

  const updateStatus = () => {
    const s = state.status.state;
    statusDot.className = `status-dot ${s === 'open' ? 'ok' : ['connecting', 'reconnecting', 'starting', 'idle'].includes(s) ? 'warn' : 'bad'}`;
    if (s === 'open') for (const jid of state.chats.keys()) forgetAvatar(jid);
  };
  on('status', updateStatus);
  updateStatus();

  const updateUnread = debounce(() => {
    const n = [...state.chats.values()].filter((c) => c.unread > 0 && !c.archived).length;
    unreadBadge.textContent = n > 99 ? '99+' : String(n);
    unreadBadge.classList.toggle('hidden', !n);
  }, 100);
  on('chats', updateUnread);
  updateUnread();

  // modo discreto: embaça valores e prévias (passar o mouse mostra)
  const applyDiscreet = () => {
    document.body.classList.toggle('discreet', !!state.settings.discreet);
    document.body.classList.toggle('discreet-msgs', !!state.settings.discreet && !!state.settings.discreetMessages);
    discreetBtn.classList.toggle('on', !!state.settings.discreet);
    discreetBtn.querySelector('.rail-label').textContent = state.settings.discreet ? 'Discreto ligado' : 'Discreto';
  };
  const toggleDiscreet = () => setSetting('discreet', !state.settings.discreet).catch(() => {});
  on('settings', applyDiscreet);
  applyDiscreet();

  // atalhos de teclado
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      toggleDiscreet();
      return;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const target = [...nav_.map((n) => n[0]), 'settings'][Number(e.key) - 1];
      if (target) setView(target);
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f' && state.view === 'inbox') {
      e.preventDefault();
      listCol.querySelector('input.search')?.focus();
    }
  });

  // o sistema sempre abre no painel do dia de cada pessoa
  const initial = 'today';
  state.view = null;
  setView(initial);
  showView(initial);
  window.__crm = { state, openChat, setView };
  // volta do login da Microsoft (Ajustes → Documentos → OneDrive)
  const params = new URLSearchParams(location.search);
  if (params.has('onedrive')) {
    history.replaceState(null, '', '/');
    setView('settings');
    if (params.get('onedrive') === 'ok') toast('OneDrive conectado. Agora escolha a pasta BARROS ADVOGADOS (passo 3).', 'success', 8000);
    else toast(`OneDrive: ${params.get('msg') || 'não foi possível conectar'}`, 'error', 10000);
  }
}

main().catch((e) => {
  console.error(e);
  document.body.append(h('pre', { class: 'fatal' }, `Erro ao iniciar: ${e.message}`));
});
