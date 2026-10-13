// Documento pronto de outro cliente → modelo com campos (procuração do escritório).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeZip, readZip } from '../src/main/zip.js';
import { makeTemplate, hasMarkers, fillDocx, templateValues, docxText } from '../src/main/docs.js';

const B = '<w:rPr><w:b/></w:rPr>';
const BU = '<w:rPr><w:b/><w:u w:val="single"/></w:rPr>';
const r = (rPr, t) => `<w:r>${rPr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const p = (...runs) => `<w:p><w:pPr><w:jc w:val="both"/></w:pPr>${runs.join('')}</w:p>`;

function procuracao() {
  const body = [
    p(r(B, 'PROCURAÇÃO “AD JUDICIA ET EXTRA”')),
    // como o Word grava: nome e dados quebrados em vários pedaços
    p(r(BU, 'OUTORGANTE:'), r('', ' '), r(B, 'RONNICE '), '<w:proofErr w:type="spellStart"/>', r(B, 'DE ALMEIDA'), r('', ', brasileiro, casado, comerciante, nascido em 14/05/1974 (52 anos), natural de Cuiabá/MT, portador do RG nº 625820 SSP/MT e inscrito no CPF nº 503.471.'), r('', '791-34, residente e domiciliado na Rua Sebastiana Pereira da Silva, nº 01, Várzea Grande/MT, telefone (65) 99954-5615.')),
    p(r(BU, 'OUTORGADOS:'), r('', ' '), r(B, 'RAFAEL AUGUSTO DE BARROS CORRÊA,'), r('', ' brasileiro, solteiro, advogado, inscrito na OAB/MT nº 00000.')),
    p(r('', 'PODERES: os da cláusula ad judicia et extra, nascido em 3 de março de 1990 não muda.')),
    p(r('', 'Cuiabá/MT, 12 de '), r('', 'agosto de 2025.')),
    p(r(B, 'RONNICE DE ALMEIDA')),
    p(r('', 'CPF 503.471.791-34')),
  ].join('');
  return writeZip({ 'word/document.xml': `<w:document><w:body>${body}</w:body></w:document>` });
}

test('procuração pronta vira modelo e sai com os dados do cliente novo', () => {
  const buf = procuracao();
  assert.equal(hasMarkers(buf), false);
  const t = makeTemplate(buf);
  assert.ok(t, 'achou a qualificação');
  assert.equal(t.oldName, 'RONNICE DE ALMEIDA');
  assert.equal(hasMarkers(t.buf), true);
  const tplText = docxText(t.buf);
  assert.match(tplText, /OUTORGANTE: \{NOME\}, \{qualificacao_resto\}/);
  assert.doesNotMatch(tplText, /RONNICE|503\.471|Sebastiana/);
  assert.match(tplText, /RAFAEL AUGUSTO DE BARROS CORRÊA/, 'outorgados não mudam');
  assert.match(tplText, /Cuiabá\/MT, \{data_extenso\}\./);
  assert.match(tplText, /3 de março de 1990/, 'só a última data por extenso vira a do dia');
  // o nome continua em negrito
  const xml = readZip(t.buf).get('word/document.xml').toString();
  assert.match(xml, /<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">\{NOME\}<\/w:t><\/w:r>/);

  const elton = { name: 'Elton Rodrigues da Silva', kind: 'pf', nationality: 'brasileira', gender: 'm', marital: 'solteiro', profession: 'motorista', rg: '123456', rg_issuer: 'SSP/MT', cpf: '11122233396', street: 'Rua A', number: '10', district: 'Centro', city: 'Cuiabá', uf: 'MT', cep: '78000000' };
  const out = docxText(fillDocx(t.buf, templateValues(elton, null)));
  assert.match(out, /OUTORGANTE: ELTON RODRIGUES DA SILVA, brasileiro, solteiro, motorista, portador do RG nº 123456 SSP\/MT, inscrito no CPF sob o nº 111\.222\.333-96/);
  assert.match(out, /\nELTON RODRIGUES DA SILVA\n/);
  assert.match(out, /CPF 111\.222\.333-96/);
  assert.doesNotMatch(out, /RONNICE|\{/);
});

test('documento sem qualificação não é transformado', () => {
  const buf = writeZip({ 'word/document.xml': `<w:document><w:body>${p(r('', 'Texto qualquer sem outorgante.'))}</w:body></w:document>` });
  assert.equal(makeTemplate(buf), null);
});
