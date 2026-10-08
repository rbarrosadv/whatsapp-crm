// Tamanho da letra das conversas e zoom do programa inteiro.
import { state, setSetting, api } from './store.js';
import { toast } from './util.js';

export const FONT_SIZES = [
  ['sm', 'Pequena'], ['md', 'Normal'], ['lg', 'Grande'], ['xl', 'Muito grande'],
];
export const ZOOMS = [0.9, 1, 1.1, 1.25, 1.5];

const fontKey = () => (FONT_SIZES.some(([k]) => k === state.settings.msgFont) ? state.settings.msgFont : 'md');
const zoomVal = () => (ZOOMS.includes(Number(state.settings.uiZoom)) ? Number(state.settings.uiZoom) : 1);
let appliedZoom = null;

export function applyAppearance() {
  document.body.dataset.msgfont = fontKey();
  const z = zoomVal();
  if (z !== appliedZoom) {
    appliedZoom = z;
    api('app:setZoom', z).catch(() => {});
  }
}

/** Ctrl + roda / Ctrl + "+" / "−": muda a letra das conversas um passo. */
export async function stepFont(dir) {
  const keys = FONT_SIZES.map(([k]) => k);
  const i = dir === 0 ? keys.indexOf('md') : Math.min(keys.length - 1, Math.max(0, keys.indexOf(fontKey()) + dir));
  if (keys[i] === fontKey()) return;
  await setSetting('msgFont', keys[i]);
  toast(`Letra das conversas: ${FONT_SIZES[i][1]}`);
}

/** Ctrl + Shift + "+" / "−": zoom do programa inteiro. */
export async function stepZoom(dir) {
  const i = dir === 0 ? ZOOMS.indexOf(1) : Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(zoomVal()) + dir));
  if (ZOOMS[i] === zoomVal()) return;
  await setSetting('uiZoom', ZOOMS[i]);
  toast(`Zoom do programa: ${Math.round(ZOOMS[i] * 100)}%`);
}
