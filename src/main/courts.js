// Tribunais: intimações do DJEN (Diário de Justiça Eletrônico Nacional, pela
// OAB de cada advogado) e andamentos do DataJud (base pública do CNJ, pelo nº
// do processo). As duas são APIs públicas do CNJ; nada aqui depende de login
// no PJe. Também: número CNJ → tribunal, e contagem de prazo em dias úteis.

export const DJEN_URL = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
export const DATAJUD_URL = 'https://api-publica.datajud.cnj.jus.br';
// chave pública divulgada pelo CNJ na wiki do DataJud (pode mudar: Ajustes → Intimações)
export const DATAJUD_PUBLIC_KEY = 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';

// ------------------------------------------------------------ número CNJ

export const cnjDigits = (n) => String(n || '').replace(/\D/g, '');

/** NNNNNNN-DD.AAAA.J.TR.OOOO (20 dígitos), ou o texto como veio. */
export function formatCnj(n) {
  const d = cnjDigits(n);
  if (d.length !== 20) return String(n || '').trim();
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16)}`;
}

const UF_BY_TR = ['', 'ac', 'al', 'ap', 'am', 'ba', 'ce', 'dft', 'es', 'go', 'ma', 'mt', 'ms', 'mg', 'pa', 'pb', 'pr', 'pe', 'pi', 'rj', 'rn', 'rs', 'ro', 'rr', 'sc', 'se', 'sp', 'to'];

/** Tribunal do processo pelo número CNJ (segmento J + tribunal TR). */
export function tribunalOf(n) {
  const d = cnjDigits(n);
  if (d.length !== 20) return null;
  const j = d[13];
  const tr = Number(d.slice(14, 16));
  if (j === '8') return UF_BY_TR[tr] ? (tr === 7 ? 'TJDFT' : `TJ${UF_BY_TR[tr].toUpperCase()}`) : null;
  if (j === '5') return tr === 0 ? 'TST' : `TRT${tr}`;
  if (j === '4') return tr >= 1 && tr <= 6 ? `TRF${tr}` : null;
  if (j === '6') return UF_BY_TR[tr] ? `TRE-${tr === 7 ? 'DF' : UF_BY_TR[tr].toUpperCase()}` : null;
  if (j === '3') return 'STJ';
  if (j === '9') return UF_BY_TR[tr] ? `TJM${UF_BY_TR[tr].toUpperCase()}` : null;
  if (j === '7') return 'STM';
  return null;
}

/** Nome do índice do DataJud para o tribunal (ex.: api_publica_tjmt). */
export function datajudIndex(n) {
  const t = tribunalOf(n);
  if (!t) return null;
  return `api_publica_${t.toLowerCase()}`;
}

/** "MARIA DA SILVA" → "Maria da Silva" (nomes do DJEN chegam em maiúsculas). */
export function nameCase(s) {
  const small = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
  const str = String(s || '').trim();
  if (str !== str.toUpperCase()) return str; // já veio com minúsculas: respeita
  return str.toLowerCase().split(/\s+/).map((w, i) => (i > 0 && small.has(w) ? w : w.replace(/^\p{L}/u, (c) => c.toUpperCase()))).join(' ');
}

// ------------------------------------------------------------ dias úteis

function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const holidayCache = new Map();

/** Feriados nacionais + Carnaval, Sexta-feira Santa e Corpus Christi (sem os locais). */
export function holidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const set = new Set(['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map((md) => `${y}-${md}`));
  const e = easter(y);
  for (const off of [-48, -47, -2, 60]) { const d = new Date(e); d.setDate(d.getDate() + off); set.add(ymd(d)); }
  holidayCache.set(y, set);
  return set;
}

/** Recesso forense (CPC art. 220): prazos suspensos de 20/12 a 20/01. */
const inRecess = (d) => (d.getMonth() === 11 && d.getDate() >= 20) || (d.getMonth() === 0 && d.getDate() <= 20);

export function isCourtDay(d, { recess = true } = {}) {
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  if (holidays(d.getFullYear()).has(ymd(d))) return false;
  return !(recess && inRecess(d));
}

/** Próximo dia útil depois de `d` (não conta o próprio dia). */
export function nextCourtDay(d, opts) {
  const x = new Date(d);
  do x.setDate(x.getDate() + 1); while (!isCourtDay(x, opts));
  return x;
}

/** `n` dias úteis antes de `ts` (prazo interno). */
export function courtDaysBefore(ts, n) {
  const d = new Date(ts);
  for (let k = 0; k < n;) { d.setDate(d.getDate() - 1); if (isCourtDay(d)) k++; }
  return d;
}

/** Quantos dias úteis faltam até `ts` (0 = hoje; -1 = já passou o dia). */
export function courtDaysUntil(ts, from = Date.now()) {
  const a = new Date(from); a.setHours(0, 0, 0, 0);
  const b = new Date(ts); b.setHours(0, 0, 0, 0);
  if (b < a) return -1;
  let n = 0;
  for (const d = new Date(a); d < b;) { d.setDate(d.getDate() + 1); if (isCourtDay(d)) n++; }
  return n;
}

/**
 * Prazo de uma intimação do DJEN: considera-se publicada no 1º dia útil após a
 * disponibilização, e o prazo começa no 1º dia útil seguinte à publicação
 * (Lei 11.419/2006, art. 4º; CPC art. 224). Conta `days` dias úteis; vence às 23h59.
 * Feriados locais e suspensões do tribunal não entram: o sistema avisa para conferir.
 */
export function deadlineFromAvailability(availableTs, days) {
  const pub = nextCourtDay(new Date(availableTs));
  let d = pub;
  for (let n = 0; n < days; n++) d = nextCourtDay(d);
  d.setHours(23, 59, 0, 0);
  return { published: pub.getTime(), due: d.getTime() };
}

/**
 * Datas de um prazo contado da disponibilização no DJEN:
 * disponibilizada → publicada (1º dia útil seguinte) → começa (1º dia útil após
 * a publicação) → vence. `corridos` = dias corridos (processo criminal: começa
 * no 1º dia útil e, se vencer em dia sem expediente, passa para o próximo útil).
 */
export function deadlineDates(availableTs, days, { corridos = false } = {}) {
  const n = Math.max(1, Number(days) || 1);
  const pub = nextCourtDay(new Date(availableTs));
  const start = nextCourtDay(pub);
  let due;
  if (corridos) {
    due = new Date(start);
    due.setDate(due.getDate() + n - 1);
    if (!isCourtDay(due)) due = nextCourtDay(due);
  } else {
    due = start;
    for (let i = 1; i < n; i++) due = nextCourtDay(due);
  }
  const at = (d, h, m) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); };
  return { available: at(new Date(availableTs), 12, 0), published: at(pub, 12, 0), start: at(start, 12, 0), due: at(due, 23, 59) };
}

// ------------------------------------------------------------ prazo sugerido pelo texto

const NUM_WORDS = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18,
  dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, sessenta: 60, noventa: 90,
};
export const foldText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Processo criminal (prazos em dias corridos — CPP art. 798). */
export function isCriminal({ area = '', classe = '', text = '' } = {}) {
  const t = foldText(`${area} ${classe}`);
  if (/criminal|penal|crime|habeas|inquerito|acao penal|execucao penal|termo circunstanciado|medidas protetivas/.test(t)) return true;
  return /\bacao penal\b|\breu preso\b|codigo de processo penal|\bcpp\b/.test(foldText(text).slice(0, 2000));
}

/**
 * Prazo sugerido para uma intimação: lê "prazo de 5 (cinco) dias", "em 15 dias",
 * "48 horas"; sem prazo no texto, usa o do ato (sentença → recurso; embargos;
 * contestação…) e, sem nada, os 5 dias do CPC (art. 218, § 3º).
 * Devolve { days, corridos, reason, event } — `event` = é audiência/sessão (agenda, não prazo).
 */
export function suggestDeadline({ text = '', doc_kind = '', kind = '', classe = '', area = '', tribunal = '' } = {}) {
  const t = foldText(text);
  const trab = /trabalh/i.test(area) || /^TRT|^TST/.test(String(tribunal || ''));
  const jec = /juizado/.test(foldText(classe)) || /juizado especial/.test(t.slice(0, 1500));
  const corridos = isCriminal({ area, classe, text });
  const out = (days, reason) => ({ days, corridos, reason: corridos ? `${reason} · processo criminal: dias corridos` : reason });
  // prazo escrito no texto
  const numRe = '(\\d{1,3}|' + Object.keys(NUM_WORDS).join('|') + ')';
  const re = new RegExp(`(?:prazo(?: legal| comum| sucessivo| improrrogavel)? de|no prazo de|em|dentro de|por)\\s+${numRe}\\s*(?:\\([a-z ]+\\)\\s*)?(dias?(?: uteis| corridos)?|horas)`, 'g');
  const found = [];
  let m;
  while ((m = re.exec(t))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1]];
    if (!n) continue;
    found.push(m[2] === 'horas' ? { days: Math.max(1, Math.ceil(n / 24)), hours: n } : { days: n });
  }
  const valid = found.filter((f) => f.days >= 1 && f.days <= 120);
  if (valid.length) {
    // o menor prazo citado é o que vence primeiro (o mais seguro)
    const f = valid.sort((a, b) => a.days - b.days)[0];
    return out(f.days, f.hours ? `o texto fala em ${f.hours} horas` : `o texto fala em prazo de ${f.days} dia(s)`);
  }
  const k = foldText(`${doc_kind} ${kind}`);
  const head = `${k} ${t.slice(0, 600)}`;
  if (/pauta|audiencia|sessao de julgamento|sessao virtual/.test(k) || (/designad[ao] (a )?audiencia|audiencia (de|designada|redesignada)/.test(t) && !/sentenca|acordao/.test(k))) {
    return { days: null, corridos, event: true, reason: 'é audiência/sessão: vai para a agenda (Pôr na agenda), não é prazo' };
  }
  if (/embargos de declaracao/.test(t) && /(oposto|opostos|interpost|contrarraz|manifest)/.test(t)) return out(5, 'embargos de declaração (contrarrazões em 5 dias)');
  if (/acordao/.test(head)) return out(trab ? 8 : 15, trab ? 'acórdão trabalhista: recurso de revista em 8 dias' : 'acórdão: recurso especial/extraordinário em 15 dias (embargos de declaração em 5)');
  if (/sentenca/.test(head) && !/cumprimento de sentenca/.test(t.slice(0, 200))) {
    if (trab) return out(8, 'sentença trabalhista: recurso ordinário em 8 dias');
    if (jec) return out(10, 'sentença no juizado: recurso inominado em 10 dias');
    if (corridos) return out(5, 'sentença criminal: apelação em 5 dias');
    return out(15, 'sentença: apelação em 15 dias (embargos de declaração em 5)');
  }
  if (/\bcitad|\bcitacao/.test(head)) return out(trab ? 5 : 15, trab ? 'citação trabalhista: confira a data da audiência' : 'citação: contestação em 15 dias');
  if (/contrarraz/.test(t)) return out(trab ? 8 : 15, 'contrarrazões');
  if (/replica|impugnar a contestacao|manifestar sobre a contestacao|sobre a contestacao/.test(t)) return out(15, 'réplica à contestação em 15 dias');
  if (/especifi\w* (as )?provas/.test(t)) return out(5, 'especificar provas: 5 dias, se o juiz não fixou outro');
  if (/laudo/.test(t)) return out(15, 'manifestação sobre o laudo em 15 dias');
  if (/pagamento|pagar|cumprimento/.test(t) && /cumprimento de sentenca|art\.? 523/.test(t)) return out(15, 'cumprimento de sentença: pagar em 15 dias');
  return out(5, 'sem prazo no texto: 5 dias (CPC art. 218, § 3º)');
}

// ------------------------------------------------------------ prioridade da intimação

/** 'alta' (decisão, sentença, citação, audiência, prazo no texto) | 'normal' | 'rotina' (ato ordinatório sem prazo). */
export function intimationPriority({ text = '', doc_kind = '', kind = '' } = {}) {
  const k = foldText(`${doc_kind} ${kind}`);
  const t = foldText(text).slice(0, 3000);
  if (/sentenca|acordao|decisao|citacao|pauta|tutela|liminar/.test(k)) return 'alta';
  if (/sentenca|acordao|julgo |tutela de urgencia|liminar|citacao|audiencia|bloqueio|penhora|sob pena|alvara|transitou em julgado|prazo de (\d+|[a-z]+) (\(|dias|horas)|intime-se .{0,80}para|no prazo/.test(t)) return 'alta';
  if (/ato ordinatorio|mero expediente|certidao|juntada|remessa|vista ao|redistribu|conclus|ciencia/.test(`${k} ${t.slice(0, 500)}`)) return 'rotina';
  return 'normal';
}

// ------------------------------------------------------------ nome do advogado: variações e comparação

const PARTICLES = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
const nameTokens = (s) => foldText(s).replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w && !PARTICLES.has(w));

/** Erros comuns de digitação num sobrenome (rr/r, ss/s, ç/c/s, z/s, y/i, h mudo, nn/n, ll/l). */
function misspellings(w) {
  const out = new Set();
  const swaps = [[/rr/g, 'r'], [/(?<=[aeiou])r(?=[aeiou])/g, 'rr'], [/ss/g, 's'], [/(?<=[aeiou])s(?=[aeiou])/g, 'ss'], [/z/g, 's'], [/(?<=[aeiou])s(?=[aeiou])/g, 'z'],
    [/y/g, 'i'], [/th/g, 't'], [/ph/g, 'f'], [/^h/, ''], [/ll/g, 'l'], [/nn/g, 'n'], [/tt/g, 't'], [/ç/g, 'c'], [/sc/g, 's'], [/x/g, 'ch'], [/ch/g, 'x']];
  for (const [re, to] of swaps) { const v = w.replace(re, to); if (v !== w && v.length > 2) out.add(v); }
  return [...out];
}

/**
 * Formas do nome para buscar no DJEN (no máximo `max`): o nome completo, sem
 * acentos, só primeiro e último nome, as grafias que o escritório cadastrou e
 * erros comuns de digitação no sobrenome.
 */
export function nameVariants(name, extra = [], { max = 6 } = {}) {
  const out = [];
  const add = (v) => { const x = String(v || '').replace(/\s+/g, ' ').trim().toUpperCase(); if (x.split(' ').length >= 2 && !out.includes(x)) out.push(x); };
  add(name);
  add(foldText(name));
  for (const e of extra) add(foldText(e));
  const tk = nameTokens(name);
  if (tk.length >= 2) {
    const first = tk[0];
    const last = tk[tk.length - 1];
    add(`${first} ${last}`);
    if (tk.length >= 3) add(`${first} ${tk[tk.length - 2]} ${last}`);
    for (const v of misspellings(last)) add(`${first} ${v}`);
    for (const v of misspellings(first)) add(`${v} ${last}`);
  }
  return out.slice(0, max);
}

function lev(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// grafia "pelo som": ph=f, th=t, y=i, k=c, w=v, z=s, h mudo, letras dobradas
const phon = (w) => w.replace(/ph/g, 'f').replace(/th/g, 't').replace(/y/g, 'i').replace(/k/g, 'c').replace(/w/g, 'v').replace(/z/g, 's')
  .replace(/^h/, '').replace(/(.)\1+/g, '$1');
const close = (a, b) => a === b || phon(a) === phon(b) || (Math.min(a.length, b.length) >= 4 && lev(phon(a), phon(b)) <= (Math.min(a.length, b.length) >= 7 ? 2 : 1));

/**
 * O nome publicado é desta pessoa? Primeiro e último nome iguais ou quase
 * (1–2 letras de diferença) e os do meio, se houver, batendo com algum dela.
 */
export function nameMatches(target, published, extra = []) {
  const p = nameTokens(published);
  if (p.length < 2) return false;
  for (const n of [target, ...extra]) {
    const t = nameTokens(n);
    if (t.length < 2) continue;
    // o 1º nome é mais rígido (Rafael ≠ Rafaela): só a mesma grafia "pelo som" ou 1 letra em nome longo
    const firstOk = t[0] === p[0] || phon(t[0]) === phon(p[0]) || (Math.min(t[0].length, p[0].length) >= 7 && lev(phon(t[0]), phon(p[0])) <= 1);
    if (!firstOk || !close(t[t.length - 1], p[p.length - 1])) continue;
    const midP = p.slice(1, -1);
    const midT = t.slice(1, -1);
    if (midP.every((w) => midT.some((x) => close(x, w) || (w.length === 1 && x[0] === w)))) return true;
  }
  return false;
}

/**
 * A parte publicada é este cliente? Empresa: o nome sem "LTDA", "S/A", "ME"…
 * igual; pessoa: como `nameMatches`.
 */
export function partyMatches(clientName, partyName) {
  const strip = (s) => foldText(s).replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(ltda|limitada|s ?a|sa|me|epp|eireli|cia|companhia|e cia|ss|s s)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const a = strip(clientName);
  const b = strip(partyName);
  if (!a || !b) return false;
  if (a === b) return true;
  return nameMatches(clientName, partyName);
}

// ------------------------------------------------------------ consulta no site do tribunal

/** Página de consulta processual do tribunal (o nº é copiado para colar). */
export function consultaUrl(tribunal) {
  const t = String(tribunal || '').toUpperCase();
  const known = {
    TJSP: 'https://esaj.tjsp.jus.br/cpopg/open.do',
    TJMT: 'https://pje.tjmt.jus.br/pje/ConsultaPublica/listView.seam',
    TJMS: 'https://esaj.tjms.jus.br/cpopg5/open.do',
    TJGO: 'https://projudi.tjgo.jus.br/BuscaProcesso',
    TJMG: 'https://www.tjmg.jus.br/portal-tjmg/processos/',
    TJRJ: 'https://www3.tjrj.jus.br/consultaprocessual/',
    TJPR: 'https://www.tjpr.jus.br/consulta-processual-unificada',
    TRF1: 'https://pje1g.trf1.jus.br/consultapublica/ConsultaPublica/listView.seam',
    STJ: 'https://processo.stj.jus.br/processo/pesquisa/',
    STF: 'https://portal.stf.jus.br/',
    TST: 'https://consultaprocessual.tst.jus.br/',
  };
  if (known[t]) return known[t];
  const trt = /^TRT(\d{1,2})$/.exec(t);
  if (trt) return `https://pje.trt${trt[1]}.jus.br/consultaprocessual/`;
  if (/^(TJ|TRF|TRE)/.test(t)) return `https://www.${t.toLowerCase().replace('-', '')}.jus.br/`;
  return 'https://www.cnj.jus.br/pjecnj/ConsultaPublica/listView.seam';
}

// ------------------------------------------------------------ DJEN

const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

function dateOf(v) {
  if (!v) return null;
  const s = String(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12).getTime();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Uma comunicação do DJEN → formato do sistema (aceita as variações de nome dos campos). */
export function parseDjenItem(it) {
  const num = it.numeroprocessocommascara || it.numero_processo || it.numeroProcesso || '';
  return {
    ext_id: String(it.id ?? it.hash ?? `${num}-${it.data_disponibilizacao}-${it.numeroComunicacao}`),
    date: dateOf(it.data_disponibilizacao || it.dataDisponibilizacao || it.datadisponibilizacao),
    tribunal: it.siglaTribunal || it.sigla_tribunal || tribunalOf(num) || '',
    kind: it.tipoComunicacao || it.tipo_comunicacao || 'Intimação',
    doc_kind: it.tipoDocumento || it.tipo_documento || '',
    orgao: it.nomeOrgao || it.nome_orgao || '',
    classe: it.nomeClasse || it.nome_classe || '',
    process_number: formatCnj(num),
    text: stripHtml(it.texto),
    link: it.link || '',
    hash: it.hash || '',
    parties: (it.destinatarios || []).map((d) => ({ name: d.nome, polo: d.polo })).filter((d) => d.name),
    lawyers: (it.destinatarioadvogados || []).map((a) => a.advogado || a).map((a) => ({ name: a.nome, oab: String(a.numero_oab || a.numeroOab || ''), uf: a.uf_oab || a.ufOab || '' })).filter((a) => a.name),
  };
}

// ------------------------------------------------------------ DataJud

/** Processo do DataJud → dados para a ficha + andamentos. */
export function parseDatajudHit(src) {
  const moves = (src.movimentos || []).map((m) => {
    const comp = (m.complementosTabelados || []).map((c) => c.nome || c.descricao).filter(Boolean);
    const ts = Date.parse(m.dataHora) || null;
    return {
      ext_id: `dj:${m.codigo || ''}:${m.dataHora || ''}`,
      ts,
      text: `${m.nome || 'Movimentação'}${comp.length ? ` (${comp.join(', ')})` : ''}`,
    };
  }).filter((m) => m.ts);
  const filed = src.dataAjuizamento ? String(src.dataAjuizamento) : '';
  const filedIso = /^\d{8}/.test(filed) ? `${filed.slice(0, 4)}-${filed.slice(4, 6)}-${filed.slice(6, 8)}` : (filed.slice(0, 10) || null);
  return {
    process_number: formatCnj(src.numeroProcesso),
    tribunal: src.tribunal || tribunalOf(src.numeroProcesso),
    classe: src.classe?.nome || '',
    orgao: src.orgaoJulgador?.nome || '',
    grau: src.grau || '',
    filed_at: filedIso,
    assuntos: (src.assuntos || []).map((a) => a.nome).filter(Boolean),
    updated: Date.parse(src.dataHoraUltimaAtualizacao) || null,
    moves,
  };
}

// ------------------------------------------------------------ consultas

export class CourtsService {
  /** @param {{ fetch?: typeof fetch, getDatajudKey?: () => string }} opts */
  constructor({ fetch: f = globalThis.fetch, getDatajudKey } = {}) {
    this.fetch = f;
    this.getDatajudKey = getDatajudKey || (() => DATAJUD_PUBLIC_KEY);
  }

  async getJson(url, init = {}) {
    let r;
    try {
      r = await this.fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(`Sem resposta de ${new URL(url).host} (${e.cause?.code || e.message}). Verifique a internet.`);
    }
    if (r.status === 429) throw new Error('O tribunal pediu para esperar (muitas consultas). Tente de novo em alguns minutos.');
    if (!r.ok) throw new Error(`${new URL(url).host} respondeu ${r.status}.`);
    return r.json();
  }

  /** Comunicações do DJEN com os filtros dados, num período (todas as páginas, até `maxPages`). */
  async djenSearch(filters, { from, to, maxPages = 10 }) {
    const out = [];
    const day = (ts) => new Date(ts).toISOString().slice(0, 10);
    for (let page = 1; page <= maxPages; page++) {
      const q = new URLSearchParams({
        ...filters,
        dataDisponibilizacaoInicio: day(from), dataDisponibilizacaoFim: day(to),
        pagina: String(page), itensPorPagina: '100',
      });
      const data = await this.getJson(`${DJEN_URL}?${q}`);
      const items = data.items || data.content || [];
      out.push(...items.map(parseDjenItem));
      const total = Number(data.count ?? data.totalElements ?? items.length);
      if (!items.length || out.length >= total) break;
      await new Promise((r) => setTimeout(r, 700)); // sem rajadas
    }
    return out;
  }

  /** Intimações de uma OAB num período. */
  djenByOab({ number, uf, from, to, maxPages = 10 }) {
    return this.djenSearch({ numeroOab: cnjDigits(number), ufOab: String(uf || '').toUpperCase() }, { from, to, maxPages });
  }

  /** Publicações em que a pessoa/empresa é parte (vigiar clientes). */
  djenByParty({ name, from, to, maxPages = 2 }) {
    return this.djenSearch({ nomeParte: name }, { from, to, maxPages });
  }

  /** Intimações pelo nome do advogado (pega publicação com a OAB errada ou sem OAB). */
  djenByLawyerName({ name, from, to, maxPages = 5 }) {
    return this.djenSearch({ nomeAdvogado: name }, { from, to, maxPages });
  }

  /** Comunicações de um processo pelo nº (para achar as partes): até 2 páginas. */
  async djenByProcess(number, { maxPages = 2 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const q = new URLSearchParams({ numeroProcesso: cnjDigits(number), pagina: String(page), itensPorPagina: '100' });
      const data = await this.getJson(`${DJEN_URL}?${q}`);
      const items = data.items || data.content || [];
      out.push(...items.map(parseDjenItem));
      const total = Number(data.count ?? data.totalElements ?? items.length);
      if (!items.length || out.length >= total) break;
      await new Promise((r) => setTimeout(r, 700));
    }
    return out;
  }

  /** Processo no DataJud pelo número (null se o tribunal não tiver ou não achar). */
  async datajud(number) {
    const index = datajudIndex(number);
    if (!index) throw new Error('Não deu para saber o tribunal pelo número do processo (confira o nº CNJ).');
    const data = await this.getJson(`${DATAJUD_URL}/${index}/_search`, {
      method: 'POST',
      headers: { Authorization: `APIKey ${this.getDatajudKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: 1, query: { match: { numeroProcesso: cnjDigits(number) } } }),
    });
    const hit = data.hits?.hits?.[0]?._source;
    return hit ? parseDatajudHit(hit) : null;
  }
}
