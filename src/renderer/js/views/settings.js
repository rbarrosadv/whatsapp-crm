// Configurações: conexão, notificações, funis, etiquetas, respostas
// rápidas, backup e importação do Kanban antigo.
import { h, fill, modal, toast, errToast, confirmDialog, formatPhone, phoneOf, PALETTE, downloadUrl, fmtDateTime, pickFiles } from '../util.js';
import { state, on, api, setSetting } from '../store.js';
import { icon, named, iconName, PICK_ICONS } from '../icons.js';

let root;

export function mountSettings(el) {
  root = el;
  on('view', (v) => v === 'settings' && render());
  on('config', () => state.view === 'settings' && render());
  on('status', () => state.view === 'settings' && render());
  on('settings', () => state.view === 'settings' && render());
  on('me', () => state.view === 'settings' && render());
  on('users', () => state.view === 'settings' && render());
}

// configurações que valem para o escritório todo (só sócio muda)
const OFFICE_KEYS = ['sendReadReceipts', 'forgottenHours', 'chargeTemplate', 'pixKey', 'paymentNoticeDays',
  'staleCaseDays', 'googleSync', 'googleCalendarId', 'signMessages', 'docsRequestTemplate', 'datajudKey',
  'officeName', 'officeDoc', 'officeAddress', 'officeCity'];

function toggle(key, label, hint, def = true) {
  const val = state.settings[key] ?? def;
  const locked = OFFICE_KEYS.includes(key) && !state.can.admin;
  return h('label', { class: 'toggle-row', title: locked ? 'Só um sócio pode mudar esta configuração do escritório.' : null },
    h('div', null, h('div', null, label), hint ? h('div', { class: 'muted small' }, hint) : null),
    h('input', { type: 'checkbox', class: 'switch', checked: !!val, disabled: locked, onchange: (e) => setSetting(key, e.target.checked).catch(errToast) }));
}

/** Opção deste computador (só no app de desktop). */
function desktopToggle(key, label, hint, def) {
  if (!window.desktop?.getSetting) return null;
  const input = h('input', {
    type: 'checkbox', class: 'switch', checked: !!def,
    onchange: (e) => window.desktop.setSetting(key, e.target.checked).catch(errToast),
  });
  window.desktop.getSetting(key).then((v) => { input.checked = !!(v ?? def); }).catch(() => {});
  return h('label', { class: 'toggle-row' },
    h('div', null, h('div', null, label), hint ? h('div', { class: 'muted small' }, hint) : null), input);
}

// ------------------------------------------------------------ minha conta e equipe

function accountSection() {
  const me = state.me;
  return section('Minha conta',
    h('div', { class: 'conn-info' },
      h('div', null, h('b', null, me.name), h('div', { class: 'muted small' }, `${me.roleLabel} · login: ${me.login}`))),
    h('p', { class: 'muted small' }, `No WhatsApp do escritório, suas mensagens saem assinadas como “*${me.signature}:*”.`),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onclick: editMe }, 'Nome e assinatura'),
      h('button', { class: 'btn', onclick: changePassword }, 'Trocar senha'),
      h('button', { class: 'btn btn-danger', onclick: () => window.api.logout() }, 'Sair')));
}

function editMe() {
  const name = h('input', { class: 'input', value: state.me.name });
  const sig = h('input', { class: 'input', value: state.me.signature, placeholder: 'Ex.: Dr. Barros' });
  modal({
    title: 'Nome e assinatura',
    body: h('div', { class: 'form' },
      h('label', null, 'Nome', name),
      h('label', null, 'Assinatura no WhatsApp', sig),
      h('p', { class: 'muted small' }, 'Vai no começo de cada mensagem que você enviar, em negrito.')),
    actions: [{ label: 'Cancelar' }, {
      label: 'Salvar', primary: true,
      onClick: async () => { await api('me:update', { name: name.value, signature: sig.value }); toast('Salvo', 'success'); },
    }],
  });
}

function changePassword() {
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const again = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  modal({
    title: 'Trocar senha',
    body: h('div', { class: 'form' },
      h('label', null, 'Senha atual', cur), h('label', null, 'Nova senha (mínimo 6 caracteres)', next), h('label', null, 'Repita a nova senha', again)),
    actions: [{ label: 'Cancelar' }, {
      label: 'Trocar', primary: true,
      onClick: async () => {
        if (next.value !== again.value) throw new Error('As duas senhas novas não são iguais.');
        await api('me:password', cur.value, next.value);
        toast('Senha trocada', 'success');
      },
    }],
  });
}

async function restoreBackup() {
  const [file] = await pickFiles({ multiple: false, accept: '.sqlite' });
  if (!file) return;
  const ok = await confirmDialog(`Trocar TODOS os dados do sistema pelos do backup “${file.name}”? `
    + 'Conversas, casos, financeiro e equipe passam a ser os do backup. O banco atual fica guardado no servidor. '
    + 'O sistema reinicia e todos precisam entrar de novo.', { okLabel: 'Restaurar', danger: true });
  if (!ok) return;
  toast('Enviando o backup…', 'info', 60000);
  const r = await fetch('/admin/restore', { method: 'POST', headers: { 'X-CRM': '1', 'Content-Type': 'application/octet-stream' }, body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { errToast(new Error(data.error || 'Não foi possível restaurar.')); return; }
  toast('Backup recebido. O sistema está reiniciando…', 'success', 15000);
  setTimeout(() => { location.href = '/login.html'; }, 8000);
}

let usersCache = null;
function teamSection() {
  if (!state.can.admin) return null;
  if (!usersCache) {
    api('users:list').then((u) => { usersCache = u; render(); }).catch(errToast);
    return section('Equipe', h('p', { class: 'muted small' }, 'Carregando…'));
  }
  return section('Equipe',
    h('p', { class: 'muted small' }, 'Cada pessoa entra com o próprio login. Estagiário(a) não vê o financeiro; só sócio muda as configurações do escritório e a equipe.'),
    ...usersCache.map((u) => h('div', { class: `list-row ${u.active ? '' : 'muted'}` },
      h('div', { class: 'grow' }, h('b', null, u.name), h('div', { class: 'muted small' },
        [u.roleLabel, `login: ${u.login}`, `assina “${u.signature}”`, u.active ? (u.last_login ? `último acesso ${fmtDateTime(u.last_login)}` : 'nunca entrou') : 'desativado'].join(' · '))),
      h('button', { class: 'btn btn-sm', onclick: () => userEditor(u) }, 'Editar'))),
    h('button', { class: 'btn', onclick: () => userEditor() }, [icon('plus', 15), 'Adicionar pessoa']),
    toggle('signMessages', 'Assinar as mensagens com o nome de quem enviou', 'Ex.: “*Dr. Barros:*” no começo de cada mensagem do WhatsApp do escritório.'));
}

async function userEditor(u = {}) {
  const roles = await api('users:roles');
  const name = h('input', { class: 'input', value: u.name || '' });
  const login = h('input', { class: 'input', value: u.login || '', placeholder: 'ex.: isabella' });
  const sig = h('input', { class: 'input', value: u.id ? u.signature : '', placeholder: 'Ex.: Dra. Lima (vazio = primeiro nome)' });
  const role = h('select', { class: 'input' }, Object.entries(roles).map(([v, l]) => h('option', { value: v, selected: (u.role || 'advogado') === v }, l)));
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: u.id ? 'deixe vazio para manter' : 'mínimo 6 caracteres' });
  const active = h('input', { type: 'checkbox', class: 'switch', checked: u.id ? u.active : true });
  modal({
    title: u.id ? `Editar ${u.name}` : 'Adicionar pessoa à equipe',
    body: h('div', { class: 'form' },
      h('label', null, 'Nome', name),
      h('label', null, 'Login (para entrar no sistema)', login),
      h('label', null, 'Perfil', role),
      h('label', null, 'Assinatura no WhatsApp', sig),
      h('label', null, u.id ? 'Nova senha' : 'Senha inicial', pass),
      u.id ? h('label', { class: 'toggle-row' }, h('div', null, 'Ativo (pode entrar no sistema)'), active) : null,
      h('p', { class: 'muted small' }, 'Passe o login e a senha inicial para a pessoa; ela pode trocar a senha em Configurações → Minha conta.')),
    actions: [{ label: 'Cancelar' }, {
      label: 'Salvar', primary: true,
      onClick: async () => {
        await api('users:save', {
          id: u.id, name: name.value, login: login.value, role: role.value, signature: sig.value,
          password: pass.value || undefined, active: active.checked,
        });
        usersCache = null;
        toast('Salvo', 'success');
        render();
      },
    }],
  });
}

/** Pasta do escritório no OneDrive (onde estão 02 CLIENTES, 04 MODELOS…). */
function docsSection() {
  const box = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Carregando…'));
  api('docs:status').then((st) => {
    const input = h('input', { class: 'input', value: st.configured || st.root || '', placeholder: st.guess || 'C:\\Users\\...\\OneDrive\\BARROS ADVOGADOS' });
    const save = async (value) => {
      try {
        await api('settings:set', 'docsRoot', value);
        toast('Pasta salva. Lendo os documentos para a busca…', 'success');
        api('docs:reindex').then((r) => toast(`Busca pronta: ${r.indexed} arquivo(s)`, 'success')).catch(() => {});
        render();
      } catch (e) { errToast(e); }
    };
    fill(box,
      st.ok
        ? h('div', null, h('div', { class: 'conn-info' }, h('span', { class: 'status-dot ok' }), h('div', null, h('b', null, 'Pasta encontrada'),
          h('div', { class: 'muted small' }, `${st.indexed} arquivo(s) na busca${st.missing?.length ? ` · faltam: ${st.missing.join(', ')}` : ''}`))))
        : h('div', { class: 'conn-info' }, h('span', { class: 'status-dot warn' }), h('div', null, h('b', null, 'Pasta não encontrada'),
          st.guess ? h('div', { class: 'muted small' }, `Achei: ${st.guess}`) : null)),
      state.can.admin ? h('label', { class: 'field' }, h('span', null, 'Onde está a pasta “BARROS ADVOGADOS” neste computador'), input) : h('code', { class: 'path' }, st.root || '—'),
      state.can.admin ? h('div', { class: 'row wrap' },
        h('button', { class: 'btn btn-primary', onclick: () => save(input.value) }, 'Salvar'),
        st.guess && st.guess !== st.root ? h('button', { class: 'btn', onclick: () => save(st.guess) }, 'Usar a pasta encontrada') : null) : null,
      h('p', { class: 'muted small' }, 'Dica: no Explorador de Arquivos, abra a pasta BARROS ADVOGADOS, clique na barra de endereço e copie. O sistema cria e lê pastas só dentro dela; o OneDrive sincroniza normalmente.'));
  }).catch((e) => fill(box, h('p', { class: 'muted small' }, e.message)));
  return section('Documentos (OneDrive)', box);
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
      accountSection(),
      teamSection(),
      docsSection(),
      section('Conexão com o WhatsApp',
        h('div', { class: 'conn-info' },
          h('span', { class: `status-dot ${connected ? 'ok' : 'warn'}` }),
          connected ? h('div', null, h('b', null, 'Conectado'), me ? h('div', { class: 'muted' }, `${me.name || ''} ${formatPhone(phoneOf(me.jid))}`) : null)
            : h('div', null, h('b', null, statusLabel(st.state)), st.error ? h('div', { class: 'muted small' }, st.error) : null)),
        h('p', { class: 'muted small' }, 'A sessão fica salva no servidor do escritório: ninguém precisa ler o QR code de novo. Para trocar de número, um sócio desconecta aqui.'),
        h('div', { class: 'row' },
          !connected ? h('button', { class: 'btn', onclick: () => api('wa:reconnect').catch(errToast) }, '⟳ Tentar reconectar') : null,
          !st.registered ? h('button', { class: 'btn btn-primary', onclick: () => api('wa:reset').catch(errToast) }, 'Mostrar QR code') : null,
          h('button', { class: 'btn', onclick: runDiagnosis }, 'Testar conexão'),
          state.can.admin && h('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!await confirmDialog('Desconectar este WhatsApp do CRM? As conversas e dados do CRM continuam salvos no computador. Para usar de novo será preciso ler o QR code.', { okLabel: 'Desconectar', danger: true })) return;
              api('wa:logout').catch(errToast);
            },
          }, 'Desconectar WhatsApp'))),

      section('Notificações e comportamento',
        toggle('notifications', 'Avisos de novas mensagens', 'Mostra um aviso no computador ou no celular quando chega mensagem (vale só para você).'),
        toggle('notificationPreview', 'Mostrar o texto da mensagem no aviso'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn btn-sm', onclick: () => api('app:testNotification').catch(errToast) }, 'Testar notificação'),
          window.desktop?.openNotificationSettings ? h('button', { class: 'btn btn-sm', onclick: () => window.desktop.openNotificationSettings() }, 'Abrir notificações do Windows') : null),
        h('p', { class: 'muted small' }, 'Se o teste não aparecer: em Configurações do Windows → Sistema → Notificações, confira se “Barros Associados” está ligado e se o “Não perturbe” / “Assistente de foco” está desligado.'),
        desktopToggle('minimizeToTray', 'Continuar rodando ao fechar a janela', 'O app fica perto do relógio e segue avisando de mensagens e lembretes.', true),
        desktopToggle('openAtLogin', 'Abrir junto com o Windows', 'Vale só para este computador.', false),
        toggle('sendReadReceipts', 'Marcar como lida no celular ao abrir a conversa', 'Envia a confirmação de leitura (tique azul), se ela estiver ativa no seu WhatsApp.'),
        toggle('enterToSend', 'Enter envia a mensagem', 'Desligado: use Ctrl+Enter para enviar e Enter para pular linha.'),
        toggle('spellcheck', 'Corretor ortográfico', 'Sublinha palavras erradas; clique com o botão direito na palavra para ver as correções.'),
        toggle('autocorrect', 'Correção automática (português do Brasil)', 'Ao terminar a palavra, corrige acentos esquecidos e erros comuns: nao → não, voce → você, procuracao → procuração. Backspace logo depois desfaz.'),
        toggle('wordSuggest', 'Sugerir palavras ao digitar', 'Completa a palavra com as que você mais usa nas suas mensagens. Tab (ou clique) aceita a sugestão.'),
        h('label', { class: 'toggle-row' }, h('div', null, 'Tema'),
          h('select', { class: 'input select-sm', onchange: (e) => setSetting('theme', e.target.value).then(applyTheme) },
            [['system', 'Automático'], ['dark', 'Escuro'], ['light', 'Claro']].map(([v, l]) => h('option', { value: v, selected: (state.settings.theme || 'system') === v }, l)))),
        h('label', { class: 'toggle-row' },
          h('div', null, h('div', null, 'Avisar conversa sem resposta'), h('div', { class: 'muted small' }, 'Quando um contato de trabalho espera sua resposta há mais tempo que isso.')),
          h('select', { class: 'input select-sm', onchange: (e) => setSetting('forgottenHours', Number(e.target.value)).catch(errToast) },
            [[0, 'Nunca'], [2, '2 horas'], [4, '4 horas'], [8, '8 horas'], [24, '24 horas'], [48, '2 dias']].map(([v, l]) =>
              h('option', { value: v, selected: Number(state.settings.forgottenHours ?? 24) === v }, l))))),

      section('Modo discreto',
        h('p', { class: 'muted small' }, 'Para compartilhar a tela ou atender alguém na sua sala: embaça valores (honorários, financeiro, totais) e as prévias das mensagens na lista. Passe o mouse em cima para ver. Liga e desliga pelo botão na barra lateral ou com Ctrl+Shift+D. Os avisos do Windows também deixam de mostrar nomes e mensagens.'),
        toggle('discreet', 'Modo discreto ligado', null, false),
        toggle('discreetMessages', 'Embaçar também as mensagens da conversa aberta', 'Útil se for mostrar a tela com uma conversa aberta.', false)),

      state.can.configure && section('Tipos de contato',
        h('p', { class: 'muted small' }, 'Classifique cada conversa (ex.: Pessoal, Cliente, Empresa). Tipos marcados como pessoais não entram em "Aguardando resposta" nem nos avisos de conversa esquecida.'),
        ...state.contactTypes.map((t, i) => h('div', { class: 'list-row' },
          h('span', { class: 'tag-chip', style: { '--c': t.color } }, named(t, 13)),
          h('span', { class: 'muted small grow' }, [t.personal ? 'pessoal' : 'trabalho', t.notify ? null : 'sem avisos', t.autodownload ? 'baixa arquivos' : null].filter(Boolean).join(' · ')),
          h('div', { class: 'row' },
            h('button', { class: 'icon-btn small', title: 'Subir', disabled: i === 0, onclick: () => moveItem('types', state.contactTypes, i, -1) }, '↑'),
            h('button', { class: 'icon-btn small', title: 'Descer', disabled: i === state.contactTypes.length - 1, onclick: () => moveItem('types', state.contactTypes, i, 1) }, '↓'),
            h('button', { class: 'btn btn-sm', onclick: () => typeEditor(t) }, 'Editar')))),
        h('button', { class: 'btn', onclick: () => typeEditor() }, [icon('plus', 15), 'Novo tipo'])),

      state.can.configure && section('Filtros das conversas',
        h('p', { class: 'muted small' }, 'Os botões no topo da lista de conversas. Crie os seus combinando tipo de contato, etiquetas, etapas, não lidas, aguardando resposta… Nada some: é só uma forma de ver a lista.'),
        ...state.filters.map((f, i) => h('div', { class: 'list-row' },
          h('span', { class: 'with-ico' }, named(f)),
          h('span', { class: 'muted small grow ellipsis' }, describeRules(f.rules)),
          h('div', { class: 'row' },
            h('button', { class: 'icon-btn small', title: 'Subir', disabled: i === 0, onclick: () => moveItem('filters', state.filters, i, -1) }, '↑'),
            h('button', { class: 'icon-btn small', title: 'Descer', disabled: i === state.filters.length - 1, onclick: () => moveItem('filters', state.filters, i, 1) }, '↓'),
            h('button', { class: 'btn btn-sm', onclick: () => filterEditor(f) }, 'Editar')))),
        h('button', { class: 'btn', onclick: () => filterEditor() }, [icon('plus', 15), 'Novo filtro'])),

      section('Intimações e andamentos',
        h('p', { class: 'small' }, 'As OABs acompanhadas ficam em Jurídico → Intimações. O sistema busca as intimações no DJEN e os andamentos no DataJud a cada 6 horas (das 6h às 22h) e avisa no computador.'),
        h('label', { class: 'field' }, h('span', null, 'Me avisar de andamentos e intimações (vale só para você)'),
          h('select', { class: 'input', onchange: (e) => setSetting('notifyCourts', e.target.value).catch(errToast) },
            [['mine', 'Dos processos em que sou responsável'], ['all', 'De todos os processos do escritório'], ['off', 'Não avisar (vejo no Hoje e no Jurídico)']]
              .map(([v, l]) => h('option', { value: v, selected: (state.settings.notifyCourts || 'mine') === v }, l)))),
        h('button', { class: 'btn btn-sm', onclick: () => import('../store.js').then((m) => m.openLegal('intimacoes')) }, 'Abrir Intimações'),
        state.can.admin ? h('label', { class: 'field' }, h('span', null, 'Chave pública do DataJud (só trocar se o CNJ mudar)'),
          h('input', { class: 'input mono', value: state.settings.datajudKey || '', placeholder: 'padrão do CNJ', onchange: (e) => setSetting('datajudKey', e.target.value.trim() || null).catch(errToast) })) : null),

      section('Pedido de documentos ao cliente',
        h('label', { class: 'field' }, h('span', null, 'Mensagem (na ficha do processo → Fluxo → Solicitar)'), docsTemplateInput()),
        h('p', { class: 'muted small' }, 'Campos: {nome} (primeiro nome) {nome_completo} {caso} {lista} (os documentos marcados). Você sempre revisa antes de enviar.')),

      state.can.finance && section('Proposta de honorários',
        h('label', { class: 'field' }, h('span', null, 'Modelo do texto (Atendimento → Comercial → ficha do interessado → Proposta)'), proposalTemplateInput()),
        h('p', { class: 'muted small' }, 'Campos: {nome} (primeiro nome) {nome_completo} {assunto} {area} {honorarios} {validade} {escritorio}. Você sempre revisa antes de enviar.'),
        h('label', { class: 'toggle-row' }, h('div', null, 'Validade da proposta'),
          h('select', { class: 'input select-sm', disabled: !state.can.admin, onchange: (e) => setSetting('proposalValidDays', Number(e.target.value)).catch(errToast) },
            [[7, '7 dias'], [15, '15 dias'], [30, '30 dias']].map(([v, l]) => h('option', { value: v, selected: Number(state.settings.proposalValidDays ?? 15) === v }, l))))),

      state.can.finance && section('Dados do escritório (recibos)',
        ...[['officeName', 'Nome', 'Barros Associados'], ['officeDoc', 'CNPJ ou OAB da sociedade', 'Ex.: CNPJ 00.000.000/0001-00'],
          ['officeAddress', 'Endereço', 'Rua, nº, sala, bairro, cidade-UF, CEP'], ['officeCity', 'Cidade (data do recibo)', 'Cuiabá-MT']]
          .map(([key, label, ph]) => h('label', { class: 'field' }, h('span', null, label),
            h('input', { class: 'input', value: state.settings[key] || '', placeholder: ph, disabled: !state.can.admin, onchange: (e) => setSetting(key, e.target.value.trim() || null).catch(errToast) }))),
        h('p', { class: 'muted small' }, 'Aparecem no cabeçalho e na assinatura dos recibos (Financeiro → parcela recebida → Recibo).')),

      state.can.finance && section('Honorários e cobrança',
        h('label', { class: 'field' }, h('span', null, 'Chave PIX / dados para pagamento'),
          h('input', { class: 'input', value: state.settings.pixKey || '', placeholder: 'Ex.: CNPJ, e-mail ou celular', onchange: (e) => setSetting('pixKey', e.target.value.trim()).catch(errToast) })),
        h('label', { class: 'field' }, h('span', null, 'Mensagem de cobrança'),
          chargeTemplateInput()),
        h('p', { class: 'muted small' }, 'Campos que são preenchidos sozinhos: {nome} {nome_completo} {valor} {vencimento} {parcela} {descricao} {caso} {processo} {pix} {pix_linha}. Você sempre revisa antes de enviar.'),
        h('label', { class: 'toggle-row' }, h('div', null, 'Avisar antes do vencimento'),
          h('select', { class: 'input select-sm', onchange: (e) => setSetting('paymentNoticeDays', Number(e.target.value)).catch(errToast) },
            [[0, 'Não avisar'], [1, '1 dia antes'], [3, '3 dias antes'], [5, '5 dias antes'], [7, '7 dias antes']].map(([v, l]) =>
              h('option', { value: v, selected: Number(state.settings.paymentNoticeDays ?? 3) === v }, l)))),
        h('label', { class: 'toggle-row' }, h('div', null, h('div', null, 'Avisar caso sem retorno ao cliente'), h('div', { class: 'muted small' }, 'Quando um caso aberto fica esse tempo sem você mandar notícia.')),
          h('select', { class: 'input select-sm', onchange: (e) => setSetting('staleCaseDays', Number(e.target.value)).catch(errToast) },
            [[0, 'Nunca'], [7, '7 dias'], [15, '15 dias'], [30, '30 dias'], [60, '60 dias']].map(([v, l]) =>
              h('option', { value: v, selected: Number(state.settings.staleCaseDays ?? 15) === v }, l))))),

      state.can.configure && section('Funis e etapas',
        h('p', { class: 'muted small' }, 'Cada funil tem suas etapas (colunas do quadro). Ex.: Atendimento → Novo, Proposta, Fechado.'),
        ...state.pipelines.map((p, i) => h('div', { class: 'list-row' },
          h('span', { class: 'with-ico' }, named(p)),
          h('span', { class: 'stage-dots' }, p.stages.map((s) => h('span', { class: 'dot', style: { background: s.color }, title: s.name }))),
          h('div', { class: 'row' },
            h('button', { class: 'icon-btn small', title: 'Subir', disabled: i === 0, onclick: () => movePipeline(i, -1) }, '↑'),
            h('button', { class: 'icon-btn small', title: 'Descer', disabled: i === state.pipelines.length - 1, onclick: () => movePipeline(i, 1) }, '↓'),
            h('button', { class: 'btn btn-sm', onclick: () => pipelineEditor(p) }, 'Editar')))),
        h('button', { class: 'btn', onclick: () => pipelineEditor() }, [icon('plus', 15), 'Novo funil'])),

      state.can.configure && section('Etiquetas',
        ...state.tags.map((t) => h('div', { class: 'list-row' },
          h('span', { class: 'tag-chip', style: { '--c': t.color } }, t.name),
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-sm', onclick: () => tagEditor(t) }, 'Editar'),
            h('button', {
              class: 'btn btn-sm btn-danger',
              onclick: async () => { if (await confirmDialog(`Excluir a etiqueta “${t.name}”?`, { okLabel: 'Excluir', danger: true })) api('tags:delete', t.id).catch(errToast); },
            }, 'Excluir')))),
        h('button', { class: 'btn', onclick: () => tagEditor() }, [icon('plus', 15), 'Nova etiqueta'])),

      section('Respostas rápidas',
        h('p', { class: 'muted small' }, 'Na conversa, digite “/” e o atalho para inserir o texto. Use {nome} para o primeiro nome do contato.'),
        ...state.quickReplies.map((r) => h('div', { class: 'list-row' },
          h('div', { class: 'grow' }, h('b', null, `/${r.shortcut}`), h('div', { class: 'muted small ellipsis' }, r.text)),
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-sm', onclick: () => quickEditor(r) }, 'Editar'),
            h('button', { class: 'btn btn-sm btn-danger', onclick: () => api('quick:delete', r.id).catch(errToast) }, 'Excluir')))),
        h('button', { class: 'btn', onclick: () => quickEditor() }, [icon('plus', 15), 'Nova resposta rápida'])),

      state.can.admin && section('Dados e backup',
        h('p', { class: 'muted small' }, 'Tudo fica salvo no servidor do escritório, na pasta:'),
        h('code', { class: 'path' }, state.dataDir),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', onclick: () => downloadUrl('/download/backup') }, 'Baixar backup do sistema'),
          state.canRestore ? h('button', { class: 'btn', onclick: restoreBackup }, 'Restaurar um backup…') : null),
        h('p', { class: 'muted small' }, 'O servidor também guarda sozinho uma cópia por dia (as últimas 14).'),
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
        h('b', null, s.ok ? icon('check', 16) : icon('x', 16), s.label), h('div', { class: 'muted small' }, s.detail))),
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
  try { localStorage.setItem('theme', t); } catch { /* ignore */ } // a tela de login usa o mesmo tema
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

/** Escolha do ícone (desenhos de traço) para funis, tipos e filtros. `.value` = nome. */
function iconPicker(value, allowNone = false) {
  const wrap = h('div', { class: 'icon-picker', role: 'radiogroup' });
  wrap.value = iconName(value);
  const draw = () => fill(wrap,
    allowNone ? h('button', { type: 'button', class: `icon-pick ${wrap.value ? '' : 'on'}`, title: 'Sem ícone', onclick: (e) => { e.preventDefault(); wrap.value = ''; draw(); } }, icon('ban', 16)) : null,
    PICK_ICONS.map((n) => h('button', {
      type: 'button', class: `icon-pick ${wrap.value === n ? 'on' : ''}`, 'aria-pressed': wrap.value === n ? 'true' : 'false',
      onclick: (e) => { e.preventDefault(); wrap.value = n; draw(); },
    }, icon(n, 16))));
  draw();
  return wrap;
}

export function pipelineEditor(p) {
  const draft = p ? { ...p, stages: p.stages.map((s) => ({ ...s })) }
    : { name: '', icon: '', stages: [{ name: 'Novo', color: PALETTE[0] }, { name: 'Em andamento', color: PALETTE[1] }, { name: 'Concluído', color: PALETTE[3] }] };
  const name = h('input', { class: 'input', value: draft.name, placeholder: 'Ex.: Vendas' });
  const iconIn = iconPicker(draft.icon || 'folder');
  const stagesEl = h('div', { class: 'stage-editor' });
  const draw = () => {
    fill(stagesEl, ...draft.stages.map((s, i) => h('div', { class: 'stage-edit-row' },
      h('span', { class: 'dot big', style: { background: s.color } }),
      h('input', { class: 'input input-sm grow', value: s.name, oninput: (e) => { s.name = e.target.value; } }),
      colorPicker(s.color, (c) => { s.color = c; draw(); }),
      h('button', { class: 'icon-btn small', disabled: i === 0, onclick: () => { [draft.stages[i - 1], draft.stages[i]] = [draft.stages[i], draft.stages[i - 1]]; draw(); } }, '↑'),
      h('button', { class: 'icon-btn small', disabled: i === draft.stages.length - 1, onclick: () => { [draft.stages[i + 1], draft.stages[i]] = [draft.stages[i], draft.stages[i + 1]]; draw(); } }, '↓'),
      h('button', { class: 'icon-btn small', title: 'Remover etapa', disabled: draft.stages.length <= 1, onclick: () => { draft.stages.splice(i, 1); draw(); } }, icon('trash', 16)))),
    h('button', { class: 'btn btn-sm', onclick: () => { draft.stages.push({ name: 'Nova etapa', color: PALETTE[draft.stages.length % PALETTE.length] }); draw(); } }, [icon('plus', 15), 'Adicionar etapa']));
  };
  draw();
  modal({
    title: p ? `Editar funil “${p.name}”` : 'Novo funil',
    wide: true,
    body: h('div', { class: 'form' },
      h('label', { class: 'field grow' }, h('span', null, 'Nome do funil'), name),
      h('div', { class: 'field' }, h('span', null, 'Ícone'), iconIn),
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
          const id = await api('pipelines:save', { id: p?.id, name: name.value.trim(), icon: iconIn.value, stages });
          if (!p) await setSetting('lastPipeline', id);
          return true;
        },
      },
    ],
  });
}

function proposalTemplateInput() {
  const ta = h('textarea', { class: 'input', rows: 7, disabled: !state.can.admin, onchange: (e) => setSetting('proposalTemplate', e.target.value).catch(errToast) });
  if (state.settings.proposalTemplate) ta.value = state.settings.proposalTemplate;
  else api('leads:defaultTemplate').then((t) => { ta.value = t; }).catch(() => {});
  return ta;
}

function chargeTemplateInput() {
  const ta = h('textarea', { class: 'input', rows: 5, onchange: (e) => setSetting('chargeTemplate', e.target.value).catch(errToast) });
  if (state.settings.chargeTemplate) ta.value = state.settings.chargeTemplate;
  else api('finance:defaultTemplate').then((t) => { ta.value = t; }).catch(() => {});
  return h('div', null, ta, h('button', {
    class: 'btn btn-sm', style: { marginTop: '6px' },
    onclick: async () => { const t = await api('finance:defaultTemplate'); ta.value = t; setSetting('chargeTemplate', null).catch(errToast); },
  }, 'Restaurar texto padrão'));
}

function docsTemplateInput() {
  const ta = h('textarea', { class: 'input', rows: 5, disabled: !state.can.admin, onchange: (e) => setSetting('docsRequestTemplate', e.target.value).catch(errToast) });
  ta.value = state.settings.docsRequestTemplate || 'Olá, {nome}! Para darmos andamento ao seu caso ({caso}), precisamos dos seguintes documentos:\n\n{lista}\n\nPode enviar por aqui mesmo, por foto ou PDF. Qualquer dúvida, estou à disposição.';
  return ta;
}

async function moveItem(kind, list, i, dir) {
  const ids = list.map((x) => x.id);
  [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
  await api(`${kind}:reorder`, ids).catch(errToast);
}

function typeEditor(t) {
  let color = t?.color || PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const name = h('input', { class: 'input', value: t?.name || '', placeholder: 'Ex.: Cliente' });
  const iconIn = iconPicker(t?.icon || 'tag');
  const personal = h('input', { type: 'checkbox', class: 'switch', checked: !!t?.personal });
  const notify = h('input', { type: 'checkbox', class: 'switch', checked: t ? !!t.notify : true });
  const autodownload = h('input', { type: 'checkbox', class: 'switch', checked: !!t?.autodownload });
  modal({
    title: t ? `Editar tipo “${t.name}”` : 'Novo tipo de contato',
    body: h('div', { class: 'form' },
      h('label', { class: 'field grow' }, h('span', null, 'Nome'), name),
      h('div', { class: 'field' }, h('span', null, 'Ícone'), iconIn),
      h('div', { class: 'field' }, h('span', null, 'Cor'), colorPicker(color, (c) => { color = c; })),
      h('label', { class: 'toggle-row' }, h('div', null, h('div', null, 'É pessoal (não é trabalho)'),
        h('div', { class: 'muted small' }, 'Fica fora de "Aguardando resposta" e dos avisos de conversa esquecida.')), personal),
      h('label', { class: 'toggle-row' }, h('div', null, h('div', null, 'Mostrar aviso de nova mensagem'),
        h('div', { class: 'muted small' }, 'Desligue para receber em silêncio (a conversa continua aparecendo na lista).')), notify),
      h('label', { class: 'toggle-row' }, h('div', null, h('div', null, 'Baixar arquivos automaticamente'),
        h('div', { class: 'muted small' }, 'Documentos, fotos, vídeos e áudios (até 100 MB) são baixados assim que chegam, e os dos últimos 6 meses que faltam também.')), autodownload)),
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
          await api('types:save', { id: t?.id, name: name.value.trim(), icon: iconIn.value, color, personal: personal.checked, notify: notify.checked, autodownload: autodownload.checked });
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
  const iconIn = iconPicker(f?.icon || '', true);
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
      h('label', { class: 'field grow' }, h('span', null, 'Nome do filtro'), name),
      h('div', { class: 'field' }, h('span', null, 'Ícone'), iconIn),
      h('div', { class: 'field' }, h('span', null, 'Tipos de contato (nenhum marcado = todos)'),
        h('div', { class: 'row wrap' }, state.contactTypes.map((t) => check(named(t, 14),
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
        select('Funil', r.pipeline || '', [['', 'Qualquer'], ...state.pipelines.map((p) => [p.id, p.name])], (v) => { r.pipeline = v || undefined; }),
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
          await api('filters:save', { id: f?.id, name: name.value.trim(), icon: iconIn.value, rules: r });
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
