// Fase do processo pelos andamentos (regras em src/renderer/js/phases.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phaseFromText, derivePhase, phaseList, rulerPhases, phaseLabel } from '../src/renderer/js/phases.js';

const d = (s) => { const [dd, mm, yy] = s.split('/').map(Number); return new Date(yy, mm - 1, dd).getTime(); };

test('andamento → fase', () => {
  assert.equal(phaseFromText('Distribuído por sorteio'), 'inicial');
  assert.equal(phaseFromText('Expedida carta de citação'), 'citacao');
  assert.equal(phaseFromText('Juntada de contestação'), 'contestacao');
  assert.equal(phaseFromText('Audiência de instrução designada para 14/10/2026 14:00'), 'audiencia');
  assert.equal(phaseFromText('Laudo pericial juntado'), 'instrucao');
  assert.equal(phaseFromText('Conclusos para sentença'), 'conclusos');
  assert.equal(phaseFromText('Conclusos para despacho'), null);
  assert.equal(phaseFromText('Julgado procedente em parte o pedido'), 'sentenca');
  assert.equal(phaseFromText('Recebido o recurso de apelação'), 'recurso');
  assert.equal(phaseFromText('Recurso especial admitido'), 'superiores');
  assert.equal(phaseFromText('Certidão de trânsito em julgado'), 'transito');
  assert.equal(phaseFromText('Iniciado o cumprimento de sentença'), 'cumprimento');
  assert.equal(phaseFromText('Expedido alvará de levantamento'), 'pagamento');
  assert.equal(phaseFromText('Arquivamento provisório (art. 921, III, CPC)'), 'arquivado');
  assert.equal(phaseFromText('Desarquivamento'), 'desarquivar');
  assert.equal(phaseFromText('Juntada de petição'), null);
});

test('fase só avança; arquivado/suspenso entram e saem', () => {
  const moves = [
    { ts: d('02/03/2025'), text: 'Distribuído por sorteio' },
    { ts: d('20/03/2025'), text: 'Citação' },
    { ts: d('15/05/2025'), text: 'Sentença: julgado procedente' },
    { ts: d('30/06/2025'), text: 'Trânsito em julgado' },
    { ts: d('15/08/2025'), text: 'Cumprimento de sentença iniciado' },
    { ts: d('01/09/2025'), text: 'Mandado de citação do executado' }, // não volta para citação
    { ts: d('15/03/2026'), text: 'Arquivamento provisório' },
    { ts: d('10/09/2026'), text: 'Desarquivamento' },
  ];
  const r = derivePhase(moves);
  assert.equal(r.phase, 'cumprimento', 'desarquivado volta para onde estava');
  assert.deepEqual(r.history.map((h) => h.phase), ['citacao', 'sentenca', 'transito', 'cumprimento', 'arquivado', 'cumprimento']);
  // escolhido à mão: vale até um andamento levar adiante
  const manual = derivePhase(moves, { start: 'recurso', startTs: d('01/07/2025') });
  assert.equal(manual.phase, 'cumprimento');
  const stay = derivePhase([{ ts: d('01/08/2025'), text: 'Citação' }], { start: 'recurso', startTs: d('01/07/2025') });
  assert.equal(stay.phase, 'recurso');
});

test('configuração do escritório: nomes, escondidas, fase a mais e responsável', () => {
  const cfg = { names: { pagamento: 'Pagamento / alvará' }, hidden: ['superiores'], custom: [{ id: 'c_precatorio', label: 'Precatório', after: 'cumprimento' }], resp: { inicial: 3 } };
  const list = phaseList(cfg);
  assert.equal(list.find((p) => p.id === 'pagamento').label, 'Pagamento / alvará');
  assert.equal(list.findIndex((p) => p.id === 'c_precatorio'), list.findIndex((p) => p.id === 'cumprimento') + 1);
  assert.equal(list.find((p) => p.id === 'inicial').resp, 3);
  assert.equal(phaseLabel('c_precatorio', JSON.stringify(cfg)), 'Precatório');
  const ruler = rulerPhases(cfg, 'judicial', 'arquivado', ['inicial', 'citacao']).map((p) => p.id);
  assert.ok(ruler.includes('arquivado') && !ruler.includes('superiores') && !ruler.includes('suspenso'));
  assert.ok(rulerPhases(null, 'inss', 'inss_exigencia').some((p) => p.id === 'inss_exigencia'));
});
