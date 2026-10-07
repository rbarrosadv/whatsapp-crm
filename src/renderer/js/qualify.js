// Qualificação das partes (procurações, contratos, petições): monta o parágrafo
// "FULANO DE TAL, brasileiro, casado, advogado, portador do RG…" a partir da
// ficha do cliente. Puro (sem DOM): a tela mostra a prévia e o servidor usa o
// mesmo texto no marcador {qualificacao} dos modelos.

export const MARITAL = [
  ['solteiro', 'Solteiro(a)', 'solteiro', 'solteira'],
  ['casado', 'Casado(a)', 'casado', 'casada'],
  ['uniao_estavel', 'União estável', 'convivente em união estável', 'convivente em união estável'],
  ['divorciado', 'Divorciado(a)', 'divorciado', 'divorciada'],
  ['separado', 'Separado(a) judicialmente', 'separado judicialmente', 'separada judicialmente'],
  ['viuvo', 'Viúvo(a)', 'viúvo', 'viúva'],
];

export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI',
  'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

export const REP_ROLES = ['sócio-administrador', 'sócio', 'administrador', 'diretor', 'diretor-presidente', 'presidente', 'procurador', 'titular'];

const digits = (v) => String(v || '').replace(/\D/g, '');
const clean = (v) => String(v ?? '').trim();
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function fmtCpf(v) {
  const d = digits(v);
  return d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : clean(v);
}
export function fmtCnpj(v) {
  const d = digits(v);
  return d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : clean(v);
}
export function fmtDoc(v) { return digits(v).length === 14 ? fmtCnpj(v) : fmtCpf(v); }
export function fmtCep(v) {
  const d = digits(v);
  return d.length === 8 ? d.replace(/(\d{5})(\d{3})/, '$1-$2') : clean(v);
}

/** "Rua X, nº 10, Apto 2, Bairro Centro, Cuiabá/MT, CEP 78000-000". */
export function fullAddress(a = {}, prefix = '') {
  const g = (k) => clean(a[`${prefix}${k}`]);
  const street = g('street');
  if (!street && !g('city') && !g('cep')) return '';
  const num = g('number');
  const parts = [
    street,
    num ? (/^(s\/?n|sem)/i.test(num) ? 's/nº' : `nº ${num}`) : null,
    g('complement'),
    g('district') ? (/^bairro\b/i.test(g('district')) ? g('district') : `Bairro ${g('district')}`) : null,
    g('city') ? `${g('city')}${g('uf') ? `/${g('uf').toUpperCase()}` : ''}` : (g('uf') || null),
    g('cep') ? `CEP ${fmtCep(g('cep'))}` : null,
  ];
  return parts.filter(Boolean).join(', ');
}

/** Pessoa jurídica pelo nome ("LTDA", "S/A", "ME"…) — para sugerir o tipo. */
export function looksLikeCompany(name) {
  return /\b(ltda|s\.?\/?a\.?|eireli|me|epp|mei|cia|companhia|comercio|comércio|industria|indústria|servicos|serviços|associacao|associação|cooperativa|condominio|condomínio|banco|seguros|empreendimentos|holding|fundacao|fundação|igreja|sindicato|instituto|spe)\b/i.test(String(name || ''));
}

const g2 = (gender, m, f, both) => (gender === 'f' ? f : gender === 'm' ? m : both);

export function maritalText(v, gender) {
  const s = clean(v);
  if (!s) return '';
  const row = MARITAL.find((r) => r[0] === s || fold(r[1]) === fold(s) || fold(r[2]) === fold(s) || fold(r[3]) === fold(s));
  if (!row) return s.toLowerCase();
  if (gender === 'f') return row[3];
  if (gender === 'm') return row[2];
  // sem sexo informado: o texto digitado fica como está; a opção da lista sai com "(a)"
  return s === row[0] ? (row[0] === 'uniao_estavel' ? row[2] : row[1].toLowerCase()) : s.toLowerCase();
}

export function nationalityText(v, gender) {
  const s = clean(v) || 'brasileiro(a)';
  if (/^brasileir/i.test(s) && gender) return g2(gender, 'brasileiro', 'brasileira', s);
  return s.toLowerCase();
}

/** Qualificação de pessoa física (sem ponto final). `p` usa os campos da ficha, com prefixo opcional (rep_). */
export function personQualification(p = {}, { prefix = '', address = null, upper = true } = {}) {
  const g = (k) => clean(p[`${prefix}${k}`]);
  const gender = g('gender');
  const name = g('name');
  const parts = [upper ? name.toUpperCase() : name];
  parts.push(nationalityText(g('nationality'), gender));
  if (g('marital')) parts.push(maritalText(g('marital'), gender));
  if (g('profession')) parts.push(g('profession').toLowerCase());
  if (g('rg')) parts.push(`${g2(gender, 'portador', 'portadora', 'portador(a)')} do RG nº ${g('rg')}${g('rg_issuer') ? ` ${g('rg_issuer').toUpperCase()}` : ''}`);
  if (digits(g('cpf'))) parts.push(`${g2(gender, 'inscrito', 'inscrita', 'inscrito(a)')} no CPF sob o nº ${fmtCpf(g('cpf'))}`);
  if (g('email')) parts.push(`com endereço eletrônico ${g('email')}`);
  const addr = address ?? fullAddress(p, prefix);
  if (addr) parts.push(`${g2(gender, 'residente e domiciliado', 'residente e domiciliada', 'residente e domiciliado(a)')} na ${addr}`);
  return parts.filter(Boolean).join(', ');
}

/** Representante legal guardado em `clients.rep` (JSON). */
export function parseRep(c) {
  if (!c?.rep) return {};
  if (typeof c.rep === 'object') return c.rep;
  try { return JSON.parse(c.rep) || {}; } catch { return {}; }
}

/** Qualificação completa do cliente (pessoa física ou jurídica), com ponto final. */
export function qualification(c = {}) {
  if (!clean(c.name)) return '';
  if (c.kind !== 'pj') return `${personQualification(c)}.`;
  const parts = [clean(c.name).toUpperCase()];
  if (clean(c.trade_name)) parts.push(`nome fantasia ${clean(c.trade_name)}`);
  parts.push('pessoa jurídica de direito privado');
  if (digits(c.cpf)) parts.push(`inscrita no CNPJ sob o nº ${fmtCnpj(c.cpf)}`);
  if (clean(c.ie)) parts.push(`inscrição estadual nº ${clean(c.ie)}`);
  if (clean(c.email)) parts.push(`com endereço eletrônico ${clean(c.email)}`);
  const addr = fullAddress(c);
  if (addr) parts.push(`com sede na ${addr}`);
  let text = parts.join(', ');
  const rep = parseRep(c);
  if (clean(rep.name)) {
    const role = clean(rep.role) || 'representante legal';
    // cargo no feminino indica o sexo; "sócio-administrador" não (a Receita usa para todos)
    const gender = rep.gender || (/^(sócia|socia|diretora|administradora|presidenta|procuradora)/i.test(role) ? 'f' : '');
    const article = g2(gender, 'seu', 'sua', 'seu(sua)');
    const repAddr = rep.same_address ? addr : fullAddress(rep);
    text += `, neste ato representada por ${article} ${role}, ${personQualification({ ...rep, gender: rep.gender || gender }, { address: repAddr })}`;
  }
  return `${text}.`;
}

/** Campos que faltam para a qualificação ficar completa (para avisar na ficha). */
export function missingFields(c = {}) {
  const miss = [];
  if (c.kind === 'pj') {
    if (!digits(c.cpf)) miss.push('CNPJ');
    if (!fullAddress(c)) miss.push('endereço da sede');
    if (!clean(parseRep(c).name)) miss.push('representante legal');
  } else {
    if (!digits(c.cpf)) miss.push('CPF');
    if (!clean(c.rg)) miss.push('RG');
    if (!clean(c.marital)) miss.push('estado civil');
    if (!clean(c.profession)) miss.push('profissão');
    if (!fullAddress(c)) miss.push('endereço');
  }
  return miss;
}

/** Nomes parecidos (mesmas palavras, sem acento): para avisar cliente duplicado. */
export function sameName(a, b) {
  const wa = fold(a).split(/\s+/).filter((w) => w.length > 2);
  const wb = fold(b).split(/\s+/).filter((w) => w.length > 2);
  if (!wa.length || !wb.length) return false;
  if (wa.join(' ') === wb.join(' ')) return true;
  const [s, l] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return s.length >= 2 && s[0] === l[0] && s.every((w) => l.includes(w));
}
