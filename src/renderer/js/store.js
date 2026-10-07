// Estado compartilhado da interface + ponte com o servidor (bridge.js).

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
  contactTypes: [],
  filters: [],
  settings: {},
  view: 'inbox',
  activeJid: null,
  history: null,
  dataDir: '',
  me: null, // quem está usando: { id, name, role, roleLabel, signature }
  can: {}, // o que o perfil pode: { finance, admin, configure, deleteCases }
  viewers: [], // equipe com conversa aberta: [{ jid, userId, name }]
  typing: new Map(), // jid → { name, until } (alguém da equipe escrevendo)
};

export async function bootstrap() {
  await window.api.ready;
  const b = await api('bootstrap');
  state.demo = b.demo;
  state.me = b.me;
  state.can = b.can;
  state.viewers = b.viewers || [];
  state.status = b.status;
  state.pipelines = b.pipelines;
  state.tags = b.tags;
  state.quickReplies = b.quickReplies;
  state.contactTypes = b.contactTypes;
  state.filters = b.filters;
  state.settings = b.settings;
  state.dataDir = b.dataDir;
  state.version = b.version;
  state.canRestore = b.canRestore;
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
  window.api.on('cases:changed', (jid) => emit('cases', jid));
  window.api.on('clients:changed', (id) => emit('clients', id));
  window.api.on('intimations:changed', () => emit('intimations'));
  window.api.on('courts:history', (st) => emit('courts-history', st));
  window.api.on('cases:import', (st) => { emit('cases-import', st); if (!st.running) emit('cases', null); });
  window.api.on('leads:changed', (id) => emit('leads', id));
  window.api.on('finance:changed', () => emit('finance'));
  window.api.on('ui:open-chat', (jid) => openChat(jid));
  window.api.on('ui:open-view', (v) => setView(v));
  window.api.on('ui:open-filter', (kind) => { setView('inbox'); emit('open-filter', kind); });

  // equipe
  window.api.on('me:changed', (me) => { state.me = me; emit('me', me); });
  window.api.on('users:changed', () => emit('users'));
  window.api.on('settings:office', async () => {
    state.settings = await api('settings:get');
    emit('settings', state.settings);
  });
  window.api.on('viewers', (list) => { state.viewers = list; emit('viewers', list); });
  window.api.on('chats:typing', ({ jid, userId, name }) => {
    if (userId === state.me?.id) return;
    state.typing.set(jid, { name, until: Date.now() + 6000 });
    emit('typing', jid);
    setTimeout(() => emit('typing', jid), 6100);
  });

  // a janela está em foco? (conversa aberta + foco = mensagens lidas)
  const sendFocus = () => api('app:focus', document.hasFocus() && !document.hidden).catch(() => {});
  window.addEventListener('focus', sendFocus);
  window.addEventListener('blur', sendFocus);
  document.addEventListener('visibilitychange', sendFocus);

  // servidor reiniciou ou a internet voltou: atualiza tudo
  window.api.on('bridge:reconnected', async () => {
    try {
      const fresh = await api('bootstrap');
      state.status = fresh.status;
      state.viewers = fresh.viewers || [];
      setChats(fresh.chats);
      emit('status', state.status);
      emit('chats', { changed: null });
      if (state.activeJid) api('chats:setActive', state.activeJid).catch(() => {});
      sendFocus();
    } catch { /* tenta de novo na próxima */ }
  });
  window.api.on('bridge:online', (online) => emit('online', online));
}

/** Outras pessoas da equipe com esta conversa aberta. */
export function othersViewing(jid) {
  return state.viewers.filter((v) => v.jid === jid && v.userId !== state.me?.id).map((v) => v.name);
}

/** Alguém da equipe escrevendo nesta conversa agora (nome) ou null. */
export function someoneTyping(jid) {
  const t = state.typing.get(jid);
  return t && t.until > Date.now() ? t.name : null;
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

/** Abre a ficha do cliente (módulo Jurídico). */
export function openClient(id) {
  setView('legal');
  emit('open-client', id);
}

/** Abre a ficha de um interessado do Comercial (por cima da tela atual). */
export function openLead(id) {
  emit('open-lead', id);
}

/** Abre o módulo Jurídico numa aba (clientes, processos, intimações). */
export function openLegal(tab, opts = {}) {
  setView('legal');
  emit('open-legal', { tab, ...opts });
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

export function typeById(id) {
  return state.contactTypes.find((t) => t.id === id);
}

const HOUR = 3600 * 1000;

/** Conversa esperando resposta sua (última mensagem é do contato). */
export function isAwaiting(c) {
  return !c.is_group && !c.last_from_me && c.last_ts > 0 && !(typeById(c.type_id)?.personal)
    && Date.now() - c.last_ts < 30 * 24 * HOUR; // conversas muito antigas não contam como pendência
}

/** Aplica as regras de um filtro (editável em Configurações) a uma conversa. */
export function chatMatchesRules(c, r = {}) {
  const t = typeById(c.type_id);
  const unclassified = !t;
  if (r.groups === 'exclude' && c.is_group) return false;
  if (r.groups === 'only' && !c.is_group) return false;
  if (r.unclassified === 'only' && !unclassified) return false;
  if (r.types?.length) {
    const inTypes = t && r.types.includes(t.id);
    if (!inTypes && !(unclassified && r.unclassified === 'include')) return false;
  } else if (r.unclassified === 'exclude' && unclassified) return false;
  if (r.work && t?.personal) return false;
  if (r.unread && !(c.unread > 0)) return false;
  if (r.awaiting) {
    if (!isAwaiting(c)) return false;
    if (r.awaitingHours && Date.now() - c.last_ts < r.awaitingHours * HOUR) return false;
  }
  if (r.tasks && !(c.open_tasks > 0)) return false;
  const stageIds = c.stage_ids || (c.stage_id ? [c.stage_id] : []);
  const pipelineIds = c.pipeline_ids || (c.pipeline_id ? [c.pipeline_id] : []);
  if (r.noStage && stageIds.length) return false;
  if (r.pipeline && !pipelineIds.includes(r.pipeline)) return false;
  if (r.stages?.length && !r.stages.some((x) => stageIds.includes(x))) return false;
  if (r.tags?.length && !r.tags.some((x) => c.tag_ids.includes(x))) return false;
  return true;
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
