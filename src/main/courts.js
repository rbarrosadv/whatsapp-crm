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

  /** Intimações de uma OAB num período (todas as páginas, até `maxPages`). */
  async djenByOab({ number, uf, from, to, maxPages = 10 }) {
    const out = [];
    const day = (ts) => new Date(ts).toISOString().slice(0, 10);
    for (let page = 1; page <= maxPages; page++) {
      const q = new URLSearchParams({
        numeroOab: cnjDigits(number), ufOab: String(uf || '').toUpperCase(),
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
