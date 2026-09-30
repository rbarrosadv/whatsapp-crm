// Pedacinhos de interface reaproveitados em várias telas.
import { h, initials, colorFor, popupMenu, errToast } from './util.js';
import { state, avatarFor, stageById, tagById, typeById, api } from './store.js';

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

export function typePill(typeId) {
  const t = typeById(typeId);
  if (!t) return null;
  return h('span', { class: 'stage-pill small', style: { '--c': t.color || '#94a3b8' } }, `${t.icon || ''} ${t.name}`);
}

/** Menu para classificar o contato (Pessoal, Cliente, Empresa…). */
export function typeMenu(anchor, chat, opts = {}) {
  return popupMenu(anchor, [
    ...state.contactTypes.map((t) => ({
      icon: t.icon, label: t.name, active: chat.type_id === t.id,
      onClick: () => api('crm:setType', chat.jid, t.id).catch(errToast),
    })),
    ...(chat.type_id ? ['-', { label: 'Remover classificação', onClick: () => api('crm:setType', chat.jid, null).catch(errToast) }] : []),
  ], opts);
}

/** Faixa "Quem é este contato?" para conversas ainda não classificadas. */
export function classifyBar(chat) {
  if (chat.type_id && typeById(chat.type_id)) return null;
  return h('div', { class: 'classify-bar' },
    h('span', null, chat.is_group ? 'Classificar este grupo:' : 'Quem é este contato?'),
    ...state.contactTypes.map((t) => h('button', {
      class: 'btn btn-sm', style: { borderColor: t.color },
      onclick: () => api('crm:setType', chat.jid, t.id).catch(errToast),
    }, `${t.icon || ''} ${t.name}`)));
}
