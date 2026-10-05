// Correção automática em português do Brasil enquanto digita (como o teclado
// do celular): ao terminar a palavra (espaço ou pontuação), troca erros
// comuns e acentos esquecidos pela forma certa. Só correções sem ambiguidade —
// "esta/está", "e/é", "pais/país", "duvida/dúvida", "analise/análise" (verbo ×
// substantivo) ficam como você escreveu.
// Sem DOM aqui, para poder testar no Node.

const WORDS = {
  // acentos esquecidos (palavras do dia a dia)
  nao: 'não', voce: 'você', voces: 'vocês', tambem: 'também', entao: 'então', ja: 'já', ate: 'até',
  so: 'só', porem: 'porém', alem: 'além', apos: 'após', atraves: 'através', ninguem: 'ninguém',
  alguem: 'alguém', ha: 'há', la: 'lá', amanha: 'amanhã', manha: 'manhã',
  mae: 'mãe', irmao: 'irmão', irma: 'irmã', sao: 'são', estao: 'estão', vao: 'vão',
  terao: 'terão', serao: 'serão', farao: 'farão', poderao: 'poderão', deverao: 'deverão', estarao: 'estarão',
  tera: 'terá', sera: 'será', fara: 'fará', estara: 'estará', podera: 'poderá', devera: 'deverá',
  numero: 'número', numeros: 'números', codigo: 'código', proximo: 'próximo', proxima: 'próxima',
  ultimo: 'último', ultima: 'última', unico: 'único', unica: 'única', rapido: 'rápido', facil: 'fácil',
  dificil: 'difícil', pagina: 'página', paginas: 'páginas', juridico: 'jurídico', juridica: 'jurídica',
  judiciario: 'judiciário', forum: 'fórum', orcamento: 'orçamento', credito: 'crédito', debito: 'débito',
  familia: 'família', historico: 'histórico', medico: 'médico', periodo: 'período',
  conteudo: 'conteúdo', duvidas: 'dúvidas', necessario: 'necessário', necessaria: 'necessária',
  honorarios: 'honorários', honorario: 'honorário', titulo: 'título',
  endereco: 'endereço', comeco: 'começo', servico: 'serviço', servicos: 'serviços', preco: 'preço',
  cobranca: 'cobrança', sentenca: 'sentença', licenca: 'licença', diferenca: 'diferença', crianca: 'criança',
  criancas: 'crianças', heranca: 'herança', mudanca: 'mudança', seguranca: 'segurança', confianca: 'confiança',
  audiencia: 'audiência', audiencias: 'audiências', publico: 'público',
  otimo: 'ótimo', otima: 'ótima', obvio: 'óbvio', proprio: 'próprio',
  propria: 'própria', varios: 'vários', varias: 'várias', minimo: 'mínimo', maximo: 'máximo',
  saude: 'saúde', salario: 'salário', horario: 'horário', horarios: 'horários', calendario: 'calendário',
  escritorio: 'escritório', relatorio: 'relatório', cartorio: 'cartório', inventario: 'inventário',
  contrario: 'contrário', usuario: 'usuário', proprietario: 'proprietário', beneficio: 'benefício',
  previdenciario: 'previdenciário', imovel: 'imóvel', imoveis: 'imóveis', automovel: 'automóvel',
  veiculo: 'veículo', invalido: 'inválido', util: 'útil', uteis: 'úteis',
  sabado: 'sábado', acao: 'ação', acoes: 'ações', mao: 'mão', maos: 'mãos',
  razao: 'razão', opcao: 'opção', opcoes: 'opções', ola: 'olá', agua: 'água', ultimos: 'últimos', ultimas: 'últimas',
  tecnico: 'técnico', especifico: 'específico', basico: 'básico', clinica: 'clínica',
  logico: 'lógico', unicos: 'únicos', possivel: 'possível', impossivel: 'impossível', responsavel: 'responsável',
  disponivel: 'disponível', provavel: 'provável',
  // erros de digitação frequentes
  qeu: 'que', uqe: 'que', nõa: 'não', naõ: 'não', vcoê: 'você', obrigdo: 'obrigado',
  obrigda: 'obrigada', poruqe: 'porque', porqeu: 'porque', tambme: 'também', entoa: 'então',
  processso: 'processo', porcesso: 'processo', procurcao: 'procuração', advogdo: 'advogado',
};

// Terminações que em pt-BR sempre levam acento/cedilha (palavras de 5+ letras)
const ENDINGS = [
  [/coes$/, 'ções'], [/cao$/, 'ção'], [/soes$/, 'sões'], [/sao$/, 'são'],
  [/encia$/, 'ência'], [/encias$/, 'ências'], [/ancia$/, 'ância'], [/ancias$/, 'âncias'],
  [/avel$/, 'ável'], [/ivel$/, 'ível'], [/aveis$/, 'áveis'], [/iveis$/, 'íveis'],
];

/** Forma correta da palavra, ou null se não há o que corrigir. */
export function correctWord(word) {
  if (!word || /\d|[A-Z]{2}/.test(word)) return null; // números e siglas (OAB, STJ) ficam
  const lower = word.toLowerCase();
  let fixed = Object.hasOwn(WORDS, lower) ? WORDS[lower] : null;
  if (!fixed && lower.length >= 5 && /^[a-zç]+$/.test(lower)) {
    for (const [re, rep] of ENDINGS) {
      if (re.test(lower)) { fixed = lower.replace(re, rep); break; }
    }
  }
  if (!fixed || fixed === lower) return null;
  // mantém a maiúscula do começo ("Nao" → "Não")
  return word[0] !== word[0].toLowerCase() ? fixed[0].toUpperCase() + fixed.slice(1) : fixed;
}

/**
 * Chamado logo depois de digitar um espaço/pontuação no fim de `before`.
 * @returns {{before:string, from:string, to:string, sep:string} | null}
 */
export function autocorrectBefore(before) {
  const m = /([\p{L}]+)([\s.,!?;:)]+)$/u.exec(before);
  if (!m) return null;
  // pedaço de palavra com hífen ("pegá-la", "e-mail") fica como está
  if (/[-\p{L}@/]$/u.test(before.slice(0, before.length - m[0].length))) return null;
  const to = correctWord(m[1]);
  if (!to) return null;
  const start = before.length - m[0].length;
  return { before: before.slice(0, start) + to + m[2], from: m[1], to, sep: m[2] };
}
