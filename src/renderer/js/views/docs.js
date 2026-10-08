// Documentos: a pasta "BARROS ADVOGADOS" do OneDrive dentro do sistema.
// Peças usadas em vários lugares (ficha do caso, ficha do contato) e a tela
// "Documentos" (busca no nome e no conteúdo, modelos e pastas).
import {
  h, fill, modal, toast, errToast, promptDialog, fmtSize, fmtDateTime, pickFiles, uploadFiles, openDoc, showDoc, debounce, normalize,
} from '../util.js';
import { state, on, api, openChat } from '../store.js';
import { icon } from '../icons.js';
import { previewDoc, editDoc, touchDoc, OFFICE_RE } from './docviewer.js';

const KINDS = [
  [/\.(docx?|odt|rtf)$/i, 'doc'], [/\.pdf$/i, 'pdf'], [/\.(xlsx?|csv|ods)$/i, 'sheet'], [/\.(pptx?)$/i, 'slides'],
  [/\.(jpe?g|png|gif|webp|heic)$/i, 'img'], [/\.(mp3|ogg|opus|m4a|wav|mp4|mov|avi|mkv)$/i, 'media'], [/\.(zip|rar|7z)$/i, 'zip'],
];
export const docIcon = (d) => (d.dir ? icon('folder', 18, 'ico-folder')
  : icon('file', 18, `ico-${KINDS.find(([re]) => re.test(d.name))?.[1] || 'other'}`));
const base = (rel) => String(rel || '').split('/').pop() || 'BARROS ADVOGADOS';
const join = (...p) => p.filter(Boolean).join('/');

/** Abre o documento (Word no app de desktop; cópia no navegador). */
/**
 * Abrir: no app de desktop com a pasta neste computador abre o arquivo de
 * verdade; senão mostra dentro do sistema (sem baixar cópia).
 */
export async function openDocument(d) {
  if (d.dir) return openDoc(d).catch(errToast);
  if (window.desktop?.openDoc && await window.desktop.openDoc(d.rel).catch(() => false)) { touchDoc(d, 'open'); return; }
  return previewDoc(d);
}

// ------------------------------------------------------------ navegador de pastas

/**
 * Lista uma pasta com navegação (sem sair de `top`), envio de arquivos,
 * nova pasta e "novo a partir de modelo".
 */
export function folderBrowser(el, { top, start, caseId, clientId }) {
  let rel = start || top;
  async function render(fresh = false) {
    let r;
    if (!el.childElementCount) fill(el, h('p', { class: 'muted small' }, 'Carregando…'));
    try { r = await api('docs:list', rel, { fresh }); } catch (e) { fill(el, h('p', { class: 'muted' }, e.message)); return; }
    const crumbs = [];
    const parts = rel.slice(top.length).split('/').filter(Boolean);
    crumbs.push(h('button', { class: 'crumb', onclick: () => go(top) }, `${base(top)}`));
    parts.forEach((p, i) => {
      const to = join(top, ...parts.slice(0, i + 1));
      crumbs.push(h('span', { class: 'muted' }, ' › '), h('button', { class: 'crumb', onclick: () => go(to) }, p));
    });
    fill(el,
      h('div', { class: 'docs-toolbar' },
        h('div', { class: 'crumbs grow' }, crumbs),
        h('button', { class: 'icon-btn', title: 'Atualizar (ver o que mudou no OneDrive agora)', onclick: () => render(true) }, icon('refresh', 16)),
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => templatePicker({ caseId, clientId, dirRel: rel, onDone: () => render() }) }, 'Novo do modelo'),
        h('button', { class: 'btn btn-sm', title: 'Ou arraste os arquivos do computador para cá', onclick: () => upload() }, [icon('plus', 15), 'Enviar arquivos']),
        h('button', { class: 'btn btn-sm', title: 'Criar uma subpasta aqui', onclick: () => mkdir() }, [icon('plus', 15), 'Pasta']),
        window.desktop?.openDoc ? h('button', { class: 'btn btn-sm', title: 'Abrir esta pasta no Explorador de Arquivos', onclick: () => openDocument({ rel, dir: true, name: base(rel) }) }, 'Abrir no Windows') : null),
      !r.exists ? h('p', { class: 'muted small' }, 'Esta pasta não existe mais no OneDrive.')
        : r.entries.length ? h('div', { class: 'doc-list' }, r.entries.map((d) => entryRow(d, { onOpenDir: () => go(d.rel), caseId })))
          : h('p', { class: 'muted small' }, 'Pasta vazia. Arraste arquivos para cá, envie ou crie um documento a partir de um modelo.'));
  }
  const go = (to) => { rel = to; render(); };
  // arrastar arquivos do computador para a pasta aberta (um ouvinte só por elemento,
  // mesmo que a pasta seja redesenhada várias vezes)
  el.__dropTo = (files) => upload(files);
  if (!el.__dropBound) {
    el.__dropBound = true;
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    el.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; el.classList.add('drop-target'); });
    el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('drop-target'); } });
    el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      el.classList.remove('drop-target');
      const files = [...e.dataTransfer.files].filter((f) => f.size > 0 || f.type);
      if (files.length) el.__dropTo(files);
    });
  }
  async function upload(dropped) {
    const files = dropped || await pickFiles();
    if (!files.length) return;
    try {
      toast('Enviando…');
      const saved = await api('docs:upload', rel, await uploadFiles(files));
      toast(`${saved.length} arquivo(s) salvos na pasta`, 'success');
      render();
    } catch (e) { errToast(e); }
  }
  async function mkdir() {
    const name = await promptDialog('Nova pasta', { label: 'Nome da pasta' });
    if (!name?.trim()) return;
    try { await api('docs:mkdir', join(rel, name.trim().replace(/[\\/:*?"<>|]/g, '-'))); render(); } catch (e) { errToast(e); }
  }
  render();
  return { refresh: () => render() };
}

function entryRow(d, { onOpenDir, caseId } = {}) {
  return h('div', { class: 'doc-row', ondblclick: () => (d.dir ? onOpenDir?.() : openDocument(d)) },
    h('span', { class: 'doc-icon' }, docIcon(d)),
    h('div', { class: 'grow doc-main', onclick: d.dir ? onOpenDir : null },
      h('div', { class: 'ellipsis' }, d.name),
      h('div', { class: 'muted small' }, [d.mtime ? fmtDateTime(d.mtime) : null, d.size != null ? fmtSize(d.size) : null].filter(Boolean).join(' · '))),
    d.dir ? h('button', { class: 'btn btn-sm', onclick: onOpenDir }, 'Entrar')
      : [
        h('button', { class: 'btn btn-sm', onclick: () => openDocument(d) }, 'Ver'),
        OFFICE_RE.test(d.name) ? h('button', { class: 'btn btn-sm', title: 'Abrir no Word/Excel direto do OneDrive: o que salvar vai para a pasta do escritório', onclick: () => editDoc(d) }, 'Editar') : null,
        /\.docx$/i.test(d.name) ? h('button', { class: 'btn btn-sm', title: 'Fazer uma cópia deste documento na pasta de um caso', onclick: () => useAsBaseDialog(d, { caseId }) }, 'Usar como base') : null,
        h('button', { class: 'icon-btn small', title: window.desktop?.showDoc ? 'Mostrar na pasta' : 'Baixar uma cópia', onclick: () => showDoc(d).catch(errToast) }, window.desktop?.showDoc ? icon('folder', 16) : icon('download', 16)),
      ]);
}

// ------------------------------------------------------------ modelos

/** Escolher um modelo de 04 MODELOS e criar o documento já preenchido. */
export async function templatePicker({ caseId, clientId, dirRel, onDone } = {}) {
  let list;
  try { list = await api('docs:templates'); } catch (e) { errToast(e); return; }
  if (!list.length) {
    toast('Nenhum modelo em “04 MODELOS”. Coloque os modelos (.docx) lá, separados por área.', 'info', 6000);
    return;
  }
  const search = h('input', { class: 'input', placeholder: 'Procurar modelo…', type: 'search' });
  const box = h('div', { class: 'tpl-list' });
  const render = () => {
    const q = normalize(search.value);
    const items = list.filter((t) => !q || normalize(`${t.area} ${t.name}`).includes(q));
    const areas = [...new Set(items.map((t) => t.area))];
    fill(box, areas.length ? areas.map((a) => h('div', { class: 'tpl-group' },
      h('div', { class: 'tpl-area' }, a),
      items.filter((t) => t.area === a).map((t) => h('button', { class: 'tpl-item', onclick: () => make(t) },
        h('span', null, docIcon(t)), h('span', { class: 'grow' }, t.name.replace(/\.[^.]+$/, '')),
        t.fillable ? h('span', { class: 'muted small' }, 'preenche os dados') : h('span', { class: 'muted small' }, 'cópia'))))) : h('p', { class: 'muted' }, 'Nenhum modelo com esse nome.'));
  };
  search.addEventListener('input', render);
  render();
  const m = modal({
    title: 'Novo documento a partir de modelo',
    wide: true,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'O documento é criado na pasta, com a data na frente do nome, e os campos como {nome} e {cpf} já preenchidos com a ficha do cliente e do caso. Depois é só abrir e revisar.'),
      search, box),
    actions: [{ label: 'Fechar' }],
  });
  setTimeout(() => search.focus(), 50);
  async function make(t) {
    try {
      const r = await api('docs:useAsBase', t.rel, { caseId, clientId, dirRel });
      m.close?.();
      toast(`Criado: ${base(r.rel)}`, 'success', 5000);
      onDone?.();
      const nd = { rel: r.rel, url: r.url, name: base(r.rel) };
      touchDoc(nd, 'create');
      (OFFICE_RE.test(nd.name) ? editDoc(nd) : openDocument(nd));
    } catch (e) { errToast(e); }
  }
}

/** "Usar como base": copiar um documento encontrado para a pasta de um caso. */
export async function useAsBaseDialog(d, { caseId } = {}) {
  if (caseId) return copyTo(caseId);
  const cases = (await api('cases:list', { status: 'aberto' }).catch(() => [])).filter((k) => k.status === 'aberto');
  if (!cases.length) { toast('Nenhum caso aberto. Crie o caso na ficha do cliente primeiro.'); return; }
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Procurar caso ou cliente…' });
  const box = h('div', { class: 'tpl-list' });
  const name = (k) => k.client_name || '';
  const render = () => {
    const q = normalize(search.value);
    fill(box, cases.filter((k) => !q || normalize(`${k.title} ${name(k)}`).includes(q)).slice(0, 40).map((k) => h('button', { class: 'tpl-item', onclick: () => { m.close?.(); copyTo(k.id); } },
      h('span', null, k.folder ? icon('folder', 16) : icon('plus', 16)),
      h('span', { class: 'grow' }, h('b', null, name(k)), ` — ${k.title}`),
      h('span', { class: 'muted small' }, k.folder ? 'tem pasta' : 'sem pasta'))));
  };
  search.addEventListener('input', render);
  render();
  const m = modal({
    title: `Usar “${d.name}” como base`,
    body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Escolha o caso. Uma cópia vai para a pasta dele (o original não muda).'), search, box),
    actions: [{ label: 'Cancelar' }],
  });
  setTimeout(() => search.focus(), 50);

  async function copyTo(id) {
    try {
      const info = await api('docs:caseFolder', id);
      if (!info.folder) await api('docs:createCaseFolder', id, { clientFolder: info.clientFolder || info.clientSuggestion?.rel });
      const r = await api('docs:useAsBase', d.rel, { caseId: id });
      toast(`Cópia criada: ${base(r.rel)}`, 'success', 5000);
      const nd = { rel: r.rel, url: r.url, name: base(r.rel) };
      touchDoc(nd, 'create');
      (OFFICE_RE.test(nd.name) ? editDoc(nd) : openDocument(nd));
    } catch (e) { errToast(e); }
  }
}

// ------------------------------------------------------------ pasta do cliente / do caso

/** Ligar o contato a uma pasta de cliente (a sugerida, outra, ou criar). */
export async function clientFolderDialog(clientId, onDone) {
  let info;
  try { info = await api('docs:clientFolder', clientId); } catch (e) { errToast(e); return; }
  const chat = { display_name: (await api('clients:get', clientId).catch(() => null))?.name || '' };
  const folders = (await api('docs:list', '02 CLIENTES').catch(() => ({ entries: [] }))).entries.filter((e) => e.dir);
  const sel = h('select', { class: 'input' },
    h('option', { value: '' }, '— escolha a pasta —'),
    folders.map((f) => h('option', { value: f.rel, selected: f.rel === (info.folder || info.suggestion?.rel) }, f.name)));
  const m = modal({
    title: `Pasta de ${chat?.display_name || 'cliente'}`,
    body: h('div', { class: 'stack' },
      info.folder ? h('p', null, 'Ligada a ', h('b', null, info.folder))
        : info.suggestion ? h('p', null, 'Encontrei a pasta ', h('b', null, info.suggestion.name), info.suggestion.archived ? ' (no arquivo morto)' : '', '. É deste cliente?')
          : h('p', { class: 'muted' }, 'Não achei uma pasta com este nome em 02 CLIENTES.'),
      h('label', { class: 'field' }, h('span', null, 'Pasta do cliente'), sel)),
    actions: [
      { label: 'Cancelar' },
      { label: `Criar “${String(chat?.display_name || '').toUpperCase()}”`, onClick: async () => { try { await api('docs:createClientFolder', clientId); toast('Pasta criada no OneDrive', 'success'); onDone?.(); } catch (e) { errToast(e); return false; } } },
      { label: 'Ligar', primary: true, onClick: async () => { if (!sel.value) return false; try { await api('docs:linkClient', clientId, sel.value); onDone?.(); } catch (e) { errToast(e); return false; } } },
    ],
  });
  return m;
}

/** Aba Documentos do caso: a pasta do caso no OneDrive (ou como criar/ligar). */
export async function caseFolderPanel(el, k, { onChange } = {}) {
  let st;
  try { st = await api('docs:status'); } catch { st = { ok: false }; }
  if (!st.ok) {
    fill(el, h('div', { class: 'docs-empty' },
      h('b', null, 'Pasta do OneDrive não configurada'),
      h('p', { class: 'muted small' }, state.me?.role === 'socio'
        ? 'Em Ajustes → Documentos, informe onde está a pasta “BARROS ADVOGADOS” neste computador.'
        : 'Peça a um sócio para configurar a pasta do escritório em Ajustes → Documentos.')));
    return;
  }
  let info;
  try { info = await api('docs:caseFolder', k.id); } catch (e) { fill(el, h('p', { class: 'muted' }, e.message)); return; }
  if (info.folder) {
    folderBrowser(el, { top: info.folder, caseId: k.id, clientId: k.client_id });
    return;
  }
  const client = info.clientFolder || info.clientSuggestion?.rel;
  const target = `${client || `02 CLIENTES/${String(k.client_name || '').toUpperCase()}`}/${info.newName}`;
  const pick = info.options.length ? h('select', { class: 'input input-sm' },
    h('option', { value: '' }, 'ou ligar a uma pasta que já existe…'),
    info.options.map((o) => h('option', { value: o }, base(o)))) : null;
  pick?.addEventListener('change', async () => {
    if (!pick.value) return;
    try { await api('docs:linkCase', k.id, pick.value); onChange?.(); caseFolderPanel(el, k, { onChange }); } catch (e) { errToast(e); }
  });
  fill(el, h('div', { class: 'docs-empty' },
    h('b', null, 'Este caso ainda não tem pasta no OneDrive'),
    info.linked ? h('p', { class: 'bad-text small' }, `A pasta ligada (${info.linked}) não foi encontrada — foi movida ou renomeada?`) : null,
    !info.clientFolder && info.clientSuggestion ? h('p', { class: 'small' }, 'Pasta do cliente encontrada: ', h('b', null, info.clientSuggestion.rel)) : null,
    h('p', { class: 'muted small' }, 'Nova pasta, no padrão do escritório:'),
    h('div', { class: 'mono small folder-preview' }, target),
    h('div', { class: 'row wrap' },
      h('button', {
        class: 'btn btn-primary btn-sm',
        onclick: async () => {
          try {
            await api('docs:createCaseFolder', k.id, { clientFolder: client });
            toast('Pasta criada no OneDrive', 'success');
            onChange?.();
            caseFolderPanel(el, k, { onChange });
          } catch (e) { errToast(e); }
        },
      }, 'Criar pasta do caso'),
      pick,
      h('button', { class: 'btn btn-sm', onclick: () => clientFolderDialog(k.client_id, () => caseFolderPanel(el, k, { onChange })) }, 'Escolher a pasta do cliente…'))));
}

// ------------------------------------------------------------ tela Documentos

let root;
let tab = 'busca';
let lastQuery = '';

export function mountDocs(el) {
  root = el;
  on('view', (v) => v === 'docs' && render());
}

async function render() {
  let st;
  try { st = await api('docs:status'); } catch (e) { errToast(e); return; }
  const tabs = h('div', { class: 'segmented' },
    [['busca', 'Buscar'], ['recentes', 'Recentes'], ['modelos', 'Modelos'], ['pastas', 'Pastas']].map(([id, label]) => h('button', {
      class: `seg ${tab === id ? 'active' : ''}`, onclick: () => { tab = id; render(); },
    }, label)));
  const body = h('div', { class: 'docs-body' });
  fill(root,
    h('div', { class: 'page-head' },
      h('div', null, h('h2', null, 'Documentos'),
        h('div', { class: 'muted small' }, st.ok ? `Pasta do escritório: ${st.mode === 'onedrive' ? `${st.onedrive?.folder?.name || 'BARROS ADVOGADOS'} (OneDrive)` : st.root}` : 'Pasta do escritório não configurada')),
      st.ok ? tabs : null),
    st.ok ? body : h('div', { class: 'panel' },
      h('p', null, 'O sistema precisa saber onde está a pasta ', h('b', null, 'BARROS ADVOGADOS'), ' do OneDrive.'),
      state.me?.role === 'socio'
        ? h('button', { class: 'btn btn-primary', onclick: () => import('../store.js').then((s) => s.setView('settings')) }, 'Configurar em Ajustes → Documentos')
        : h('p', { class: 'muted' }, 'Peça a um sócio para configurar em Ajustes → Documentos.')));
  if (!st.ok) return;
  if (tab === 'busca') renderSearch(body, st);
  else if (tab === 'recentes') renderRecent(body);
  else if (tab === 'modelos') renderTemplates(body);
  else folderBrowser(body, { top: '', start: st.folders.includes('02 CLIENTES') ? '02 CLIENTES' : '' });
}

const ACTION_LABEL = { open: 'aberto', edit: 'editado', create: 'criado', upload: 'enviado', save: 'salvo do WhatsApp' };

/** Os arquivos que você abriu, editou ou criou por último. */
async function renderRecent(el) {
  fill(el, h('p', { class: 'muted small' }, 'Carregando…'));
  let list;
  try { list = await api('docs:recent'); } catch (e) { fill(el, h('p', { class: 'muted' }, e.message)); return; }
  if (!list.length) {
    fill(el, h('p', { class: 'muted' }, 'Os arquivos que você abrir, editar ou criar aparecem aqui, para voltar a eles rápido.'));
    return;
  }
  fill(el, h('div', { class: 'doc-list recent-list' }, list.map((d) => h('div', { class: 'doc-row' },
    h('span', { class: 'doc-icon' }, docIcon(d)),
    h('div', { class: 'grow doc-main', ondblclick: () => openDocument(d) },
      h('div', { class: 'ellipsis' }, d.name),
      h('div', { class: 'muted small ellipsis' }, `${d.folder || 'BARROS ADVOGADOS'} · ${ACTION_LABEL[d.action] || 'aberto'} ${fmtDateTime(d.at)}`)),
    h('button', { class: 'btn btn-sm', onclick: () => openDocument(d) }, 'Ver'),
    OFFICE_RE.test(d.name) ? h('button', { class: 'btn btn-sm', onclick: () => editDoc(d) }, 'Editar') : null,
    h('button', {
      class: 'icon-btn small', title: 'Tirar da lista',
      onclick: () => api('docs:forgetRecent', d.rel).then(() => renderRecent(el)).catch(errToast),
    }, icon('x', 14))))));
}

function renderSearch(el, st) {
  const input = h('input', {
    class: 'input docs-search', type: 'search', value: lastQuery, autofocus: true,
    placeholder: 'Buscar por nome do cliente, assunto ou palavras dentro dos documentos (ex.: atraso de voo dano moral)',
  });
  const results = h('div', { class: 'docs-results' });
  const run = debounce(async () => {
    lastQuery = input.value.trim();
    if (lastQuery.length < 2) {
      fill(results, h('div', { class: 'muted small docs-hint' },
        `Busca nos nomes e no conteúdo de documentos Word, PDF (com texto) e .txt da pasta do escritório${st.indexed ? ` — ${st.indexed} arquivo(s) lidos` : ''}. `,
        'Achou uma peça parecida? Clique em “Usar como base” para levar uma cópia para a pasta do caso.'));
      return;
    }
    fill(results, h('div', { class: 'muted small' }, st.indexed ? 'Buscando…' : 'Lendo os documentos pela primeira vez — pode levar alguns minutos…'));
    try {
      const list = await api('docs:search', lastQuery);
      if (input.value.trim() !== lastQuery) return;
      fill(results, list.length ? list.map((d) => h('div', { class: 'doc-row search-hit' },
        h('span', { class: 'doc-icon' }, docIcon(d)),
        h('div', { class: 'grow doc-main', ondblclick: () => openDocument(d) },
          h('div', { class: 'ellipsis' }, highlight(d.name, lastQuery)),
          h('div', { class: 'muted small ellipsis' }, `${d.folder} · ${fmtDateTime(d.mtime)}`),
          d.snippet ? h('div', { class: 'snippet small' }, highlight(d.snippet, lastQuery)) : null),
        h('button', { class: 'btn btn-sm', onclick: () => openDocument(d) }, 'Ver'),
        OFFICE_RE.test(d.name) ? h('button', { class: 'btn btn-sm', onclick: () => editDoc(d) }, 'Editar') : null,
        /\.docx$/i.test(d.name) ? h('button', { class: 'btn btn-sm', onclick: () => useAsBaseDialog(d) }, 'Usar como base') : null,
        h('button', { class: 'icon-btn small', title: window.desktop?.showDoc ? 'Mostrar na pasta' : 'Baixar', onclick: () => showDoc(d).catch(errToast) }, window.desktop?.showDoc ? icon('folder', 16) : icon('download', 16))))
        : h('p', { class: 'muted' }, 'Nada encontrado. Tente menos palavras ou sem o nome completo.'));
    } catch (e) { errToast(e); }
  }, 300);
  input.addEventListener('input', run);
  fill(el, h('div', { class: 'row' }, input,
    h('button', {
      class: 'btn', title: 'Ler de novo os arquivos novos ou alterados',
      onclick: async () => { toast('Atualizando a busca…'); try { const r = await api('docs:reindex'); toast(`Busca atualizada (${r.indexed} arquivos)`, 'success'); run(); } catch (e) { errToast(e); } },
    }, '↻')), results);
  run();
  setTimeout(() => input.focus(), 30);
}

/** Destaca as palavras buscadas (sem diferença de acento). */
function highlight(text, q) {
  const words = normalize(q).split(/\s+/).filter((w) => w.length >= 2);
  const t = String(text);
  const n = normalize(t);
  if (n.length !== t.length || !words.length) return t;
  const marks = [];
  for (const w of words) for (let i = n.indexOf(w); i >= 0; i = n.indexOf(w, i + w.length)) marks.push([i, i + w.length]);
  marks.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    out.push(t.slice(pos, a), h('mark', null, t.slice(a, b)));
    pos = b;
  }
  out.push(t.slice(pos));
  return h('span', null, out);
}

async function renderTemplates(el) {
  let list;
  try { list = await api('docs:templates'); } catch (e) { errToast(e); return; }
  const st = await api('docs:status');
  const areas = [...new Set(list.map((t) => t.area))];
  fill(el,
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', null, 'Como preparar um modelo'), h('span', { class: 'muted small' }, 'pasta 04 MODELOS')),
      h('p', { class: 'small' }, 'Num documento Word (.docx) da pasta 04 MODELOS, escreva entre chaves o campo que deve ser preenchido. Ex.: “OUTORGANTE: {NOME}, CPF {cpf}”. Em maiúsculas ({NOME}) sai em maiúsculas.'),
      h('div', { class: 'placeholder-grid small' }, st.placeholders.map(([k, d]) => h('div', null, h('code', null, `{${k}}`), ` ${d}`))),
      h('p', { class: 'muted small' }, 'Os dados do cliente (CPF, RG, endereço…) ficam na ficha do contato, em “Dados para documentos”.')),
    list.length ? areas.map((a) => h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', null, a)),
      h('div', { class: 'doc-list' }, list.filter((t) => t.area === a).map((t) => entryRow({ ...t, dir: false })))))
      : h('p', { class: 'muted' }, 'Nenhum modelo ainda em 04 MODELOS.'));
}

export { openChat };
