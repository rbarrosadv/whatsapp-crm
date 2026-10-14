// Página do cliente: andamentos do tribunal em palavras simples e o que fica de fora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientMoveText, SENSITIVE_MOVE, portalParts } from '../src/main/portal.js';

test('andamentos traduzidos para o cliente; rotina some; sensíveis marcados', () => {
  assert.equal(clientMoveText('Conclusos para decisão'), 'O processo foi para o juiz decidir um pedido');
  assert.equal(clientMoveText('Conclusos para sentença'), 'O processo foi para o juiz decidir o caso');
  assert.equal(clientMoveText('Audiência de conciliação designada para 20/11/2026'), 'Foi marcada uma audiência');
  assert.equal(clientMoveText('Juntada de Petição de contestação'), 'A outra parte apresentou a defesa');
  assert.equal(clientMoveText('Remetidos os autos ao Tribunal de Justiça'), 'O processo foi enviado ao tribunal para julgar o recurso');
  assert.equal(clientMoveText('Certidão de publicação'), null);
  assert.equal(clientMoveText('Decorrido prazo de FULANO'), null);
  assert.equal(clientMoveText('Algo diferente'), 'Houve uma movimentação no processo');
  for (const t of ['Julgado improcedente o pedido', 'Sentença proferida', 'Deferida a tutela de urgência', 'Penhora on-line via Sisbajud', 'Homologado o acordo', 'Expedição de alvará'])
    assert.ok(SENSITIVE_MOVE.test(t), t);
  assert.ok(!SENSITIVE_MOVE.test('Expedição de mandado de citação'));
  assert.deepEqual(portalParts(null), { moves: true, docs: true, faq: true, hearing: true, rating: true });
  assert.equal(portalParts('{"faq":false}').faq, false);
});
