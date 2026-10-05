// Tela de conexão (QR code ou código pelo número) e faixa de status.
import { h, fill, errToast, confirmDialog, downloadUrl } from '../util.js';
import { state, on, api } from '../store.js';
import { statusLabel, runDiagnosis } from './settings.js';

let mode = 'qr'; // 'qr' | 'phone'
let phoneValue = '';

export function mountConnect(overlay, banner) {
  const render = () => {
    const s = state.status;
    // enquanto o celular não confirmou a conexão, a tela de conexão fica aberta
    const needsLogin = s.state !== 'open' && !s.registered && s.state !== 'replaced';
    overlay.classList.toggle('hidden', !needsLogin);
    if (needsLogin) renderOverlay(overlay, s);
    renderBanner(banner, s);
  };
  on('status', render);
  on('history', () => renderBanner(banner, state.status));
  overlay._rerender = render;
  render();
}

function renderOverlay(el, s) {
  // não redesenha enquanto a pessoa digita o número
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
    el.querySelector('.connect-error')?.replaceWith(errorBox(s));
    return;
  }
  const rerender = () => el._rerender?.() ?? renderOverlay(el, state.status);
  const tabs = h('div', { class: 'tabs connect-tabs' },
    h('button', { class: `tab ${mode === 'qr' ? 'active' : ''}`, onclick: () => { mode = 'qr'; renderOverlay(el, state.status); } }, 'Ler QR code'),
    h('button', { class: `tab ${mode === 'phone' ? 'active' : ''}`, onclick: () => { mode = 'phone'; renderOverlay(el, state.status); } }, 'Conectar com número de telefone'));

  const waiting = h('div', { class: 'qr qr-loading' }, h('div', { class: 'spinner' }),
    h('div', { class: 'muted small' }, 'Conectando ao WhatsApp…'));

  let right;
  let steps;
  if (mode === 'qr') {
    right = h('div', { class: 'connect-qr' },
      s.state === 'qr' && s.qr ? h('img', { class: 'qr', src: s.qr, alt: 'QR code' }) : waiting,
      s.state === 'qr' ? h('div', { class: 'muted small' }, 'O código se renova sozinho a cada poucos segundos.') : null);
    steps = h('ol', null,
      h('li', null, 'Abra o ', h('b', null, 'WhatsApp'), ' no celular.'),
      h('li', null, 'Android: toque nos ', h('b', null, '3 pontinhos ⋮'), ' (canto de cima). iPhone: toque em ', h('b', null, 'Configurações'), '.'),
      h('li', null, 'Toque em ', h('b', null, 'Dispositivos conectados'), ' e depois em ', h('b', null, 'Conectar dispositivo'), '.'),
      h('li', null, 'Aponte a câmera do celular para o código ao lado.'));
  } else {
    const input = h('input', {
      class: 'input', placeholder: 'Seu número com DDD, ex.: 11 98765-4321', value: phoneValue,
      oninput: (e) => { phoneValue = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') ask(); },
    });
    const btn = h('button', { class: 'btn btn-primary', disabled: s.state !== 'qr', onclick: () => ask() }, 'Gerar código');
    async function ask() {
      btn.disabled = true;
      try { await api('wa:pairingCode', phoneValue); } catch (e) { errToast(e); btn.disabled = false; }
      document.activeElement?.blur();
      rerender();
    }
    right = h('div', { class: 'connect-qr' },
      s.pairingCode
        ? h('div', { class: 'pairing' }, h('div', { class: 'muted small' }, 'Digite este código no celular:'), h('div', { class: 'pairing-code' }, s.pairingCode))
        : h('div', { class: 'pairing form' },
          h('label', { class: 'field' }, h('span', null, 'Número do WhatsApp que vai conectar'), input),
          btn,
          s.state !== 'qr' ? h('div', { class: 'muted small' }, 'Aguarde a conexão com o WhatsApp…') : null));
    steps = h('ol', null,
      h('li', null, 'Digite ao lado o número do WhatsApp e clique em ', h('b', null, 'Gerar código'), '.'),
      h('li', null, 'No celular: ', h('b', null, '⋮ / Configurações → Dispositivos conectados → Conectar dispositivo'), '.'),
      h('li', null, 'Na tela da câmera, toque em ', h('b', null, 'Conectar com número de telefone'), ' (embaixo).'),
      h('li', null, 'Digite o código de 8 letras que aparecer aqui.'));
  }

  fill(el, h('div', { class: 'connect-card' },
    h('div', { class: 'connect-text' },
      h('h1', null, 'Conecte seu WhatsApp'),
      tabs,
      errorBox(s),
      steps,
      h('p', { class: 'muted small' }, '🔒 Você só precisa fazer isso uma vez. A sessão fica salva no servidor do escritório e as conversas ficam armazenadas lá, para toda a equipe.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: () => { api('wa:reset').catch(errToast); } }, '⟳ Gerar novo código'),
        h('button', { class: 'btn', onclick: runDiagnosis }, '🩺 Testar conexão'),
        state.can.admin ? h('button', { class: 'btn', onclick: () => downloadUrl('/download/logs', 'registro-whatsapp.log') }, '📄 Baixar registros de erro') : null),
      state.demo ? h('p', { class: 'alert info' }, 'Modo demonstração: o código é fictício e a conexão acontece sozinha.') : null),
    right));
}

function errorBox(s) {
  return s.error ? h('div', { class: 'alert connect-error' }, s.error) : h('div', { class: 'connect-error' });
}

// quedas curtas se resolvem sozinhas: a faixa só aparece depois de 10 s
const BANNER_DELAY = 10000;
let offlineSince = null;
let bannerTimer = null;

function renderBanner(el, s) {
  const h_ = state.history;
  const syncing = s.state === 'open' && h_ && h_.progress != null && h_.progress < 100;
  const offline = s.registered && ['connecting', 'reconnecting'].includes(s.state);
  if (offline && !offlineSince) offlineSince = Date.now();
  if (!offline) offlineSince = null;
  clearTimeout(bannerTimer);
  const waited = offline ? Date.now() - offlineSince : 0;
  if (offline && waited < BANNER_DELAY && !s.suggestRepair) {
    bannerTimer = setTimeout(() => renderBanner(el, state.status), BANNER_DELAY - waited + 50);
  }
  let content = null;
  if (offline && (waited >= BANNER_DELAY || s.suggestRepair)) {
    content = h('div', { class: 'banner warn' }, h('span', { class: 'spinner small' }), statusLabel(s.state),
      s.error ? h('span', { class: 'muted small' }, ` (${s.error})`) : null,
      s.state === 'reconnecting' ? h('button', { class: 'btn btn-sm', onclick: () => api('wa:reconnect') }, 'Tentar agora') : null,
      s.suggestRepair ? h('button', {
        class: 'btn btn-sm btn-primary',
        title: 'O WhatsApp parece não aceitar mais a sessão salva',
        onclick: async () => {
          if (!await confirmDialog('O WhatsApp está recusando a sessão salva neste computador. Vamos ler o QR code de novo: as conversas, casos e todos os dados do CRM continuam salvos. Antes, no celular, em Dispositivos conectados, pode remover o "WhatsApp CRM" antigo se ele aparecer lá.', { okLabel: 'Mostrar QR code' })) return;
          mode = 'qr';
          api('wa:repair').catch(errToast);
        },
      }, '📱 Conectar de novo (QR code)') : null,
      h('button', { class: 'btn btn-sm', onclick: runDiagnosis }, '🩺 Testar conexão'));
  } else if (s.state === 'replaced') {
    content = h('div', { class: 'banner warn' }, '⚠ ', s.error || statusLabel(s.state),
      h('button', { class: 'btn btn-sm', onclick: () => api('wa:reconnect') }, 'Usar aqui'));
  } else if (syncing) {
    content = h('div', { class: 'banner info' }, h('span', { class: 'spinner small' }), `Sincronizando histórico de conversas… ${Math.round(h_.progress)}%`);
  }
  fill(el, content);
  el.classList.toggle('hidden', !content);
}
