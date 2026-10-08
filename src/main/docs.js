// Documentos do escritório: a pasta "BARROS ADVOGADOS" do OneDrive.
//
// O servidor lê e grava direto no disco (no modo "neste computador" a pasta do
// OneDrive está ali; o próprio OneDrive sincroniza). Tudo é guardado como
// caminho relativo à pasta do escritório, para continuar valendo se a pasta
// mudar de lugar. Estrutura combinada com o escritório:
//   00 ENTRADA · 01 ATENDIMENTOS · 02 CLIENTES/<CLIENTE>/<caso> · 03 ARQUIVO MORTO
//   04 MODELOS · 05 FINANCEIRO · 06 ADMINISTRATIVO · 07 EQUIPE/<pessoa>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readZip, writeZip } from './zip.js';
import { readSheet } from './sheet.js';
import * as db from './db.js';
import { qualification, fullAddress, fmtDoc, fmtCep, nationalityText, maritalText, parseRep } from '../renderer/js/qualify.js';

export const FOLDERS = {
  entrada: '00 ENTRADA',
  atendimentos: '01 ATENDIMENTOS',
  clientes: '02 CLIENTES',
  arquivo: '03 ARQUIVO MORTO',
  modelos: '04 MODELOS',
  financeiro: '05 FINANCEIRO',
  administrativo: '06 ADMINISTRATIVO',
  equipe: '07 EQUIPE',
};
const PARTNERS_ONLY = [FOLDERS.financeiro, FOLDERS.administrativo];
const HIDDEN = /^(~\$|\.|desktop\.ini$|thumbs\.db$)/i;
const PREVIEW_KIND = [
  [/^\.docx$/, 'docx'], [/^\.(xlsx|csv)$/, 'sheet'], [/^\.(txt|md|rtf|log)$/, 'text'], [/^\.pdf$/, 'pdf'],
  [/^\.(png|jpe?g|gif|webp)$/, 'image'], [/^\.(mp3|ogg|oga|opus|m4a|wav)$/, 'audio'], [/^\.(mp4|webm)$/, 'video'],
];
const TEXT_EXT = new Set(['.docx', '.txt', '.pdf', '.md', '.rtf']);
const MAX_TEXT = 200000;

/** Pasta do escritório no OneDrive deste computador, se existir. */
export function guessRoot() {
  const bases = [process.env.OneDrive, process.env.OneDriveConsumer, path.join(os.homedir(), 'OneDrive')].filter(Boolean);
  for (const b of bases) {
    const p = path.join(b, 'BARROS ADVOGADOS');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Minúsculas sem acento, com o MESMO tamanho do texto (para achar o trecho). */
export function fold(s) {
  let out = '';
  for (const ch of String(s || '')) {
    const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    out += f.length === ch.length ? f : ch.toLowerCase().slice(0, ch.length).padEnd(ch.length, ' ');
  }
  return out;
}

/** Nome válido no Windows (sem \ / : * ? " < > | e sem ponto/espaço no fim). */
export function safeFileName(s, max = 120) {
  return String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max).replace(/[. ]+$/, '') || 'sem nome';
}

const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------ texto dos arquivos

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENT[e.toLowerCase()]));
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Texto de um .docx (corpo, cabeçalho e rodapé). */
export function docxText(buf) {
  const files = readZip(buf);
  const parts = [...files.keys()].filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n)).sort();
  return parts.map((n) => unxml(files.get(n).toString('utf8')
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * .docx em blocos simples para ver dentro do sistema (sem baixar): parágrafos
 * com negrito/itálico/sublinhado, alinhamento, títulos e tabelas. Não é o
 * layout exato do Word; para isso há "Editar no Word".
 */
export function docxBlocks(buf, max = 3000) {
  const xml = readZip(buf).get('word/document.xml')?.toString('utf8') || '';
  const on = (r, tag) => new RegExp(`<w:${tag}(?: w:val="(?:1|true|on)")?\\/>`).test(r);
  const runs = (p) => [...p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map(([r]) => {
    const text = unxml([...r.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab)\/>|<w:(br)[^>]*\/>/g)]
      .map((m) => (m[2] ? '\t' : m[3] ? '\n' : m[1])).join(''));
    return { text, b: on(r, 'b'), i: on(r, 'i'), u: /<w:u w:val="(?!none)/.test(r) };
  }).filter((x) => x.text);
  const para = (p) => {
    const jc = /<w:jc w:val="(\w+)"/.exec(p)?.[1];
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] || '';
    return {
      t: 'p', runs: runs(p),
      align: { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }[jc] || null,
      heading: /^(heading|t[ií]tulo|ttulo)\s*\d/i.test(style) || /^title$/i.test(style),
    };
  };
  const out = [];
  for (const [blk] of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    if (out.length >= max) break;
    if (blk.startsWith('<w:tbl>')) {
      const rows = [...blk.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(([tr]) => [...tr.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)]
        .map(([tc]) => [...tc.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(([p]) => runs(p).map((r) => r.text).join('')).join('\n')));
      out.push({ t: 'table', rows });
    } else out.push(blk === '<w:p/>' ? { t: 'p', runs: [] } : para(blk));
  }
  return out;
}

/**
 * Texto de um PDF simples (o que o Word gera com fontes comuns): descomprime
 * os blocos e junta os textos entre parênteses. PDFs escaneados (imagem) ou
 * com fontes embaralhadas ficam só com a busca pelo nome.
 */
export function pdfText(buf) {
  const out = [];
  const raw = buf.toString('latin1');
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw)) && out.join('').length < MAX_TEXT) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let data = buf.subarray(start, end);
    try { data = zlib.inflateSync(data); } catch { continue; }
    const s = data.toString('latin1');
    if (!/T[jJ]/.test(s)) continue;
    const parts = [];
    for (const t of s.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj|(T\*|Td|TD|ET)/g)) {
      if (t[3]) { parts.push(t[3] === 'ET' || t[3] === 'T*' ? '\n' : ' '); continue; }
      const chunk = t[1] != null ? [...t[1].matchAll(/\(((?:[^)\\]|\\.)*)\)/g)].map((x) => x[1]).join('') : t[2];
      parts.push(chunk.replace(/\\([nrtbf()\\]|\d{1,3})/g, (_, e) => ({ n: '\n', r: '', t: '\t', b: '', f: '' }[e]
        ?? (/\d/.test(e) ? String.fromCharCode(parseInt(e, 8)) : e))));
    }
    out.push(parts.join(''));
  }
  const text = out.join('\n').replace(/[ \t]+/g, ' ').trim();
  // fonte com codificação própria vira lixo: só aceita se parecer texto
  const letters = (text.match(/[\p{L}\d\s.,;:()/-]/gu) || []).length;
  return text.length > 20 && letters / text.length > 0.85 ? text : '';
}

export function fileText(abs) {
  try { return bufferText(fs.readFileSync(abs), path.extname(abs).toLowerCase()); } catch { return ''; }
}

/** .docx simples (um parágrafo por linha) — para a demonstração e os testes. */
export function makeDocx(lines) {
  const body = lines.map((l) => {
    // "{no|me}" com | = marcador quebrado em dois pedaços, como o Word faz
    const runs = String(l).split('|').map((t) => `<w:r><w:t xml:space="preserve">${escXml(t)}</w:t></w:r>`).join('');
    return `<w:p>${runs}</w:p>`;
  }).join('');
  return writeZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

// ------------------------------------------------------------ modelos

/** Data por extenso: "5 de outubro de 2026". */
export function dateLong(d = new Date()) {
  return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Troca os marcadores {nome}, {cpf}… do .docx pelos valores. O Word às vezes
 * quebra o marcador em pedaços com formatação diferente ("{no" + "me}"), então
 * a busca aceita marcas de formatação no meio (dentro do mesmo parágrafo).
 * Marcador em maiúsculas ({NOME}) recebe o valor em maiúsculas.
 */
export function fillDocx(buf, values) {
  const files = readZip(buf);
  const keys = Object.keys(values);
  if (!keys.length) return buf;
  const gap = '(?:<(?!/?w:p[ >/])[^>]+>)*';
  const charRe = (c) => `${gap}${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  for (const name of files.keys()) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) continue;
    let xml = files.get(name).toString('utf8');
    for (const key of keys) {
      const re = new RegExp(`\\{${[...key].map(charRe).join('')}${gap}\\}`, 'gi');
      xml = xml.replace(re, (m) => {
        const typed = m.replace(/<[^>]+>/g, '').slice(1, -1);
        const v = String(values[key] ?? '');
        return escXml(typed === typed.toUpperCase() && typed !== typed.toLowerCase() ? v.toUpperCase() : v);
      });
    }
    files.set(name, Buffer.from(xml, 'utf8'));
  }
  return writeZip(files);
}

/** Valores dos marcadores a partir da ficha do cliente e do caso. */
export function templateValues(chat, kase) {
  const phone = chat?.phone || ((chat?.jid || '').endsWith('@s.whatsapp.net') ? chat.jid.split('@')[0] : '');
  const v = {
    nome: chat?.name || chat?.display_name || kase?.client_name || '',
    cpf: chat?.cpf ? fmtDoc(chat.cpf) : '',
    cnpj: chat?.kind === 'pj' && chat?.cpf ? fmtDoc(chat.cpf) : '',
    rg: chat?.rg ? `${chat.rg}${chat.rg_issuer ? ` ${chat.rg_issuer}` : ''}` : '',
    nacionalidade: chat?.kind === 'pj' ? '' : nationalityText(chat?.nationality, chat?.gender),
    estado_civil: maritalText(chat?.marital, chat?.gender),
    profissao: chat?.profession || '',
    endereco: fullAddress(chat || {}) || chat?.address || '',
    cep: chat?.cep ? fmtCep(chat.cep) : '',
    rua: chat?.street || '',
    numero: chat?.number || '',
    complemento: chat?.complement || '',
    bairro: chat?.district || '',
    cidade: chat?.city || '',
    uf: chat?.uf || '',
    qualificacao: chat?.name ? qualification(chat) : '',
    nome_fantasia: chat?.trade_name || '',
    representante: parseRep(chat).name || '',
    representante_cargo: parseRep(chat).role || '',
    nascimento: chat?.birth || '',
    email: chat?.email || '',
    telefone: phone,
    data: new Date().toLocaleDateString('pt-BR'),
    data_extenso: dateLong(),
  };
  if (kase) {
    Object.assign(v, {
      caso: kase.title || '',
      processo: kase.process_number || '',
      parte_contraria: kase.opposing_party || '',
      area: kase.area || '',
      vara: kase.court || '',
      valor_honorarios: kase.fee_total ? Number(kase.fee_total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '',
      percentual: kase.fee_percent ? `${kase.fee_percent}%` : '',
    });
  }
  return v;
}

/** Lista dos marcadores, para mostrar na tela de ajuda. */
export const PLACEHOLDERS = [
  ['qualificacao', 'qualificação completa (nome, nacionalidade, estado civil, profissão, RG, CPF, endereço — ou empresa com representante)'],
  ['nome', 'nome do cliente'], ['cpf', 'CPF (ou CNPJ)'], ['cnpj', 'CNPJ'], ['rg', 'RG com órgão emissor'], ['nacionalidade', 'nacionalidade'],
  ['estado_civil', 'estado civil'], ['profissao', 'profissão'], ['endereco', 'endereço completo'],
  ['cep', 'CEP'], ['rua', 'rua'], ['numero', 'número'], ['complemento', 'complemento'], ['bairro', 'bairro'], ['cidade', 'cidade'], ['uf', 'UF'],
  ['nome_fantasia', 'nome fantasia'], ['representante', 'representante legal'], ['representante_cargo', 'cargo do representante'],
  ['nascimento', 'data de nascimento'], ['email', 'e-mail'], ['telefone', 'telefone (WhatsApp)'],
  ['data', 'data de hoje (05/10/2026)'], ['data_extenso', 'data por extenso (5 de outubro de 2026)'],
  ['caso', 'nome do caso'], ['processo', 'nº do processo'], ['parte_contraria', 'parte contrária'],
  ['area', 'área'], ['vara', 'vara / tribunal'], ['valor_honorarios', 'honorários (R$)'], ['percentual', '% de êxito'],
];

// ------------------------------------------------------------ serviço

/** Texto pesquisável a partir do conteúdo (já lido). */
export function bufferText(buf, ext) {
  try {
    if (ext === '.docx') return docxText(buf).slice(0, MAX_TEXT);
    if (ext === '.pdf') return pdfText(buf).slice(0, MAX_TEXT);
    if (ext === '.rtf') return buf.toString('latin1').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\[a-z]+-?\d* ?|[{}]/gi, '').slice(0, MAX_TEXT);
    return buf.toString('utf8').slice(0, MAX_TEXT);
  } catch { return ''; }
}

/** Caminho relativo limpo (barras normais, sem "..") — a pasta do escritório é o limite. */
export function safeRel(rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) throw new Error('Caminho fora da pasta do escritório.');
  return parts.join('/');
}
const dirOf = (rel) => safeRel(rel).split('/').slice(0, -1).join('/');
const baseOf = (rel) => safeRel(rel).split('/').pop() || '';

export class DocsService {
  /**
   * @param {{ getStore: () => (import('./storage.js').LocalStore|import('./storage.js').GraphStore|null),
   *           describe?: () => object }} opts
   * `getStore` = onde está a pasta (disco deste computador ou OneDrive pela API).
   */
  constructor({ getStore, describe }) {
    this.getStore = getStore;
    this.describe = describe || (() => ({}));
    this.indexing = null;
    this.lastIndex = 0;
  }

  /** A pasta do escritório configurada (não confere se está acessível). */
  store() { return this.getStore() || null; }
  get mode() { return this.store()?.kind || null; }

  async status() {
    const st = this.store();
    const extra = this.describe();
    if (!st || !(await st.ok())) return { ...extra, ok: false, mode: st?.kind || extra.mode || null, guess: guessRoot() };
    const top = (await st.list('').catch(() => [])) || [];
    const names = new Set(top.filter((e) => e.dir).map((e) => e.name));
    const present = Object.values(FOLDERS).filter((f) => names.has(f));
    const n = db.get('SELECT COUNT(*) AS n FROM doc_index')?.n || 0;
    return {
      ...extra, ok: true, mode: st.kind, root: st.kind === 'local' ? st.root : null,
      folders: present, missing: Object.values(FOLDERS).filter((f) => !present.includes(f)),
      indexed: n, indexing: !!this.indexing, lastIndex: this.lastIndex,
    };
  }

  requireStore() {
    const st = this.store();
    if (!st) throw new Error('A pasta do escritório no OneDrive não está configurada. Veja em Ajustes → Documentos.');
    return st;
  }

  /**
   * O que mostrar ao "ver" um arquivo dentro do sistema: blocos do Word,
   * linhas da planilha, texto; PDF/imagem/áudio/vídeo a página abre direto
   * pelo link (?inline=1).
   */
  async preview(rel, user) {
    const r = this.check(rel, user);
    const st = this.requireStore();
    const info = await st.stat(r);
    if (!info || info.dir) throw new Error('Arquivo não encontrado.');
    const ext = path.extname(r).toLowerCase();
    const base = { rel: r, name: baseOf(r), size: info.size, mtime: info.mtime, ext };
    const kind = PREVIEW_KIND.find(([re]) => re.test(ext))?.[1] || 'none';
    if (kind === 'docx' && info.size < 15e6) return { ...base, kind, blocks: docxBlocks(await st.read(r)) };
    if (kind === 'sheet' && info.size < 10e6) {
      try { return { ...base, kind, rows: readSheet(await st.read(r), r).slice(0, 300) }; } catch (e) { return { ...base, kind: 'none', note: e.message }; }
    }
    if (kind === 'text' && info.size < 5e6) return { ...base, kind, text: bufferText(await st.read(r), ext).slice(0, 200000) };
    if (['pdf', 'image', 'audio', 'video'].includes(kind)) return { ...base, kind };
    return { ...base, kind: 'none' };
  }

  /** Links para editar no Office direto no OneDrive (só no modo OneDrive). */
  async editLinks(rel, user) {
    const r = this.check(rel, user);
    const st = this.requireStore();
    if (!st.editInfo) return null;
    return st.editInfo(r);
  }

  /** Caminho no disco (só no modo local: abrir no Word/Explorador). */
  localPath(rel = '') {
    const st = this.store();
    return st?.kind === 'local' ? st.abs(safeRel(rel)) : null;
  }

  /**
   * Quem pode ver o quê: financeiro e administrativo só sócios; em 07 EQUIPE
   * cada pessoa vê a própria pasta (pelo primeiro nome), sócios veem todas.
   */
  allowed(rel, user) {
    if (!user || user.role === 'socio') return true;
    const parts = safeRel(rel).split('/').filter(Boolean);
    if (!parts.length) return true;
    if (PARTNERS_ONLY.includes(parts[0])) return false;
    if (parts[0] === FOLDERS.equipe && parts[1]) {
      const first = fold(user.name.split(' ')[0]);
      return fold(parts[1]).startsWith(first);
    }
    return true;
  }

  /** Confere o acesso e devolve o caminho relativo limpo. */
  check(rel, user) {
    const r = safeRel(rel);
    if (!this.allowed(r, user)) throw new Error('Você não tem acesso a esta pasta.');
    this.requireStore();
    return r;
  }

  async exists(rel) { const st = this.store(); return !!(st && rel && await st.exists(safeRel(rel)).catch(() => false)); }

  async list(rel, user) {
    const r = this.check(rel, user);
    const list = await this.requireStore().list(r);
    if (!list) return { rel: r, exists: false, entries: [] };
    const entries = [];
    for (const e of list) {
      if (HIDDEN.test(e.name)) continue;
      const er = r ? `${r}/${e.name}` : e.name;
      if (!this.allowed(er, user)) continue;
      entries.push({ name: e.name, rel: er, dir: e.dir, size: e.dir ? null : e.size, mtime: e.mtime, ext: e.dir ? '' : path.extname(e.name).toLowerCase() });
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
    return { rel: r, exists: true, entries };
  }

  /** Pastas de clientes (ativos e arquivo morto). */
  async clientFolders() {
    const st = this.store();
    if (!st) return [];
    const out = [];
    for (const top of [FOLDERS.clientes, FOLDERS.arquivo]) {
      const list = await st.list(top).catch(() => null);
      for (const d of list || []) if (d.dir && !HIDDEN.test(d.name)) out.push({ name: d.name, rel: `${top}/${d.name}`, archived: top === FOLDERS.arquivo });
    }
    return out;
  }

  /** Pasta de cliente que parece ser desta pessoa (nome igual ou que começa igual). */
  async suggestClientFolder(name) {
    const want = fold(name).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!want) return null;
    const words = want.split(' ');
    let best = null;
    for (const f of await this.clientFolders()) {
      const have = fold(f.name).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      // pastas antigas: "CLIENTE x PARTE - ASSUNTO" ou "NOME_B31" → compara só o nome
      const head = have.split(/ x | - |_/)[0].trim();
      let score = 0;
      if (head === want) score = 3;
      else if (words.length > 1 && head.startsWith(`${words[0]} `) && head.endsWith(` ${words[words.length - 1]}`)) score = 2;
      else if (head === words[0] || (words.length > 1 && head === `${words[0]} ${words[1]}`)) score = 1;
      if (score && (!best || score > best.score || (score === best.score && !f.archived && best.archived))) best = { ...f, score };
    }
    return best;
  }

  async mkdir(rel) {
    const r = safeRel(rel);
    await this.requireStore().mkdir(r);
    return r;
  }

  /** Cria a pasta do cliente no padrão: 02 CLIENTES/NOME COMPLETO (+ _CADASTRO). */
  async createClientFolder(name) {
    const rel = `${FOLDERS.clientes}/${safeFileName(String(name || '').toUpperCase())}`;
    await this.mkdir(`${rel}/_CADASTRO`);
    return rel;
  }

  /**
   * Move uma pasta dentro da pasta do escritório (ex.: para o 03 ARQUIVO MORTO).
   * Se o destino já existir, usa "NOME (2)". Devolve o caminho novo.
   */
  async move(fromRel, toRel) {
    const st = this.requireStore();
    const from = safeRel(fromRel);
    if (!(await st.exists(from))) throw new Error('A pasta não foi encontrada no OneDrive.');
    let dest = safeRel(toRel);
    for (let i = 2; await st.exists(dest); i++) dest = `${safeRel(toRel)} (${i})`;
    await st.move(from, dest);
    // o índice da busca guarda os caminhos: troca o começo
    db.run("UPDATE doc_index SET rel = ? || substr(rel, ?) WHERE rel LIKE ? || '/%'", dest, from.length + 1, from);
    return dest;
  }

  /** Nome da pasta do caso: ASSUNTO x PARTE CONTRÁRIA - nº do processo. */
  static caseFolderName(k) {
    let name = String(k.title || 'CASO').toUpperCase();
    if (k.opposing_party) name += ` x ${k.opposing_party.toUpperCase()}`;
    if (k.process_number) name += ` - ${k.process_number.replace(/[^\d.-]/g, '')}`;
    return safeFileName(name);
  }

  /** Não sobrescreve: "arquivo (2).docx". */
  async uniqueRel(dirRel, name) {
    const st = this.requireStore();
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    const dir = safeRel(dirRel);
    let candidate = name;
    for (let i = 2; await st.exists(`${dir}/${candidate}`); i++) candidate = `${base} (${i})${ext}`;
    return `${dir}/${candidate}`;
  }

  /** Copia arquivos enviados (uploads) para uma pasta, com a data na frente do nome. */
  async saveFiles(dirRel, files, user, { datePrefix = true } = {}) {
    const dir = this.check(dirRel, user);
    const st = this.requireStore();
    await st.mkdir(dir);
    const out = [];
    for (const f of files) {
      let name = safeFileName(f.name, 150);
      if (datePrefix && !/^\d{4}-\d{2}-\d{2}/.test(name)) name = `${today()} - ${name}`;
      const rel = await this.uniqueRel(dir, name);
      await st.copyIn(rel, f.path);
      out.push(rel);
      await this.indexOne(rel, { buf: fs.readFileSync(f.path) });
    }
    return out;
  }

  /**
   * "Usar como base": copia um documento (modelo ou peça de outro caso) para a
   * pasta de destino, preenchendo os marcadores se for .docx.
   */
  async copyAsBase(srcRel, destDirRel, values, user, newName) {
    const src = this.check(srcRel, user);
    const dest = this.check(destDirRel, user);
    const st = this.requireStore();
    const info = await st.stat(src);
    if (!info || info.dir) throw new Error('Escolha um arquivo.');
    const ext = path.extname(src).toLowerCase();
    let name = newName ? safeFileName(newName) : path.basename(src, ext).replace(/^\d{4}-\d{2}-\d{2} - /, '').replace(/^MODELO\s*[-–]\s*/i, '');
    if (!name.toLowerCase().endsWith(ext)) name += ext;
    if (!/^\d{4}-\d{2}-\d{2}/.test(name)) name = `${today()} - ${name}`;
    await st.mkdir(dest);
    const rel = await this.uniqueRel(dest, name);
    const buf = await st.read(src);
    const out = ext === '.docx' ? fillDocx(buf, values || {}) : buf;
    await st.write(rel, out);
    await this.indexOne(rel, { buf: out });
    return rel;
  }

  /** Modelos em 04 MODELOS (com a área = subpasta). */
  async templates() {
    const st = this.store();
    if (!st) return [];
    const out = [];
    const walk = async (rel, depth) => {
      const list = await st.list(rel).catch(() => null);
      for (const d of list || []) {
        if (HIDDEN.test(d.name)) continue;
        const r = `${rel}/${d.name}`;
        if (d.dir) { if (depth < 4) await walk(r, depth + 1); continue; }
        const area = rel.slice(FOLDERS.modelos.length + 1) || 'Geral';
        out.push({ name: d.name, rel: r, area, fillable: /\.docx$/i.test(d.name) });
      }
    };
    await walk(FOLDERS.modelos, 0);
    return out.sort((a, b) => a.area.localeCompare(b.area, 'pt-BR') || a.name.localeCompare(b.name, 'pt-BR'));
  }

  // -------------------------------------------------------- busca

  /**
   * Põe um arquivo no índice. Só lê o conteúdo de documentos de tamanho
   * normal (no OneDrive, ler = baixar): PDFs grandes (autos, escaneados)
   * ficam só com a busca pelo nome.
   */
  async indexOne(rel, { buf, meta } = {}) {
    try {
      const st = this.requireStore();
      const info = meta || await st.stat(rel);
      if (!info || info.dir) return;
      const name = baseOf(rel);
      const ext = path.extname(name).toLowerCase();
      const readable = TEXT_EXT.has(ext) && info.size < (ext === '.pdf' ? 8e6 : 15e6);
      const text = readable ? bufferText(buf || await st.read(rel), ext) : '';
      db.run('INSERT OR REPLACE INTO doc_index (rel, name, mtime, size, text, fold) VALUES (?, ?, ?, ?, ?, ?)',
        rel, name, Math.floor(info.mtime || Date.now()), info.size || 0, text, fold(`${name}\n${text}`));
    } catch { /* arquivo sumiu ou está aberto */ }
  }

  /**
   * Atualiza o índice: só lê os arquivos novos ou alterados (pela data), e tira
   * os que sumiram. Roda em partes para não travar o servidor.
   */
  reindex() {
    if (this.indexing) return this.indexing;
    const st = this.store();
    if (!st) return Promise.resolve(0);
    this.indexing = (async () => {
      if (!(await st.ok())) return 0;
      const known = new Map(db.all('SELECT rel, mtime FROM doc_index').map((r) => [r.rel, r.mtime]));
      const seen = new Set();
      let changed = 0;
      for await (const f of st.walk()) {
        seen.add(f.rel);
        if (known.get(f.rel) === Math.floor(f.mtime)) continue;
        await this.indexOne(f.rel, { meta: f });
        changed++;
      }
      for (const rel of known.keys()) if (!seen.has(rel)) { db.run('DELETE FROM doc_index WHERE rel = ?', rel); changed++; }
      this.lastIndex = Date.now();
      return changed;
    })().finally(() => { this.indexing = null; });
    return this.indexing;
  }

  /**
   * Busca no nome e no conteúdo. Todas as palavras precisam aparecer (sem
   * diferença de acento e maiúsculas). Nome conta mais que conteúdo.
   */
  search(q, user, { limit = 60, under } = {}) {
    const words = fold(q).split(/\s+/).filter((w) => w.length >= 2).slice(0, 8);
    if (!words.length) return [];
    const where = words.map(() => 'fold LIKE ?');
    const args = words.map((w) => `%${w.replace(/[%_\\]/g, '\\$&')}%`);
    let sql = `SELECT rel, name, mtime, size, text, fold FROM doc_index WHERE ${where.map((w) => `${w} ESCAPE '\\'`).join(' AND ')}`;
    if (under) { sql += " AND rel LIKE ? ESCAPE '\\'"; args.push(`${under.replace(/[%_\\]/g, '\\$&')}/%`); }
    const rows = db.all(`${sql} LIMIT 2000`, ...args).filter((r) => this.allowed(r.rel, user));
    const scored = rows.map((r) => {
      const nameF = fold(r.name);
      const pathF = fold(r.rel);
      let score = 0;
      for (const w of words) score += nameF.includes(w) ? 10 : pathF.includes(w) ? 4 : 1;
      if (r.rel.startsWith(FOLDERS.modelos)) score += 2;
      return { r, score };
    }).sort((a, b) => b.score - a.score || b.r.mtime - a.r.mtime).slice(0, limit);
    return scored.map(({ r }) => {
      // trecho em volta da primeira palavra encontrada no conteúdo
      let snippet = '';
      if (r.text) {
        const tf = r.fold.slice(r.name.length + 1);
        const pos = Math.min(...words.map((w) => tf.indexOf(w)).filter((i) => i >= 0));
        if (Number.isFinite(pos)) {
          const a = Math.max(0, pos - 80);
          snippet = `${a ? '…' : ''}${r.text.slice(a, pos + 160).replace(/\s+/g, ' ').trim()}…`;
        }
      }
      return { rel: r.rel, name: r.name, folder: dirOf(r.rel), mtime: r.mtime, size: r.size, snippet, ext: path.extname(r.name).toLowerCase() };
    });
  }
}
