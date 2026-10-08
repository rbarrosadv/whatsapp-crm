// Rascunhos das mensagens: guardados por conversa no computador (continuam lá
// depois de trocar de conversa, de tela ou de fechar o programa).
import { emit } from './store.js';

const KEY = (jid) => `draft:${jid}`;

export function getDraft(jid) {
  try { return localStorage.getItem(KEY(jid)) || ''; } catch { return ''; }
}

export function setDraft(jid, text) {
  const had = !!getDraft(jid);
  const has = !!(text && text.trim());
  try {
    if (has) localStorage.setItem(KEY(jid), text);
    else localStorage.removeItem(KEY(jid));
  } catch { /* sem armazenamento: segue sem rascunho */ }
  // a lista só precisa redesenhar quando a conversa passa a ter/não ter rascunho
  if (had !== has) emit('drafts', jid);
}

export function clearDraft(jid) { setDraft(jid, ''); }
