// Texto do balão da lista de conversas: até ~300 letras (cerca de 6 linhas),
// cortado no fim de uma palavra. Sem DOM aqui, para testar no Node.
export const TIP_MAX = 300;

export function tipText(text, max = TIP_MAX) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  let cut = t.slice(0, max);
  const sp = cut.search(/\s+\S*$/);
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return `${cut.replace(/[\s.,;:!?-]+$/, '')}… (abra a conversa para ler tudo)`;
}
