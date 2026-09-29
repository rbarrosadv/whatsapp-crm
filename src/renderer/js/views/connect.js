// Tela de conexão (QR code) e faixa de status da conexão.
import { h, clear, fill } from '../util.js';
import { state, on, api } from '../store.js';
import { statusLabel } from './settings.js';

export function mountConnect(overlay, banner) {
  const render = () => {
    const s = state.status;
    const needsQr = ['qr', 'logged_out', 'starting', 'idle'].includes(s.state) && !(s.state === 'idle' && state.chats.size);
    overlay.classList.toggle('hidden', !needsQr);
    if (needsQr) renderOverlay(overlay, s);
    renderBanner(banner, s);
  };
  on('status', render);
  on('history', () => renderBanner(banner, state.status));
  render();
}

function renderOverlay(el, s) {
  const qr = s.state === 'qr' && s.qr
    ? h('img', { class: 'qr', src: s.qr, alt: 'QR code' })
    : h('div', { class: 'qr qr-loading' }, h('div', { class: 'spinner' }), h('div', { class: 'muted small' }, 'Gerando QR code…'));
  fill(el, h('div', { class: 'connect-card' },
    h('div', { class: 'connect-text' },
      h('h1', null, 'Conecte seu WhatsApp'),
      s.error ? h('div', { class: 'alert' }, s.error) : null,
      h('ol', null,
        h('li', null, 'Abra o ', h('b', null, 'WhatsApp'), ' no seu celular.'),
        h('li', null, 'Toque em ', h('b', null, 'Mais opções ⋮'), ' (Android) ou ', h('b', null, 'Configurações ⚙'), ' (iPhone).'),
        h('li', null, 'Toque em ', h('b', null, 'Aparelhos conectados'), ' e depois em ', h('b', null, 'Conectar aparelho'), '.'),
        h('li', null, 'Aponte o celular para esta tela para ler o código.')),
      h('p', { class: 'muted small' }, '🔒 Você só precisa fazer isso uma vez. A sessão fica salva neste computador e as conversas ficam armazenadas aqui mesmo.'),
      state.demo ? h('p', { class: 'alert info' }, 'Modo demonstração: o QR code é fictício e a conexão acontece sozinha em alguns segundos.') : null),
    h('div', { class: 'connect-qr' }, qr, s.state === 'qr' ? h('div', { class: 'muted small' }, 'O código se renova sozinho a cada poucos segundos.') : null)));
}

function renderBanner(el, s) {
  const h_ = state.history;
  const syncing = s.state === 'open' && h_ && h_.progress != null && h_.progress < 100;
  let content = null;
  if (['connecting', 'reconnecting'].includes(s.state)) {
    content = h('div', { class: 'banner warn' }, h('span', { class: 'spinner small' }), statusLabel(s.state),
      s.error ? h('span', { class: 'muted small' }, ` (${s.error})`) : null,
      s.state === 'reconnecting' ? h('button', { class: 'btn btn-sm', onclick: () => api('wa:reconnect') }, 'Tentar agora') : null);
  } else if (s.state === 'replaced') {
    content = h('div', { class: 'banner warn' }, '⚠ ', s.error || statusLabel(s.state),
      h('button', { class: 'btn btn-sm', onclick: () => api('wa:reconnect') }, 'Usar aqui'));
  } else if (syncing) {
    content = h('div', { class: 'banner info' }, h('span', { class: 'spinner small' }), `Sincronizando histórico de conversas… ${Math.round(h_.progress)}%`);
  }
  clear(el);
  if (content) el.append(content);
  el.classList.toggle('hidden', !content);
}
