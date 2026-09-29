// Estado compartilhado da interface + ponte com o processo principal.

export const api = (method, ...args) => window.api.call(method, ...args);

const listeners = new Map();
export function on(evt, cb) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(cb);
  return () => listeners.get(evt)?.delete(cb);
}
export function emit(evt, payload) {
  for (const cb of listeners.get(evt) || []) {
    try { cb(payload); } catch (e) { console.error(e); }
  }
}

export const state = {
  demo: false,
  status: { state: 'idle' },
  chats: new Map(),
  pipelines: [],
  tags: [],
  quickReplies: [],
  settings: {},
  view: 'inbox',
  activeJid: null,
  history: null,
  legacyAvailable: false,
  legacyPending: 0,
  dataDir: '',
};

export async function bootstrap() {
  const b = await api('bootstrap');
  state.demo = b.demo;
  state.status = b.status;
  state.pipelines = b.pipelines;
  state.tags = b.tags;
  state.quickReplies = b.quickReplies;
  state.settings = b.settings;
  state.legacyAvailable = b.legacyAvailable;
  state.legacyPending = b.legacyPending;
  state.dataDir = b.dataDir;
  state.version = b.version;
  setChats(b.chats);

  window.api.on('wa:status', (s) => { state.status = s; emit('status', s); });
  window.api.on('wa:history', (h) => { state.history = h; emit('history', h); });
  window.api.on('chats:changed', ({ chats, removed }) => {
    for (const c of chats) state.chats.set(c.jid, c);
    for (const j of removed || []) state.chats.delete(j);
    emit('chats', { changed: chats.map((c) => c.jid) });
  });
  window.api.on('chats:reload', (list) => { setChats(list); emit('chats', { changed: null }); });
  window.api.on('chats:merged', ({ from, to }) => {
    state.chats.delete(from);
    if (state.activeJid === from) openChat(to);
    emit('chats', { changed: [to] });
  });
  window.api.on('message', (m) => emit('message', m));
  window.api.on('config:changed', (c) => {
    Object.assign(state, c);
    emit('config', c);
    emit('chats', { changed: null });
  });
  window.api.on('tasks:changed', () => emit('tasks'));
  window.api.on('ui:open-chat', (jid) => openChat(jid));
  window.api.on('ui:open-view', (v) => setView(v));
}

function setChats(list) {
  state.chats = new Map(list.map((c) => [c.jid, c]));
}

export function sortedChats() {
  return [...state.chats.values()].sort((a, b) => (b.pinned - a.pinned) || (b.last_ts - a.last_ts));
}

export function setView(view) {
  if (state.view === view) return;
  state.view = view;
  api('settings:set', 'lastView', view).catch(() => {});
  emit('view', view);
}

export function openChat(jid) {
  state.activeJid = jid;
  if (state.view !== 'inbox') { state.view = 'inbox'; emit('view', 'inbox'); }
  emit('active', jid);
  api('chats:setActive', jid).catch(() => {});
}

export function stageById(id) {
  for (const p of state.pipelines) {
    const s = p.stages.find((x) => x.id === id);
    if (s) return { ...s, pipeline: p };
  }
  return null;
}

export function tagById(id) {
  return state.tags.find((t) => t.id === id);
}

export async function refreshChat(jid) {
  const c = await api('chats:get', jid);
  if (c) { state.chats.set(jid, c); emit('chats', { changed: [jid] }); }
  return c;
}

export async function setSetting(key, value) {
  state.settings = await api('settings:set', key, value);
  emit('settings', state.settings);
}

const avatarCache = new Map();
/** Busca (uma vez) a foto de perfil da conversa. */
export function avatarFor(jid) {
  if (!avatarCache.has(jid)) {
    avatarCache.set(jid, api('chats:avatar', jid).catch(() => null));
  }
  return avatarCache.get(jid);
}
export function forgetAvatar(jid) { avatarCache.delete(jid); }
