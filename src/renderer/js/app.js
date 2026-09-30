// Ponto de entrada da interface.
import { h, debounce } from './util.js';
import { state, on, bootstrap, setView, openChat, forgetAvatar } from './store.js';
import { mountChatList } from './views/chatlist.js';
import { mountChatView } from './views/chatview.js';
import { mountCrmPanel } from './views/crmpanel.js';
import { mountBoard } from './views/board.js';
import { mountContacts } from './views/contacts.js';
import { mountTasks } from './views/tasks.js';
import { mountDashboard } from './views/dashboard.js';
import { mountFinance } from './views/finance.js';
import { mountSettings, applyTheme } from './views/settings.js';
import { mountConnect } from './views/connect.js';

const NAV = [
  ['inbox', '💬', 'Conversas'],
  ['board', '📊', 'Funil'],
  ['contacts', '👥', 'Contatos'],
  ['tasks', '⏰', 'Tarefas'],
  ['finance', '💰', 'Financeiro'],
  ['dashboard', '📈', 'Painel'],
];

async function main() {
  await bootstrap();
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  const views = {
    inbox: h('div', { class: 'view view-inbox' }),
    board: h('div', { class: 'view view-board' }),
    contacts: h('div', { class: 'view view-page' }),
    tasks: h('div', { class: 'view view-page' }),
    dashboard: h('div', { class: 'view view-page' }),
    finance: h('div', { class: 'view view-page' }),
    settings: h('div', { class: 'view view-page' }),
  };

  const navBtns = {};
  const unreadBadge = h('span', { class: 'nav-badge hidden' });
  const statusDot = h('span', { class: 'status-dot' });
  const nav = h('nav', { class: 'rail' },
    h('img', { class: 'rail-logo', src: '../../assets/icon.png', alt: 'WhatsApp CRM', title: state.demo ? 'WhatsApp CRM — demonstração' : 'WhatsApp CRM' }),
    ...NAV.map(([id, icon, label]) => {
      navBtns[id] = h('button', { class: 'rail-btn', title: label, onclick: () => setView(id) },
        h('span', { class: 'rail-icon' }, icon), h('span', { class: 'rail-label' }, label), id === 'inbox' ? unreadBadge : null);
      return navBtns[id];
    }),
    h('div', { class: 'grow' }),
    navBtns.settings = h('button', { class: 'rail-btn', title: 'Configurações', onclick: () => setView('settings') },
      h('span', { class: 'rail-icon' }, '⚙️'), h('span', { class: 'rail-label' }, 'Ajustes')),
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

  const banner = h('div', { class: 'banner-wrap hidden' });
  const overlay = h('div', { class: 'connect-overlay hidden' });
  const main_ = h('main', { class: 'main' }, banner, ...Object.values(views));
  document.getElementById('app').append(nav, main_, overlay);

  mountChatList(listCol);
  mountChatView(chatCol, { onTogglePanel: togglePanel });
  mountCrmPanel(crmCol);
  mountBoard(views.board);
  mountContacts(views.contacts);
  mountTasks(views.tasks);
  mountDashboard(views.dashboard);
  mountFinance(views.finance);
  mountSettings(views.settings);
  mountConnect(overlay, banner);

  const showView = (v) => {
    for (const [id, el] of Object.entries(views)) el.classList.toggle('active', id === v);
    for (const [id, b] of Object.entries(navBtns)) b.classList.toggle('active', id === v);
  };
  on('view', showView);

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

  // atalhos de teclado
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-7]$/.test(e.key)) {
      e.preventDefault();
      setView([...NAV.map((n) => n[0]), 'settings'][Number(e.key) - 1]);
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f' && state.view === 'inbox') {
      e.preventDefault();
      listCol.querySelector('input.search')?.focus();
    }
  });

  const initial = ['inbox', 'board', 'contacts', 'tasks', 'finance', 'dashboard'].includes(state.settings.lastView) ? state.settings.lastView : 'inbox';
  state.view = null;
  setView(initial);
  showView(initial);
  window.__crm = { state, openChat, setView };
}

main().catch((e) => {
  console.error(e);
  document.body.append(h('pre', { class: 'fatal' }, `Erro ao iniciar: ${e.message}`));
});
