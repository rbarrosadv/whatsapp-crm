// Utilitários da interface: criação de elementos, formatação, modais e avisos.

/** Cria um elemento: h('div', { class: 'x', onclick }, 'texto', filho) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv == null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else el.style[sk] = sv;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/** Limpa o elemento e coloca os filhos (ignorando null/false). */
export function fill(el, ...children) { clear(el); append(el, children); return el; }

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Formatação do WhatsApp (*negrito*, _itálico_, ~riscado~, ```mono```) + links clicáveis. */
export function formatWhatsApp(text) {
  let s = escapeHtml(text);
  s = s.replace(/```([\s\S]+?)```/g, '<code>$1</code>');
  s = s.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=$|[\s).,!?:;])/g, '$1<b>$2</b>');
  s = s.replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=$|[\s).,!?:;])/g, '$1<i>$2</i>');
  s = s.replace(/(^|[\s(])~(?!\s)([^~\n]+?)~(?=$|[\s).,!?:;])/g, '$1<s>$2</s>');
  s = s.replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/(^|\s)(www\.[^\s<]+[^\s<.,;:!?)\]'"])/g, '$1<a href="https://$2" target="_blank" rel="noreferrer">$2</a>');
  return s.replace(/\n/g, '<br>');
}

const DAY = 24 * 3600 * 1000;

function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function fmtListTime(ts) {
  if (!ts) return '';
  const today = startOfDay(Date.now());
  if (ts >= today) return fmtTime(ts);
  if (ts >= today - DAY) return 'Ontem';
  if (ts >= today - 6 * DAY) return new Date(ts).toLocaleDateString('pt-BR', { weekday: 'long' });
  return new Date(ts).toLocaleDateString('pt-BR');
}

export function fmtDay(ts) {
  const today = startOfDay(Date.now());
  if (ts >= today) return 'Hoje';
  if (ts >= today - DAY) return 'Ontem';
  const d = new Date(ts);
  if (ts >= today - 6 * DAY) return d.toLocaleDateString('pt-BR', { weekday: 'long' });
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

export function fmtDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDue(ts) {
  if (!ts) return 'Sem data';
  const today = startOfDay(Date.now());
  const t = new Date(ts);
  const hm = fmtTime(ts);
  if (ts >= today && ts < today + DAY) return `Hoje, ${hm}`;
  if (ts >= today + DAY && ts < today + 2 * DAY) return `Amanhã, ${hm}`;
  if (ts >= today - DAY && ts < today) return `Ontem, ${hm}`;
  return `${t.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}, ${hm}`;
}

export function fmtDuration(ms) {
  const d = Math.floor(ms / DAY);
  if (d >= 1) return `${d} dia${d > 1 ? 's' : ''}`;
  const hrs = Math.floor(ms / 3600000);
  if (hrs >= 1) return `${hrs} h`;
  return `${Math.max(1, Math.floor(ms / 60000))} min`;
}

export function fmtMoney(v) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtSeconds(s) {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function phoneOf(jid) {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  return jid.split('@')[0];
}

export function formatPhone(digits) {
  if (!digits) return '';
  const d = String(digits);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const rest = d.slice(4);
    const head = rest.length === 9 ? rest.slice(0, 5) : rest.slice(0, 4);
    return `+55 (${d.slice(2, 4)}) ${head}-${rest.slice(head.length)}`;
  }
  return `+${d}`;
}

export function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

const AVATAR_COLORS = ['#e57373', '#f06292', '#ba68c8', '#9575cd', '#7986cb', '#64b5f6', '#4fc3f7', '#4dd0e1',
  '#4db6ac', '#81c784', '#aed581', '#ffb74d', '#ff8a65', '#a1887f'];

export function initials(name) {
  const parts = String(name || '').replace(/[^\p{L} ]/gu, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '👤';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function colorFor(key) {
  let hsh = 0;
  for (const ch of String(key)) hsh = (hsh * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hsh) % AVATAR_COLORS.length];
}

export function normalize(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// --------------------------------------------------------------- avisos

export function toast(msg, kind = 'info', ms = 3500) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const el = h('div', { class: `toast toast-${kind}` }, msg);
  box.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

export function errToast(e) {
  console.error(e);
  toast(e?.message || String(e), 'error', 5000);
}

// --------------------------------------------------------------- modais

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const footer = h('div', { class: 'modal-actions' },
    actions.map((a) => h('button', {
      class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`,
      onclick: async () => {
        try {
          const r = await a.onClick?.();
          if (r !== false) close();
        } catch (e) { errToast(e); }
      },
    }, a.label)));
  const box = h('div', { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog' },
    h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'icon-btn', title: 'Fechar', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? footer : null);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  setTimeout(() => box.querySelector('input, textarea, select')?.focus(), 30);
  return { close, box };
}

export function confirmDialog(message, { okLabel = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title: 'Confirmar',
      body: h('p', null, message),
      actions: [
        { label: 'Cancelar', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, primary: !danger, danger, onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function promptDialog(title, { label, value = '', placeholder = '', multiline = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = multiline
      ? h('textarea', { class: 'input', rows: 4, placeholder }, value)
      : h('input', { class: 'input', value, placeholder });
    const m = modal({
      title,
      body: h('label', { class: 'field' }, label ? h('span', null, label) : null, input),
      actions: [
        { label: 'Cancelar', onClick: () => { done = true; resolve(null); } },
        { label: 'OK', primary: true, onClick: () => { done = true; resolve(input.value.trim()); } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done = true; resolve(input.value.trim()); m.close(); } });
  });
}

/** Menu flutuante (clique direito / botão "⋮"). items: [{label, onClick, danger}] */
export function popupMenu(anchor, items, { x, y } = {}) {
  document.querySelectorAll('.popup-menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'popup-menu' },
    items.filter(Boolean).map((it) => (it === '-' ? h('div', { class: 'popup-sep' })
      : h('button', {
        class: `popup-item ${it.danger ? 'danger' : ''} ${it.active ? 'active' : ''}`,
        onclick: (e) => { e.stopPropagation(); menu.remove(); it.onClick?.(); },
      }, it.icon ? h('span', { class: 'popup-icon', style: it.color ? { color: it.color } : null }, it.icon) : null, it.label))));
  document.body.append(menu);
  const r = anchor?.getBoundingClientRect?.();
  let left = x ?? r.left;
  let top = y ?? r.bottom + 4;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, (x ?? r.right) - mw);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, (y ?? r.top) - mh - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off, true); } };
  setTimeout(() => document.addEventListener('mousedown', off, true), 0);
  return menu;
}

export const EMOJIS = ['😀', '😂', '😊', '😍', '😘', '😉', '😎', '🤔', '😅', '😢', '😭', '😡', '🙏', '👍', '👎', '👏',
  '🙌', '💪', '🤝', '👋', '✌️', '👌', '❤️', '💚', '💙', '🔥', '✨', '🎉', '✅', '❌', '⚠️', '📌', '📅', '⏰', '📞',
  '💰', '📄', '📷', '🚀', '⭐', '💡', '😴', '🤩', '🥳', '😬', '🙄', '😇', '🤗'];

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export const PALETTE = ['#94a3b8', '#3b82f6', '#06b6d4', '#22c55e', '#84cc16', '#f59e0b', '#f97316', '#ef4444',
  '#ec4899', '#a855f7', '#6366f1', '#14b8a6'];
