// Service worker do Barros Associados: recebe os avisos do servidor (Web Push)
// mesmo com o app fechado e, no clique, abre o sistema na tela certa.
// Não guarda páginas em cache: o sistema sempre usa a versão do servidor.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Barros Associados', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Barros Associados', {
    body: d.body || '',
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    requireInteraction: !!d.urgent,
    data: { action: d.action || null },
    lang: 'pt-BR',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const action = e.notification.data?.action || null;
  const url = action ? `/?acao=${encodeURIComponent(JSON.stringify(action))}` : '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      if (action) win.postMessage({ type: 'aviso', action });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
