// Importação da lista de processos de outro sistema (LinkLei e afins) e as
// regras que organizam a carteira depois: área pela classe/assunto do DataJud,
// situação de arquivamento pelos andamentos (baixa definitiva × arquivamento
// provisório, que ainda pode prescrever) e partes a partir do título.
import { formatCnj, cnjDigits, tribunalOf, nameCase } from './courts.js';

const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const validCnj = (d) => /^\d{20}$/.test(d);

// ------------------------------------------------------------ colunas

const COLS = {
  number: /n[ºo°.]*\s*(do\s+)?processo|numero|cnj|^processo\s*n/,
  title: /^(processo|titulo|nome|acao|caso|descricao)$/,
  tribunal: /tribunal|^orgao$/,
  status: /situacao|status|^fase$/,
  client: /^cliente|cliente\(s\)|^clientes$|segurad|requerente/,
  opposing: /contraria|adverso|^reu$|parte contraria|polo passivo/,
  responsible: /respons|advogado|^adv\b/,
  area: /^area|area do direito/,
  court: /vara|juizo|comarca|orgao julgador/,
  moves: /movimenta/,
  benefit: /benef[ií]cio|especie/,
};

/** Qual coluna é o quê: pelo nome do cabeçalho e, para o nº, pelo conteúdo. */
export function detectColumns(header, rows, { mode } = {}) {
  const h = header.map(fold);
  if (mode === 'inss') {
    const map = {};
    const num = h.findIndex((x) => /protocolo|requerimento|n[ºo°.]*\s*(do\s+)?(processo|beneficio|nb)|^nb$/.test(x));
    if (num >= 0) map.number = num;
    for (const [key, re] of Object.entries(COLS)) {
      if (key === 'number') continue;
      const i = h.findIndex((x, idx) => re.test(x) && !Object.values(map).includes(idx));
      if (i >= 0) map[key] = i;
    }
    return map;
  }
  const map = {};
  for (const [key, re] of Object.entries(COLS)) {
    const i = h.findIndex((x, idx) => re.test(x) && !Object.values(map).includes(idx));
    if (i >= 0) map[key] = i;
  }
  // o nº do processo é a coluna em que a maioria tem 20 dígitos
  const sample = rows.slice(0, 60);
  let best = -1;
  let bestN = 0;
  for (let c = 0; c < header.length; c++) {
    const n = sample.filter((r) => validCnj(cnjDigits(r[c]))).length;
    if (n > bestN) { best = c; bestN = n; }
  }
  if (best >= 0 && bestN >= Math.max(1, sample.length * 0.5)) {
    if (map.title === best) delete map.title;
    map.number = best;
  }
  if (map.title == null) {
    const t = h.findIndex((x, idx) => /^processo/.test(x) && idx !== map.number);
    if (t >= 0) map.title = t;
  }
  return map;
}

/** "FULANO x CICLANO e outros" → partes (o título do LinkLei, quando tem). */
export function partiesFromTitle(title) {
  const t = String(title || '');
  const m = t.split(/\s+x\s+|\s+X\s+|\s+vs\.?\s+|\s+versus\s+/);
  if (m.length !== 2) return [];
  const clean = (s) => s.replace(/\s+e\s+outros?\s*$/i, '').replace(/\s*\(.*?\)\s*$/, '').trim();
  const out = [];
  if (clean(m[0]) && !/parte ocultada/i.test(m[0])) out.push({ name: nameCase(clean(m[0])), polo: 'A' });
  if (clean(m[1]) && !/parte ocultada/i.test(m[1])) out.push({ name: nameCase(clean(m[1])), polo: 'P' });
  return out;
}

/** Título que é só o nome do tribunal (o LinkLei usa quando não tem as partes). */
export const isGenericTitle = (title, tribunal) => {
  const f = fold(title);
  return !f || /^(tribunal|trt|trf|tj|tre|tst|stj|stf|justica|processo\b)/.test(f) || f === fold(tribunal);
};

/**
 * Linhas da planilha → processos. `map` = colunas (detectColumns, que a tela
 * deixa corrigir). Junta números repetidos e separa os sem nº válido.
 */
export function parseImport(rows, map, { mode } = {}) {
  const items = [];
  const seen = new Map();
  const problems = [];
  const inss = mode === 'inss';
  rows.forEach((r, i) => {
    const raw = map.number != null ? r[map.number] : '';
    const digits = cnjDigits(raw);
    const get = (k) => (map[k] != null ? String(r[map[k]] || '').trim() : '');
    if (!r.some((c) => String(c || '').trim())) return;
    if (inss ? digits.length < 5 : !validCnj(digits)) { problems.push({ line: i + 2, value: raw || '(vazio)', reason: inss ? 'nº do protocolo inválido' : 'nº do processo inválido' }); return; }
    if (seen.has(digits)) { seen.get(digits).dupes++; return; }
    const title = get('title');
    const tribunalText = get('tribunal');
    const it = {
      line: i + 2,
      digits,
      number: inss ? String(raw).trim() : formatCnj(digits),
      tribunal: inss ? 'INSS' : tribunalOf(digits) || (/- ([A-Z0-9]+)$/.exec(tribunalText)?.[1] || ''),
      title: inss ? title : (isGenericTitle(title, tribunalText) ? '' : title),
      benefit: get('benefit'),
      status: get('status'),
      client: get('client'),
      opposing: get('opposing'),
      responsible: get('responsible'),
      area: get('area'),
      court: get('court'),
      moves: get('moves'),
      dupes: 0,
    };
    it.parties = partiesFromTitle(it.title);
    seen.set(digits, it);
    items.push(it);
  });
  return { items, problems, duplicates: items.reduce((a, x) => a + x.dupes, 0) };
}

// ------------------------------------------------------------ área

const AREA_RULES = [
  ['Criminal', /penal|criminal|crime|inquerito|habeas corpus|execucao da pena|contravencao|medidas protetivas/],
  ['Família e Sucessões', /divorcio|alimentos|guarda|familia|uniao estavel|inventario|arrolamento|partilha|investigacao de paternidade|curatela|interdicao|adocao|sucess|visitas/],
  ['Previdenciário', /previdenci|aposentadoria|auxilio[- ]doenca|auxilio por incapacidade|beneficio assistencial|bpc|loas|pensao por morte|salario[- ]maternidade|inss/],
  ['Tributário', /tribut|execucao fiscal|fiscal|icms|iptu|ipva|imposto|contribuic|divida ativa/],
  ['Consumidor', /consumidor|bancari|cartao de credito|plano de saude|telefonia|negativacao|inscricao indevida|cadastro de inadimplentes|transporte aereo|cobranca indevida/],
  ['Empresarial', /falencia|recuperacao judicial|societari|dissolucao de sociedade|empresarial/],
  ['Administrativo', /servidor publico|administrativ|licitac|improbidade|concurso publico|mandado de seguranca/],
];

/** Área do processo pelo tribunal, classe e assuntos (DataJud/DJEN). */
export function classifyArea({ tribunal = '', number = '', classe = '', assuntos = [] } = {}) {
  const trib = String(tribunal || tribunalOf(number) || '').toUpperCase();
  const seg = cnjDigits(number).slice(13, 14);
  if (/^TRT|^TST/.test(trib) || seg === '5') return 'Trabalhista';
  const text = fold([classe, ...(assuntos || [])].join(' | '));
  for (const [area, re] of AREA_RULES) if (re.test(text)) return area;
  if (seg === '4' && /beneficio|aposent|auxilio|pensao/.test(text)) return 'Previdenciário';
  if (!text) return '';
  return 'Cível';
}

// ------------------------------------------------------------ arquivamento

const DEFINITIVE = /arquivad[oa]s?\s+definitivamente|arquivamento\s+definitivo|baixa\s+definitiva|\bdefinitivo\b.*arquiv|arquiv.*\(definitivo\)/;
const PROVISIONAL = /arquivad[oa]s?\s+provisoriamente|arquivamento\s+provis|provis[oó]rio.*arquiv|arquiv.*\(provis|sobrestad|sobrestamento|suspens[aã]o do processo|processo suspenso|suspenso por|art\.?\s*921|art\.?\s*40 da lei 6\.?830|11-a da clt/;
const REOPEN = /desarquiv|reativa[cç][aã]o|retorno dos autos|reabertura|processo reativado|remetidos os autos.*(?:para|ao).*(?:tribunal|instancia)/;
// "Arquivado"/"Arquivamento" sem dizer qual: tratado como provisório (vigiar),
// porque considerar definitivo um arquivamento provisório é o que deixa prescrever
const GENERIC = /\barquivad[oa]s?\b|\barquivamento\b/;
// códigos da Tabela Processual Unificada do CNJ (DataJud)
const DEF_CODES = new Set([22, 246]); // baixa definitiva, arquivamento definitivo
const PROV_CODES = new Set([245, 861]); // arquivamento provisório, arquivamento (sem dizer qual)
const REOPEN_CODES = new Set([893, 849]); // desarquivamento, reativação

/**
 * Situação de arquivamento pelos andamentos (do mais antigo ao mais novo):
 * { state: null | 'provisorio' | 'definitivo', since, lastMove }. Um andamento
 * de desarquivamento volta para null; o último marcador vale.
 */
export function archiveState(moves = []) {
  const list = [...moves].filter((m) => m && m.ts).sort((a, b) => a.ts - b.ts);
  let state = null;
  let since = null;
  for (const m of list) {
    const t = fold(m.text);
    const code = Number(String(m.ext_id || '').split(':')[1]) || Number(m.code) || 0;
    if (REOPEN.test(t) || REOPEN_CODES.has(code)) { state = null; since = null; continue; }
    if (DEFINITIVE.test(t) || DEF_CODES.has(code)) { if (state !== 'definitivo') since = m.ts; state = 'definitivo'; continue; }
    if (PROVISIONAL.test(t) || PROV_CODES.has(code) || GENERIC.test(t)) { if (state !== 'provisorio') since = m.ts; state = 'provisorio'; }
  }
  return { state, since, lastMove: list.length ? list[list.length - 1].ts : null };
}

/** Data sugerida para conferir a prescrição de um arquivado provisoriamente. */
export function suggestPrescription(since, area, years = {}) {
  if (!since) return null;
  const y = Number(area === 'Trabalhista' ? years.trabalhista ?? 2 : years.outros ?? 1);
  const d = new Date(since);
  d.setFullYear(d.getFullYear() + y);
  return d.getTime();
}

/** Andamentos importantes para avisar o cliente (sentença, audiência, acordo…). */
export const CLIENT_WORTHY = /senten[cç]a|julgad[oa]\s+(procedente|improcedente)|homologad[oa]\s+(o\s+)?acordo|acordo homologado|audi[eê]ncia\s+(designada|marcada|redesignada)|designad[oa]\s+audi[eê]ncia|alvar[aá]\s+(expedido|de levantamento)|expedi[cç][aã]o de alvar[aá]|tr[aâ]nsito em julgado|ac[oó]rd[aã]o|provimento|conhecido e provido|desprovido|pauta de julgamento|per[ií]cia (designada|agendada)|laudo pericial|cita[cç][aã]o (realizada|efetivada)|penhora|bloqueio|libera[cç][aã]o de valores|rpv|precat[oó]rio/i;

/** "Audiência designada para 15/11/2026 às 14:00" → { ts, text } */
export function hearingFromText(text) {
  const s = String(text || '');
  if (!/audi[eê]ncia/i.test(s)) return null;
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[^\d]{1,12}(\d{1,2})[:h](\d{2})?)?/.exec(s.slice(s.search(/audi[eê]ncia/i)));
  if (!m) return null;
  const y = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
  const d = new Date(y, Number(m[2]) - 1, Number(m[1]), m[4] ? Number(m[4]) : 9, m[5] ? Number(m[5]) : 0);
  if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() - 86400e3) return null;
  const kind = /concilia/i.test(s) ? 'Audiência de conciliação' : /instru/i.test(s) ? 'Audiência de instrução' : /una\b/i.test(s) ? 'Audiência una' : /inicial/i.test(s) ? 'Audiência inicial' : 'Audiência';
  return { ts: d.getTime(), title: kind, hasTime: !!m[4] };
}

/**
 * Partes de um processo a partir das comunicações do DJEN: nome, polo e se a
 * comunicação foi para uma OAB do escritório (aí a parte é provavelmente o
 * nosso cliente — a intimação vai para a parte pelo advogado dela).
 */
export function partiesFromDjen(items, oabs = []) {
  const ours = new Set(oabs.map((o) => `${cnjDigits(o.number)}/${String(o.uf || '').toUpperCase()}`));
  const map = new Map();
  for (const it of items) {
    const forUs = (it.lawyers || []).some((l) => ours.has(`${cnjDigits(l.oab)}/${String(l.uf || '').toUpperCase()}`));
    for (const p of it.parties || []) {
      const key = fold(p.name);
      if (!key || /parte ocultada|segredo de justica/.test(key)) continue;
      const cur = map.get(key) || { name: nameCase(p.name), polo: p.polo || '', hits: 0, ours: 0 };
      cur.hits++;
      if (forUs) cur.ours++;
      if (!cur.polo && p.polo) cur.polo = p.polo;
      map.set(key, cur);
    }
  }
  const list = [...map.values()];
  // sugestão: quem aparece nas comunicações para a nossa OAB; empate → polo ativo
  const best = list.filter((p) => p.ours).sort((a, b) => b.ours - a.ours || (a.polo === 'A' ? -1 : 1))[0];
  return list
    .map((p) => ({ name: p.name, polo: p.polo === 'A' ? 'ativo' : p.polo === 'P' ? 'passivo' : '', suggested: !!best && p === best }))
    .sort((a, b) => (a.polo === b.polo ? 0 : a.polo === 'ativo' ? -1 : 1));
}
