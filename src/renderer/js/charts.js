// Gráficos simples em SVG (sem biblioteca): colunas agrupadas por mês e barras
// horizontais por categoria. Seguem as regras de visualização do sistema:
// marcas finas (≤ 24 px) com ponta arredondada, 2 px de folga entre barras,
// grade em linha fina, legenda sempre que há 2+ séries, valor ao passar o
// mouse (ou foco pelo teclado) e a tabela com os mesmos números.
import { h, fill } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k);
  return el;
};

/** Passo "redondo" do eixo para 4 divisões (0, 500, 1.000…). */
function niceStep(v) {
  const raw = v > 0 ? v / 4 : 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= raw);
}
const compact = (v) => (v >= 1e6 ? `${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`
  : v >= 1e3 ? `${(v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : v.toLocaleString('pt-BR'));

/** Coluna com ponta arredondada (4 px) e base reta. */
function colPath(x, y, w, hgt, r = 4) {
  if (hgt <= 0) return '';
  const rr = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}
function barPath(x, y, w, hgt, r = 4) {
  if (w <= 0) return '';
  const rr = Math.min(r, hgt / 2, w);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt - rr}Q${x + w},${y + hgt} ${x + w - rr},${y + hgt}H${x}Z`;
}

function tooltip(wrap) {
  const tip = h('div', { class: 'viz-tip', role: 'status' });
  wrap.append(tip);
  return {
    show(evt, title, rows) {
      fill(tip, h('div', { class: 'viz-tip-title' }, title), rows.map(([color, label, value]) => h('div', { class: 'viz-tip-row' },
        color ? h('span', { class: 'viz-key', style: { background: color } }) : null, h('b', null, value), h('span', null, label))));
      tip.classList.add('on');
      const r = wrap.getBoundingClientRect();
      const t = evt.target.getBoundingClientRect?.() || r;
      const x = (evt.clientX ?? t.left + t.width / 2) - r.left;
      const y = (evt.clientY ?? t.top) - r.top;
      tip.style.left = `${Math.min(Math.max(8, x + 12), r.width - tip.offsetWidth - 8)}px`;
      tip.style.top = `${Math.max(4, y - tip.offsetHeight - 10)}px`;
    },
    hide() { tip.classList.remove('on'); },
  };
}

/** Mostra o gráfico ou a tabela com os mesmos números. */
function withTable(chartEl, tableEl) {
  const box = h('div', null, chartEl);
  let table = false;
  const btn = h('button', { class: 'link-btn small viz-toggle', onclick: () => { table = !table; fill(box, table ? tableEl : chartEl); btn.textContent = table ? 'ver gráfico' : 'ver tabela'; } }, 'ver tabela');
  return h('div', { class: 'viz' }, btn, box);
}

/**
 * Colunas agrupadas: rows = [{ label, values: [n, n…] }], series = [{ name, color }].
 * `fmt` formata os valores (ex.: R$).
 */
export function columnChart({ rows, series, fmt, height = 240 }) {
  const wrap = h('div', { class: 'viz-plot' });
  const draw = () => {
    const W = Math.max(320, wrap.clientWidth || 640);
    const H = height;
    const m = { l: 56, r: 8, t: 10, b: 26 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const max = niceStep(Math.max(...rows.flatMap((r) => r.values), 0)) * 4;
    const band = iw / rows.length;
    const gap = 2;
    const bw = Math.min(24, (band * 0.7 - gap * (series.length - 1)) / series.length);
    const group = bw * series.length + gap * (series.length - 1);
    const y = (v) => m.t + ih - (v / max) * ih;
    fill(wrap);
    const tip = tooltip(wrap);
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'viz-svg', role: 'img' });
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'viz-grid' }),
        s('text', { x: m.l - 6, y: y(v) + 4, class: 'viz-axis', 'text-anchor': 'end' }, compact(v)));
    }
    rows.forEach((r, i) => {
      const gx = m.l + band * i + (band - group) / 2;
      svg.append(s('text', { x: m.l + band * i + band / 2, y: H - 8, class: 'viz-axis', 'text-anchor': 'middle' }, r.label));
      const hit = s('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, fill: 'transparent', tabindex: 0, class: 'viz-hit' });
      const marks = r.values.map((v, j) => s('path', { d: colPath(gx + j * (bw + gap), y(v), bw, m.t + ih - y(v)), fill: series[j].color, class: 'viz-mark' }));
      const on = (e) => { marks.forEach((mk) => mk.classList.add('hover')); tip.show(e, r.title || r.label, r.values.map((v, j) => [series[j].color, series[j].name, fmt(v)]).concat(r.extra || [])); };
      const off = () => { marks.forEach((mk) => mk.classList.remove('hover')); tip.hide(); };
      hit.addEventListener('pointermove', on);
      hit.addEventListener('focus', on);
      hit.addEventListener('pointerleave', off);
      hit.addEventListener('blur', off);
      svg.append(...marks, hit);
    });
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, class: 'viz-base' }));
    wrap.prepend(svg);
  };
  // desenha com a largura real e redesenha se a janela mudar de tamanho
  let lastW = 0;
  new ResizeObserver(() => { const w = wrap.clientWidth; if (w && Math.abs(w - lastW) > 4) { lastW = w; draw(); } }).observe(wrap);
  const legend = series.length > 1 ? h('div', { class: 'viz-legend' }, series.map((x) => h('span', null, h('span', { class: 'viz-swatch', style: { background: x.color } }), x.name))) : null;
  const table = h('table', { class: 'table compact' },
    h('thead', null, h('tr', null, h('th', null, ''), series.map((x) => h('th', { class: 'num' }, x.name)))),
    h('tbody', null, rows.map((r) => h('tr', null, h('td', null, r.title || r.label), r.values.map((v) => h('td', { class: 'num' }, fmt(v)))))));
  return h('div', null, legend, withTable(wrap, table));
}

/** Barras horizontais de uma série: items = [{ label, value }], ordenadas do maior para o menor. */
export function barChart({ items, color, fmt, max: maxItems = 8 }) {
  let list = [...items].sort((a, b) => b.value - a.value);
  if (list.length > maxItems) {
    const rest = list.slice(maxItems - 1).reduce((a, x) => a + x.value, 0);
    list = [...list.slice(0, maxItems - 1), { label: 'Outros', value: rest }];
  }
  const max = Math.max(...list.map((x) => x.value), 1);
  const wrap = h('div', { class: 'viz-bars' }, list.map((x) => h('div', { class: 'viz-bar-row', tabindex: 0, title: `${x.label}: ${fmt(x.value)}` },
    h('span', { class: 'viz-bar-label' }, x.label),
    h('span', { class: 'viz-bar-track' }, h('span', { class: 'viz-bar', style: { width: `${Math.max(1, (x.value / max) * 100)}%`, background: color } })),
    h('b', { class: 'viz-bar-value money plain' }, fmt(x.value)))));
  const table = h('table', { class: 'table compact' }, h('tbody', null, list.map((x) => h('tr', null, h('td', null, x.label), h('td', { class: 'num' }, fmt(x.value))))));
  return withTable(wrap, table);
}
