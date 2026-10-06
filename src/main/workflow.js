// Processo de trabalho do caso: as 10 etapas combinadas com o escritório
// (documento do projeto) e os documentos que costumam ser pedidos ao cliente
// em cada área. As etapas "automáticas" se concluem sozinhas a partir dos
// dados do caso; qualquer etapa pode ser marcada à mão (feito / não se aplica).

export const STEPS = [
  { key: 'triagem', label: 'Primeiro contato e triagem', hint: 'Nome, CPF e resumo do caso na ficha.' },
  { key: 'atendimento', label: 'Atendimento', hint: 'Consulta feita, ficha de atendimento salva.' },
  { key: 'proposta', label: 'Proposta de honorários', hint: 'Honorários combinados (aba Honorários).' },
  { key: 'contrato', label: 'Contrato e procuração', hint: 'Gerados dos modelos e assinados.' },
  { key: 'documentos', label: 'Solicitar documentação', hint: 'Lista de documentos pedida e recebida.' },
  { key: 'pasta', label: 'Pasta, cadastro e agenda', hint: 'Pasta do caso no OneDrive e prazos na agenda.' },
  { key: 'peticao', label: 'Petição e protocolo', hint: 'Protocolado: nº do processo informado.' },
  { key: 'cobranca', label: 'Cobrança de honorários', hint: 'Parcelas lançadas no financeiro.' },
  { key: 'acompanhamento', label: 'Acompanhamento processual', hint: 'Intimações, andamentos e retorno ao cliente.' },
  { key: 'encerramento', label: 'Encerramento', hint: 'Êxito cobrado, pasta para o arquivo morto, caso encerrado.' },
];

/**
 * Situação de cada etapa: `done` | `na` (não se aplica) | `open`.
 * `auto` diz se veio dos dados do caso (e não de alguém marcar).
 * ctx: { manual: [{step,status,done_at,user_name}], checklist: [...], payments: n, tasks: n }
 */
export function computeSteps(k, ctx = {}) {
  const manual = new Map((ctx.manual || []).map((m) => [m.step, m]));
  const list = ctx.checklist || [];
  const auto = {
    triagem: !!k.client_id,
    proposta: !!(k.fee_total || k.fee_success || (ctx.payments || 0) > 0),
    documentos: list.length > 0 && list.every((i) => i.status === 'recebido'),
    pasta: !!k.folder,
    peticao: !!k.process_number && k.kind !== 'consultivo',
    cobranca: (ctx.payments || 0) > 0,
    encerramento: k.status !== 'aberto',
  };
  const steps = STEPS.map((s) => {
    const m = manual.get(s.key);
    if (m) return { ...s, status: m.status === 'na' ? 'na' : 'done', auto: false, at: m.done_at, by: m.user_name };
    if (auto[s.key]) return { ...s, status: 'done', auto: true };
    return { ...s, status: 'open', auto: false };
  });
  // a etapa "solicitar documentação" mostra o andamento da lista
  const docs = steps.find((s) => s.key === 'documentos');
  if (list.length) docs.progress = `${list.filter((i) => i.status === 'recebido').length}/${list.length} recebidos`;
  const next = steps.find((s) => s.status === 'open' && s.key !== 'acompanhamento' && s.key !== 'encerramento')
    || (k.status === 'aberto' ? steps.find((s) => s.key === 'acompanhamento') : null);
  return { steps, next: next ? next.label : null, done: steps.filter((s) => s.status !== 'open').length, total: steps.length };
}

// ------------------------------------------------------------ documentos por área

const BASE = ['Documento de identidade (RG ou CNH)', 'CPF', 'Comprovante de residência atualizado'];

export const CHECKLISTS = {
  trabalhista: [
    'Carteira de trabalho (páginas de identificação e dos contratos)', 'Holerites / contracheques', 'Termo de rescisão (TRCT)',
    'Extrato do FGTS', 'Guias do seguro-desemprego', 'Provas: mensagens, fotos, cartões de ponto, nomes de testemunhas',
  ],
  previdenciario: [
    'Extrato do CNIS (Meu INSS)', 'Carta de indeferimento ou decisão do INSS', 'Laudos, exames e atestados médicos',
    'Carteira de trabalho', 'PPP (se trabalhou em atividade especial)', 'Senha do Meu INSS (gov.br) ou procuração',
  ],
  familia: [
    'Certidão de casamento ou declaração de união estável', 'Certidões de nascimento dos filhos', 'Comprovantes de renda',
    'Comprovantes de despesas dos filhos (escola, saúde)', 'Relação de bens (documentos de imóveis e veículos)',
  ],
  consumidor: [
    'Contrato ou comprovante da compra/serviço', 'Comprovantes de pagamento', 'Protocolos de atendimento',
    'Prints de conversas, e-mails e telas', 'Fotos ou vídeos do problema',
  ],
  civel: ['Contrato ou documento que originou o caso', 'Comprovantes de pagamento', 'Notificações e correspondências trocadas', 'Provas: fotos, prints, testemunhas'],
  imobiliario: ['Matrícula atualizada do imóvel', 'Contrato de compra e venda ou de locação', 'IPTU', 'Comprovantes de pagamento'],
  sucessoes: ['Certidão de óbito', 'Certidões de nascimento/casamento dos herdeiros', 'Documentos dos bens (matrículas, CRLV, extratos)', 'Testamento (se houver)'],
  criminal: ['Boletim de ocorrência', 'Intimações ou mandados recebidos', 'Provas e nomes de testemunhas'],
  tributario: ['Notificações / autos de infração', 'Guias e comprovantes de pagamento', 'Contrato social (empresa)'],
};

const AREA_KEYS = [
  [/trabalh/, 'trabalhista'], [/previd|inss|aposent|benef/, 'previdenciario'], [/famil|divor|alimento|guarda|uniao/, 'familia'],
  [/consum|voo|aere|banc/, 'consumidor'], [/imobil|loca|aluguel|usucap/, 'imobiliario'], [/sucess|invent|heran/, 'sucessoes'],
  [/crim|penal/, 'criminal'], [/tribut|fiscal/, 'tributario'], [/civ/, 'civel'],
];

/** Lista sugerida para o caso, pela área (ou pelo assunto, se a área estiver vazia). */
export function suggestedChecklist(k) {
  const text = `${k.area || ''} ${k.title || ''}`.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const key = AREA_KEYS.find(([re]) => re.test(text))?.[1];
  return { area: key || null, items: [...BASE, ...(key ? CHECKLISTS[key] : CHECKLISTS.civel)] };
}

export const DEFAULT_DOCS_TEMPLATE = 'Olá, {nome}! Para darmos andamento ao seu caso ({caso}), precisamos dos seguintes documentos:\n\n{lista}\n\n'
  + 'Pode enviar por aqui mesmo, por foto ou PDF. Qualquer dúvida, estou à disposição.';

/** Texto do pedido de documentos (revisado pela pessoa antes de enviar). */
export function docsRequestText(template, { nome, caso, itens }) {
  const first = String(nome || '').trim().split(/\s+/)[0] || '';
  return String(template || DEFAULT_DOCS_TEMPLATE)
    .replace(/\{nome\}/g, first)
    .replace(/\{nome_completo\}/g, nome || '')
    .replace(/\{caso\}/g, caso || '')
    .replace(/\{lista\}/g, itens.map((i) => `• ${i}`).join('\n'));
}

/** Próximo dia útil (seg–sex) depois de `days` dias úteis, às 9h. */
export function addBusinessDays(ts, days) {
  const d = new Date(ts);
  let n = 0;
  while (n < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) n++;
  }
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

export const PARTY_ROLES = [
  ['autor', 'Autor / requerente'], ['reu', 'Réu / requerido'], ['terceiro', 'Terceiro interessado'],
  ['adv_contrario', 'Advogado da parte contrária'], ['testemunha', 'Testemunha'], ['outro', 'Outro'],
];
