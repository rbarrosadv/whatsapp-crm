// Qualificação das partes e busca de CEP/CNPJ (respostas no formato real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualification, fullAddress, missingFields, sameName, looksLikeCompany, maritalText } from '../src/renderer/js/qualify.js';
import { lookupCep, lookupCnpj, parseViaCep, titleCase } from '../src/main/lookup.js';

test('qualificação de pessoa física com concordância', () => {
  const c = {
    name: 'Maria das Graças Souza', gender: 'f', nationality: 'brasileiro(a)', marital: 'casado', profession: 'Professora',
    rg: '1234567', rg_issuer: 'ssp/mt', cpf: '12345678900', email: 'maria@ex.com',
    street: 'Rua das Flores', number: '10', complement: 'Apto 2', district: 'Centro', city: 'Cuiabá', uf: 'mt', cep: '78000000',
  };
  assert.equal(qualification(c),
    'MARIA DAS GRAÇAS SOUZA, brasileira, casada, professora, portadora do RG nº 1234567 SSP/MT, inscrita no CPF sob o nº 123.456.789-00, '
    + 'com endereço eletrônico maria@ex.com, residente e domiciliada na Rua das Flores, nº 10, Apto 2, Bairro Centro, Cuiabá/MT, CEP 78000-000.');
  assert.match(qualification({ name: 'João', gender: 'm', marital: 'uniao_estavel' }), /^JOÃO, brasileiro, convivente em união estável\.$/);
  assert.equal(maritalText('viuvo', 'f'), 'viúva');
  assert.equal(maritalText('casado'), 'casado(a)');
  assert.deepEqual(missingFields({ name: 'X' }), ['CPF', 'RG', 'estado civil', 'profissão', 'endereço']);
  assert.equal(fullAddress({ street: 'Av. Brasil', number: 'sn', city: 'Cuiabá', uf: 'MT' }), 'Av. Brasil, s/nº, Cuiabá/MT');
});

test('qualificação de empresa com representante', () => {
  const c = {
    kind: 'pj', name: 'Papelaria Nobre Comercio Ltda', cpf: '12345678000190', street: 'Avenida Getulio Vargas', number: '1200', city: 'Cuiabá', uf: 'MT',
    rep: JSON.stringify({ name: 'Maria Nobre', role: 'sócia-administradora', gender: 'f', marital: 'solteiro', profession: 'empresária', cpf: '11122233344', same_address: true }),
  };
  const q = qualification(c);
  assert.match(q, /^PAPELARIA NOBRE COMERCIO LTDA, pessoa jurídica de direito privado, inscrita no CNPJ sob o nº 12\.345\.678\/0001-90, com sede na Avenida Getulio Vargas, nº 1200, Cuiabá\/MT, neste ato representada por sua sócia-administradora, MARIA NOBRE, brasileira, solteira, empresária, inscrita no CPF sob o nº 111\.222\.333-44, residente e domiciliada na Avenida Getulio Vargas/);
  assert.deepEqual(missingFields({ kind: 'pj', name: 'X' }), ['CNPJ', 'endereço da sede', 'representante legal']);
  assert.ok(looksLikeCompany('Doce Sabor Restaurante LTDA'));
  assert.ok(!looksLikeCompany('Elson Ferreira Barros'));
});

test('nomes parecidos para avisar cliente repetido', () => {
  assert.ok(sameName('JOAO DA SILVA', 'João da Silva'));
  assert.ok(sameName('João Silva', 'João Pedro da Silva'));
  assert.ok(!sameName('João Silva', 'Maria Silva'));
  assert.ok(!sameName('Silva', 'João Silva'));
});

test('busca de CEP (ViaCEP, BrasilAPI de reserva) e CNPJ (BrasilAPI, publica.cnpj.ws de reserva)', async () => {
  const calls = [];
  const fake = (routes) => async (url) => {
    calls.push(url);
    const r = routes.find(([re]) => re.test(url));
    if (!r) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: r[1] < 400, status: r[1], json: async () => r[2] };
  };
  const cep = await lookupCep('78.043-306', fake([[/viacep/, 200, { cep: '78043-306', logradouro: 'Rua Presidente Marques', complemento: '', bairro: 'Quilombo', localidade: 'Cuiabá', uf: 'MT' }]]));
  assert.deepEqual(cep, { cep: '78043306', street: 'Rua Presidente Marques', complement: '', district: 'Quilombo', city: 'Cuiabá', uf: 'MT' });
  assert.equal(parseViaCep({ erro: true }), null);
  const viaBr = await lookupCep('78043306', fake([[/viacep/, 500, {}], [/brasilapi/, 200, { cep: '78043306', state: 'MT', city: 'Cuiabá', neighborhood: 'Quilombo', street: 'Rua Presidente Marques' }]]));
  assert.equal(viaBr.district, 'Quilombo');
  assert.equal(await lookupCep('00000000', fake([[/viacep/, 200, { erro: true }], [/brasilapi/, 404, {}]])), null);
  await assert.rejects(lookupCep('123', fake([])), /8 números/);

  const cnpj = await lookupCnpj('12.345.678/0001-90', fake([[/brasilapi/, 200, {
    cnpj: '12345678000190', razao_social: 'DOCE SABOR RESTAURANTE LTDA', nome_fantasia: 'DOCE SABOR', descricao_situacao_cadastral: 'ATIVA',
    descricao_tipo_de_logradouro: 'RUA', logradouro: 'TREZE DE JUNHO', numero: '500', complemento: '', bairro: 'CENTRO SUL',
    municipio: 'CUIABA', uf: 'MT', cep: '78020000', email: null, ddd_telefone_1: '6530001111',
    qsa: [{ nome_socio: 'JOSE DA SILVA', qualificacao_socio: 'Sócio-Administrador' }],
  }]]));
  assert.equal(cnpj.name, 'DOCE SABOR RESTAURANTE LTDA');
  assert.equal(cnpj.street, 'Rua Treze de Junho');
  assert.equal(cnpj.city, 'Cuiaba');
  assert.deepEqual(cnpj.partners, [{ name: 'Jose da Silva', role: 'sócio-administrador' }]);
  const ws = await lookupCnpj('12345678000190', fake([[/brasilapi/, 503, {}], [/cnpj\.ws/, 200, {
    razao_social: 'DOCE SABOR RESTAURANTE LTDA', socios: [],
    estabelecimento: { cnpj: '12345678000190', nome_fantasia: null, tipo_logradouro: 'RUA', logradouro: 'TREZE DE JUNHO', numero: '500', bairro: 'CENTRO SUL', cep: '78020000', cidade: { nome: 'Cuiabá' }, estado: { sigla: 'MT' }, situacao_cadastral: 'Ativa' },
  }]]));
  assert.equal(ws.city, 'Cuiabá');
  assert.equal(titleCase('AVENIDA DO CPA'), 'Avenida do Cpa');
});
