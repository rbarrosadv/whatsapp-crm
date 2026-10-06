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
import * as db from './db.js';

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
const posix = (rel) => rel.split(path.sep).join('/');

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
  const ext = path.extname(abs).toLowerCase();
  try {
    const buf = fs.readFileSync(abs);
    if (ext === '.docx') return docxText(buf).slice(0, MAX_TEXT);
    if (ext === '.pdf') return pdfText(buf).slice(0, MAX_TEXT);
    if (ext === '.rtf') return buf.toString('latin1').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\[a-z]+-?\d* ?|[{}]/gi, '').slice(0, MAX_TEXT);
    return buf.toString('utf8').slice(0, MAX_TEXT);
  } catch { return ''; }
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
    cpf: chat?.cpf || '',
    rg: chat?.rg || '',
    nacionalidade: chat?.nationality || '',
    estado_civil: chat?.marital || '',
    profissao: chat?.profession || '',
    endereco: chat?.address || '',
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
  ['nome', 'nome do cliente'], ['cpf', 'CPF'], ['rg', 'RG'], ['nacionalidade', 'nacionalidade'],
  ['estado_civil', 'estado civil'], ['profissao', 'profissão'], ['endereco', 'endereço completo'],
  ['nascimento', 'data de nascimento'], ['email', 'e-mail'], ['telefone', 'telefone (WhatsApp)'],
  ['data', 'data de hoje (05/10/2026)'], ['data_extenso', 'data por extenso (5 de outubro de 2026)'],
  ['caso', 'nome do caso'], ['processo', 'nº do processo'], ['parte_contraria', 'parte contrária'],
  ['area', 'área'], ['vara', 'vara / tribunal'], ['valor_honorarios', 'honorários (R$)'], ['percentual', '% de êxito'],
];

// ------------------------------------------------------------ serviço

export class DocsService {
  /** @param {{ getRoot: () => string|null }} opts */
  constructor({ getRoot }) {
    this.getRoot = getRoot;
    this.indexing = null;
    this.lastIndex = 0;
  }

  root() {
    const r = this.getRoot();
    return r && fs.existsSync(r) && fs.statSync(r).isDirectory() ? path.resolve(r) : null;
  }

  status() {
    const configured = this.getRoot() || null;
    const root = this.root();
    if (!root) return { configured, ok: false, guess: guessRoot() };
    const present = Object.values(FOLDERS).filter((f) => fs.existsSync(path.join(root, f)));
    const n = db.get('SELECT COUNT(*) AS n FROM doc_index')?.n || 0;
    return { configured, ok: true, root, folders: present, missing: Object.values(FOLDERS).filter((f) => !present.includes(f)), indexed: n, indexing: !!this.indexing, lastIndex: this.lastIndex };
  }

  requireRoot() {
    const r = this.root();
    if (!r) throw new Error('A pasta do escritório no OneDrive não foi encontrada. Configure em Ajustes → Documentos.');
    return r;
  }

  /** Caminho absoluto de um relativo, sem sair da pasta do escritório. */
  abs(rel = '') {
    const root = this.requireRoot();
    const a = path.resolve(root, String(rel || '').replace(/\//g, path.sep));
    if (a !== root && !a.startsWith(root + path.sep)) throw new Error('Caminho fora da pasta do escritório.');
    return a;
  }

  rel(abs) { return posix(path.relative(this.requireRoot(), abs)); }

  /**
   * Quem pode ver o quê: financeiro e administrativo só sócios; em 07 EQUIPE
   * cada pessoa vê a própria pasta (pelo primeiro nome), sócios veem todas.
   */
  allowed(rel, user) {
    if (!user || user.role === 'socio') return true;
    const parts = posix(String(rel || '')).split('/').filter(Boolean);
    if (!parts.length) return true;
    if (PARTNERS_ONLY.includes(parts[0])) return false;
    if (parts[0] === FOLDERS.equipe && parts[1]) {
      const first = fold(user.name.split(' ')[0]);
      return fold(parts[1]).startsWith(first);
    }
    return true;
  }

  check(rel, user) {
    if (!this.allowed(rel, user)) throw new Error('Você não tem acesso a esta pasta.');
    return this.abs(rel);
  }

  list(rel, user) {
    const dir = this.check(rel, user);
    if (!fs.existsSync(dir)) return { rel: posix(rel || ''), exists: false, entries: [] };
    const entries = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (HIDDEN.test(d.name)) continue;
      const r = posix(path.join(rel || '', d.name));
      if (!this.allowed(r, user)) continue;
      let st;
      try { st = fs.statSync(path.join(dir, d.name)); } catch { continue; }
      entries.push({ name: d.name, rel: r, dir: st.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: st.mtimeMs, ext: path.extname(d.name).toLowerCase() });
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
    return { rel: posix(rel || ''), exists: true, entries };
  }

  /** Pastas de clientes (ativos e arquivo morto). */
  clientFolders() {
    const root = this.root();
    if (!root) return [];
    const out = [];
    for (const top of [FOLDERS.clientes, FOLDERS.arquivo]) {
      const dir = path.join(root, top);
      if (!fs.existsSync(dir)) continue;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory() && !HIDDEN.test(d.name)) out.push({ name: d.name, rel: `${top}/${d.name}`, archived: top === FOLDERS.arquivo });
      }
    }
    return out;
  }

  /** Pasta de cliente que parece ser desta pessoa (nome igual ou que começa igual). */
  suggestClientFolder(name) {
    const want = fold(name).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!want) return null;
    const words = want.split(' ');
    let best = null;
    for (const f of this.clientFolders()) {
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

  mkdir(rel) {
    const a = this.abs(rel);
    fs.mkdirSync(a, { recursive: true });
    return posix(rel);
  }

  /** Cria a pasta do cliente no padrão: 02 CLIENTES/NOME COMPLETO (+ _CADASTRO). */
  createClientFolder(name) {
    const rel = `${FOLDERS.clientes}/${safeFileName(String(name || '').toUpperCase())}`;
    this.mkdir(rel);
    this.mkdir(`${rel}/_CADASTRO`);
    return rel;
  }

  /** Nome da pasta do caso: ASSUNTO x PARTE CONTRÁRIA - nº do processo. */
  static caseFolderName(k) {
    let name = String(k.title || 'CASO').toUpperCase();
    if (k.opposing_party) name += ` x ${k.opposing_party.toUpperCase()}`;
    if (k.process_number) name += ` - ${k.process_number.replace(/[^\d.-]/g, '')}`;
    return safeFileName(name);
  }

  /** Não sobrescreve: "arquivo (2).docx". */
  uniqueRel(dirRel, name) {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    let candidate = name;
    for (let i = 2; fs.existsSync(this.abs(`${dirRel}/${candidate}`)); i++) candidate = `${base} (${i})${ext}`;
    return posix(path.join(dirRel, candidate));
  }

  /** Copia arquivos enviados (uploads) para uma pasta, com a data na frente do nome. */
  saveFiles(dirRel, files, user, { datePrefix = true } = {}) {
    this.check(dirRel, user);
    this.mkdir(dirRel);
    const out = [];
    for (const f of files) {
      let name = safeFileName(f.name, 150);
      if (datePrefix && !/^\d{4}-\d{2}-\d{2}/.test(name)) name = `${today()} - ${name}`;
      const rel = this.uniqueRel(dirRel, name);
      fs.copyFileSync(f.path, this.abs(rel));
      out.push(rel);
      this.indexOne(rel);
    }
    return out;
  }

  /**
   * "Usar como base": copia um documento (modelo ou peça de outro caso) para a
   * pasta de destino, preenchendo os marcadores se for .docx.
   */
  copyAsBase(srcRel, destDirRel, values, user, newName) {
    const src = this.check(srcRel, user);
    this.check(destDirRel, user);
    if (!fs.statSync(src).isFile()) throw new Error('Escolha um arquivo.');
    const ext = path.extname(src).toLowerCase();
    let name = newName ? safeFileName(newName) : path.basename(src, ext).replace(/^\d{4}-\d{2}-\d{2} - /, '').replace(/^MODELO\s*[-–]\s*/i, '');
    if (!name.toLowerCase().endsWith(ext)) name += ext;
    if (!/^\d{4}-\d{2}-\d{2}/.test(name)) name = `${today()} - ${name}`;
    this.mkdir(destDirRel);
    const rel = this.uniqueRel(destDirRel, name);
    const buf = fs.readFileSync(src);
    fs.writeFileSync(this.abs(rel), ext === '.docx' ? fillDocx(buf, values || {}) : buf);
    this.indexOne(rel);
    return rel;
  }

  /** Modelos em 04 MODELOS (com a área = subpasta). */
  templates() {
    const root = this.root();
    if (!root) return [];
    const base = path.join(root, FOLDERS.modelos);
    if (!fs.existsSync(base)) return [];
    const out = [];
    const walk = (dir, depth) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (HIDDEN.test(d.name)) continue;
        const a = path.join(dir, d.name);
        if (d.isDirectory()) { if (depth < 4) walk(a, depth + 1); continue; }
        if (!/\.(docx?|odt|rtf|pdf|xlsx?)$/i.test(d.name)) continue;
        const rel = this.rel(a);
        const area = posix(path.relative(base, dir)) || 'Geral';
        out.push({ name: d.name, rel, area, fillable: /\.docx$/i.test(d.name) });
      }
    };
    walk(base, 0);
    return out.sort((a, b) => a.area.localeCompare(b.area, 'pt-BR') || a.name.localeCompare(b.name, 'pt-BR'));
  }

  // -------------------------------------------------------- busca

  indexOne(rel) {
    try {
      const a = this.abs(rel);
      const st = fs.statSync(a);
      const name = path.basename(a);
      // só lê o conteúdo de documentos de tamanho normal: no OneDrive com
      // "arquivos sob demanda", ler um arquivo faz ele ser baixado; PDFs grandes
      // (autos do processo, escaneados) ficam só com a busca pelo nome
      const ext = path.extname(a).toLowerCase();
      const text = TEXT_EXT.has(ext) && st.size < (ext === '.pdf' ? 8e6 : 15e6) ? fileText(a) : '';
      db.run('INSERT OR REPLACE INTO doc_index (rel, name, mtime, size, text, fold) VALUES (?, ?, ?, ?, ?, ?)',
        rel, name, Math.floor(st.mtimeMs), st.size, text, fold(`${name}\n${text}`));
    } catch { /* arquivo sumiu ou está aberto */ }
  }

  /**
   * Atualiza o índice: só lê os arquivos novos ou alterados (pela data), e tira
   * os que sumiram. Roda em partes para não travar o servidor.
   */
  reindex() {
    if (this.indexing) return this.indexing;
    const root = this.root();
    if (!root) return Promise.resolve(0);
    this.indexing = (async () => {
      const known = new Map(db.all('SELECT rel, mtime FROM doc_index').map((r) => [r.rel, r.mtime]));
      const seen = new Set();
      let changed = 0;
      let n = 0;
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        let list;
        try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const d of list) {
          if (HIDDEN.test(d.name)) continue;
          const a = path.join(dir, d.name);
          if (d.isDirectory()) { stack.push(a); continue; }
          const rel = posix(path.relative(root, a));
          seen.add(rel);
          let st;
          try { st = fs.statSync(a); } catch { continue; }
          if (known.get(rel) === Math.floor(st.mtimeMs)) continue;
          this.indexOne(rel);
          changed++;
          if (++n % 25 === 0) await new Promise((r) => setImmediate(r));
          if (seen.size > 100000) break; // pasta gigante: para por aqui
        }
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
      return { rel: r.rel, name: r.name, folder: posix(path.dirname(r.rel)), mtime: r.mtime, size: r.size, snippet, ext: path.extname(r.name).toLowerCase() };
    });
  }
}
