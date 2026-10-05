// Sugestão de palavras ao digitar (como o teclado do celular): completa a palavra
// em andamento com as palavras que você mais usa nas suas mensagens.
// Sem DOM aqui, para poder testar no Node.

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Palavra sendo digitada no fim do texto (antes do cursor), ou null. */
export function currentWord(before) {
  const m = /([\p{L}][\p{L}'-]*)$/u.exec(before || '');
  return m ? m[1] : null;
}

/**
 * @param {string[]} vocab  palavras, mais usadas primeiro
 * @param {string} before   texto antes do cursor
 * @returns {string[]} até `limit` palavras completas
 */
export function suggestWords(vocab, before, limit = 3) {
  const word = currentWord(before);
  if (!word || word.length < 2 || !vocab?.length) return [];
  const p = fold(word);
  const out = [];
  const seen = new Set();
  for (const w of vocab) {
    const f = fold(w);
    if (f.length <= p.length || !f.startsWith(p) || seen.has(f)) continue;
    seen.add(f);
    out.push(matchCase(word, w));
    if (out.length >= limit) break;
  }
  return out;
}

// "Proc" → "Procuração"; "PROC" → "PROCURAÇÃO"; "proc" → "procuração" (ou a forma salva, ex.: nome próprio)
function matchCase(typed, w) {
  if (typed.length > 1 && typed === typed.toUpperCase()) return w.toUpperCase();
  if (typed[0] !== typed[0].toLowerCase()) return w[0].toUpperCase() + w.slice(1);
  return w;
}

/** Aplica a sugestão: troca a palavra em andamento pela completa + espaço. */
export function applyWord(before, after, word) {
  const cur = currentWord(before) || '';
  const head = before.slice(0, before.length - cur.length) + word;
  const tail = /^\s/.test(after) ? after : ` ${after}`;
  return { value: head + tail, cursor: head.length + 1 };
}

/** Acrescenta as palavras de uma mensagem enviada (aprende na hora). */
export function learnWords(vocab, text) {
  const known = new Set(vocab.map(fold));
  for (const m of String(text || '').matchAll(/[\p{L}][\p{L}'-]{3,}/gu)) {
    const w = m[0].replace(/[-']+$/, '');
    if (w.length >= 4 && !known.has(fold(w))) { vocab.push(w.toLowerCase()); known.add(fold(w)); }
  }
  return vocab;
}
