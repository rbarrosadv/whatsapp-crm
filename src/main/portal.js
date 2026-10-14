// Página de acompanhamento do cliente (como o rastreio de um pedido): as fases
// do processo em palavras do cliente, a etapa atual explicada, o próximo
// compromisso e as novidades que a equipe aprovou. Nada interno aparece.
import { rulerPhases } from '../renderer/js/phases.js';

/** Nome da fase para o cliente + o que ela significa (curto, sem juridiquês). */
export const CLIENT_PHASES = {
  pre: ['Preparando a ação', 'Estamos reunindo os documentos e preparando o seu pedido para entrar na Justiça.'],
  inicial: ['Ação protocolada', 'Seu pedido já está na Justiça. Agora o juiz vai analisar e mandar avisar a outra parte.'],
  citacao: ['A outra parte foi avisada', 'A Justiça está comunicando oficialmente a outra parte, que terá prazo para se defender.'],
  contestacao: ['Defesa e nossa resposta', 'A outra parte apresenta a defesa e nós respondemos ao juiz.'],
  audiencia: ['Audiência', 'Há uma audiência no caminho. Vamos conversar antes para prepararmos tudo.'],
  instrucao: ['Provas e testemunhas', 'É a fase das provas: documentos, perícia ou testemunhas, conforme o caso.'],
  conclusos: ['Aguardando a decisão do juiz', 'O processo está com o juiz para decidir. Agora é aguardar.'],
  sentenca: ['Sentença', 'O juiz decidiu o caso. Explicamos o que isso significa para você.'],
  recurso: ['Recurso', 'A decisão está sendo revista por um tribunal, a pedido de uma das partes.'],
  superiores: ['Tribunais superiores', 'O processo está em Brasília, num tribunal superior, para uma última análise.'],
  transito: ['Decisão definitiva', 'A decisão ficou definitiva: não cabe mais recurso.'],
  liquidacao: ['Cálculo dos valores', 'Estamos calculando o valor exato do que foi decidido.'],
  cumprimento: ['Cobrança do que foi decidido', 'Estamos cobrando na Justiça o cumprimento da decisão.'],
  pagamento: ['Pagamento', 'Fase de acordo ou pagamento dos valores.'],
  suspenso: ['Processo suspenso', 'O processo está parado por um motivo previsto em lei. Avisamos quando voltar a andar.'],
  arquivado: ['Arquivado provisoriamente', 'O processo foi guardado por enquanto. Seguimos de olho e avisamos se houver novidade.'],
  encerrado: ['Concluído', 'Processo concluído.'],
  inss_protocolo: ['Pedido protocolado', 'Seu pedido foi feito no INSS.'],
  inss_analise: ['Em análise no INSS', 'O INSS está analisando o pedido. Acompanhamos pelo Meu INSS.'],
  inss_exigencia: ['O INSS pediu documentos', 'O INSS pediu documentos ou informações. Vamos falar com você para providenciar.'],
  inss_pericia: ['Perícia', 'Há uma perícia ou avaliação marcada no INSS.'],
  inss_decisao: ['Decisão do INSS', 'O INSS decidiu o pedido. Explicamos o resultado para você.'],
  inss_recurso: ['Recurso', 'Recorremos da decisão do INSS.'],
};

const DRAFT_TEXT = {
  documentos: 'Estamos aguardando alguns documentos para preparar a sua ação.',
  redacao: 'Estamos escrevendo o seu pedido.',
  revisao: 'O seu pedido está em revisão final.',
  pronta: 'O seu pedido está pronto e será protocolado em breve.',
};

/**
 * Etapas do processo para o cliente: o caminho principal + as fases por onde ele
 * já passou (com a data), a atual destacada e as próximas em cinza.
 */
export function clientSteps(k, history = [], cfg) {
  const kind = k.kind === 'inss' ? 'inss' : 'judicial';
  const current = k.phase || (kind === 'inss' ? 'inss_protocolo' : (k.process_number ? 'inicial' : 'pre'));
  const visited = [...new Set(history.map((h) => h.phase))];
  let list = rulerPhases(cfg, kind, current, visited).map((p) => p.id);
  if (kind === 'judicial' && !list.includes('pre') && (current === 'pre' || visited.includes('pre'))) list = ['pre', ...list];
  if (kind === 'judicial' && current === 'pre' && !list.includes('pre')) list.unshift('pre');
  const at = new Map();
  for (const h of history) if (!at.has(h.phase)) at.set(h.phase, h.at);
  const idx = Math.max(0, list.indexOf(current));
  const steps = list.map((id, i) => {
    const [label, desc] = CLIENT_PHASES[id] || [id, ''];
    const state = i < idx ? 'done' : i === idx ? (current === 'encerrado' ? 'done' : 'current') : 'next';
    return {
      id, label, state,
      date: at.get(id) || (i === idx ? k.phase_since || null : null),
      desc: state === 'current' ? (id === 'pre' && k.draft_status && DRAFT_TEXT[k.draft_status] ? DRAFT_TEXT[k.draft_status] : desc) : null,
    };
  });
  return { steps, current, index: idx + 1, total: list.length, label: (CLIENT_PHASES[current] || [current])[0] };
}

/** O texto que a equipe aprovou, sem a saudação e a despedida (fica só a notícia). */
export function newsText(text) {
  let t = String(text || '').trim()
    .replace(/^\*[^*\n]{1,40}:\*\s*/, '') // assinatura "*Rafael:*"
    .replace(/^ol[áa][^!\n]{0,60}!\s*/i, '')
    .replace(/^passando para (dar not[íi]cia|informar|avisar)[^:]{0,120}:\s*/i, '')
    .replace(/\n+\s*(qualquer d[úu]vida|estamos [àa] disposi|abra[çc]os|att\.?)[\s\S]*$/i, '')
    .trim();
  if (t) t = t[0].toUpperCase() + t.slice(1);
  return t.slice(0, 1500);
}

// ------------------------------------------------------------ andamentos para o cliente

/**
 * Andamentos que só aparecem depois que a equipe explicar ao cliente (podem ser
 * má notícia, ou pedem uma conversa antes): sentença, decisão, acordo, penhora…
 */
export const SENSITIVE_MOVE = /senten[cç]a|julg(ad[oa]|o |amento)|procedente|improcedente|indefer|deferid|decis[aã]o|liminar|tutela|acord[aã]o|acordo|homolog|penhora|bloqueio|sisbajud|bacenjud|extin[cç]|arquiv|tr[aâ]nsito|multa|conden|revelia|desist|ren[uú]ncia|alvar[aá]|pagamento|rpv|precat[oó]rio|perda|nulidade|recurso (n[aã]o )?(conhecido|provido)/i;

/** Andamentos de rotina que não dizem nada ao cliente (somem da página). */
export const ROUTINE_CLIENT = /juntada de (aviso|ar\b|guia|procura)|mero expediente|ato ordinat|expedi[cç][aã]o de certid|decorrid[oa] (o )?prazo|publicad[oa]|disponibilizad[oa]|remessa interna|redistribu|certid[aã]o|confirmad[oa] a intima|ci[eê]ncia|leitura|aguardando|retifica[cç][aã]o de autua|evolu[cç][aã]o da classe|altera[cç][aã]o de (classe|assunto|parte)|cadastr|anota[cç][aã]o/i;

/** Tradução dos andamentos mais comuns para palavras simples (do mais específico ao geral). */
const MOVE_TEXT = [
  [/distribu[ií]d[oa]|distribui[cç][aã]o/i, 'O processo foi registrado na Justiça e enviado a uma vara'],
  [/peti[cç][aã]o inicial/i, 'O pedido inicial foi registrado na Justiça'],
  [/conclusos? para (senten|julgamento)/i, 'O processo foi para o juiz decidir o caso'],
  [/conclusos? para decis/i, 'O processo foi para o juiz decidir um pedido'],
  [/conclusos?/i, 'O processo foi para o juiz analisar'],
  [/expedi[cç][aã]o de mandado de cita|mandado de cita|carta de cita/i, 'A Justiça mandou avisar oficialmente a outra parte'],
  [/cita[cç][aã]o.*(cumprid|efetivad|positiv)|citad[oa]/i, 'A outra parte foi avisada oficialmente do processo'],
  [/cita[cç][aã]o/i, 'A Justiça está avisando a outra parte'],
  [/contesta[cç][aã]o/i, 'A outra parte apresentou a defesa'],
  [/r[eé]plica|impugna[cç][aã]o [àa] contesta/i, 'Respondemos à defesa da outra parte'],
  [/designad[oa].*audi[eê]ncia|audi[eê]ncia.*designad|audi[eê]ncia.*(marcad|agendad)/i, 'Foi marcada uma audiência'],
  [/audi[eê]ncia.*(realizad|ocorrid)/i, 'A audiência foi realizada'],
  [/audi[eê]ncia.*(cancelad|redesignad|adiad)/i, 'A audiência foi remarcada ou cancelada'],
  [/per[ií]cia|perito|laudo/i, 'Andamento da perícia (avaliação técnica)'],
  [/testemunha/i, 'Andamento sobre as testemunhas'],
  [/juntada de peti[cç][aã]o|peti[cç][aã]o (juntada|protocolad)/i, 'Foi anexado um pedido ao processo'],
  [/juntada de (documento|of[ií]cio|mandado)/i, 'Foi anexado um documento ao processo'],
  [/intima[cç][aã]o|intimad[oa]/i, 'A Justiça enviou uma comunicação às partes'],
  [/despacho/i, 'O juiz deu um encaminhamento ao processo'],
  [/remetid[oa]s? (os autos )?(ao|para o?) (tribunal|tj|trt|trf|2[ºo] grau|inst[aâ]ncia superior)|remessa ao (tribunal|tj|trt|trf)/i, 'O processo foi enviado ao tribunal para julgar o recurso'],
  [/recebid[oa]s? os autos|baixa(dos)? os autos|retorno dos autos/i, 'O processo voltou para a vara de origem'],
  [/recurso|apela[cç][aã]o|agravo|embargos/i, 'Andamento sobre um recurso'],
  [/suspens[aã]o|suspens[oa]|sobrestad/i, 'O processo foi suspenso por enquanto'],
  [/c[aá]lculo|liquida[cç]/i, 'Andamento sobre o cálculo dos valores'],
  [/cumprimento de senten/i, 'Andamento da cobrança do que foi decidido'],
];

/** Andamento do tribunal em palavras do cliente; null = rotina (não mostra). */
export function clientMoveText(text) {
  const t = String(text || '');
  if (!t.trim() || ROUTINE_CLIENT.test(t)) return null;
  for (const [re, label] of MOVE_TEXT) if (re.test(t)) return label;
  return 'Houve uma movimentação no processo';
}

/** Dúvidas comuns em cada fase (o escritório pode trocar em Ajustes → `portalFaq`). */
export const DEFAULT_FAQ = {
  pre: [['Quando a ação entra na Justiça?', 'Assim que tivermos todos os documentos e o pedido estiver revisado. Avisamos você no mesmo dia.'],
    ['Preciso fazer alguma coisa?', 'Se houver algum documento pendente, ele aparece aqui na página em "O que precisamos de você".']],
  inicial: [['E agora?', 'O juiz vai analisar o pedido e mandar avisar a outra parte. Essa etapa costuma levar algumas semanas.'],
    ['Preciso fazer alguma coisa?', 'Por enquanto não. Se precisarmos de algo, avisamos você.']],
  citacao: [['Por que demora?', 'A Justiça precisa encontrar e avisar oficialmente a outra parte. Às vezes o endereço muda e é preciso tentar de novo.'],
    ['Preciso fazer alguma coisa?', 'Não. Se você souber um endereço novo da outra parte, conte para nós.']],
  contestacao: [['O que é a defesa?', 'É a resposta da outra parte ao seu pedido. Nós lemos e respondemos ao juiz.'],
    ['Preciso fazer alguma coisa?', 'Às vezes pedimos informações ou documentos para rebater a defesa. Se for o caso, entramos em contato.']],
  audiencia: [['Preciso ir à audiência?', 'Sim, a sua presença costuma ser obrigatória. Confirme aqui na página e conversamos antes para prepararmos tudo.'],
    ['O que levar?', 'Documento com foto e, se tiver, os documentos que combinamos. Chegue 30 minutos antes (ou entre no link 10 minutos antes, se for virtual).']],
  instrucao: [['O que acontece nesta fase?', 'É quando se produzem as provas: perícia, documentos ou testemunhas.'],
    ['Preciso fazer alguma coisa?', 'Se houver perícia ou testemunhas, combinamos com você os detalhes.']],
  conclusos: [['Por que demora?', 'O processo está com o juiz para decidir. O tempo depende da quantidade de processos da vara, e não há como apressar.'],
    ['Preciso fazer alguma coisa?', 'Não. Assim que sair a decisão, explicamos o que ela significa.']],
  sentenca: [['O que é a sentença?', 'É a decisão do juiz sobre o caso. Vamos explicar o resultado e os próximos passos com você.'],
    ['Ainda pode mudar?', 'Sim, qualquer das partes pode recorrer. Conversamos sobre isso.']],
  recurso: [['O que é o recurso?', 'É o pedido para um tribunal rever a decisão. Costuma levar alguns meses.'],
    ['Preciso fazer alguma coisa?', 'Não. Acompanhamos o julgamento e avisamos você.']],
  transito: [['O que significa?', 'A decisão ficou definitiva: não cabe mais recurso.'], ['E agora?', 'Se houver valores a receber, começa a fase de cobrança.']],
  cumprimento: [['Quando recebo?', 'Depende de a outra parte pagar ou de a Justiça localizar bens. Avisamos a cada novidade.'],
    ['Preciso fazer alguma coisa?', 'Mantenha seus dados bancários atualizados conosco.']],
  inss_analise: [['Por que demora?', 'O INSS tem prazos longos de análise. Acompanhamos pelo Meu INSS.'], ['Preciso fazer alguma coisa?', 'Não, a não ser que o INSS peça documentos.']],
};

/** Partes da página que cada cliente vê (padrão: todas). */
export const PORTAL_PARTS = { moves: 'Andamentos do tribunal (automáticos)', docs: 'Documentos que faltam', faq: 'Perguntas frequentes', hearing: 'Confirmar presença na audiência', rating: 'Avaliação ao final' };
export function portalParts(json) {
  let p = {};
  try { p = JSON.parse(json || '{}') || {}; } catch { /* padrão */ }
  return Object.fromEntries(Object.keys(PORTAL_PARTS).map((k) => [k, p[k] !== false]));
}
