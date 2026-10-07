// Busca de endereço pelo CEP e de empresa pelo CNPJ em serviços públicos e
// gratuitos (ViaCEP, BrasilAPI; publica.cnpj.ws de reserva). Feita no servidor
// (o navegador não precisa sair do domínio do sistema). O ambiente de
// desenvolvimento na nuvem não alcança esses hosts: os testes passam um `fetch`
// com respostas no formato real e o modo demonstração responde sozinho.

const digits = (v) => String(v || '').replace(/\D/g, '');
const cap = (s) => String(s || '').trim();

/** Nome em maiúsculas da Receita → "Rua das Flores" (preposições minúsculas). */
export function titleCase(s) {
  const small = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'na', 'no', 'a', 'o']);
  return cap(s).toLowerCase().split(/\s+/).filter(Boolean)
    .map((w, i) => (i && small.has(w) ? w : w.replace(/^\p{L}/u, (c) => c.toUpperCase()))).join(' ');
}

async function getJson(fetchFn, url) {
  const r = await fetchFn(url, { headers: { Accept: 'application/json', 'User-Agent': 'BarrosAssociados/1.0' }, signal: AbortSignal.timeout?.(10000) });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function parseViaCep(j) {
  if (!j || j.erro) return null;
  return { cep: digits(j.cep), street: cap(j.logradouro), complement: cap(j.complemento), district: cap(j.bairro), city: cap(j.localidade), uf: cap(j.uf).toUpperCase() };
}
export function parseBrasilApiCep(j) {
  if (!j || !j.cep) return null;
  return { cep: digits(j.cep), street: cap(j.street), complement: '', district: cap(j.neighborhood), city: cap(j.city), uf: cap(j.state).toUpperCase() };
}

export async function lookupCep(cep, fetchFn = fetch) {
  const d = digits(cep);
  if (d.length !== 8) throw new Error('CEP deve ter 8 números.');
  let lastErr = null;
  for (const [url, parse] of [[`https://viacep.com.br/ws/${d}/json/`, parseViaCep], [`https://brasilapi.com.br/api/cep/v1/${d}`, parseBrasilApiCep]]) {
    try {
      const r = parse(await getJson(fetchFn, url));
      if (r) return r;
      lastErr = null;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw new Error('Não foi possível consultar o CEP agora. Preencha o endereço à mão.');
  return null;
}

/** BrasilAPI (/cnpj/v1) — dados da Receita. */
export function parseBrasilApiCnpj(j) {
  if (!j || !j.cnpj) return null;
  const street = [j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(' ');
  return {
    cnpj: digits(j.cnpj),
    name: cap(j.razao_social),
    trade_name: titleCase(j.nome_fantasia || ''),
    situation: cap(j.descricao_situacao_cadastral),
    cep: digits(j.cep), street: titleCase(street), number: cap(j.numero), complement: titleCase(j.complemento || ''),
    district: titleCase(j.bairro || ''), city: titleCase(j.municipio || ''), uf: cap(j.uf).toUpperCase(),
    email: cap(j.email).toLowerCase(),
    phone: digits(j.ddd_telefone_1),
    partners: (j.qsa || []).map((s) => ({ name: titleCase(s.nome_socio || ''), role: cap(s.qualificacao_socio).toLowerCase() })).filter((s) => s.name),
  };
}

/** publica.cnpj.ws (reserva). */
export function parseCnpjWs(j) {
  const e = j?.estabelecimento;
  if (!e) return null;
  const street = [e.tipo_logradouro, e.logradouro].filter(Boolean).join(' ');
  return {
    cnpj: digits(e.cnpj),
    name: cap(j.razao_social),
    trade_name: titleCase(e.nome_fantasia || ''),
    situation: cap(e.situacao_cadastral),
    cep: digits(e.cep), street: titleCase(street), number: cap(e.numero), complement: titleCase(e.complemento || ''),
    district: titleCase(e.bairro || ''), city: titleCase(e.cidade?.nome || ''), uf: cap(e.estado?.sigla).toUpperCase(),
    email: cap(e.email).toLowerCase(),
    phone: digits(`${e.ddd1 || ''}${e.telefone1 || ''}`),
    partners: (j.socios || []).map((s) => ({ name: titleCase(s.nome || ''), role: cap(s.qualificacao_socio?.descricao).toLowerCase() })).filter((s) => s.name),
  };
}

const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** A Receita escreve sem acento ("Cuiaba"): o CEP traz a grafia certa da cidade, bairro e rua. */
async function withAccents(r, fetchFn) {
  if (!r || r.cep?.length !== 8) return r;
  try {
    const c = await lookupCep(r.cep, fetchFn);
    if (!c) return r;
    const fix = (a, b) => (b && fold(a) === fold(b) ? b : a);
    return { ...r, city: fix(r.city, c.city) || c.city, uf: r.uf || c.uf, district: fix(r.district, c.district), street: fix(r.street, c.street) };
  } catch { return r; }
}

export async function lookupCnpj(cnpj, fetchFn = fetch) {
  const d = digits(cnpj);
  if (d.length !== 14) throw new Error('CNPJ deve ter 14 números.');
  let lastErr = null;
  for (const [url, parse] of [[`https://brasilapi.com.br/api/cnpj/v1/${d}`, parseBrasilApiCnpj], [`https://publica.cnpj.ws/cnpj/${d}`, parseCnpjWs]]) {
    try {
      const r = parse(await getJson(fetchFn, url));
      if (r) return withAccents(r, fetchFn);
      lastErr = null;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw new Error('Não foi possível consultar o CNPJ agora. Preencha os dados à mão.');
  return null;
}

/** Respostas do modo demonstração (sem internet). */
export function demoLookupFetch(url) {
  const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  if (url.includes('viacep')) {
    const cep = url.match(/ws\/(\d{8})/)?.[1];
    return ok({ cep: `${cep.slice(0, 5)}-${cep.slice(5)}`, logradouro: 'Avenida Historiador Rubens de Mendonça', complemento: '', bairro: 'Bosque da Saúde', localidade: 'Cuiabá', uf: 'MT' });
  }
  if (url.includes('/cnpj/')) {
    const d = url.match(/(\d{14})/)?.[1];
    return ok({
      cnpj: d, razao_social: 'PAPELARIA NOBRE COMERCIO LTDA', nome_fantasia: 'PAPEL NOBRE', descricao_situacao_cadastral: 'ATIVA',
      descricao_tipo_de_logradouro: 'AVENIDA', logradouro: 'GETULIO VARGAS', numero: '1200', complemento: 'SALA 3', bairro: 'CENTRO NORTE',
      municipio: 'CUIABA', uf: 'MT', cep: '78005370', email: 'CONTATO@PAPELNOBRE.COM.BR', ddd_telefone_1: '6533221100',
      qsa: [{ nome_socio: 'MARIA DAS GRACAS NOBRE', qualificacao_socio: 'Sócio-Administrador' }],
    });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
}
