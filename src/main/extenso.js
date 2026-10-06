// Valor por extenso em reais, para o recibo: 1.234,56 → "mil duzentos e
// trinta e quatro reais e cinquenta e seis centavos".

const UN = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze',
  'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZ = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CEM = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

/** 0–999 por extenso. */
function ate999(n) {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100);
  const r = n % 100;
  const parts = [];
  if (c) parts.push(CEM[c]);
  if (r) parts.push(r < 20 ? UN[r] : [DEZ[Math.floor(r / 10)], UN[r % 10]].filter(Boolean).join(' e '));
  return parts.join(' e ');
}

/** Inteiro por extenso (até centenas de bilhões). */
export function inteiro(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zero';
  const grupos = [];
  while (n > 0) { grupos.push(n % 1000); n = Math.floor(n / 1000); }
  const nomes = [['', ''], ['mil', 'mil'], ['milhão', 'milhões'], ['bilhão', 'bilhões']];
  const partes = [];
  for (let i = grupos.length - 1; i >= 0; i--) {
    const g = grupos[i];
    if (!g) continue;
    const txt = i === 1 && g === 1 ? 'mil' : `${ate999(g)}${nomes[i][0] ? ` ${g === 1 ? nomes[i][0] : nomes[i][1]}` : ''}`;
    partes.push({ txt, g, i });
  }
  // "e" antes do último grupo quando ele é < 100 ou centena redonda
  // (mil e cem, dois mil e cinco, dois milhões e quinhentos mil)
  return partes.map((p, k) => {
    if (k === 0) return p.txt;
    const last = k === partes.length - 1;
    const useE = last && (p.g < 100 || p.g % 100 === 0);
    return `${useE ? ' e ' : ' '}${p.txt}`;
  }).join('');
}

/** Valor em reais por extenso. */
export function reais(valor) {
  const cents = Math.round(Math.abs(Number(valor) || 0) * 100);
  const r = Math.floor(cents / 100);
  const c = cents % 100;
  const parts = [];
  if (r) {
    const big = r >= 1e6 && r % 1e6 === 0; // "um milhão de reais"
    parts.push(`${inteiro(r)}${big ? ' de' : ''} ${r === 1 ? 'real' : 'reais'}`);
  }
  if (c) parts.push(`${inteiro(c)} ${c === 1 ? 'centavo' : 'centavos'}`);
  return parts.length ? parts.join(' e ') : 'zero real';
}
