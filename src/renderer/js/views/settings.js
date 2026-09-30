// Configurações: conexão, notificações, funis, etiquetas, respostas
// rápidas, backup e importação do Kanban antigo.
import { h, fill, modal, toast, errToast, confirmDialog, formatPhone, phoneOf, PALETTE } from '../util.js';
import { state, on, api, setSetting } from '../store.js';

let root;

export function mountSettings(el) {
  root = el;
  on('view', (v) => v === 'settings' && render());
  on('config', () => state.view === 'settings' && render());
  on('status', () => state.view === 'settings' && render());
  on('settings', () => state.view === 'settings' && render());
}

function toggle(key, label, hint, def = true) {
  const val = state.settings[key] ?? def;
  return h('label', { class: 'toggle-row' },
    h('div', null, h('div', null, label), hint ? h('div', { class: 'muted small' }, hint) : null),
    h('input', { type: 'checkbox', class: 'switch', checked: !!val, onchange: (e) => setSetting(key, e.target.checked).catch(errToast) }));
}

function section(title, ...children) {
  return h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', null, title)), ...children);
}

function render() {
  const st = state.status;
  const me = st.me;
  const connected = st.state === 'open';
  fill(root, 
    h('div', { class: 'page-head' }, h('h2', null, 'Configurações')),
    h('div', { class: 'settings-grid' },
      section('📱 Conexão com o WhatsApp',
        h('div', { class: 'conn-info' },
          h('span', { class: `status-dot ${connected ? 'ok' : 'warn'}` }),
          connected ? h('div', null, h('b', null, 'Conectado'), me ? h('div', { class: 'muted' }, `${me.name || ''} ${formatPhone(phoneOf(me.jid))}`) : null)
            : h('div', null, h('b', null, statusLabel(st.state)), st.error ? h('div', { class: 'muted small' }, st.error) : null)),
        h('p', { class: 'muted small' }, 'A sessão fica salva neste computador: você não precisa ler o QR code de novo ao abrir o app. Para trocar de número, desconecte aqui.'),
        h('div', { class: 'row' },
          !connected ? h('button', { class: 'btn', onclick: () => api('wa:reconnect').catch(errToast) }, '⟳ Tentar reconectar') : null,
          !st.registered ? h('button', { class: 'btn btn-primary', onclick: () => api('wa:reset').catch(errToast) }, '📱 Mostrar QR code') : null,
          h('button', { class: 'btn', onclick: runDiagnosis }, '🩺 Testar conexão'),
          h('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!await confirmDialog('Desconectar este WhatsApp do CRM? As conversas e dados do CRM continuam salvos no computador. Para usar de novo será preciso ler o QR code.', { okLabel: 'Desconectar', danger: true })) return;
              api('wa:logout').catch(errToast);
            },
          }, 'Desconectar WhatsApp'))),

      section('🔔 Notificações e comportamento',
        toggle('notifications', 'Avisos de novas mensagens', 'Mostra um aviso do Windows quando chega mensagem.'),
        toggle('notificationPreview', 'Mostrar o texto da mensagem no aviso'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn btn-sm', onclick: () => api('app:testNotification').catch(errToast) }, '🔔 Testar notificação'),
          h('button', { class: 'btn btn-sm', onclick: () => api('app:openNotificationSettings').catch(errToast) }, 'Abrir notificações do Windows')),
        h('p', { class: 'muted small' }, 'Se o teste não aparecer: em Configurações do Windows → Sistema → Notificações, confira se “WhatsApp CRM” está ligado e se o “Não perturbe” / “Assistente de foco” está desligado.'),
        toggle('minimizeToTray', 'Continuar rodando ao fechar a janela', 'O app fica perto do relógio e segue recebendo mensagens e lembretes.'),
        toggle('openAtLogin', 'Abrir junto com o Windows', null, false),
        toggle('sendReadReceipts', 'Marcar como lida no celular ao abrir a conversa', 'Envia a confirmação de leitura (tique azul), se ela estiver ativa no seu WhatsApp.'),
        toggle('enterToSend', 'Enter envia a mensagem', 'Desligado: use Ctrl+Enter para enviar e Enter para pular linha.'),
        h('label', { class: 'toggle-row' }, h('div', null, 'Tema'),
          h('select', { class: 'input select-sm', onchange: (e) => setSetting('theme', e.target.value).then(applyTheme) },
            [['system', 'Automático'], ['dark', 'Escuro'], ['light', 'Claro']].map(([v, l]) => h('option', { value: v, selected: (state.settings.theme || 'system') === v }, l)))),
        h('label', { class: 'toggle-row' },
          h('div', null, h('div', null, 'Avisar conversa sem resposta'), h('div', { class: 'muted small' }, 'Quando um contato de trabalho espera sua resposta há mais tempo que isso.')),
          h('select', { class: 'input select-sm', onchange: (e) => setSetting('forgottenHours', Number(e.target.value)).catch(errToast) },
            [[0, 'Nunca'], [2, '2 horas'], [4, '4 horas'], [8, '8 horas'], [24, '24 horas'], [48, '2 dias']].map(([v, l]) =>
              h('option', { value: v, selected: Number(state.settings.forgottenHours ?? 24) === v }, l))))),

      section('👥 Tipos de contato',
        h('p', { class: 'muted small' }, 'Classifique cada conversa (ex.: Pessoal, Cliente, Empresa). Tipos marcados como pessoais não entram em "Aguardando resposta" nem nos avisos de conversa esquecida.'),
        ...state.contactTypes.map((t, i) => h('div', { class: 'list-row' },
          h('span', { class: 'tag-chip', style: { '--c': t.color } }, `${t.icon || ''} ${t.name}`),
          h('span', { class: 'muted small grow' }, [t.personal ? 'pessoal' : 'trabalho', t.notify ? null : 'sem avisos'].filter(Boolean).join(' · ')),
          h('div', { class: 'row' },
            h('button', { class: 'icon-btn small', title: 'Subir', disabled: i === 0, onclick: () => moveItem('types', state.contactTypes, i, -1) }, '↑'),
            h('button', { class: 'icon-btn small', title: 'Descer', disabled: i === state.contactTypes.length - 1, onclick: () => moveItem('types', state.contactTypes, i, 1) }, '↓'),
            h('button', { class: 'btn btn-sm', onclick: () => typeEditor(t) }, 'Editar')))),
        h('button', { class: 'btn', onclick: () => typeEditor() }, '＋ Novo tipo')),

      section('🔎 Filtros das conversas',
        h('p', { class: 'muted small' }, 'Os botões no topo da lista de conversas. Crie os seus combinando tipo de contato, etiquetas, etapas, não lidas, aguardando resposta… Nada some: é só uma forma de ver a lista.'),
        ...state.filters.map((f, i) => h('div', { class: 'list-row' },
          h('span', null, `${f.icon || ''} ${f.name}`),
          h('span', { class: 'muted small grow ellipsis' }, describeRules(f.rules)),
          h('div', { class: 'row' },
            h('button', { class: 'icon-btn small', title: 'Subir', disabled: i === 0, onclick: () => moveItem('filters', state.filters, i, -1) }, '↑'),
            h('button', { class: 'icon-btn small', title: 'Descer', disabled: i === state.filters.length - 1, onclick: () => moveItem('filters', state.filters, i, 1) }, '↓'),
            h('button', { class: 'btn btn-sm', onclick: () => filterEditor(f) }, 'Editar')))),
        h('button', { class: 'btn', onclick: () => filterEditor() }, '＋ Novo filtro')),

      section('📊 Funis e etapas',
        h('p', { class: 'muted small' }, 'Cada funil tem suas etapas (colunas do quadro). Ex.: Atendimento → Novo, Proposta, Fechado.'),
        ...state.pipelines.map((p, i) => h('div', { class: 'list-row' },
          h('span', null, `${p.icon || ''} ${p.name}`),
          h('span', { class: 'stage-dots' }, p.stages.map((s) => h('span', { class: 'dot', style: { background: s.color }, title: s.name }))),
          h('div', { class: 'row' },
            h('button', { class: 'icon-btn small', title: 'Subir', disabled: i === 0, onclick: () => movePipeline(i, -1) }, '↑'),
            h('button', { class: 'icon-btn small', title: 'Descer', disabled: i === state.pipelines.length - 1, onclick: () => movePipeline(i, 1) }, '↓'),
            h('button', { class: 'btn btn-sm', onclick: () => pipelineEditor(p) }, 'Editar')))),
        h('button', { class: 'btn', onclick: () => pipelineEditor() }, '＋ Novo funil')),

      section('🏷 Etiquetas',
        ...state.tags.map((t) => h('div', { class: 'list-row' },
          h('span', { class: 'tag-chip', style: { '--c': t.color } }, t.name),
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-sm', onclick: () => tagEditor(t) }, 'Editar'),
            h('button', {
              class: 'btn btn-sm btn-danger',
              onclick: async () => { if (await confirmDialog(`Excluir a etiqueta “${t.name}”?`, { okLabel: 'Excluir', danger: true })) api('tags:delete', t.id).catch(errToast); },
            }, 'Excluir')))),
        h('button', { class: 'btn', onclick: () => tagEditor() }, '＋ Nova etiqueta')),

      section('⚡ Respostas rápidas',
        h('p', { class: 'muted small' }, 'Na conversa, digite “/” e o atalho para inserir o texto. Use {nome} para o primeiro nome do contato.'),
        ...state.quickReplies.map((r) => h('div', { class: 'list-row' },
          h('div', { class: 'grow' }, h('b', null, `/${r.shortcut}`), h('div', { class: 'muted small ellipsis' }, r.text)),
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-sm', onclick: () => quickEditor(r) }, 'Editar'),
            h('button', { class: 'btn btn-sm btn-danger', onclick: () => api('quick:delete', r.id).catch(errToast) }, 'Excluir')))),
        h('button', { class: 'btn', onclick: () => quickEditor() }, '＋ Nova resposta rápida')),

      section('💾 Dados e backup',
        h('p', { class: 'muted small' }, 'Tudo fica salvo neste computador, na pasta:'),
        h('code', { class: 'path' }, state.dataDir),
        h('div', { class: 'row wrap' },
          h('button', {
            class: 'btn',
            onclick: async () => { try { const f = await api('backup:export'); if (f) toast(`Backup salvo em ${f}`, 'success', 6000); } catch (e) { errToast(e); } },
          }, '⬇ Fazer backup do CRM'),
          h('button', { class: 'btn', onclick: () => api('app:openDataDir') }, '📂 Abrir pasta de dados')),
        state.legacyAvailable ? h('div', { class: 'legacy' },
          h('p', null, h('b', null, 'Kanban antigo encontrado. '), 'Importe as categorias, colunas, notas e prazos do app anterior.',
            state.legacyPending ? h('span', { class: 'muted small' }, ` (${state.legacyPending} classificação(ões) aguardando a conversa aparecer)`) : null),
          h('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              try {
                const r = await api('legacy:import');
                state.legacyPending = r.waiting;
                toast(`Importado: ${r.pipelines} funil(is), ${r.conversations} conversa(s) (${r.applied} já aplicadas).`, 'success', 7000);
                render();
              } catch (e) { errToast(e); }
            },
          }, 'Importar do Kanban antigo')) : null,
        h('p', { class: 'muted small' }, `Versão ${state.version || ''}${state.demo ? ' — modo demonstração' : ''}`)),
    ),
  );
}

export async function runDiagnosis() {
  const body = h('div', { class: 'diag' }, h('div', { class: 'row' }, h('span', { class: 'spinner small' }), 'Testando a conexão com o WhatsApp…'));
  modal({ title: 'Teste de conexão', body, actions: [{ label: 'Fechar', primary: true }] });
  try {
    const r = await api('wa:diagnose');
    fill(body,
      ...r.steps.map((s) => h('div', { class: `diag-step ${s.ok ? 'ok' : 'bad'}` },
        h('b', null, s.ok ? '✔ ' : '✖ ', s.label), h('div', { class: 'muted small' }, s.detail))),
      r.ok ? h('p', { class: 'alert info' }, 'Tudo certo com a rede. Se ainda cair, clique em “Tentar reconectar”.')
        : h('p', { class: 'alert' }, r.hint || 'Algo está bloqueando a conexão com o WhatsApp.'),
      h('p', { class: 'muted small' }, 'O resultado também foi gravado no registro de erros (whatsapp.log).'));
  } catch (e) {
    fill(body, h('p', { class: 'alert' }, e.message));
  }
}

export function statusLabel(s) {
  return {
    idle: 'Iniciando…', starting: 'Iniciando…', connecting: 'Conectando…', qr: 'Aguardando leitura do QR code',
    open: 'Conectado', reconnecting: 'Sem conexão — tentando reconectar…', logged_out: 'Desconectado',
    replaced: 'Sessão aberta em outro lugar',
  }[s] || s;
}

export function applyTheme() {
  const t = state.settings.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

async function movePipeline(i, dir) {
  const ids = state.pipelines.map((p) => p.id);
  [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
  await api('pipelines:reorder', ids).catch(errToast);
}

function colorPicker(value, onPick) {
  const wrap = h('div', { class: 'palette' });
  const draw = (cur) => {
    fill(wrap, ...PALETTE.map((c) => h('button', {
      class: `swatch ${c === cur ? 'on' : ''}`, style: { background: c }, title: c,
      onclick: (e) => { e.preventDefault(); onPick(c); draw(c); },
    })));
  };
  draw(value);
  return wrap;
}

export function pipelineEditor(p) {
  const draft = p ? { ...p, stages: p.stages.map((s) => ({ ...s })) }
    : { name: '', icon: '📁', stages: [{ name: 'Novo', color: PALETTE[0] }, { name: 'Em andamento', color: PALETTE[1] }, { name: 'Concluído', color: PALETTE[3] }] };
  const name = h('input', { class: 'input', value: draft.name, placeholder: 'Ex.: Vendas' });
  const icon = h('input', { class: 'input icon-input', value: draft.icon || '', maxLength: 4 });
  const stagesEl = h('div', { class: 'stage-editor' });
  const draw = () => {
    fill(stagesEl, ...draft.stages.map((s, i) => h('div', { class: 'stage-edit-row' },
      h('span', { class: 'dot big', style: { background: s.color } }),
      h('input', { class: 'input input-sm grow', value: s.name, oninput: (e) => { s.name = e.target.value; } }),
      colorPicker(s.color, (c) => { s.color = c; draw(); }),
      h('button', { class: 'icon-btn small', disabled: i === 0, onclick: () => { [draft.stages[i - 1], draft.stages[i]] = [draft.stages[i], draft.stages[i - 1]]; draw(); } }, '↑'),
      h('button', { class: 'icon-btn small', disabled: i === draft.stages.length - 1, onclick: () => { [draft.stages[i + 1], draft.stages[i]] = [draft.stages[i], draft.stages[i + 1]]; draw(); } }, '↓'),
      h('button', { class: 'icon-btn small', title: 'Remover etapa', disabled: draft.stages.length <= 1, onclick: () => { draft.stages.splice(i, 1); draw(); } }, '🗑'))),
    h('button', { class: 'btn btn-sm', onclick: () => { draft.stages.push({ name: 'Nova etapa', color: PALETTE[draft.stages.length % PALETTE.length] }); draw(); } }, '＋ Adicionar etapa'));
  };
  draw();
  modal({
    title: p ? `Editar funil “${p.name}”` : 'Novo funil',
    wide: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', null, 'Ícone'), icon),
        h('label', { class: 'field grow' }, h('span', null, 'Nome do funil'), name)),
      h('div', { class: 'field' }, h('span', null, 'Etapas (da primeira à última)'), stagesEl),
      p ? h('p', { class: 'muted small' }, 'Ao remover uma etapa, as conversas que estavam nela saem do funil.') : null),
    actions: [
      ...(p ? [{
        label: 'Excluir funil',
        danger: true,
        onClick: async () => {
          if (!await confirmDialog(`Excluir o funil “${p.name}”? As conversas continuam salvas, só saem do funil.`, { okLabel: 'Excluir', danger: true })) return false;
          await api('pipelines:delete', p.id);
          return true;
        },
      }] : []),
      { label: 'Cancelar' },
      {
        label: 'Salvar',
        primary: true,
        onClick: async () => {
          if (!name.value.trim()) { toast('Dê um nome ao funil', 'error'); return false; }
          const stages = draft.stages.filter((s) => s.name.trim());
          if (!stages.length) { toast('O funil precisa de pelo menos uma etapa', 'error'); return false; }
          const id = await api('pipelines:save', { id: p?.id, name: name.value.trim(), icon: icon.value.trim(), stages });
          if (!p) await setSetting('lastPipeline', id);
          return true;
        },
      },
    ],
  });
}

async function moveItem(kind, list, i, dir) {
  const ids = list.map((x) => x.id);
  [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
  await api(`${kind}:reorder`, ids).catch(errToast);
}

function typeEditor(t) {
  let color = t?.color || PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const name = h('input', { class: 'input', value: t?.name || '', placeholder: 'Ex.: Cliente' });
  const icon = h('input', { class: 'input icon-input', value: t?.icon || '🏷', maxLength: 4 });
  const personal = h('input', { type: 'checkbox', class: 'switch', checked: !!t?.personal });
  const notify = h('input', { type: 'checkbox', class: 'switch', checked: t ? !!t.notify : true });
  modal({
    title: t ? `Editar tipo “${t.name}”` : 'Novo tipo de contato',
    body: h('div', { class: 'form' },
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', null, 'Ícone'), icon),
        h('label', { class: 'field grow' }, h('span', null, 'Nome'), name)),
      h('div', { class: 'field' }, h('span', null, 'Cor'), colorPicker(color, (c) => { color = c; })),
      h('label', { class: 'toggle-row' }, h('div', null, h('div', null, 'É pessoal (não é trabalho)'),
        h('div', { class: 'muted small' }, 'Fica fora de "Aguardando resposta" e dos avisos de conversa esquecida.')), personal),
      h('label', { class: 'toggle-row' }, h('div', null, h('div', null, 'Mostrar aviso de nova mensagem'),
        h('div', { class: 'muted small' }, 'Desligue para receber em silêncio (a conversa continua aparecendo na lista).')), notify)),
    actions: [
      ...(t ? [{
        label: 'Excluir', danger: true,
        onClick: async () => {
          if (!await confirmDialog(`Excluir o tipo “${t.name}”? As conversas desse tipo voltam para "não classificado".`, { okLabel: 'Excluir', danger: true })) return false;
          await api('types:delete', t.id);
          return true;
        },
      }] : []),
      { label: 'Cancelar' },
      {
        label: 'Salvar', primary: true,
        onClick: async () => {
          if (!name.value.trim()) { toast('Dê um nome ao tipo', 'error'); return false; }
          await api('types:save', { id: t?.id, name: name.value.trim(), icon: icon.value.trim(), color, personal: personal.checked, notify: notify.checked });
          return true;
        },
      },
    ],
  });
}

export function describeRules(r = {}) {
  const parts = [];
  const typeNames = (r.types || []).map((id) => state.contactTypes.find((t) => t.id === id)?.name).filter(Boolean);
  if (typeNames.length) parts.push(typeNames.join(' / '));
  if (r.unclassified === 'include' && typeNames.length) parts.push('+ não classificados');
  if (r.unclassified === 'only') parts.push('só não classificados');
  if (r.unclassified === 'exclude') parts.push('sem os não classificados');
  if (r.work) parts.push('só trabalho');
  if (r.awaiting) parts.push(r.awaitingHours ? `aguardando resposta há +${r.awaitingHours} h` : 'aguardando resposta');
  if (r.unread) parts.push('não lidas');
  if (r.tasks) parts.push('com tarefa');
  if (r.noStage) parts.push('sem etapa');
  if (r.pipeline) parts.push(`funil ${state.pipelines.find((p) => p.id === r.pipeline)?.name || ''}`);
  if (r.stages?.length) parts.push(`${r.stages.length} etapa(s)`);
  if (r.tags?.length) parts.push(r.tags.map((id) => state.tags.find((t) => t.id === id)?.name).filter(Boolean).join(', '));
  if (r.groups === 'exclude') parts.push('sem grupos');
  if (r.groups === 'only') parts.push('só grupos');
  return parts.join(' · ') || 'todas as conversas';
}

/** Criar/editar um filtro da lista de conversas. */
export function filterEditor(f) {
  const r = structuredClone(f?.rules || {});
  const name = h('input', { class: 'input', value: f?.name || '', placeholder: 'Ex.: Clientes aguardando' });
  const icon = h('input', { class: 'input icon-input', value: f?.icon || '🔎', maxLength: 4 });
  const check = (label, get, set) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: !!get(), onchange: (e) => set(e.target.checked) }), ' ', label);
  const select = (label, value, options, set) => h('label', { class: 'field' }, h('span', null, label),
    h('select', { class: 'input', onchange: (e) => set(e.target.value) },
      options.map(([v, l]) => h('option', { value: v, selected: (value ?? '') === v }, l))));
  const toggleIn = (key, id, on) => {
    const set = new Set(r[key] || []);
    if (on) set.add(id); else set.delete(id);
    r[key] = [...set];
  };
  const stageOpts = state.pipelines.flatMap((p) => p.stages.map((s) => [s.id, `${p.name} → ${s.name}`]));

  const m = modal({
    title: f ? `Editar filtro “${f.name}”` : 'Novo filtro',
    wide: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', null, 'Ícone'), icon),
        h('label', { class: 'field grow' }, h('span', null, 'Nome do filtro'), name)),
      h('div', { class: 'field' }, h('span', null, 'Tipos de contato (nenhum marcado = todos)'),
        h('div', { class: 'row wrap' }, state.contactTypes.map((t) => check(`${t.icon || ''} ${t.name}`,
          () => (r.types || []).includes(t.id), (v) => toggleIn('types', t.id, v))))),
      h('div', { class: 'row wrap' },
        select('Contatos ainda não classificados', r.unclassified || '', [['', 'Seguir os tipos acima'], ['include', 'Incluir sempre'], ['only', 'Mostrar só eles'], ['exclude', 'Não mostrar']], (v) => { r.unclassified = v || undefined; }),
        select('Grupos', r.groups || '', [['', 'Incluir'], ['exclude', 'Não mostrar'], ['only', 'Só grupos']], (v) => { r.groups = v || undefined; })),
      h('div', { class: 'field' }, h('span', null, 'Mostrar só conversas…'),
        h('div', { class: 'row wrap' },
          check('não lidas', () => r.unread, (v) => { r.unread = v || undefined; }),
          check('aguardando minha resposta', () => r.awaiting, (v) => { r.awaiting = v || undefined; }),
          check('de trabalho (sem tipos pessoais)', () => r.work, (v) => { r.work = v || undefined; }),
          check('com tarefa aberta', () => r.tasks, (v) => { r.tasks = v || undefined; }),
          check('sem etapa no funil', () => r.noStage, (v) => { r.noStage = v || undefined; }))),
      h('div', { class: 'row wrap' },
        select('Funil', r.pipeline || '', [['', 'Qualquer'], ...state.pipelines.map((p) => [p.id, `${p.icon || ''} ${p.name}`])], (v) => { r.pipeline = v || undefined; }),
        select('Etapa', r.stages?.[0] || '', [['', 'Qualquer'], ...stageOpts], (v) => { r.stages = v ? [v] : undefined; }),
        select('Esperando resposta há mais de', String(r.awaitingHours || ''), [['', '—'], ['1', '1 hora'], ['4', '4 horas'], ['24', '1 dia'], ['72', '3 dias']], (v) => { r.awaitingHours = v ? Number(v) : undefined; if (v) r.awaiting = true; })),
      h('div', { class: 'field' }, h('span', null, 'Etiquetas (qualquer uma delas)'),
        h('div', { class: 'row wrap' }, state.tags.map((t) => check(t.name, () => (r.tags || []).includes(t.id), (v) => toggleIn('tags', t.id, v)))))),
    actions: [
      ...(f ? [{
        label: 'Excluir filtro', danger: true,
        onClick: async () => {
          if (!await confirmDialog(`Excluir o filtro “${f.name}”? As conversas não são afetadas.`, { okLabel: 'Excluir', danger: true })) return false;
          await api('filters:delete', f.id);
          return true;
        },
      }] : []),
      { label: 'Cancelar' },
      {
        label: 'Salvar', primary: true,
        onClick: async () => {
          if (!name.value.trim()) { toast('Dê um nome ao filtro', 'error'); return false; }
          await api('filters:save', { id: f?.id, name: name.value.trim(), icon: icon.value.trim(), rules: r });
          return true;
        },
      },
    ],
  });
  return m;
}

function tagEditor(t) {
  let color = t?.color || PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const name = h('input', { class: 'input', value: t?.name || '', placeholder: 'Ex.: Cliente VIP' });
  modal({
    title: t ? 'Editar etiqueta' : 'Nova etiqueta',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Nome'), name),
      h('div', { class: 'field' }, h('span', null, 'Cor'), colorPicker(color, (c) => { color = c; }))),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Salvar', primary: true,
        onClick: async () => {
          if (!name.value.trim()) return false;
          await api('tags:save', { id: t?.id, name: name.value.trim(), color });
          return true;
        },
      },
    ],
  });
}

function quickEditor(r) {
  const sc = h('input', { class: 'input', value: r?.shortcut || '', placeholder: 'Ex.: preco' });
  const text = h('textarea', { class: 'input', rows: 5, placeholder: 'Olá {nome}! Nossos preços são…' }, r?.text || '');
  modal({
    title: r ? 'Editar resposta rápida' : 'Nova resposta rápida',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Atalho (sem espaço)'), sc),
      h('label', { class: 'field' }, h('span', null, 'Texto'), text)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Salvar', primary: true,
        onClick: async () => {
          const shortcut = sc.value.trim().replace(/\s+/g, '-');
          if (!shortcut || !text.value.trim()) { toast('Preencha o atalho e o texto', 'error'); return false; }
          await api('quick:save', { id: r?.id, shortcut, text: text.value.trim() });
          return true;
        },
      },
    ],
  });
}
