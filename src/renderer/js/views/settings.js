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
        toggle('minimizeToTray', 'Continuar rodando ao fechar a janela', 'O app fica perto do relógio e segue recebendo mensagens e lembretes.'),
        toggle('openAtLogin', 'Abrir junto com o Windows', null, false),
        toggle('sendReadReceipts', 'Marcar como lida no celular ao abrir a conversa', 'Envia a confirmação de leitura (tique azul), se ela estiver ativa no seu WhatsApp.'),
        toggle('enterToSend', 'Enter envia a mensagem', 'Desligado: use Ctrl+Enter para enviar e Enter para pular linha.'),
        h('label', { class: 'toggle-row' }, h('div', null, 'Tema'),
          h('select', { class: 'input select-sm', onchange: (e) => setSetting('theme', e.target.value).then(applyTheme) },
            [['system', 'Automático'], ['dark', 'Escuro'], ['light', 'Claro']].map(([v, l]) => h('option', { value: v, selected: (state.settings.theme || 'system') === v }, l))))),

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
