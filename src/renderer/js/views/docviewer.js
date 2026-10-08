// Ver um arquivo da pasta do escritório sem baixar (PDF, foto, Word, planilha,
// texto, áudio/vídeo) e editar no Word/Excel direto no OneDrive (o que salvar
// vai para o OneDrive, sem cópia esquecida no computador).
import { h, fill, modal, toast, errToast, fmtSize, fmtDateTime, showDoc } from '../util.js';
import { api } from '../store.js';
import { icon } from '../icons.js';
import { openImageViewer } from './imageviewer.js';

export const OFFICE_RE = /\.(docx?|docm|rtf|odt|xlsx?|xlsm|csv|ods|pptx?|ppsx|odp)$/i;
const APP_NAME = { word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint' };

const inlineUrl = (d) => `${d.url}?inline=1`;

/** Registra o arquivo em "Recentes" (sem esperar). */
export function touchDoc(d, action = 'open') {
  if (d?.rel) api('docs:touch', d.rel, action).catch(() => {});
}

/**
 * Editar no Office: no modo "neste computador" o app de desktop abre o arquivo
 * de verdade; com o OneDrive pela internet, abre o Word do computador no
 * arquivo do OneDrive (ou o Word online).
 */
export async function editDoc(d) {
  if (window.desktop?.openDoc && await window.desktop.openDoc(d.rel).catch(() => false)) { touchDoc(d, 'edit'); return; }
  let links;
  try { links = await api('docs:editLinks', d.rel); } catch (e) { errToast(e); return; }
  if (!links) { // pasta no disco do servidor: aqui só dá para ver (editar = baixar e enviar de volta)
    toast('A pasta do escritório não está ligada ao OneDrive pela internet: para editar, baixe, edite e envie de volta.', 'info', 7000);
    previewDoc(d, { noEdit: true });
    return;
  }
  touchDoc(d, 'edit');
  const app = APP_NAME[links.app] || 'Office';
  if (links.desktopUrl && window.desktop?.openOffice && await window.desktop.openOffice(links.desktopUrl).catch(() => false)) {
    toast(`Abrindo no ${app}… Ao salvar, vai direto para o OneDrive.`, 'success', 6000);
    return;
  }
  const phone = matchMedia('(max-width: 760px)').matches;
  modal({
    title: `Editar no ${app}`,
    body: h('div', { class: 'stack' },
      h('p', null, d.name),
      h('p', { class: 'muted small' }, `O arquivo abre direto do OneDrive: ao salvar, a alteração vai para a pasta do escritório (sem cópia no computador). O ${app} precisa estar com uma conta Microsoft que tenha acesso à pasta BARROS ADVOGADOS.`)),
    actions: [
      { label: 'Cancelar' },
      links.webUrl ? { label: `${app} online`, primary: phone || !links.desktopUrl, onClick: () => { window.open(links.webUrl, '_blank', 'noopener'); } } : null,
      links.desktopUrl && !phone ? { label: `${app} do computador`, primary: true, onClick: () => { location.href = links.desktopUrl; } } : null,
    ].filter(Boolean),
  });
}

/** Mostra o arquivo dentro do sistema. */
export async function previewDoc(d, { noEdit = false } = {}) {
  touchDoc(d, 'open');
  if (/\.(png|jpe?g|gif|webp)$/i.test(d.name)) {
    openImageViewer([{ url: inlineUrl(d), m: d }], 0, { actions: () => [{ label: icon('download', 16), title: 'Baixar', onClick: () => showDoc(d).catch(errToast) }] });
    return;
  }
  const body = h('div', { class: 'doc-preview' }, h('p', { class: 'muted small' }, 'Abrindo…'));
  const office = OFFICE_RE.test(d.name) && !noEdit;
  const editLabel = /\.(xlsx?|xlsm|csv|ods)$/i.test(d.name) ? 'Editar no Excel' : /\.(pptx?|ppsx|odp)$/i.test(d.name) ? 'Editar no PowerPoint' : 'Editar no Word';
  const m = modal({
    title: d.name,
    wide: true,
    body,
    actions: [
      { label: 'Baixar', onClick: () => { showDoc(d).catch(errToast); return false; } },
      office ? { label: editLabel, primary: true, onClick: () => { editDoc(d); } } : null,
      { label: 'Fechar' },
    ].filter(Boolean),
  });
  m.box.classList.add('modal-preview');
  let p;
  try { p = await api('docs:preview', d.rel); } catch (e) { fill(body, h('p', { class: 'bad-text' }, e.message)); return; }
  const info = h('div', { class: 'muted small' }, [p.mtime ? `Alterado em ${fmtDateTime(p.mtime)}` : null, p.size != null ? fmtSize(p.size) : null].filter(Boolean).join(' · '));
  const url = inlineUrl({ url: p.url });
  let view;
  if (p.kind === 'pdf') view = h('iframe', { class: 'doc-frame', src: url, title: d.name });
  else if (p.kind === 'audio') view = h('audio', { controls: true, src: url, class: 'doc-media' });
  else if (p.kind === 'video') view = h('video', { controls: true, src: url, class: 'doc-media' });
  else if (p.kind === 'docx') view = h('div', { class: 'doc-page' }, p.blocks.length ? p.blocks.map(block) : h('p', { class: 'muted' }, '(documento sem texto)'));
  else if (p.kind === 'sheet') view = sheetView(p.rows);
  else if (p.kind === 'text') view = h('pre', { class: 'doc-text' }, p.text || '(vazio)');
  else {
    view = h('div', { class: 'doc-none' }, icon('file', 40),
      h('p', null, p.note || 'Este tipo de arquivo não dá para ver aqui.'),
      h('p', { class: 'muted small' }, office ? 'Use "Editar" para abrir no programa, ou baixe uma cópia.' : 'Baixe para abrir no programa do computador.'));
  }
  fill(body, info, view);
}

function block(b) {
  if (b.t === 'table') {
    return h('table', { class: 'doc-table' }, h('tbody', null, b.rows.map((r) => h('tr', null, r.map((c) => h('td', null, c))))));
  }
  const runs = b.runs.map((r) => {
    let el = document.createTextNode(r.text);
    if (r.u) el = h('u', null, el);
    if (r.i) el = h('em', null, el);
    if (r.b) el = h('strong', null, el);
    return el;
  });
  return h(b.heading ? 'h4' : 'p', { style: b.align ? { textAlign: b.align } : null }, runs.length ? runs : ' ');
}

function sheetView(rows) {
  if (!rows?.length) return h('p', { class: 'muted' }, '(planilha vazia)');
  const [head, ...rest] = rows;
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => Array.from({ length: width }, (_, i) => r[i] ?? '');
  return h('div', { class: 'table-wrap doc-sheet' },
    h('table', { class: 'table' },
      h('thead', null, h('tr', null, pad(head).map((c) => h('th', null, c)))),
      h('tbody', null, rest.map((r) => h('tr', null, pad(r).map((c) => h('td', null, c)))))),
    rows.length >= 300 ? h('p', { class: 'muted small' }, 'Mostrando as primeiras 300 linhas.') : null);
}
