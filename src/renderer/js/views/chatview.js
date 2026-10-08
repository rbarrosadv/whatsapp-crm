// Conversa aberta: cabeçalho, mensagens e caixa de envio.
import { openImageViewer } from './imageviewer.js';
import { getDraft, setDraft, clearDraft } from '../drafts.js';
import { firstUrl, siteOf } from '../links.js';
import { suggestWords, applyWord, learnWords } from '../wordsuggest.js';
import { autocorrectBefore, correctWord } from '../autocorrect.js';

// palavras que você desfez a correção (Backspace logo depois): não corrige mais nesta sessão
const keepAsTyped = new Set();
import {
  h, clear, fill, fmtTime, fmtDay, fmtSize, fmtSeconds, formatWhatsApp, formatPhone, phoneOf, colorFor,
  toast, errToast, modal, confirmDialog, popupMenu, EMOJIS, QUICK_REACTIONS,
} from '../util.js';
import { state, on, emit, api, stageById, openChat, typeById } from '../store.js';
import { avatarEl, ticks, emptyState, typeMenu, classifyBar } from '../components.js';
import { openCase, newCaseDialog } from './casemodal.js';
import { newChatDialog } from './chatlist.js';

export function mediaUrl(rel) {
  return `crm-media://file/${String(rel).split(/[\\/]/).map(encodeURIComponent).join('/')}`;
}

let root;
let current = null; // { jid, messages: [], els: Map, loadingOlder, noMoreLocal }
let replyTo = null;
let editing = null; // mensagem sua sendo editada
let vocab = null; // palavras que você mais usa (sugestão ao digitar)
const loadVocab = () => { if (!vocab) { vocab = []; api('words:vocab').then((v) => { vocab = v || []; }).catch(() => {}); } };
const EDIT_WINDOW_MS = 15 * 60 * 1000;
let recorder = null;

export function mountChatView(el, { onTogglePanel }) {
  root = el;
  on('active', (jid) => open(jid));
  on('message', onMessageEvent);
  on('focus-message', (f) => { if (current?.jid === f.jid) jumpTo(f.id, f.query); });
  on('chats', ({ changed }) => {
    if (!current) return;
    if (changed === null || changed.includes(current.jid)) {
      renderHeader();
      maybeFetchNewer();
    }
  });
  on('status', () => current && renderComposerState());
  on('config', () => current && renderHeader());
  on('cases', (j) => { if (current && (!j || j === current.jid)) renderHeader(); });
  root._togglePanel = onTogglePanel;
  renderEmpty();
}

function renderEmpty() {
  current = null;
  fill(root, emptyState('💬', 'WhatsApp CRM',
    'Escolha uma conversa na lista para ver as mensagens e a ficha do contato.',
    h('button', { class: 'btn btn-primary', onclick: newChatDialog }, '＋ Nova conversa')));
}

async function open(jid) {
  if (!jid) { renderEmpty(); return; }
  if (current?.jid === jid) return;
  stopRecording(true);
  replyTo = null;
  editing = null;
  current = { jid, messages: [], els: new Map(), loadingOlder: false, noMoreLocal: false };
  const headerEl = h('div', { class: 'chat-head' });
  const classifyEl = h('div');
  const msgsEl = h('div', { class: 'messages', onscroll: onScroll });
  const newBtn = h('button', { class: 'new-msgs-btn hidden', onclick: () => (current.detached ? reloadLatest() : scrollToBottom(true)) }, '↓ Novas mensagens');
  const composerEl = h('div', { class: 'composer' });
  const pane = h('div', { class: 'chat-pane' }, headerEl, classifyEl, h('div', { class: 'messages-wrap' }, msgsEl, newBtn), composerEl);
  setupDrop(pane);
  fill(root, pane);
  Object.assign(current, { headerEl, classifyEl, msgsEl, composerEl, newBtn });
  renderHeader();
  renderComposer();
  // veio de um resultado da busca: abre no ponto da mensagem encontrada
  if (state.focus?.jid === jid) {
    const f = state.focus;
    state.focus = null;
    if (await jumpTo(f.id, f.query)) return;
  }
  const msgs = await api('messages:list', jid, { limit: 80 });
  if (current?.jid !== jid) return;
  current.messages = msgs;
  current.noMoreLocal = msgs.length < 80;
  renderMessages();
  scrollToBottom();
}

// --------------------------------------------------------------- cabeçalho

function renderHeader() {
  const chat = state.chats.get(current.jid);
  if (!chat) return;
  const phone = phoneOf(chat.jid);
  const sub = chat.is_group ? 'Grupo' : (phone ? formatPhone(phone) : '');
  const st = chat.stage_id ? stageById(chat.stage_id) : null;
  const n = chat.open_cases || 0;
  const stageBtn = chat.is_group ? null : h('button', {
    class: `stage-btn ${n ? '' : 'unset'}`,
    style: st && n === 1 ? { '--c': st.color } : null,
    title: 'Casos deste contato',
    onclick: (e) => casesMenu(e.currentTarget, chat),
  }, n === 0 ? '＋ Novo caso' : n === 1 && st ? `📁 ${st.name}` : `📁 ${n} casos`, ' ▾');
  const t = typeById(chat.type_id);
  const typeBtn = h('button', {
    class: `stage-btn ${t ? '' : 'unset'}`,
    style: t ? { '--c': t.color } : null,
    title: 'Tipo de contato',
    onclick: (e) => typeMenu(e.currentTarget, chat),
  }, t ? `${t.icon || ''} ${t.name}` : '❓ Classificar', ' ▾');
  fill(current.classifyEl, classifyBar(chat));
  fill(current.headerEl, 
    avatarEl(chat, 40),
    h('div', { class: 'chat-head-info', onclick: () => root._togglePanel?.(true) },
      h('div', { class: 'chat-head-name' }, chat.display_name),
      h('div', { class: 'chat-head-sub' }, sub, chat.company ? ` · ${chat.company}` : '')),
    typeBtn,
    stageBtn,
    h('button', { class: 'icon-btn', title: 'Marcar como não lida', onclick: () => api('chats:markUnread', chat.jid) }, '●'),
    h('button', { class: 'icon-btn', title: 'Ficha do contato (CRM)', onclick: () => root._togglePanel?.() }, '☰'),
  );
}

async function casesMenu(anchor, chat) {
  const list = await api('cases:list', { jid: chat.jid, includeClosed: false }).catch(() => []);
  if (!list.length) { newCaseDialog(chat.jid); return; }
  popupMenu(anchor, [
    ...list.map((k) => {
      const s = stageById(k.stage_id);
      return { icon: '📁', label: `${k.title}${s ? ` — ${s.name}` : ''}`, color: s?.color, onClick: () => openCase(k.id) };
    }),
    ...(list.length ? ['-'] : []),
    { icon: '＋', label: 'Novo caso', onClick: () => newCaseDialog(chat.jid) },
  ]);
}

/** Guarda a mídia da mensagem nos documentos de um caso do contato. */
async function attachToCase(anchor, m) {
  const jid = current.jid;
  const list = await api('cases:list', { jid, includeClosed: false }).catch(() => []);
  const attach = async (caseId) => {
    try {
      const id = await api('cases:attachMessage', caseId, jid, m.id);
      toast(id ? 'Arquivo guardado nos documentos do caso' : 'Este arquivo já estava no caso', 'success');
    } catch (e) { errToast(e); }
  };
  if (!list.length) {
    toast('Este contato ainda não tem caso. Crie um e depois anexe o arquivo.');
    newCaseDialog(jid);
    return;
  }
  if (list.length === 1) { attach(list[0].id); return; }
  popupMenu(anchor, list.map((k) => ({ icon: '📁', label: k.title, onClick: () => attach(k.id) })));
}

// ---------------------------------------------------------------- mensagens

function renderMessages() {
  const { msgsEl } = current;
  const prevHeight = msgsEl.scrollHeight;
  const prevTop = msgsEl.scrollTop;
  const frag = document.createDocumentFragment();
  current.els.clear();
  frag.append(olderBar());
  let lastDay = null;
  for (const m of current.messages) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { frag.append(h('div', { class: 'day-sep' }, h('span', null, fmtDay(m.ts)))); lastDay = day; }
    const el = msgEl(m);
    current.els.set(m.id, el);
    frag.append(el);
  }
  fill(msgsEl, frag);
  return { prevHeight, prevTop };
}

function olderBar() {
  if (!current.noMoreLocal) return h('div', { class: 'older-bar' }, h('span', { class: 'muted small' }, 'Role para cima para ver mais'));
  return h('div', { class: 'older-bar' },
    h('button', {
      class: 'btn btn-sm',
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          const ok = await api('messages:loadOlder', current.jid);
          toast(ok ? 'Pedido enviado ao celular. As mensagens antigas aparecem em instantes.' : 'Não há mensagens mais antigas disponíveis.');
          if (ok) setTimeout(() => reloadOlderAfterSync(current?.jid), 4000);
        } catch (err) { errToast(err); } finally { e.target.disabled = false; }
      },
    }, '⟳ Buscar mensagens mais antigas no celular'));
}

async function reloadOlderAfterSync(jid) {
  if (!current || current.jid !== jid) return;
  current.noMoreLocal = false;
  await loadOlder();
}

async function onScroll() {
  const el = current.msgsEl;
  if (el.scrollTop < 120 && !current.loadingOlder && !current.noMoreLocal) loadOlder();
  if (current.detached) { if (nearBottom() && !current.loadingNewer) loadNewer(); return; }
  if (nearBottom()) current.newBtn.classList.add('hidden');
}

/**
 * Abre a conversa no ponto de uma mensagem (resultado da busca): carrega as
 * mensagens ao redor, rola até ela, destaca e marca a palavra procurada.
 * @returns {Promise<boolean>} false se a mensagem não existe mais
 */
async function jumpTo(id, query = '') {
  const c = current;
  if (!c) return false;
  let el = c.els.get(id);
  if (!el) {
    const r = await api('messages:around', c.jid, id).catch(() => null);
    if (current !== c || !r?.messages.length) return false;
    c.messages = r.messages;
    c.noMoreLocal = false;
    c.detached = r.hasNewer; // há mensagens mais novas que não estão na tela
    renderMessages();
    el = c.els.get(id);
  }
  if (!el) return false;
  markQuery(el, query);
  el.scrollIntoView({ block: 'center' });
  flash(el);
  showLatestBtn();
  return true;
}

/** Destaca a palavra procurada dentro do texto da mensagem. */
function markQuery(el, query) {
  const q = String(query || '').trim();
  const textEl = el.querySelector('.text');
  if (!q || !textEl) return;
  const fold = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const fq = fold(q);
  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const t = node.nodeValue;
    const i = fold(t).indexOf(fq); // remover acentos não muda o tamanho em pt-BR
    if (i < 0) continue;
    const mark = document.createElement('mark');
    mark.className = 'found';
    mark.textContent = t.slice(i, i + q.length);
    node.replaceWith(t.slice(0, i), mark, t.slice(i + q.length));
  }
}

function showLatestBtn() {
  const b = current?.newBtn;
  if (!b) return;
  b.textContent = current.detached ? '↓ Ir para as mensagens mais recentes' : '↓ Novas mensagens';
  b.classList.toggle('hidden', !current.detached);
}

/** Rolando para baixo depois de pular para uma mensagem antiga: traz as seguintes. */
async function loadNewer() {
  const c = current;
  c.loadingNewer = true;
  const last = c.messages[c.messages.length - 1];
  const newer = await api('messages:list', c.jid, { after: (last?.ts || 0) - 1, limit: 60 }).catch(() => []);
  c.loadingNewer = false;
  if (current !== c) return;
  const known = new Set(c.messages.map((m) => m.id));
  const fresh = newer.filter((m) => !known.has(m.id));
  if (newer.length < 60) c.detached = false;
  if (fresh.length) {
    const top = c.msgsEl.scrollTop;
    c.messages = [...c.messages, ...fresh];
    renderMessages();
    c.msgsEl.scrollTop = top;
  }
  showLatestBtn();
}

/** Volta para o fim da conversa (as mensagens mais recentes). */
async function reloadLatest() {
  const c = current;
  const msgs = await api('messages:list', c.jid, { limit: 80 });
  if (current !== c) return;
  c.messages = msgs;
  c.noMoreLocal = msgs.length < 80;
  c.detached = false;
  renderMessages();
  scrollToBottom();
  showLatestBtn();
}

async function loadOlder() {
  const c = current;
  if (!c) return;
  c.loadingOlder = true;
  const before = c.messages[0]?.ts;
  const older = await api('messages:list', c.jid, { before, limit: 60 });
  if (current !== c) return;
  c.loadingOlder = false;
  const known = new Set(c.messages.map((m) => m.id));
  const fresh = older.filter((m) => !known.has(m.id));
  if (older.length < 60) c.noMoreLocal = true;
  if (!fresh.length) { renderMessages(); return; }
  c.messages = [...fresh, ...c.messages];
  const { prevHeight, prevTop } = renderMessages();
  c.msgsEl.scrollTop = c.msgsEl.scrollHeight - prevHeight + prevTop;
}

async function maybeFetchNewer() {
  const c = current;
  if (c.detached) return; // longe do fim (veio da busca): carrega ao rolar
  const newest = c.messages[c.messages.length - 1]?.ts || 0;
  const chat = state.chats.get(c.jid);
  if (!chat || chat.last_ts <= newest || c.fetchingNewer) return;
  c.fetchingNewer = true;
  const newer = await api('messages:list', c.jid, { after: newest - 1, limit: 200 }).catch(() => []);
  c.fetchingNewer = false;
  if (current !== c) return;
  for (const m of newer) upsertMessage(m, true);
}

function nearBottom() {
  const el = current.msgsEl;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 150;
}

function scrollToBottom(smooth) {
  const el = current?.msgsEl;
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  current.newBtn.classList.add('hidden');
  // imagens carregando depois mudam a altura
  if (!smooth) setTimeout(() => { if (current?.msgsEl === el) el.scrollTop = el.scrollHeight; }, 120);
}

function onMessageEvent({ chatJid, id, removed, message }) {
  if (!current || chatJid !== current.jid) return;
  if (removed) {
    current.messages = current.messages.filter((m) => m.id !== id);
    current.els.get(id)?.remove();
    current.els.delete(id);
    return;
  }
  if (!message) return;
  // olhando mensagens antigas (veio da busca): a nova fica para quando descer
  if (current.detached && !current.els.has(message.id)) {
    if (message.from_me) reloadLatest(); // você enviou: volta para o fim para ver
    else showLatestBtn();
    return;
  }
  upsertMessage(message, true);
}

function upsertMessage(m, fromLive) {
  const c = current;
  const idx = c.messages.findIndex((x) => x.id === m.id);
  if (idx >= 0) {
    c.messages[idx] = m;
    const old = c.els.get(m.id);
    if (old) {
      const el = msgEl(m);
      old.replaceWith(el);
      c.els.set(m.id, el);
    }
    return;
  }
  const last = c.messages[c.messages.length - 1];
  if (last && m.ts < last.ts) {
    // mensagem antiga chegando fora de ordem (histórico): redesenha tudo
    c.messages.push(m);
    c.messages.sort((a, b) => a.ts - b.ts);
    const top = c.msgsEl.scrollTop;
    renderMessages();
    c.msgsEl.scrollTop = top;
    return;
  }
  const wasBottom = nearBottom();
  c.messages.push(m);
  if (!last || new Date(last.ts).toDateString() !== new Date(m.ts).toDateString()) {
    c.msgsEl.append(h('div', { class: 'day-sep' }, h('span', null, fmtDay(m.ts))));
  }
  const el = msgEl(m);
  c.els.set(m.id, el);
  c.msgsEl.append(el);
  if (wasBottom || m.from_me) scrollToBottom(true);
  else if (fromLive) c.newBtn.classList.remove('hidden');
}

/** Cartão de pré-visualização do link (imagem, título, resumo e site). */
function linkCard(m) {
  const link = parseJson(m.extra, {}).link;
  if (!link || !(link.title || link.description || m.thumb)) return null;
  const url = link.url && /^https?:/i.test(link.url) ? link.url : firstUrl(m.text);
  return h('a', { class: `link-card ${m.thumb ? '' : 'no-img'}`, href: url || '#', target: '_blank', rel: 'noopener', title: url || '' },
    m.thumb ? h('img', { class: 'link-card-img', src: m.thumb, alt: '' }) : null,
    h('div', { class: 'link-card-body' },
      link.title ? h('div', { class: 'link-card-title' }, link.title) : null,
      link.description ? h('div', { class: 'link-card-desc' }, link.description) : null,
      url ? h('div', { class: 'link-card-site' }, siteOf(url)) : null));
}

function msgEl(m) {
  const chat = state.chats.get(current.jid) || {};
  if (m.type === 'system' || m.type === 'call') {
    return h('div', { class: 'sys-msg', dataset: { id: m.id } },
      h('span', null, m.type === 'call' ? '📞 ' : '', m.sender_name && m.type === 'system' ? `${m.sender_name} ` : '', m.text, ' · ', fmtTime(m.ts)));
  }
  const out = !!m.from_me;
  const body = h('div', { class: 'bubble-body' });

  if (chat.is_group && !out) {
    const who = m.sender_name || (m.sender ? formatPhone(phoneOf(m.sender)) : '');
    body.append(h('div', { class: 'sender', style: { color: colorFor(m.sender || who) } }, who));
  }
  const fw = parseJson(m.extra, {}).forwarded;
  if (fw && !m.deleted) {
    body.append(h('div', { class: 'forwarded' }, fw === 'many' ? '↪↪ Encaminhada com frequência' : '↪ Encaminhada'));
  }
  if (m.quoted_id) {
    const qMsg = current.messages.find((x) => x.id === m.quoted_id);
    const qWho = qMsg ? (qMsg.from_me ? 'Você' : (qMsg.sender_name || chat.display_name)) : '';
    body.append(h('div', {
      class: 'quoted',
      onclick: () => {
        const target = current.els.get(m.quoted_id);
        if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(target); }
      },
    }, qWho ? h('div', { class: 'quoted-who' }, qWho) : null, h('div', { class: 'quoted-text' }, (m.quoted_text || 'Mensagem').slice(0, 200))));
  }

  if (m.deleted) {
    body.append(h('div', { class: 'deleted' }, '🚫 Esta mensagem foi apagada'));
  } else {
    const media = mediaBlock(m);
    if (media) body.append(media);
    const card = m.type === 'text' ? linkCard(m) : null;
    if (card) body.append(card);
    if (m.text && !['contact', 'location', 'poll'].includes(m.type)) {
      body.append(h('div', { class: 'text', html: formatWhatsApp(m.text) }));
    }
  }
  body.append(h('div', { class: 'meta' },
    m.edited ? h('span', { class: 'edited' }, 'Editada') : null,
    h('span', null, fmtTime(m.ts)),
    out ? ticks(m.status) : null));

  const actionsBtn = h('button', { class: 'msg-menu-btn', title: 'Opções', onclick: (e) => msgMenu(e.currentTarget, m) }, '▾');
  const bubble = h('div', { class: `bubble ${out ? 'out' : 'in'} ${m.type === 'sticker' && !m.deleted ? 'sticker' : ''}` }, actionsBtn, body);
  const reactions = parseJson(m.reactions, []);
  const wrap = h('div', { class: `msg ${out ? 'out' : 'in'}`, dataset: { id: m.id }, ondblclick: () => setReply(m) }, bubble);
  if (reactions.length) {
    const counts = {};
    reactions.forEach((r) => { counts[r.text] = (counts[r.text] || 0) + 1; });
    bubble.append(h('div', { class: 'reactions' },
      Object.entries(counts).map(([e, n]) => h('span', null, e, n > 1 ? h('small', null, n) : null))));
  }
  return wrap;
}

function flash(el) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

function parseJson(s, fb) { try { return s ? JSON.parse(s) : fb; } catch { return fb; } }

function downloadBtn(m, label) {
  return h('button', {
    class: 'btn btn-sm dl-btn',
    onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      b.textContent = 'Baixando…';
      try { await api('messages:download', current.jid, m.id); } catch (err) { errToast(err); b.disabled = false; b.textContent = label; }
    },
  }, label);
}

function mediaBlock(m) {
  const url = m.media_file ? mediaUrl(m.media_file) : null;
  switch (m.type) {
    case 'image':
    case 'sticker': {
      if (url) {
        return h('img', {
          class: m.type === 'sticker' ? 'sticker-img' : 'media-img', src: url, loading: 'lazy',
          onclick: () => m.type === 'image' && viewImage(url, m),
        });
      }
      return h('div', { class: 'media-placeholder' },
        m.thumb ? h('img', { class: 'media-img blur', src: m.thumb }) : h('div', { class: 'media-icon' }, m.type === 'sticker' ? '💟' : '📷'),
        downloadBtn(m, `⬇ Baixar foto ${fmtSize(m.media_size)}`));
    }
    case 'video':
      if (url) return h('video', { class: 'media-video', src: url, controls: true, preload: 'metadata' });
      return h('div', { class: 'media-placeholder' },
        m.thumb ? h('img', { class: 'media-img blur', src: m.thumb }) : h('div', { class: 'media-icon' }, '🎥'),
        downloadBtn(m, `⬇ Baixar vídeo ${fmtSize(m.media_size)}`));
    case 'audio':
    case 'ptt':
      if (url) return h('div', { class: 'audio' }, h('span', null, m.type === 'ptt' ? '🎤' : '🎵'), h('audio', { src: url, controls: true, preload: 'metadata' }));
      return h('div', { class: 'audio' }, h('span', null, '🎤'), downloadBtn(m, `▶ Carregar áudio ${m.media_seconds ? fmtSeconds(m.media_seconds) : ''}`));
    case 'document':
      return h('div', { class: 'doc' },
        h('div', { class: 'doc-icon' }, '📄'),
        h('div', { class: 'doc-info' },
          h('div', { class: 'doc-name' }, m.media_name || 'Documento'),
          h('div', { class: 'muted small' }, [fmtSize(m.media_size), (m.media_mime || '').split('/')[1]].filter(Boolean).join(' · '))),
        url
          ? h('div', { class: 'doc-actions' },
            h('button', { class: 'btn btn-sm', onclick: () => api('media:open', m.media_file).catch(errToast) }, 'Abrir'),
            h('button', { class: 'btn btn-sm', onclick: () => api('media:saveAs', m.media_file, m.media_name).catch(errToast) }, 'Salvar como…'))
          : downloadBtn(m, '⬇ Baixar'));
    case 'location': {
      const loc = parseJson(m.extra, {});
      const href = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
      return h('a', { class: 'location', href, target: '_blank' },
        m.thumb ? h('img', { src: m.thumb }) : h('div', { class: 'media-icon' }, '📍'),
        h('div', null, h('b', null, '📍 Localização'), m.text ? h('div', null, m.text) : null, h('div', { class: 'small' }, 'Abrir no mapa')));
    }
    case 'contact': {
      const data = parseJson(m.extra, { contacts: [] });
      return h('div', { class: 'contact-card' }, data.contacts.map((c) => {
        const tel = /TEL[^:]*:([+\d\s()-]+)/.exec(c.vcard || '')?.[1]?.trim();
        return h('div', { class: 'contact-item' }, h('span', { class: 'media-icon small' }, '👤'),
          h('div', null, h('b', null, c.name || 'Contato'), tel ? h('div', { class: 'small' }, tel) : null),
          tel ? h('button', {
            class: 'btn btn-sm',
            onclick: async () => {
              try {
                const chat = await api('chats:start', tel.replace(/\D/g, ''), c.name);
                state.chats.set(chat.jid, chat);
                openChat(chat.jid);
              } catch (e) { errToast(e); }
            },
          }, 'Conversar') : null);
      }));
    }
    case 'poll': {
      const data = parseJson(m.extra, { options: [] });
      return h('div', { class: 'poll' }, h('b', null, '📊 ', m.text), h('ul', null, data.options.map((o) => h('li', null, o))));
    }
    default:
      return null;
  }
}

function viewImage(url, m) {
  const list = (current?.messages || []).filter((x) => x.type === 'image' && x.media_file && !x.deleted);
  let items = list.map((x) => ({ url: mediaUrl(x.media_file), m: x }));
  let index = items.findIndex((it) => it.m.id === m.id);
  if (index < 0) { items = [{ url, m }]; index = 0; }
  openImageViewer(items, index, {
    actions: (x) => [
      { label: '📎', title: 'Anexar ao caso', onClick: (e) => attachToCase(e.currentTarget, x) },
      { label: '💾', title: 'Salvar como…', onClick: () => api('media:saveAs', x.media_file, x.media_name || `imagem-${x.id}.jpg`) },
      { label: '📂', title: 'Mostrar na pasta', onClick: () => api('media:showInFolder', x.media_file) },
      { label: '🖼', title: 'Abrir no visualizador do Windows', onClick: () => api('media:open', x.media_file) },
    ],
  });
}

/** Escolher para quem encaminhar (até 5 conversas, como no WhatsApp). */
function forwardDialog(m) {
  const fromJid = current.jid;
  const chosen = new Set();
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Pesquisar contato ou grupo…' });
  const list = h('div', { class: 'picker-list' });
  const preview = (m.text || ({ image: '📷 Foto', video: '🎥 Vídeo', audio: '🎵 Áudio', ptt: '🎤 Áudio', document: `📄 ${m.media_name || 'Documento'}`, sticker: '💟 Figurinha' }[m.type] || '')).slice(0, 140);
  let sendBtn = null;
  const fold = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const draw = () => {
    const q = fold(input.value);
    const items = [...state.chats.values()]
      .filter((c) => !q || fold(`${c.display_name} ${c.jid}`).includes(q))
      .sort((a, b) => (chosen.has(b.jid) - chosen.has(a.jid)) || (b.last_ts - a.last_ts))
      .slice(0, 60);
    fill(list, ...items.map((c) => h('div', {
      class: `picker-item ${chosen.has(c.jid) ? 'active' : ''}`,
      onclick: () => {
        if (chosen.has(c.jid)) chosen.delete(c.jid);
        else if (chosen.size >= 5) { toast('Dá para encaminhar para até 5 conversas de uma vez.'); return; }
        else chosen.add(c.jid);
        draw();
      },
    }, h('span', { class: 'pick-check' }, chosen.has(c.jid) ? '☑' : '☐'), avatarEl(c, 28), h('div', null, c.display_name))));
    if (sendBtn) {
      sendBtn.disabled = !chosen.size;
      sendBtn.textContent = chosen.size ? `Encaminhar (${chosen.size})` : 'Encaminhar';
    }
  };
  input.addEventListener('input', draw);
  const dlg = modal({
    title: 'Encaminhar mensagem',
    body: h('div', { class: 'form' }, h('div', { class: 'quoted forward-preview' }, preview || 'Mensagem'), input, list),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Encaminhar', primary: true,
        onClick: async () => {
          if (!chosen.size) return false;
          const n = chosen.size;
          await api('messages:forward', fromJid, m.id, [...chosen]);
          toast(n === 1 ? 'Mensagem encaminhada' : `Mensagem encaminhada para ${n} conversas`, 'success');
          return true;
        },
      },
    ],
  });
  sendBtn = [...dlg.box.querySelectorAll('.modal-actions .btn')].pop();
  draw();
}

function msgMenu(anchor, m) {
  const items = [
    { icon: '↩', label: 'Responder', onClick: () => setReply(m) },
    ...(!m.deleted ? [{ icon: '↪', label: 'Encaminhar…', onClick: () => forwardDialog(m) }] : []),
    ...(!m.deleted ? [{ icon: '😊', label: 'Reagir…', onClick: () => reactMenu(anchor, m) }] : []),
    ...(m.text ? [{ icon: '📋', label: 'Copiar texto', onClick: () => navigator.clipboard.writeText(m.text) }] : []),
    ...(m.text ? [{ icon: '📝', label: 'Salvar como nota do contato', onClick: () => saveAsNote(m) }] : []),
    ...(m.text ? [{ icon: '⏰', label: 'Criar tarefa a partir desta mensagem', onClick: () => import('./crmpanel.js').then((x) => x.taskDialog({ jid: current.jid, title: m.text.slice(0, 120) })) }] : []),
    ...(['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(m.type) && !m.deleted
      ? [{ icon: '📎', label: 'Anexar ao caso…', onClick: () => attachToCase(anchor, m) }] : []),
    ...(m.media_file ? [
      { icon: '💾', label: 'Salvar arquivo como…', onClick: () => api('media:saveAs', m.media_file, m.media_name) },
      { icon: '📂', label: 'Mostrar na pasta', onClick: () => api('media:showInFolder', m.media_file) },
    ] : []),
    ...(canEdit(m) ? [{ icon: '✏️', label: 'Editar', onClick: () => startEdit(m) }] : []),
    '-', { icon: '🗑', label: 'Apagar…', danger: true, onClick: () => deleteMsg(m) },
  ];
  popupMenu(anchor, items);
}

async function saveAsNote(m) {
  try {
    await api('notes:add', current.jid, m.text);
    toast('Nota salva na ficha do contato', 'success');
    emit('notes', current.jid);
  } catch (e) { errToast(e); }
}

function reactMenu(anchor, m) {
  const mine = parseJson(m.reactions, []).find((r) => r.from === 'me')?.text;
  popupMenu(anchor, [
    ...QUICK_REACTIONS.map((e) => ({ label: e, active: mine === e, onClick: () => api('messages:react', current.jid, m.id, e).catch(errToast) })),
    ...(mine ? ['-', { label: 'Remover reação', onClick: () => api('messages:react', current.jid, m.id, '').catch(errToast) }] : []),
  ]);
}

/** Como no WhatsApp: "Apagar para mim" (qualquer mensagem) ou "para todos" (só as suas). */
function deleteMsg(m) {
  const jid = current.jid;
  const forAll = !!m.from_me && !m.deleted;
  modal({
    title: 'Apagar mensagem?',
    body: h('div', { class: 'form' },
      h('div', { class: 'quoted forward-preview' }, (m.text || m.media_name || 'Mensagem').slice(0, 140)),
      h('p', { class: 'muted small' }, forAll
        ? '“Apagar para mim” tira só da sua conversa (aqui e no seu celular). “Apagar para todos” tira também do contato.'
        : 'A mensagem some da sua conversa (aqui e no seu celular). O contato continua vendo.')),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Apagar para mim', danger: !forAll,
        onClick: async () => {
          const r = await api('messages:deleteForMe', jid, m.id);
          if (r && !r.synced) toast('Apagada neste computador. Sem conexão agora: no celular ela continua.', 'info', 6000);
          return true;
        },
      },
      ...(forAll ? [{ label: 'Apagar para todos', danger: true, onClick: async () => { await api('messages:delete', jid, m.id); return true; } }] : []),
    ],
  });
}

// ---------------------------------------------------------------- envio

function setReply(m) {
  replyTo = m;
  editing = null;
  renderComposer();
  current.composerEl.querySelector('textarea')?.focus();
}

function cancelEdit() {
  if (!editing) return;
  editing = null;
  renderComposer(); // volta o rascunho que havia antes de editar
}

function startEdit(m) {
  editing = m;
  replyTo = null;
  renderComposer();
  const ta = current.composerEl.querySelector('textarea');
  if (ta) { ta.value = m.text; ta.dispatchEvent(new Event('input')); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

export function canEdit(m) {
  return !!m && m.from_me && !m.deleted && m.type === 'text' && Date.now() - m.ts < EDIT_WINDOW_MS;
}

function renderComposerState() {
  const banner = current.composerEl.querySelector('.offline-banner');
  const connected = state.status.state === 'open';
  if (banner) banner.classList.toggle('hidden', connected);
}

function renderComposer() {
  const c = current;
  const chat = state.chats.get(c.jid);
  const saveDraft = () => { if (!editing) setDraft(c.jid, ta.value); };
  // prévia do cartão do link enquanto escreve (✕ tira: o link vai sem cartão)
  const linkBar = h('div', { class: 'link-compose hidden' });
  let linkUrl = null; // link do cartão mostrado
  let linkOff = null; // link cujo cartão você tirou
  let linkTimer = null;
  const updateLink = () => {
    clearTimeout(linkTimer);
    linkTimer = setTimeout(async () => {
      const url = editing ? null : firstUrl(ta.value);
      if (url === linkUrl) return;
      linkUrl = null;
      linkBar.classList.add('hidden');
      if (!url || url === linkOff) return;
      const p = await api('links:preview', url).catch(() => null);
      if (!p || firstUrl(ta.value) !== url) return;
      linkUrl = url;
      fill(linkBar,
        p.image ? h('img', { class: 'link-card-img', src: p.image, alt: '' }) : null,
        h('div', { class: 'link-card-body' },
          h('div', { class: 'link-card-title' }, p.title || p.site),
          p.description ? h('div', { class: 'link-card-desc' }, p.description) : null,
          h('div', { class: 'link-card-site' }, p.site)),
        h('button', { class: 'icon-btn', title: 'Enviar sem a pré-visualização', onclick: () => { linkOff = url; linkUrl = null; linkBar.classList.add('hidden'); ta.focus(); } }, '✕'));
      linkBar.classList.remove('hidden');
    }, 600);
  };
  const ta = h('textarea', {
    class: 'composer-input', rows: 1, placeholder: 'Digite uma mensagem  ( / para respostas rápidas )',
    value: editing ? '' : getDraft(c.jid),
  });
  const suggest = h('div', { class: 'quick-suggest hidden' });
  // sugestões de palavras (como no teclado do celular): Tab ou clique completa
  const wordBar = h('div', { class: 'word-suggest hidden' });
  let words = [];
  if (state.settings.wordSuggest !== false) loadVocab();
  const updateWords = () => {
    words = [];
    if (state.settings.wordSuggest !== false && ta.selectionStart === ta.selectionEnd && !ta.value.startsWith('/')) {
      const after = ta.value.slice(ta.selectionEnd);
      // só no fim de uma palavra (não no meio dela)
      if (!/^[\p{L}]/u.test(after)) words = suggestWords(vocab || [], ta.value.slice(0, ta.selectionStart));
    }
    fill(wordBar, ...words.map((w, i) => h('button', {
      class: `word-chip ${i === 0 ? 'first' : ''}`, title: i === 0 ? 'Tab para completar' : 'Clique para completar',
      onmousedown: (e) => { e.preventDefault(); acceptWord(w); },
    }, w)), words.length ? h('span', { class: 'word-hint' }, 'Tab') : null);
    wordBar.classList.toggle('hidden', !words.length);
  };
  const acceptWord = (w) => {
    const r = applyWord(ta.value.slice(0, ta.selectionStart), ta.value.slice(ta.selectionEnd), w);
    ta.value = r.value;
    ta.setSelectionRange(r.cursor, r.cursor);
    saveDraft();
    autosize();
    updateWords();
    ta.focus();
  };
  let suggestIdx = 0;
  let typingTimer = null;
  let lastTyping = 0;

  const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`; };

  // correção automática (pt-BR) ao terminar cada palavra; Backspace logo depois desfaz
  let lastFix = null;
  const autocorrectOn = () => state.settings.autocorrect !== false;
  const runAutocorrect = (e) => {
    lastFix = null;
    if (!autocorrectOn() || e?.inputType !== 'insertText' || !/^[\s.,!?;:)]$/.test(e.data || '')) return;
    if (ta.selectionStart !== ta.selectionEnd) return;
    const pos = ta.selectionStart;
    const r = autocorrectBefore(ta.value.slice(0, pos));
    if (!r || keepAsTyped.has(r.from.toLowerCase())) return;
    ta.value = r.before + ta.value.slice(pos);
    ta.setSelectionRange(r.before.length, r.before.length);
    lastFix = { ...r, pos: r.before.length, value: ta.value };
    showFix(r);
  };
  const showFix = (r) => {
    fill(wordBar, h('span', { class: 'word-fixed', title: 'Correção automática. Backspace desfaz.' }, `✓ ${r.from} → ${r.to}`),
      h('span', { class: 'word-hint' }, 'Backspace desfaz'));
    wordBar.classList.remove('hidden');
  };
  const undoFix = () => {
    const f = lastFix;
    lastFix = null;
    const head = f.before.slice(0, f.before.length - f.to.length - f.sep.length) + f.from + f.sep;
    ta.value = head + ta.value.slice(f.pos);
    ta.setSelectionRange(head.length, head.length);
    keepAsTyped.add(f.from.toLowerCase());
    saveDraft();
    wordBar.classList.add('hidden');
  };
  // a última palavra (sem espaço depois) também é corrigida ao enviar
  const fixLastWord = (text) => {
    if (!autocorrectOn()) return text;
    const m = /([\p{L}]+)([.!?)]*)$/u.exec(text);
    if (!m || keepAsTyped.has(m[1].toLowerCase()) || /[-\p{L}@/]$/u.test(text.slice(0, m.index))) return text;
    const to = correctWord(m[1]);
    return to ? text.slice(0, m.index) + to + m[2] : text;
  };

  const send = async () => {
    const text = fixLastWord(ta.value.trim());
    if (!text) return;
    if (editing) {
      const m = editing;
      if (text === m.text) { cancelEdit(); return; }
      try {
        await api('messages:edit', c.jid, m.id, text);
        cancelEdit();
      } catch (e) { errToast(e); }
      return;
    }
    const quoted = replyTo?.id;
    const sentUrl = firstUrl(text);
    const linkOpts = !sentUrl ? {} : sentUrl === linkOff ? { previewUrl: false } : { previewUrl: sentUrl };
    linkUrl = null; linkOff = null;
    linkBar.classList.add('hidden');
    if (vocab) learnWords(vocab, text);
    ta.value = '';
    updateWords();
    clearDraft(c.jid);
    autosize();
    replyTo = null;
    c.composerEl.querySelector('.reply-bar')?.remove();
    try {
      await api('messages:sendText', c.jid, text, quoted, linkOpts);
    } catch (e) {
      errToast(e);
      ta.value = text;
      saveDraft(); // não enviou: volta a ser rascunho
      autosize();
    }
  };

  const updateSuggest = () => {
    const v = ta.value;
    if (!v.startsWith('/') || v.includes('\n')) { suggest.classList.add('hidden'); return; }
    const q = v.slice(1).toLowerCase();
    const list = state.quickReplies.filter((r) => r.shortcut.toLowerCase().includes(q) || r.text.toLowerCase().includes(q));
    if (!list.length) { suggest.classList.add('hidden'); return; }
    suggestIdx = Math.min(suggestIdx, list.length - 1);
    fill(suggest, ...list.slice(0, 8).map((r, i) => h('div', {
      class: `quick-item ${i === suggestIdx ? 'active' : ''}`,
      onmousedown: (e) => { e.preventDefault(); applyQuick(r); },
    }, h('b', null, `/${r.shortcut}`), h('span', null, r.text))));
    suggest._list = list.slice(0, 8);
    suggest.classList.remove('hidden');
  };

  const applyQuick = (r) => {
    const name = chat?.display_name?.split(' ')[0] || '';
    ta.value = r.text.replace(/\{nome\}/gi, name);
    suggest.classList.add('hidden');
    autosize();
    ta.focus();
  };

  ta.addEventListener('input', (e) => {
    runAutocorrect(e);
    autosize();
    saveDraft();
    updateSuggest();
    if (!lastFix) updateWords(); // se acabou de corrigir, a faixa mostra a correção
    updateLink();
    if (Date.now() - lastTyping > 4000) { lastTyping = Date.now(); api('chats:presence', c.jid, 'composing').catch(() => {}); }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => api('chats:presence', c.jid, 'paused').catch(() => {}), 3000);
  });
  ta.addEventListener('keydown', (e) => {
    if (!suggest.classList.contains('hidden')) {
      const list = suggest._list || [];
      if (e.key === 'ArrowDown') { e.preventDefault(); suggestIdx = (suggestIdx + 1) % list.length; updateSuggest(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); suggestIdx = (suggestIdx - 1 + list.length) % list.length; updateSuggest(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyQuick(list[suggestIdx]); return; }
      if (e.key === 'Escape') { suggest.classList.add('hidden'); return; }
    }
    if (e.key === 'Backspace' && lastFix && ta.value === lastFix.value && ta.selectionStart === lastFix.pos && ta.selectionEnd === lastFix.pos) {
      e.preventDefault();
      undoFix();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && words.length) { e.preventDefault(); acceptWord(words[0]); return; }
    if (e.key === 'Escape' && words.length) { words = []; wordBar.classList.add('hidden'); if (!replyTo && !editing) return; }
    const enterSends = state.settings.enterToSend !== false;
    if (e.key === 'Enter' && !e.isComposing && ((enterSends && !e.shiftKey) || (!enterSends && e.ctrlKey))) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape' && replyTo) { replyTo = null; c.composerEl.querySelector('.reply-bar')?.remove(); }
    if (e.key === 'Escape' && editing) cancelEdit();
  });
  // cursor mudou de lugar (setas/clique): recalcula a sugestão
  ta.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') updateWords(); });
  ta.addEventListener('click', updateWords);
  ta.addEventListener('blur', () => wordBar.classList.add('hidden'));
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    confirmSendFiles(files);
  });

  const emojiBtn = h('button', {
    class: 'icon-btn', title: 'Emojis',
    onclick: (e) => {
      const pop = popupMenu(e.currentTarget, []);
      pop.classList.add('emoji-pop');
      pop.append(...EMOJIS.map((em) => h('button', {
        class: 'emoji',
        onclick: () => { insertAtCursor(ta, em); ta.focus(); },
      }, em)));
    },
  }, '😊');
  const attachBtn = h('button', {
    class: 'icon-btn', title: 'Enviar arquivo, foto ou documento',
    onclick: async () => {
      const paths = await api('messages:pickFiles');
      if (paths.length) confirmSendFiles(paths);
    },
  }, '📎');
  const quickBtn = h('button', {
    class: 'icon-btn', title: 'Respostas rápidas',
    onclick: (e) => {
      if (!state.quickReplies.length) { toast('Cadastre respostas rápidas em Configurações.'); return; }
      popupMenu(e.currentTarget, state.quickReplies.map((r) => ({ label: `/${r.shortcut} — ${r.text.slice(0, 50)}`, onClick: () => applyQuick(r) })));
    },
  }, '⚡');
  const micBtn = h('button', { class: 'icon-btn mic', title: 'Gravar áudio', onclick: () => startRecording(micBtn) }, '🎤');
  const sendBtn = h('button', { class: 'send-btn', title: 'Enviar (Enter)', onclick: send }, '➤');

  const bar = h('div', { class: 'composer-bar' }, emojiBtn, attachBtn, quickBtn, h('div', { class: 'composer-input-wrap' }, suggest, wordBar, ta), micBtn, sendBtn);
  const replyBar = replyTo ? h('div', { class: 'reply-bar' },
    h('div', { class: 'quoted' },
      h('div', { class: 'quoted-who' }, replyTo.from_me ? 'Você' : (replyTo.sender_name || chat?.display_name)),
      h('div', { class: 'quoted-text' }, (replyTo.text || replyTo.type).slice(0, 160))),
    h('button', { class: 'icon-btn', onclick: () => { replyTo = null; renderComposer(); } }, '✕')) : null;
  const editBar = editing ? h('div', { class: 'reply-bar edit-bar' },
    h('div', { class: 'quoted' },
      h('div', { class: 'quoted-who' }, '✏️ Editando mensagem'),
      h('div', { class: 'quoted-text' }, editing.text.slice(0, 160))),
    h('button', { class: 'icon-btn', title: 'Cancelar edição (Esc)', onclick: cancelEdit }, '✕')) : null;
  if (editing) { sendBtn.textContent = '✓'; sendBtn.title = 'Salvar edição (Enter)'; }
  const offline = h('div', { class: `offline-banner ${state.status.state === 'open' ? 'hidden' : ''}` },
    '⚠ WhatsApp desconectado no momento — as mensagens salvas continuam disponíveis, mas não é possível enviar até reconectar.');

  fill(c.composerEl, offline, replyBar, editBar, linkBar, bar);
  if (ta.value) updateLink();
  setTimeout(() => { autosize(); ta.focus(); }, 0);
}

function insertAtCursor(ta, text) {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.dispatchEvent(new Event('input'));
}

function setupDrop(pane) {
  let depth = 0;
  pane.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    depth++;
    pane.classList.add('dropping');
  });
  pane.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) pane.classList.remove('dropping'); });
  pane.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  pane.addEventListener('drop', (e) => {
    depth = 0;
    pane.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    confirmSendFiles(files);
  });
}

/** files: lista de caminhos (string) ou objetos File (colados/arrastados) */
function confirmSendFiles(files) {
  const jid = current.jid;
  const items = files.map((f) => {
    if (typeof f === 'string') return { path: f, name: f.split(/[\\/]/).pop() };
    const p = window.api.pathForFile(f);
    return p ? { path: p, name: f.name } : { file: f, name: f.name || `imagem-${Date.now()}.png` };
  });
  const caption = h('textarea', { class: 'input', rows: 2, placeholder: 'Legenda (opcional)' });
  const previews = h('div', { class: 'send-previews' }, items.map((it) => {
    const isImg = /\.(png|jpe?g|webp|gif)$/i.test(it.name) || it.file?.type?.startsWith('image/');
    const src = it.file ? URL.createObjectURL(it.file) : null;
    return h('div', { class: 'send-preview' },
      isImg && src ? h('img', { src }) : h('div', { class: 'media-icon' }, isImg ? '🖼' : '📄'),
      h('div', { class: 'small ellipsis' }, it.name));
  }));
  modal({
    title: `Enviar ${items.length} arquivo(s)`,
    body: h('div', { class: 'form' }, previews, caption),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Enviar',
        primary: true,
        onClick: async () => {
          const quoted = replyTo?.id;
          replyTo = null;
          toast('Enviando…');
          try {
            const paths = items.filter((i) => i.path).map((i) => i.path);
            if (paths.length) await api('messages:sendFiles', jid, paths, caption.value.trim() || undefined, quoted);
            for (const it of items.filter((i) => i.file)) {
              const bytes = new Uint8Array(await it.file.arrayBuffer());
              await api('messages:sendBuffer', jid, it.name, bytes, paths.length ? undefined : caption.value.trim() || undefined);
            }
          } catch (e) { errToast(e); }
        },
      },
    ],
  });
}

// --------------------------------------------------------- gravação de áudio

async function startRecording(btn) {
  if (recorder) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Não foi possível acessar o microfone.', 'error');
    return;
  }
  const chunks = [];
  const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const started = Date.now();
  const jid = current.jid;
  const timer = h('span', { class: 'rec-timer' }, '0:00');
  const bar = h('div', { class: 'recording-bar' },
    h('span', { class: 'rec-dot' }), 'Gravando…', timer,
    h('button', { class: 'btn btn-sm', onclick: () => stopRecording(true) }, '✕ Cancelar'),
    h('button', { class: 'btn btn-sm btn-primary', onclick: () => stopRecording(false) }, '➤ Enviar áudio'));
  recorder = { mr, stream, bar, cancel: false, jid, tick: setInterval(() => { timer.textContent = fmtSeconds((Date.now() - started) / 1000); }, 250) };
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mr.onstop = async () => {
    const rec = recorder;
    recorder = null;
    clearInterval(rec.tick);
    rec.stream.getTracks().forEach((t) => t.stop());
    rec.bar.remove();
    if (rec.cancel || !chunks.length) return;
    try {
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      await api('messages:sendVoice', rec.jid, bytes);
    } catch (e) { errToast(e); }
  };
  mr.start(250);
  current.composerEl.prepend(bar);
  btn?.blur();
}

function stopRecording(cancel) {
  if (!recorder) return;
  recorder.cancel = cancel;
  try { recorder.mr.stop(); } catch { /* ignore */ }
}
