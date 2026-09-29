// Pedacinhos de interface reaproveitados em várias telas.
import { h, initials, colorFor, popupMenu } from './util.js';
import { state, avatarFor, stageById, tagById, api } from './store.js';

export function avatarEl(chat, size = 44) {
  const el = h('div', {
    class: 'avatar',
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px`, background: colorFor(chat.jid) },
  }, chat.is_group ? '👥' : initials(chat.display_name));
  avatarFor(chat.jid).then((url) => {
    if (!url) return;
    const img = h('img', { src: url, alt: '', draggable: false });
    img.onerror = () => img.remove();
    img.onload = () => { el.textContent = ''; el.append(img); };
  });
  return el;
}

export function ticks(status) {
  if (status == null) return null;
  if (status === 0) return h('span', { class: 'tick tick-error', title: 'Erro ao enviar' }, '⚠');
  if (status <= 1) return h('span', { class: 'tick', title: 'Enviando' }, '🕓');
  if (status === 2) return h('span', { class: 'tick', title: 'Enviada' }, '✓');
  if (status === 3) return h('span', { class: 'tick', title: 'Entregue' }, '✓✓');
  return h('span', { class: 'tick tick-read', title: status === 5 ? 'Reproduzida' : 'Lida' }, '✓✓');
}

export function stagePill(stageId, { small = false } = {}) {
  const st = stageById(stageId);
  if (!st) return null;
  return h('span', {
    class: `stage-pill ${small ? 'small' : ''}`,
    style: { '--c': st.color || '#94a3b8' },
    title: `${st.pipeline.name} → ${st.name}`,
  }, st.name);
}

export function tagDots(tagIds, { max = 4 } = {}) {
  const tags = (tagIds || []).map(tagById).filter(Boolean);
  if (!tags.length) return null;
  return h('span', { class: 'tag-dots' },
    tags.slice(0, max).map((t) => h('span', { class: 'tag-chip', style: { '--c': t.color }, title: t.name }, t.name)),
    tags.length > max ? h('span', { class: 'tag-more' }, `+${tags.length - max}`) : null);
}

/** Menu para escolher etapa do funil de uma conversa. */
export function stageMenu(anchor, chat, opts = {}) {
  const items = [];
  for (const p of state.pipelines) {
    items.push({ label: `${p.icon || ''} ${p.name}`.trim(), onClick: null, header: true });
    for (const s of p.stages) {
      items.push({
        icon: '●', color: s.color, label: `   ${s.name}`, active: chat.stage_id === s.id,
        onClick: () => api('crm:setStage', chat.jid, s.id).catch(console.error),
      });
    }
  }
  if (chat.stage_id) {
    items.push('-');
    items.push({ label: 'Remover do funil', danger: true, onClick: () => api('crm:setStage', chat.jid, null) });
  }
  const menu = popupMenu(anchor, items.map((i) => (i.header ? { ...i, onClick: undefined } : i)), opts);
  menu.querySelectorAll('.popup-item').forEach((b, idx) => {
    const it = items.filter((x) => x !== '-')[idx];
    if (it?.header) { b.classList.add('popup-header'); b.disabled = true; }
  });
  return menu;
}

export function emptyState(icon, title, text, action) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon),
    h('h3', null, title),
    text ? h('p', null, text) : null,
    action || null);
}
