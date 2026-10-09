// Fases do processo (usado pelo servidor e pela interface): a lista, a
// configuração do escritório (nomes, fases escondidas, fases a mais,
// responsável por fase) e a fase deduzida dos andamentos do tribunal.

/** Fases do processo judicial, na ordem em que costumam acontecer. */
export const PHASES = [
  { id: 'pre', label: 'Pré-processual' },
  { id: 'inicial', label: 'Inicial / distribuído' },
  { id: 'citacao', label: 'Citação' },
  { id: 'contestacao', label: 'Contestação / réplica' },
  { id: 'audiencia', label: 'Audiência' },
  { id: 'instrucao', label: 'Instrução / perícia' },
  { id: 'conclusos', label: 'Aguardando sentença' },
  { id: 'sentenca', label: 'Sentença' },
  { id: 'recurso', label: 'Recurso' },
  { id: 'superiores', label: 'Tribunais superiores' },
  { id: 'transito', label: 'Trânsito em julgado' },
  { id: 'liquidacao', label: 'Liquidação' },
  { id: 'cumprimento', label: 'Cumprimento de sentença' },
  { id: 'pagamento', label: 'Acordo / pagamento' },
  { id: 'suspenso', label: 'Suspenso' },
  { id: 'arquivado', label: 'Arquivado provisório' },
  { id: 'encerrado', label: 'Encerrado' },
];

/** Processo administrativo no INSS. */
export const INSS_PHASES = [
  { id: 'inss_protocolo', label: 'Protocolado' },
  { id: 'inss_analise', label: 'Em análise' },
  { id: 'inss_exigencia', label: 'Exigência' },
  { id: 'inss_pericia', label: 'Perícia / avaliação' },
  { id: 'inss_decisao', label: 'Decisão' },
  { id: 'inss_recurso', label: 'Recurso (CRPS)' },
  { id: 'encerrado', label: 'Encerrado' },
];

/** Caminho principal mostrado na régua da ficha (as outras entram quando usadas). */
const MAIN = ['inicial', 'citacao', 'contestacao', 'audiencia', 'conclusos', 'sentenca', 'recurso', 'transito', 'cumprimento', 'pagamento'];
/** Fases "à parte": o processo entra e sai delas (não são um passo adiante). */
export const SIDE = ['suspenso', 'arquivado'];

const parseConfig = (cfg) => {
  if (!cfg) return {};
  if (typeof cfg === 'string') { try { return JSON.parse(cfg) || {}; } catch { return {}; } }
  return cfg;
};

/**
 * Fases com a configuração do escritório: `{ names: {id: nome}, hidden: [ids],
 * custom: [{id, label, after}], resp: {id: userId} }`.
 * `kind` = 'inss' para o administrativo.
 */
export function phaseList(cfg, kind = 'judicial') {
  const c = parseConfig(cfg);
  const base = (kind === 'inss' ? INSS_PHASES : PHASES).map((p) => ({ ...p }));
  if (kind !== 'inss') {
    for (const x of c.custom || []) {
      if (!x?.id || !x.label || base.some((p) => p.id === x.id)) continue;
      const at = base.findIndex((p) => p.id === x.after);
      base.splice(at >= 0 ? at + 1 : base.length - 1, 0, { id: x.id, label: String(x.label), custom: true });
    }
  }
  return base.map((p, i) => ({
    ...p, order: i, label: c.names?.[p.id] || p.label, base: p.label,
    hidden: (c.hidden || []).includes(p.id), resp: c.resp?.[p.id] || null,
  }));
}

export function phaseLabel(id, cfg, kind) {
  if (!id) return '';
  const all = [...phaseList(cfg, kind), ...phaseList(cfg, kind === 'inss' ? 'judicial' : 'inss')];
  return all.find((p) => p.id === id)?.label || id;
}

/**
 * Fases da régua da ficha: o caminho principal + as que o processo já passou
 * + a atual (na ordem certa), sem as escondidas.
 */
export function rulerPhases(cfg, kind, current, visited = []) {
  const list = phaseList(cfg, kind);
  if (kind === 'inss') return list.filter((p) => p.id !== 'encerrado' || current === 'encerrado');
  const want = new Set([...MAIN, ...visited, current].filter(Boolean));
  return list.filter((p) => want.has(p.id) && (!p.hidden || p.id === current) && (!SIDE.includes(p.id) || p.id === current) && (p.id !== 'encerrado' || current === 'encerrado'));
}

// ------------------------------------------------------------ fase pelo andamento

// do mais específico para o mais geral (o 1º que bater vale)
const RULES = [
  ['desarquivar', /desarquiv/i],
  ['arquivado', /arquivamento provis|arquivado provis|arquivem-se provis|sobrestad|art\.?\s*921|art\.?\s*40 da lei 6\.?830|suspens[aã]o da execu/i],
  ['suspenso', /suspens[aã]o do processo|processo suspenso|suspendo o (processo|feito|andamento)|suspenso o (processo|feito)/i],
  ['pagamento', /alvar[aá]|\brpv\b|requisi[cç][aã]o de pequeno valor|precat[oó]rio|levantamento de (valores|dep[oó]sito)|acordo homologado|homolog\w* (o |do )?acordo|libera[cç][aã]o de valores/i],
  ['cumprimento', /cumprimento de senten|cumprimento definitivo|cumprimento provis|in[ií]cio da execu[cç]|execu[cç][aã]o de senten|impugna[cç][aã]o ao cumprimento|penhora|bloqueio (de valores|via sisbajud|bacen)|sisbajud|bacenjud/i],
  ['liquidacao', /liquida[cç][aã]o (de|da) senten|liquida[cç][aã]o por (c[aá]lculo|arbitramento)|in[ií]cio da liquida/i],
  ['transito', /tr[aâ]nsit\w* em julgado|transitou em julgado|certid[aã]o de tr[aâ]nsito/i],
  ['superiores', /recurso especial|recurso extraordin|recurso de revista|agravo em recurso|remessa (ao|para o) (stj|stf|tst)|remetidos os autos (ao|para o) (stj|stf|tst)/i],
  ['recurso', /apela[cç][aã]o|recurso ordin[aá]rio|recurso inominado|agravo de instrumento|agravo de peti[cç]|ac[oó]rd[aã]o|remetidos os autos (ao|para o|à) (tribunal|tj|trt|trf|turma)|remessa (ao|para o) tribunal|pauta de julgamento|sess[aã]o de julgamento/i],
  ['conclusos', /conclusos? para (senten|julgamento)|conclus[aã]o para (senten|julgamento)/i],
  ['sentenca', /senten[cç]a|julgad[oa]s?\s+(procedente|improcedente|parcialmente)|julgo (procedente|improcedente|parcialmente)|extin[cç][aã]o do processo|extingo o processo/i],
  ['audiencia', /audi[eê]ncia/i],
  ['instrucao', /per[ií]cia|laudo|perito|prova pericial|instru[cç][aã]o processual|especifica[cç][aã]o de provas/i],
  ['contestacao', /contesta[cç][aã]o|r[eé]plica|impugna[cç][aã]o [àa] contesta/i],
  ['citacao', /cita[cç][aã]o|citad[oa]\b|mandado de cita|carta de cita/i],
  ['inicial', /distribu[ií]d|distribui[cç][aã]o|peti[cç][aã]o inicial|autua[cç][aã]o|recebida a inicial/i],
];

/** Fase sugerida por um andamento (ou null). 'desarquivar' = volta à fase de antes. */
export function phaseFromText(text) {
  const s = String(text || '');
  for (const [id, re] of RULES) if (re.test(s)) return id;
  return null;
}

const rank = (id) => {
  const i = PHASES.findIndex((p) => p.id === id);
  return i < 0 ? -1 : i;
};

/**
 * Fase do processo pelos andamentos (do mais antigo ao mais novo), a partir de
 * `start` (fase inicial, ou a escolhida à mão em `startTs`). Só avança: um
 * andamento que cita uma fase anterior (ex.: "citação do executado" no
 * cumprimento) não volta a fase; suspenso/arquivado entram e saem.
 * Devolve `{ phase, since, history: [{ phase, ts, text }] }`.
 */
export function derivePhase(moves, { start = 'inicial', startTs = 0 } = {}) {
  let phase = start;
  let since = startTs || null;
  let before = null; // fase antes de suspender/arquivar
  const history = [];
  const sorted = [...moves].filter((m) => (m.ts || 0) > (startTs || 0)).sort((a, b) => a.ts - b.ts);
  for (const m of sorted) {
    let next = phaseFromText(m.text);
    if (!next) continue;
    if (next === 'desarquivar') {
      if (!SIDE.includes(phase)) continue;
      next = before || 'inicial';
    }
    let change = false;
    if (SIDE.includes(next)) change = next !== phase;
    else if (SIDE.includes(phase)) change = true; // voltou a andar
    else change = rank(next) > rank(phase);
    if (!change) continue;
    if (SIDE.includes(next) && !SIDE.includes(phase)) before = phase;
    if (SIDE.includes(phase) && !SIDE.includes(next) && before && rank(before) > rank(next)) next = before;
    phase = next;
    since = m.ts;
    history.push({ phase, ts: m.ts, text: m.text });
  }
  return { phase, since, history };
}

/** Fase inicial de um processo sem andamentos. */
export function startPhase(k) {
  if (k?.kind === 'inss') return 'inss_protocolo';
  return k?.process_number ? 'inicial' : 'pre';
}

/** Situação no INSS → fase. */
export function inssPhase(status) {
  return { analise: 'inss_analise', exigencia: 'inss_exigencia', concedido: 'inss_decisao', indeferido: 'inss_decisao', recurso: 'inss_recurso', cancelado: 'encerrado' }[status] || null;
}
