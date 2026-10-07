// Importar a lista de processos de outro sistema (LinkLei e afins), escolher o
// cliente de cada processo pelas partes achadas no DJEN e os avisos de
// arquivamento (provisório = vigiar a prescrição; definitivo = encerrar?).
import { h, fill, modal, toast, errToast, confirmDialog, pickFiles, uploadFiles, fmtDay, toLocalInput } from '../util.js';
import { state, on, api } from '../store.js';
import { icon } from '../icons.js';
import { looksLikeCompany } from '../qualify.js';

const FIELD_LABELS = {
  number: 'Nº do processo', title: 'Título / partes', tribunal: 'Tribunal', status: 'Situação', client: 'Cliente',
  opposing: 'Parte contrária', responsible: 'Responsável', area: 'Área', court: 'Vara',
};

/** Janela: escolher o arquivo → prévia (colunas, novos, repetidos, problemas) → importar. */
export async function importDialog() {
  const [file] = await pickFiles({ multiple: false, accept: '.xlsx,.csv,.txt' });
  if (!file) return;
  let token;
  try { [token] = await uploadFiles([file]); } catch (e) { errToast(e); return; }
  const body = h('div', { class: 'import-box' }, h('p', { class: 'muted' }, 'Lendo a planilha…'));
  let pre = null;
  let map = null;
  const team = await api('team:list').catch(() => []);
  const resp = h('select', { class: 'input' }, team.map((u) => h('option', { value: u.id, selected: u.id === state.me?.id }, u.name)));
  const draw = () => {
    const mapRow = h('div', { class: 'import-map' }, Object.entries(FIELD_LABELS).map(([key, label]) => {
      const sel = h('select', { class: 'input select-sm' },
        h('option', { value: '' }, '—'),
        pre.header.map((col, i) => h('option', { value: i, selected: map[key] === i }, col || `Coluna ${i + 1}`)));
      sel.addEventListener('change', async () => {
        if (sel.value === '') delete map[key]; else map[key] = Number(sel.value);
        try { pre = await api('cases:importPreview', token, map); draw(); } catch (e) { errToast(e); }
      });
      return h('label', { class: 'field' }, h('span', null, label), sel);
    }));
    const tribs = Object.entries(pre.byTribunal).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}: ${n}`).join(' · ');
    fill(body,
      h('div', { class: 'stats import-stats' },
        h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(pre.newCount)), h('div', { class: 'stat-label' }, 'processos novos'), h('div', { class: 'muted small' }, tribs)),
        h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(pre.existing)), h('div', { class: 'stat-label' }, 'já cadastrados'), h('div', { class: 'muted small' }, 'ficam como estão')),
        h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(pre.duplicates)), h('div', { class: 'stat-label' }, 'repetidos na planilha'), h('div', { class: 'muted small' }, 'entram uma vez só')),
        h('div', { class: `stat ${pre.problems.length ? 'stat-warn' : ''}` }, h('div', { class: 'stat-value' }, String(pre.problems.length)), h('div', { class: 'stat-label' }, 'com problema'), h('div', { class: 'muted small' }, 'ficam de fora'))),
      pre.problems.length ? h('details', { class: 'import-problems' }, h('summary', null, 'Ver as linhas com problema'),
        h('ul', null, pre.problems.slice(0, 50).map((p) => h('li', null, `Linha ${p.line}: ${p.value} — ${p.reason}`)))) : null,
      h('h4', null, 'Como entendi as colunas'),
      h('p', { class: 'muted small' }, 'Se alguma estiver trocada, corrija aqui.'),
      mapRow,
      h('h4', null, 'Prévia'),
      h('div', { class: 'table-wrap import-preview' }, h('table', { class: 'table compact' },
        h('thead', null, h('tr', null, ['Nº do processo', 'Tribunal', 'Título / partes', 'Situação', ''].map((t) => h('th', null, t)))),
        h('tbody', null, pre.sample.slice(0, 60).map((it) => h('tr', { class: it.exists ? 'muted' : '' },
          h('td', { class: 'mono small' }, it.number),
          h('td', { class: 'small' }, it.tribunal || '—'),
          h('td', { class: 'small' }, it.parties.length ? it.parties.map((p) => p.name).join(' x ') : (it.title || h('span', { class: 'muted' }, 'cliente a identificar'))),
          h('td', { class: 'small' }, it.status || ''),
          h('td', { class: 'small' }, it.exists ? 'já cadastrado' : 'novo')))))),
      pre.sample.length > 60 ? h('p', { class: 'muted small' }, `… e mais ${pre.sample.length - 60} na planilha.`) : null,
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'Responsável pelos processos (quando a planilha não diz)'), resp)),
      h('div', { class: 'import-explain' },
        icon('help', 16),
        h('div', null,
          h('b', null, 'Depois de importar, o sistema trabalha sozinho, um processo por vez: '),
          'busca no DataJud a classe, a vara e os andamentos (a área sai daí), marca os arquivados provisoriamente para vigiar a prescrição, ',
          'sugere encerrar os que tiveram baixa definitiva (só com a sua confirmação) e procura no DJEN as partes, para você escolher quem é o cliente. ',
          `Leva cerca de ${Math.max(1, Math.round((pre.newCount * 3.5) / 60))} minutos; dá para continuar usando o sistema.`)));
  };
  const dlg = modal({
    title: 'Importar processos',
    body,
    wide: true,
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Importar',
        primary: true,
        onClick: async () => {
          if (!pre?.newCount) { toast('Nenhum processo novo para importar.', 'error'); return false; }
          await api('cases:importRun', token, { map, responsibleId: Number(resp.value) });
          toast(`${pre.newCount} processo(s) importado(s). Consultando os tribunais…`, 'success');
          return true;
        },
      },
    ],
  });
  try {
    pre = await api('cases:importPreview', token);
    map = { ...pre.map };
    draw();
  } catch (e) { dlg.close(); errToast(e); }
}

/** Barra de andamento da importação (some quando termina). */
export function importProgress() {
  const bar = h('div', { class: 'import-progress', hidden: true });
  const paint = (st) => {
    if (!bar.isConnected && bar.dataset.mounted) return;
    bar.dataset.mounted = '1';
    bar.hidden = !st?.running;
    if (!st?.running) return;
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    fill(bar,
      h('div', { class: 'row' }, h('b', null, 'Importação: '), `${st.phase} — ${st.done} de ${st.total}`, h('div', { class: 'grow' }), h('span', { class: 'muted small' }, `${pct}%`)),
      h('div', { class: 'progress' }, h('div', { class: 'progress-fill', style: { width: `${pct}%` } })));
  };
  api('cases:importStatus').then(paint).catch(() => {});
  const off = on('cases-import', (st) => { if (!bar.isConnected && bar.dataset.mounted) { off(); return; } paint(st); });
  return bar;
}

const POLO = { ativo: 'autor / polo ativo', passivo: 'réu / polo passivo' };

/**
 * Escolher o cliente de um processo: lista as partes achadas (DJEN ou título)
 * com "Meu cliente" / "Parte contrária" / "Ignorar", ou busca um cliente cadastrado.
 */
export function partyChooser(k, { onDone } = {}) {
  const el = h('div', { class: 'party-chooser' });
  const choice = new Map(); // nome → 'cliente' | 'contraria' | 'ignorar'
  const parties = k.parties_found || [];
  for (const p of parties) choice.set(p.name, p.suggested ? 'cliente' : 'contraria');
  if (parties.length && ![...choice.values()].includes('cliente')) choice.set(parties[0].name, 'cliente');
  const search = h('input', { class: 'input', placeholder: 'ou busque um cliente cadastrado…', type: 'search' });
  const results = h('div', { class: 'party-results' });
  search.addEventListener('input', async () => {
    const term = search.value.trim();
    if (term.length < 2) { fill(results); return; }
    const list = await api('clients:list', { q: term }).catch(() => []);
    fill(results, list.slice(0, 6).map((c) => h('button', {
      class: 'btn btn-sm', type: 'button',
      onclick: async () => {
        try {
          await api('cases:assignClient', k.id, { client_id: c.id, opposing: parties.filter((p) => choice.get(p.name) === 'contraria') });
          toast(`Processo ligado a ${c.name}`, 'success');
          onDone?.();
        } catch (e) { errToast(e); }
      },
    }, c.name)), list.length ? null : h('span', { class: 'muted small' }, 'Nenhum cliente com esse nome.'));
  });
  const draw = () => {
    fill(el,
      parties.length
        ? h('div', { class: 'party-list' }, parties.map((p) => h('div', { class: `party-row ${choice.get(p.name)}` },
          h('div', { class: 'grow' }, h('b', null, p.name), h('div', { class: 'muted small' }, [POLO[p.polo] || 'parte', p.suggested ? ' · comunicação para a sua OAB' : '', p.from === 'titulo' ? ' · do título da planilha' : ''].join(''))),
          h('div', { class: 'segmented' }, [['cliente', 'Meu cliente'], ['contraria', 'Parte contrária'], ['ignorar', 'Ignorar']].map(([v, l]) => h('button', {
            type: 'button', class: `seg ${choice.get(p.name) === v ? 'active' : ''}`,
            onclick: () => {
              if (v === 'cliente') for (const [n, c] of choice) if (c === 'cliente') choice.set(n, 'contraria');
              choice.set(p.name, v);
              draw();
            },
          }, l))))))
        : h('p', { class: 'muted small' }, k.parties_checked_at ? 'O DJEN não tem publicações deste processo com as partes. Busque o cliente abaixo ou cadastre.' : 'Ainda não buscamos as partes deste processo.'),
      h('div', { class: 'row wrap' },
        parties.length ? h('button', {
          class: 'btn btn-primary btn-sm', type: 'button',
          onclick: async () => {
            const mine = parties.find((p) => choice.get(p.name) === 'cliente');
            if (!mine) { toast('Marque quem é o seu cliente.', 'error'); return; }
            try {
              const r = await api('cases:assignClient', k.id, {
                name: mine.name, kind: looksLikeCompany(mine.name) ? 'pj' : 'pf', role: mine.polo,
                opposing: parties.filter((p) => choice.get(p.name) === 'contraria'),
              });
              toast(`Cliente: ${mine.name}`, 'success', 5000);
              onDone?.(r);
            } catch (e) { errToast(e); }
          },
        }, 'Confirmar') : null,
        h('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            e.currentTarget.textContent = 'Buscando no DJEN…';
            try { const nk = await api('cases:findParties', k.id); Object.assign(k, nk); fill(el); el.replaceWith(partyChooser(k, { onDone })); } catch (err) { errToast(err); draw(); }
          },
        }, k.parties_checked_at ? 'Buscar de novo' : 'Buscar partes'),
        search),
      results);
  };
  draw();
  return el;
}

/** Lista "Processos sem cliente": um cartão por processo com as partes para escolher. */
export async function drawWithoutClient(el, { q = '', onChange } = {}) {
  let list;
  try { list = await api('cases:withoutClient'); } catch (e) { errToast(e); return; }
  const nq = q.trim().toLowerCase();
  const items = list.filter((k) => !nq || `${k.title} ${k.process_number} ${(k.parties_found || []).map((p) => p.name).join(' ')}`.toLowerCase().includes(nq));
  if (!items.length) {
    fill(el, h('div', { class: 'panel' }, h('p', { class: 'muted' }, list.length ? 'Nenhum processo encontrado.' : 'Todos os processos já têm cliente.')));
    return;
  }
  const pendingSearch = items.filter((k) => !k.parties_checked_at).length;
  fill(el,
    h('div', { class: 'panel no-client-head' },
      h('div', { class: 'grow' }, h('b', null, `${items.length} processo(s) sem cliente`),
        h('div', { class: 'muted small' }, 'Marque quem é o seu cliente e quem é a parte contrária. O cadastro do cliente é criado com o nome completo; os outros dados você completa na ficha.')),
      pendingSearch ? h('span', { class: 'muted small' }, `${pendingSearch} ainda sem busca das partes`) : null),
    h('div', { class: 'no-client-list' }, items.slice(0, 80).map((k) => h('div', { class: 'panel no-client-card' },
      h('div', { class: 'row wrap' },
        h('div', { class: 'grow' },
          h('b', { class: 'mono' }, k.process_number),
          h('div', { class: 'muted small' }, [k.tribunal, k.title, k.area, k.court].filter(Boolean).join(' · '))),
        archiveBadge(k)),
      partyChooser(k, { onDone: (r) => { onChange?.(); if (r?.clientId) toast('Abra a ficha do cliente para completar os dados.', 'info'); } })))),
    items.length > 80 ? h('p', { class: 'muted small' }, `Mostrando 80 de ${items.length}. Use a busca para achar os outros.`) : null);
}

/** Etiqueta curta da situação de arquivamento. */
export function archiveBadge(k) {
  if (k.status !== 'aberto') return null;
  if (k.archive_state === 'provisorio') {
    const days = k.prescription_at ? Math.ceil((k.prescription_at - Date.now()) / 864e5) : null;
    return h('span', { class: `pill ${days != null && days <= 90 ? 'pill-bad' : 'pill-warn'}`, title: 'Arquivado provisoriamente: confira a prescrição' },
      icon('clock', 13), days == null ? 'Arquivado — vigiar' : days <= 0 ? 'Prescrição: conferir hoje' : `Vigiar: ${fmtDay(k.prescription_at)}`);
  }
  if (k.archive_state === 'definitivo' && !k.archive_dismissed) return h('span', { class: 'pill pill-muted', title: 'Baixa definitiva nos andamentos' }, icon('archive', 13), 'Baixa definitiva?');
  return null;
}

/** Faixas no topo da ficha do processo: sem cliente, arquivado provisório, baixa definitiva. */
export function caseBanners(k, { reload } = {}) {
  const out = [];
  if (k.no_client) {
    out.push(h('div', { class: 'case-banner warn' },
      h('div', null, h('b', null, 'Cliente a identificar. '), 'Este processo veio da importação. Escolha quem é o seu cliente:'),
      partyChooser(k, { onDone: () => reload?.() })));
  }
  if (k.status === 'aberto' && k.archive_state === 'provisorio') {
    const date = h('input', { class: 'input input-date', type: 'date', value: k.prescription_at ? toLocalInput(k.prescription_at).slice(0, 10) : '' });
    date.addEventListener('change', () => api('cases:archive', k.id, { prescription_at: date.value ? new Date(`${date.value}T12:00`).getTime() : null }).then(() => toast('Data de controle salva', 'success')).catch(errToast));
    out.push(h('div', { class: 'case-banner danger' },
      icon('clock', 18),
      h('div', { class: 'grow' },
        h('b', null, `Arquivado provisoriamente desde ${fmtDay(k.archive_since)}. `),
        'Não está encerrado: a prescrição pode correr. Avisamos 90 e 30 dias antes da data de controle.',
        h('div', { class: 'row wrap' }, h('span', { class: 'small' }, 'Conferir a prescrição em:'), date,
          h('span', { class: 'muted small' }, 'data sugerida — o prazo aplicável é decisão do advogado'))),
      h('button', {
        class: 'btn btn-sm', onclick: async () => {
          if (!await confirmDialog('Tirar o controle de prescrição deste processo? Use se ele foi desarquivado ou se o arquivamento não é provisório.', { okLabel: 'Tirar' })) return;
          api('cases:archive', k.id, { action: 'clear' }).catch(errToast);
        },
      }, 'Não está arquivado')));
  }
  if (k.status === 'aberto' && k.archive_state === 'definitivo' && !k.archive_dismissed) {
    out.push(h('div', { class: 'case-banner' },
      icon('archive', 18),
      h('div', { class: 'grow' }, h('b', null, `Baixa definitiva nos andamentos (${fmtDay(k.archive_since)}). `), 'Encerrar o processo? Ele vai para os encerrados (arquivo morto) e continua no sistema.'),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => closeCase(k.id) }, 'Encerrar'),
      h('button', { class: 'btn btn-sm', onclick: () => api('cases:archive', k.id, { action: 'watch' }).catch(errToast) }, 'É provisório: vigiar'),
      h('button', { class: 'btn btn-sm', onclick: () => api('cases:archive', k.id, { action: 'dismiss' }).catch(errToast) }, 'Continua ativo')));
  }
  return out;
}

// ------------------------------------------------------------ encerrar / reabrir com a pasta

/** Encerra o processo e oferece levar a pasta para o 03 ARQUIVO MORTO. */
export async function closeCase(id) {
  try { await api('cases:archive', id, { action: 'close' }); } catch (e) { errToast(e); return; }
  toast('Processo encerrado (continua no sistema, em Encerrados)', 'success');
  await folderPrompt(id, false);
}

/** Reabre o processo e oferece trazer a pasta de volta para o 02 CLIENTES. */
export async function reopenCase(id) {
  try { await api('cases:setStatus', id, 'aberto'); } catch (e) { errToast(e); return; }
  await folderPrompt(id, true);
}

async function folderPrompt(id, back) {
  let plan;
  try { plan = await api('docs:archivePlan', id, { back }); } catch { return; }
  if (!plan.can) {
    if (!back && plan.hasFolder) toast('Lembrete: mover a pasta do processo para o 03 ARQUIVO MORTO no OneDrive (Explorador de Arquivos).', 'info', 8000);
    return;
  }
  const what = plan.mode === 'client' ? 'a pasta do cliente' : 'a pasta deste processo';
  const msg = back
    ? `Trazer ${what} de volta para o 02 CLIENTES?\n\n${plan.from}\n→ ${plan.to}`
    : `Mover ${what} para o 03 ARQUIVO MORTO?${plan.mode === 'case' ? ' (o cliente tem outros processos abertos: a pasta dele fica onde está)' : ''}\n\n${plan.from}\n→ ${plan.to}`;
  if (!await confirmDialog(msg, { okLabel: back ? 'Trazer de volta' : 'Mover para o arquivo morto' })) return;
  try {
    await api('docs:archiveFolder', id, { back });
    toast(back ? 'Pasta de volta em 02 CLIENTES' : 'Pasta movida para o 03 ARQUIVO MORTO', 'success');
  } catch (e) { errToast(e); }
}
