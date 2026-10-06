// Tribunais: número CNJ, contagem de prazo e leitura das respostas do DJEN e
// do DataJud (no formato que as APIs públicas do CNJ devolvem).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nameCase, tribunalOf, datajudIndex, formatCnj, deadlineFromAvailability, parseDjenItem, parseDatajudHit, CourtsService, isCourtDay,
} from '../src/main/courts.js';

test('número CNJ → tribunal e índice do DataJud', () => {
  assert.equal(tribunalOf('1001234-56.2026.8.11.0041'), 'TJMT');
  assert.equal(datajudIndex('1001234-56.2026.8.11.0041'), 'api_publica_tjmt');
  assert.equal(tribunalOf('0000123-45.2026.5.23.0001'), 'TRT23');
  assert.equal(tribunalOf('1000000-00.2026.4.01.3600'), 'TRF1');
  assert.equal(tribunalOf('0700000-00.2026.8.07.0001'), 'TJDFT');
  assert.equal(formatCnj('10012345620268110041'), '1001234-56.2026.8.11.0041');
  assert.equal(tribunalOf('123'), null);
});

test('prazo do DJEN: publicação no dia útil seguinte, contagem em dias úteis, feriados e recesso', () => {
  const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
  const day = (ts) => new Date(ts).toISOString().slice(0, 10);
  // disponibilizado sexta 09/10/2026; 12/10 é feriado → publicado terça 13/10; 15 dias úteis (Finados no meio) → 04/11
  let r = deadlineFromAvailability(at(2026, 10, 9), 15);
  assert.equal(new Date(r.published).getDate(), 13);
  assert.equal(day(r.due - 3 * 3600e3), '2026-11-04');
  // recesso forense: disponibilizado 17/12 → prazo de 5 dias só corre depois de 20/01
  r = deadlineFromAvailability(at(2026, 12, 17), 5);
  assert.equal(day(r.due - 3 * 3600e3), '2027-01-27');
  assert.equal(isCourtDay(new Date(2027, 1, 9)), false, 'Carnaval 2027 (terça, 09/02)');
});

const DJEN_ITEM = {
  id: 123456, data_disponibilizacao: '2026-10-05', siglaTribunal: 'TJMT', tipoComunicacao: 'Intimação', nomeOrgao: '3ª VARA CÍVEL DE CUIABÁ',
  texto: '<p>Intimem-se as partes &amp; procuradores.</p><br>Prazo: 15 dias.', numero_processo: '10012345620268110041',
  numeroprocessocommascara: '1001234-56.2026.8.11.0041', link: 'https://x', tipoDocumento: 'Despacho', nomeClasse: 'PROCEDIMENTO COMUM CÍVEL',
  destinatarios: [{ nome: 'MARIA DA SILVA', polo: 'A', comunicacao_id: 123456 }],
  destinatarioadvogados: [{ id: 1, advogado: { nome: 'RAFAEL AUGUSTO DE BARROS CORREA', numero_oab: '14271', uf_oab: 'MT' } }],
};

test('DJEN: comunicação vira intimação legível', () => {
  const i = parseDjenItem(DJEN_ITEM);
  assert.equal(i.ext_id, '123456');
  assert.equal(i.process_number, '1001234-56.2026.8.11.0041');
  assert.equal(i.tribunal, 'TJMT');
  assert.equal(i.doc_kind, 'Despacho');
  assert.equal(new Date(i.date).getDate(), 5);
  assert.equal(i.text, 'Intimem-se as partes & procuradores.\n\nPrazo: 15 dias.');
  assert.deepEqual(i.parties, [{ name: 'MARIA DA SILVA', polo: 'A' }]);
  assert.equal(i.lawyers[0].oab, '14271');
});

test('DJEN: consulta pela OAB percorre as páginas sem rajada', async () => {
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(Object.fromEntries(u.searchParams));
    const page = Number(u.searchParams.get('pagina'));
    const items = page === 1 ? Array.from({ length: 100 }, (_, n) => ({ ...DJEN_ITEM, id: n })) : [{ ...DJEN_ITEM, id: 999 }];
    return new Response(JSON.stringify({ status: 'success', count: 101, items }));
  };
  const s = new CourtsService({ fetch });
  const list = await s.djenByOab({ number: '14.271', uf: 'mt', from: Date.now() - 864e5, to: Date.now() });
  assert.equal(list.length, 101);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].numeroOab, '14271');
  assert.equal(calls[0].ufOab, 'MT');
});

test('DataJud: andamentos e dados do processo; erro de rede vira mensagem clara', async () => {
  const p = parseDatajudHit({
    numeroProcesso: '10012345620268110041', tribunal: 'TJMT', classe: { nome: 'Procedimento Comum Cível' }, orgaoJulgador: { nome: '3ª VARA CÍVEL' },
    dataAjuizamento: '20260115000000', movimentos: [{ codigo: 26, nome: 'Distribuído por sorteio', dataHora: '2026-01-15T10:00:00.000Z' },
      { codigo: 581, nome: 'Juntada', complementosTabelados: [{ nome: 'Petição' }], dataHora: '2026-02-01T10:00:00.000Z' }],
  });
  assert.equal(p.filed_at, '2026-01-15');
  assert.equal(p.orgao, '3ª VARA CÍVEL');
  assert.equal(p.moves[1].text, 'Juntada (Petição)');
  let sent;
  const ok = new CourtsService({ fetch: async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ hits: { hits: [] } })); } });
  assert.equal(await ok.datajud('1001234-56.2026.8.11.0041'), null);
  assert.match(sent.url, /api_publica_tjmt\/_search$/);
  assert.match(sent.init.headers.Authorization, /^APIKey /);
  const off = new CourtsService({ fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(off.datajud('1001234-56.2026.8.11.0041'), /Sem resposta de api-publica\.datajud\.cnj\.jus\.br \(ENOTFOUND\)/);
});

test('nomes em maiúsculas do DJEN viram nome próprio', () => {
  assert.equal(nameCase('RAFAEL AUGUSTO DE BARROS CORREA'), 'Rafael Augusto de Barros Correa');
  assert.equal(nameCase('ÉLISA DA SILVA E SOUZA'), 'Élisa da Silva e Souza');
  assert.equal(nameCase('Maria de Tal'), 'Maria de Tal');
});
