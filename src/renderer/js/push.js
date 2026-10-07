// Avisos no celular (Web Push): registra o service worker, ativa/desativa os
// avisos neste aparelho e abre a tela certa quando a pessoa toca no aviso.
import { api } from './store.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext && !window.desktop?.isDesktop;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
/** iPhone só recebe avisos com o app instalado na tela de início. */
export const needsInstall = () => isIOS() && !standalone();

function keyBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function deviceName() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Outro';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'navegador';
  return `${os} · ${standalone() ? 'app' : br}`;
}

/** Liga o service worker e trata o clique nos avisos (com o app já aberto ou abrindo agora). */
export function setupPush(runAction) {
  const params = new URLSearchParams(location.search);
  if (params.has('acao')) {
    try { const a = JSON.parse(params.get('acao')); setTimeout(() => runAction(a), 300); } catch { /* ignora */ }
    history.replaceState(null, '', '/');
  }
  if (!('serviceWorker' in navigator) || !window.isSecureContext || window.desktop?.isDesktop) return;
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker:', e.message));
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'aviso') runAction(e.data.action); });
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('Este navegador não recebe avisos. Use o Chrome (Android/computador) ou instale o app no iPhone.');
  if (needsInstall()) throw new Error('No iPhone: toque em Compartilhar → "Adicionar à Tela de Início", abra o sistema pelo ícone e ative os avisos por lá.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Os avisos foram bloqueados. Libere as notificações deste site nas configurações do aparelho.');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { key } = await api('push:info');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  return api('push:subscribe', sub.toJSON(), deviceName());
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return null;
  const list = await api('push:unsubscribe', sub.endpoint);
  await sub.unsubscribe().catch(() => {});
  return list;
}
