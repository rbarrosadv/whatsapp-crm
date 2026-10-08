// Links nas mensagens (usado na interface e no processo principal). Sem DOM.

/** Primeiro link do texto (http/https ou www.), sem a pontuação do fim. */
export function firstUrl(text) {
  const m = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+\.[^\s<>"']+)/i.exec(text || '');
  if (!m) return null;
  let url = m[1].replace(/[.,;:!?)\]}'"»]+$/, '');
  if (/^www\./i.test(url)) url = `https://${url}`;
  try { return new URL(url).href; } catch { return null; }
}

/** "https://www.g1.globo.com/x" → "g1.globo.com" */
export function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
