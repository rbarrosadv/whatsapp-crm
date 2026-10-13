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
