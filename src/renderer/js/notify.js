// Avisos (notificações). O servidor manda o aviso para todas as janelas
// abertas; cada uma decide se mostra, conforme as preferências da pessoa
// (avisos ligados, prévia do texto, modo discreto) e o que ela está vendo.
import { state, on, openChat, setView, emit } from './store.js';
import { setupPush } from './push.js';

function showNative(title, body, onClick) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const n = new Notification(title, { body, icon: '/assets/icon.png', silent: false });
  n.onclick = () => {
    window.desktop?.focus?.();
    window.focus();
    onClick?.();
    n.close();
  };
  return true;
}

export function runAction(a) {
  if (!a) return;
  if (a.case) import('./views/casemodal.js').then((m) => m.openCase(a.case, { tab: a.tab || 'dados' }));
  else if (a.chat) openChat(a.chat);
  else if (a.filter) { setView('inbox'); emit('open-filter', a.filter); } else if (a.view === 'legal' && a.tab) import('./store.js').then((m) => m.openLegal(a.tab));
  else if (a.view) setView(a.view);
}

export function setupNotifications() {
  setupPush(runAction);
  // o navegador só pergunta depois de um clique da pessoa
  if ('Notification' in window && Notification.permission === 'default') {
    const ask = () => { Notification.requestPermission().catch(() => {}); document.removeEventListener('click', ask); };
    document.addEventListener('click', ask);
  }

  window.api.on('ui:open-url', (url) => {
    if (window.desktop?.openExternal) window.desktop.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  });

  window.api.on('notify', (n) => {
    const s = state.settings;
    if (!n.force && s.notifications === false) return;
    if (n.kind === 'message') {
      const focused = document.hasFocus() && !document.hidden;
      if (focused && state.activeJid === n.chatJid) return;
      if (!focused) window.desktop?.flash?.();
    }
    let { title, body } = n;
    if (n.kind === 'message' && s.notificationPreview === false) body = 'Nova mensagem';
    if (s.discreet && n.discreet) {
      title = n.discreet;
      body = 'Abra o sistema para ver.';
    }
    if (!showNative(title, body, () => runAction(n.action)) && n.kind !== 'message') {
      // sem permissão de notificação: pelo menos um aviso dentro da tela
      import('./util.js').then(({ toast }) => toast(`${title} — ${body}`, 'info', 8000));
    }
  });

  // contador de não lidas no título da janela e no ícone do app
  const base = () => (state.demo ? 'Barros Associados (demonstração)' : 'Barros Associados');
  const update = () => {
    const n = [...state.chats.values()].filter((c) => c.unread > 0 && !c.archived).length;
    document.title = n ? `(${n}) ${base()}` : base();
    window.desktop?.setBadge?.(n);
  };
  on('chats', update);
  update();
}
