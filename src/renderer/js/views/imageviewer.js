// Visualizador de imagens em tela cheia: zoom (rodinha, pinça, +/−, duplo clique),
// arrastar para mover, girar e passar para a foto anterior/próxima da conversa.
import { h } from '../util.js';

const MIN = 0.2;
const MAX = 12;

/**
 * @param {{url:string, m:object}[]} items  fotos da conversa (na ordem)
 * @param {number} index  qual abrir
 * @param {{actions?: (m)=>{label,title,onClick}[]}} opts
 */
export function openImageViewer(items, index, { actions = () => [] } = {}) {
  let i = index;
  let scale = 1; let x = 0; let y = 0; let rot = 0;
  let drag = null;

  const img = h('img', { class: 'iv-img', draggable: false, alt: '' });
  const stage = h('div', { class: 'iv-stage' }, img);
  const counter = h('span', { class: 'iv-counter' });
  const zoomLabel = h('span', { class: 'iv-zoom' });
  const extra = h('div', { class: 'iv-extra' });
  const btn = (label, title, fn) => h('button', { class: 'iv-btn', title, onclick: (e) => { e.stopPropagation(); fn(e); } }, label);
  const prevBtn = btn('‹', 'Anterior (←)', () => go(-1));
  const nextBtn = btn('›', 'Próxima (→)', () => go(1));
  prevBtn.classList.add('iv-nav', 'iv-prev');
  nextBtn.classList.add('iv-nav', 'iv-next');

  const bar = h('div', { class: 'iv-bar' },
    counter,
    btn('−', 'Diminuir (−)', () => zoomAt(scale / 1.4)),
    zoomLabel,
    btn('+', 'Aumentar (+)', () => zoomAt(scale * 1.4)),
    btn('⤢', 'Ajustar à tela (0)', reset),
    btn('⟳', 'Girar (R)', () => { rot = (rot + 90) % 360; apply(); }),
    extra,
    btn('✕', 'Fechar (Esc)', close));
  const overlay = h('div', { class: 'iv-overlay', role: 'dialog' }, stage, prevBtn, nextBtn, bar);

  function apply() {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale}) rotate(${rot}deg)`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    stage.classList.toggle('zoomed', scale > 1.01);
  }
  function reset() { scale = 1; x = 0; y = 0; apply(); }

  // zoom mantendo parado o ponto sob o cursor (cx, cy relativos ao centro da tela)
  function zoomAt(next, cx = 0, cy = 0) {
    next = Math.min(MAX, Math.max(MIN, next));
    const k = next / scale;
    x = cx - (cx - x) * k;
    y = cy - (cy - y) * k;
    scale = next;
    if (scale <= 1.01 && scale >= 0.99) { x = 0; y = 0; }
    apply();
  }
  const center = (e) => {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2];
  };

  function show() {
    const it = items[i];
    rot = 0;
    reset();
    img.src = it.url;
    counter.textContent = items.length > 1 ? `${i + 1} de ${items.length}` : '';
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i >= items.length - 1;
    prevBtn.hidden = nextBtn.hidden = items.length <= 1;
    extra.replaceChildren(...actions(it.m).map((a) => btn(a.label, a.title || a.label, a.onClick)));
  }
  function go(d) {
    const n = i + d;
    if (n < 0 || n >= items.length) return;
    i = n;
    show();
  }

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    // pinça no touchpad chega como rodinha com Ctrl; deltas pequenos = zoom suave
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
    zoomAt(scale * factor, ...center(e));
  }, { passive: false });
  stage.addEventListener('dblclick', (e) => {
    if (scale > 1.01) reset(); else zoomAt(2.5, ...center(e));
  });
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target !== img) { if (scale <= 1.01) close(); return; }
    drag = { sx: e.clientX, sy: e.clientY, x, y, moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx; const dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (scale <= 1.01) return;
    x = drag.x + dx; y = drag.y + dy;
    apply();
  });
  stage.addEventListener('pointerup', () => { drag = null; });

  function onKey(e) {
    const k = e.key;
    if (k === 'Escape') close();
    else if (k === 'ArrowLeft') go(-1);
    else if (k === 'ArrowRight') go(1);
    else if (k === '+' || k === '=') zoomAt(scale * 1.4);
    else if (k === '-') zoomAt(scale / 1.4);
    else if (k === '0') reset();
    else if (k === 'r' || k === 'R') { rot = (rot + 90) % 360; apply(); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  }

  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  show();
  return { close };
}
