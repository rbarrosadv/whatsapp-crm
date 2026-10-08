// Leitura (OCR) de PDFs escaneados, para a busca achar pelo conteúdo: tira as
// imagens das páginas de dentro do PDF (sem desenhar o PDF) e lê com o
// Tesseract em português, tudo no próprio servidor (sem mandar nada para fora).
// Formatos de imagem: JPEG (celular, scanner colorido), cinza/cor comprimido
// (Flate) e preto e branco de fax (CCITT G3/G4, o mais comum nos scanners).
// JBIG2 não é lido (fica só a busca pelo nome).
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';

const MIN_SIDE = 400; // menor que isso é logo/carimbo, não página

/** Valor de uma chave no dicionário PDF (texto cru). */
function dictVal(dict, key) {
  const m = new RegExp(`/${key}(?![A-Za-z])\\s*(\\[[^\\]]*\\]|<<[\\s\\S]*?>>|/[^\\s/<>\\[\\]()]+|\\d+\\s+\\d+\\s+R|-?[\\d.]+|true|false)`).exec(dict);
  return m ? m[1].trim() : null;
}

/** Fim do dicionário << … >> que começa em `start` (conta os aninhados). */
function dictEnd(s, start) {
  let depth = 0;
  for (let i = start; i < s.length - 1; i++) {
    if (s[i] === '<' && s[i + 1] === '<') { depth++; i++; } else if (s[i] === '>' && s[i + 1] === '>') { depth--; i++; if (!depth) return i + 1; }
  }
  return -1;
}

/**
 * Imagens das páginas de um PDF: [{ kind: 'jpeg'|'tiff'|'pnm', data }].
 * `max` = quantas no máximo (≈ páginas).
 */
export function pdfImages(buf, { max = 40 } = {}) {
  const s = buf.toString('latin1');
  if (/\/Encrypt\s/.test(s.slice(-4096)) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(s)) return { images: [], encrypted: true };
  const objNum = (n) => {
    const m = new RegExp(`(?:^|[\\r\\n\\s])${n}\\s+0\\s+obj\\s*(\\d+)\\s*endobj`).exec(s);
    return m ? Number(m[1]) : null;
  };
  const objBody = (n) => {
    const m = new RegExp(`(?:^|[\\r\\n\\s])${n}\\s+0\\s+obj\\s*([\\s\\S]{0,400}?)(?:stream|endobj)`).exec(s);
    return m ? m[1] : '';
  };
  // espaço de cor → nº de componentes (cinza 1, cor 3, CMYK 4); null = paleta (não lido)
  const components = (cs, depth = 0) => {
    if (depth > 3) return null;
    if (/^\d+\s+\d+\s+R$/.test(cs)) return components(objBody(cs.split(/\s+/)[0]).trim(), depth + 1);
    if (/Indexed|Separation|DeviceN|Pattern/.test(cs)) return null;
    if (/DeviceRGB|CalRGB|Lab/.test(cs)) return 3;
    if (/DeviceCMYK/.test(cs)) return 4;
    const icc = /ICCBased\s+(\d+)\s+\d+\s+R/.exec(cs);
    if (icc) return Number(dictVal(objBody(icc[1]), 'N')) || 3;
    return 1;
  };
  const out = [];
  let unsupported = 0;
  const re = /\d+\s+\d+\s+obj\s*<</g;
  let m;
  while ((m = re.exec(s)) && out.length < max) {
    const start = m.index + m[0].length - 2;
    const end = dictEnd(s, start);
    if (end < 0) continue;
    const dict = s.slice(start, end);
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    const sm = /^\s*stream\r?\n/.exec(s.slice(end, end + 20));
    if (!sm) continue;
    const dataStart = end + sm[0].length;
    const w = Number(dictVal(dict, 'Width'));
    const h = Number(dictVal(dict, 'Height'));
    if (!w || !h || Math.min(w, h) < MIN_SIDE || /\/ImageMask\s+true/.test(dict)) continue;
    let len = dictVal(dict, 'Length');
    len = /R$/.test(len || '') ? objNum(len.split(/\s+/)[0]) : Number(len);
    let dataEnd = len && dataStart + len <= buf.length ? dataStart + len : s.indexOf('endstream', dataStart);
    if (dataEnd < 0) continue;
    let data = buf.subarray(dataStart, dataEnd);
    const filters = (dictVal(dict, 'Filter') || '').match(/\/\w+/g) || [];
    const parms = dictVal(dict, 'DecodeParms') || '';
    const bpc = Number(dictVal(dict, 'BitsPerComponent')) || 8;
    const cs = dictVal(dict, 'ColorSpace') || '';
    try {
      let f = [...filters];
      while (f[0] === '/FlateDecode' && f.length > 1) { data = zlib.inflateSync(data); f.shift(); }
      const last = f[0] || '';
      if (last === '/DCTDecode') out.push({ kind: 'jpeg', data: Buffer.from(data) });
      else if (last === '/CCITTFaxDecode') {
        const k = Number(dictVal(parms, 'K')) || 0;
        out.push({ kind: 'tiff', data: ccittTiff(data, w, h, k) });
      } else if (last === '/FlateDecode' || !last) {
        let raw = last ? zlib.inflateSync(data) : data;
        const comps = components(cs);
        if (comps == null) { unsupported++; continue; }
        const pred = Number(dictVal(parms, 'Predictor')) || 1;
        if (pred >= 10) raw = pngUnfilter(raw, w, comps, bpc);
        out.push({ kind: 'pnm', data: toPnm(raw, w, h, comps, bpc) });
      } else unsupported++; // JBIG2, JPX…
    } catch { unsupported++; }
  }
  return { images: out, unsupported };
}

/** Desfaz o filtro PNG (Predictor ≥ 10) linha a linha. */
function pngUnfilter(raw, w, comps, bpc) {
  const bpp = Math.max(1, Math.ceil((comps * bpc) / 8));
  const row = Math.ceil((w * comps * bpc) / 8);
  const rows = Math.floor(raw.length / (row + 1));
  const out = Buffer.alloc(rows * row);
  for (let y = 0; y < rows; y++) {
    const ft = raw[y * (row + 1)];
    const src = raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1));
    const cur = out.subarray(y * row, (y + 1) * row);
    const prev = y ? out.subarray((y - 1) * row, y * row) : Buffer.alloc(row);
    for (let x = 0; x < row; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
  }
  return out;
}

/** Pixels crus → PBM/PGM/PPM (o Tesseract lê). */
function toPnm(raw, w, h, comps, bpc) {
  if (bpc === 1 && comps === 1) {
    // PDF: 0 = preto; PBM: 1 = preto → inverte os bits
    const row = Math.ceil(w / 8);
    const body = Buffer.alloc(row * h);
    for (let i = 0; i < body.length && i < raw.length; i++) body[i] = ~raw[i] & 255;
    return Buffer.concat([Buffer.from(`P4\n${w} ${h}\n`), body]);
  }
  if (bpc !== 8) throw new Error('profundidade de cor não suportada');
  if (comps === 4) { // CMYK → cinza
    const g = Buffer.alloc(w * h);
    for (let i = 0; i < g.length; i++) {
      const [c, m, y, k] = [raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2], raw[i * 4 + 3]];
      g[i] = 255 - Math.min(255, 0.3 * c + 0.59 * m + 0.11 * y + k);
    }
    return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), g]);
  }
  return Buffer.concat([Buffer.from(`P${comps === 3 ? 6 : 5}\n${w} ${h}\n255\n`), raw.subarray(0, w * h * comps)]);
}

/** Embrulha o fax (CCITT) num TIFF de uma página, que o Tesseract sabe abrir. */
export function ccittTiff(data, w, h, k) {
  const tags = [
    [256, 4, w], [257, 4, h], [258, 3, 1], [259, 3, k < 0 ? 4 : 3], [262, 3, 0],
    [273, 4, 0 /* posição dos dados, abaixo */], [277, 3, 1], [278, 4, h], [279, 4, data.length],
    ...(k >= 0 ? [[292, 4, k > 0 ? 1 : 0]] : []),
  ];
  const ifdSize = 2 + tags.length * 12 + 4;
  const dataOff = 8 + ifdSize;
  const head = Buffer.alloc(dataOff);
  head.write('II', 0, 'latin1');
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(8, 4);
  head.writeUInt16LE(tags.length, 8);
  tags.forEach(([tag, type, val], i) => {
    const o = 10 + i * 12;
    head.writeUInt16LE(tag, o);
    head.writeUInt16LE(type, o + 2);
    head.writeUInt32LE(1, o + 4);
    if (type === 3) head.writeUInt16LE(tag === 273 ? 0 : val, o + 8);
    else head.writeUInt32LE(tag === 273 ? dataOff : val, o + 8);
  });
  head.writeUInt32LE(0, 10 + tags.length * 12);
  return Buffer.concat([head, data]);
}

/**
 * Leitor (um só, reaproveitado): `read(buf)` → texto do PDF escaneado.
 * O Tesseract roda numa thread à parte; o servidor continua respondendo.
 */
export class OcrReader {
  constructor() { this.worker = null; this.idleTimer = null; }

  async getWorker() {
    clearTimeout(this.idleTimer);
    if (!this.worker) {
      const require = createRequire(import.meta.url);
      const T = require('tesseract.js');
      const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/por/package.json')), '4.0.0_best_int');
      this.worker = await T.createWorker('por', 1, { langPath, cacheMethod: 'none', gzip: true });
    }
    // sem uso por 5 min: libera a memória
    this.idleTimer = setTimeout(() => this.stop(), 5 * 60e3);
    this.idleTimer.unref?.();
    return this.worker;
  }

  /** Texto de um PDF escaneado (ou null se não há imagem que dê para ler). */
  async readPdf(buf, { maxPages = 40 } = {}) {
    const { images, unsupported, encrypted } = pdfImages(buf, { max: maxPages });
    if (!images.length) return { text: null, pages: 0, unsupported, encrypted };
    const w = await this.getWorker();
    const parts = [];
    for (const img of images) {
      try {
        const r = await w.recognize(img.data);
        parts.push(r.data.text || '');
      } catch { /* imagem que o leitor não abre */ }
    }
    const text = parts.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { text, pages: images.length, unsupported };
  }

  async stop() {
    clearTimeout(this.idleTimer);
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate().catch(() => {});
  }
}
