// Leitura de planilhas exportadas por outros sistemas (LinkLei e afins):
// .xlsx (1ª aba, textos compartilhados e em linha, datas do Excel) e .csv
// (separador ; ou , ou tab, aspas, BOM). Devolve uma lista de linhas, cada
// uma uma lista de textos. Sem dependências: o .xlsx é um zip de XML.
import { readZip } from './zip.js';

const decode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

/** Texto de um <si> ou <is> (junta os pedaços <t> com formatação diferente). */
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)].map((m) => decode(m[1] || '')).join('');

/** "AB" → 27 (coluna base 0 = 27). */
function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function excelDate(serial) {
  const ms = Math.round((Number(serial) - 25569) * 86400e3);
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

export function readXlsx(buf) {
  const files = readZip(buf);
  const get = (name) => files.get(name)?.toString('utf8') || '';
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  // 1ª aba pela ordem do workbook (normalmente sheet1.xml)
  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  const firstRid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb)?.[1];
  const target = firstRid && new RegExp(`Id="${firstRid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  const sheetName = target ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = get(sheetName) || get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('A planilha está vazia ou não é um arquivo do Excel (.xlsx).');
  // datas: estilos com formato de data
  const styles = get('xl/styles.xml');
  const dateFmts = new Set([14, 15, 16, 17, 22]);
  for (const m of styles.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)) if (/[dy]/i.test(m[2]) && !/[h]/i.test(m[2].replace(/"[^"]*"/g, ''))) dateFmts.add(Number(m[1]));
  const xfs = [...(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] || '').matchAll(/<xf\b[^>]*numFmtId="(\d+)"/g)].map((m) => Number(m[1]));
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] || '';
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const s = Number(/\bs="(\d+)"/.exec(attrs)?.[1] || -1);
      const inner = cm[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(inner);
      else if (t === 'str' || t === 'e') val = decode(v ?? '');
      else if (t === 'b') val = v === '1' ? 'VERDADEIRO' : 'FALSO';
      else if (v != null) val = s >= 0 && dateFmts.has(xfs[s]) ? excelDate(v) : decode(v);
      const idx = ref ? colIndex(ref) : row.length;
      while (row.length < idx) row.push('');
      row[idx] = String(val).trim();
    }
    rows.push(row);
  }
  return rows;
}

export function readCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const first = s.split(/\r?\n/, 1)[0];
  const sep = [';', '\t', ','].map((c) => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"' && !cell) q = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell.trim()); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}

/** Planilha pelo conteúdo: zip (PK) = .xlsx; o resto é texto (.csv). */
export function readSheet(buf, name = '') {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return readXlsx(buf).filter((r) => r.some((c) => c));
  if (/\.xls$/i.test(name) || (buf[0] === 0xd0 && buf[1] === 0xcf)) throw new Error('Esse é o formato antigo do Excel (.xls). Abra no Excel e salve como .xlsx ou .csv.');
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1'); // CSV salvo no Excel (Windows-1252)
  return readCsv(text).filter((r) => r.some((c) => c));
}
