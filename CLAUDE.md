# WhatsApp CRM — contexto do projeto

App de desktop (Electron) que é um CRM com WhatsApp integrado. Sucessor
do "Kanban CRM" v3, que abria o WhatsApp Web numa janela e fazia scraping
do DOM. Agora a conexão é direta pelo protocolo multi-device do WhatsApp
via **Baileys** (`@whiskeysockets/baileys`, não oficial): QR code uma vez,
sessão salva em disco, mensagens gravadas num SQLite local e interface
própria (não é mais o WhatsApp Web).

## Como rodar

```
npm install
npm start        # real
npm run demo     # conta simulada (src/main/demo.js), pasta de dados separada
npm test         # node --test: banco + processamento de mensagens (sem Electron)
npm i --no-save playwright-core && npm run test:e2e   # Playwright + Electron no modo demo
```

O ambiente de desenvolvimento na nuvem **não alcança web.whatsapp.com**
(bloqueado pelo proxy), então mudanças na interface devem ser validadas
com `npm run test:e2e` (usa o modo demo) e mudanças no processamento das
mensagens com `npm test`, que alimenta o `WhatsAppService` com objetos no
mesmo formato que o Baileys entrega.

## Arquitetura

Processo principal (`src/main`, ESM):

- `index.js` — janela, bandeja, menu, notificações, lembretes de tarefas,
  protocolo `crm-media://file/<caminho>` (serve arquivos de `media/` pro
  renderer), e a tabela `api` de métodos chamados via IPC
  (`ipcMain.handle('api', method, args)`). Eventos pro renderer saem por
  `send(channel, payload)` → `window.api.on(channel)`.
- `whatsapp.js` — `WhatsAppService` (EventEmitter): conexão Baileys,
  reconexão com backoff, logout (401 apaga `auth/` e volta ao QR),
  tradução dos eventos do Baileys para o banco, envio (texto, arquivos,
  voz), download de mídia, fotos de perfil, grupos, histórico sob demanda.
  Emite `status`, `chats-changed` (debounced, lista de jids), `message`,
  `history`, `chat-merged`.
- `demo.js` — `DemoWhatsAppService` (subclasse) que simula tudo; os
  métodos de envio geram mensagens no formato do Baileys e passam pelo
  mesmo `onMessages`, então o caminho de parse/gravação é o real.
- `parse.js` — WAMessage (protobuf) → linha da tabela `messages`, ou
  `reaction` / `revoke` / `edit` / `ignore`.
- `db.js` — `node:sqlite` (embutido no Electron 44, sem módulo nativo).
  Tabelas: `chats`, `contacts`, `aliases`, `messages`, `pipelines`,
  `stages`, `crm`, `tags`, `chat_tags`, `notes`, `tasks`, `activity`,
  `quick_replies`, `settings`, `legacy_pending`, `meta`, `contact_types`,
  `chat_filters`, `cases`, `payments`, `case_docs` (migrações por versão
  em `migrate()`; `meta.schema` guarda a versão atual).
- `ogg.js` — remux WebM/Opus (MediaRecorder do Chromium) → OGG/Opus, que
  é o que o WhatsApp aceita como mensagem de voz.
- `google.js` — `GoogleService`: Google Agenda pela API oficial com a chave
  (client_secret JSON, tipo "App para computador") do próprio usuário;
  login no navegador com retorno em `http://127.0.0.1:<porta>` + PKCE;
  refresh token criptografado (`safeStorage`) em `google/token.bin`;
  `invalid_grant` (modo de teste do Google vence em 7 dias) → `needsReconnect`.
- `calendar-sync.js` — `CalendarSync`: tarefas/prazos/audiências/reuniões do
  CRM viram eventos no Google (`tasks.gcal_event_id`, marcados com
  `extendedProperties.private.crmTaskId`); horário mudado no Google volta
  para o CRM (`pullChanges`); `agenda()` junta eventos do Google + tarefas
  ainda não sincronizadas. No demo, `DemoGoogleService` (em `demo.js`).
- `legacy.js` — importa `%APPDATA%\KanbanCRMWhatsApp\kanban-state.json`
  do app v3.

Preload: `src/preload/preload.cjs` (sandbox + contextIsolation) expõe
`window.api.call(method, ...args)`, `window.api.on(evt, cb)` e
`pathForFile(file)`.

Interface (`src/renderer`, JS puro em módulos ES, sem build):

- `js/store.js` — estado (`state.chats` é um Map jid → conversa já com
  campos do CRM), event bus `on/emit`, `api()`.
- `js/util.js` — `h()` pra criar elementos, `fill()` (limpa e preenche
  ignorando null — **não use `el.append(null)`**, imprime "null"),
  formatação, modais, menus, toasts.
- `js/views/*` — `chatlist`, `chatview` (mensagens + composer + gravação),
  `crmpanel` (ficha do contato, com a lista de casos), `casemodal` (ficha do
  caso em abas: dados, honorários/parcelas/cobrança, prazos, documentos,
  notas), `finance` (todas as parcelas), `agenda` (dia/semana/mês com todas
  as agendas do Google + compromissos do CRM), `board` (kanban de CASOS com
  drag-and-drop HTML5),
  `contacts`, `tasks`, `dashboard`, `settings`, `connect` (QR + faixa de
  status).
- Estilos em `styles.css` com variáveis e `[data-theme=light|dark]`. Cores
  por item (etapa/etiqueta) via variável `--c` (o `h()` usa
  `style.setProperty` para chaves `--*`).

## Decisões importantes

- **Id das conversas**: jid do WhatsApp. Contatos podem chegar como número
  (`@s.whatsapp.net`) ou LID (`@lid`); o id principal é o número quando
  conhecido. `aliases` guarda lid → número e `db.addAlias` mescla
  mensagens/CRM/notas/tarefas se a conversa já existia pelo lid.
- **Não lidas**: contadas por nós (`messages.upsert` tipo `notify`, e também
  `append` recebida — é assim que chegam as mensagens de quando o app estava
  fechado/suspenso, sem aviso individual), não
  pelo `unreadCount` incremental do Baileys; `chats.update` com 0 zera,
  -1 marca como não lida; no histórico usamos o valor absoluto.
- **Mensagem crua** (`messages.raw`, BufferJSON) só é guardada para mídia,
  enquetes e mensagens enviadas por nós (necessário para baixar mídia e
  para o `getMessage` de reenvio); texto recebido não guarda raw.
- **Sessão registrada** = `creds.json` com `me.id` e `account` (só existe
  depois que o celular confirma). Sem isso, `start()` apaga `auth/` e a
  tela de conexão fica aberta (QR ou código pelo número via
  `requestPairingCode`). `creds.routingInfo` (servidor da última conexão) é
  descartado a cada `start()` (`forgetRoute`): velho, depois de suspender, fazia
  o WhatsApp devolver 428 em loop. Falhas antes do registro trocam o perfil de
  navegador (`BROWSERS`, Chrome primeiro — "Windows Desktop" é recusado com
  428); o perfil que pareou fica em `auth/perfil.json` e é sempre reusado
  (outro perfil = WhatsApp recusa a sessão salva com 428; só sessões sem
  `perfil.json` alternam). Falta de internet (`isOfflineError`, ex.: DNS logo
  após acordar) não conta como queda rápida: tenta de 3 em 3 s. Só existe
  uma conexão por vez: `start()` tem um número (`startGen`) e desiste se
  outro começou no meio (timer de reconexão + `powerMonitor.resume` juntos
  abriam duas conexões com a mesma sessão e as mensagens paravam) e um watchdog de 40 s reinicia se não vier QR.
- **Tipos de contato** (`contact_types`, `crm.type_id`) e **filtros da
  lista** (`chat_filters`, regras em JSON aplicadas por `chatMatchesRules`
  em `store.js`) são editáveis pelo usuário. Filtros nunca escondem
  mensagens de verdade: a lista "Tudo" existe por padrão e os chips mostram
  quantas não lidas há em cada filtro. `personal` no tipo = fora de
  "Aguardando resposta" e do aviso de conversa esquecida (`checkForgotten`
  em `index.js`, configurável em horas; `chats.alerted_ts` evita repetir).
- **Casos**: o funil é de casos, não de contatos — um contato pode ter
  vários (`cases.jid`). `listChats` traz `stage_ids`/`pipeline_ids` dos casos
  abertos; `stage_id`/`pipeline_id` da conversa = caso mais recente (compat.).
  Honorários: tipos fixo/parcelado/êxito no caso; valores em `payments`
  (parcelas geradas por `generateInstallments`, centavos certos na última).
  Cobrança = texto do modelo (`chargeTemplate` + `pixKey` nas configurações,
  variáveis `{nome}` `{valor}` …) revisado e enviado pelo usuário; nada é
  enviado sozinho. `cases.last_update_at` ("último retorno ao cliente") é
  atualizado quando você manda mensagem ao contato; avisos de parcelas e de
  casos sem retorno em `checkFinanceAndCases` (`index.js`).
- **Notificações no Windows**: AppUserModelID fixo (`com.whatsappcrm.desktop`)
  + atalho no Menu Iniciar com o mesmo id, recriado pelo próprio app
  (`ensureStartMenuShortcut`, via `shell.writeShortcutLink`). As
  `Notification` ficam guardadas em `liveNotifications` para o clique não
  se perder.
- **Modo discreto**: configurações `discreet`/`discreetMessages` → classes
  `body.discreet`/`body.discreet-msgs` com `filter: blur` nos valores e
  prévias (hover mostra; ao criar tela com valor em R$, use as classes
  `money`/`money-total`/`td.num` para entrar no embaçamento). No processo
  principal, `notify(..., discreetTitle)` troca título/texto por genérico.
- Mídia pequena (foto, figurinha, áudio) é baixada automaticamente quando
  chega; o resto sob demanda (botão Baixar), com `reuploadRequest` pra
  mídia expirada. Tipos de contato com `autodownload` (Cliente, por padrão)
  baixam tudo até 100 MB, numa fila serial (`queueDownload`); ao classificar,
  ao ligar a opção e ao conectar, `backfillDownloads` busca o que faltou dos
  últimos 180 dias. Falha conta em `messages.dl_failed` (2 falhas = só
  manual). Link vencido (403/404/410): o próprio `downloadMedia` pede link
  novo ao celular (`updateMediaMessage`) — o reenvio automático do Baileys
  não dispara porque o erro dele não tem `.status`.
- **Visualização única**: o conteúdo nunca chega aos aparelhos conectados; o
  Baileys descarta o aviso (`unavailable type=view_once…`), então
  `onRawMessageNode` escuta `CB:message` no socket e grava um texto
  "👁 … abra no celular" (`parse.viewOnceKind`, `extra.viewOnce`).
- **Ligações**: o Baileys só grava as perdidas; `onCalls` (evento `call`)
  grava/atualiza uma linha `type='call'` com o id da chamada (recebida →
  atendida/recusada/perdida) e avisa a ligação recebida.
- **Corretor e sugestões ao digitar**: corretor do Chromium em pt-BR
  (`setupSpellcheck` em `index.js` monta o menu do botão direito com as
  sugestões — o Chromium só sublinha); configurações `spellcheck` e
  `wordSuggest`. Sugestão de palavras = `js/wordsuggest.js` (puro, testado no
  Node) sobre `db.vocabulary()` — palavras das SUAS mensagens enviadas e
  respostas rápidas, por frequência (≥2 usos), aprende na hora ao enviar;
  Tab ou clique completa. Correção automática pt-BR (`js/autocorrect.js`,
  configuração `autocorrect`): ao digitar espaço/pontuação troca acentos
  esquecidos e erros comuns, só sem ambiguidade; Backspace logo depois desfaz;
  a última palavra é corrigida ao enviar.
- **Rascunhos** (`js/drafts.js`): por conversa no `localStorage` (sobrevivem a
  trocar de conversa/tela e a fechar o app); a lista mostra "✏️ Rascunho:"
  nas conversas não abertas. Obs.: `h()` põe `value` na propriedade — no
  `<textarea>` o atributo é ignorado (era por isso que o rascunho sumia).
- **Balão da lista**: parar o mouse 0,5 s numa conversa mostra a última
  mensagem (até 300 letras, `js/preview-tip.js`); não abre nem marca como
  lida; não aparece no modo discreto.
- **Letra e zoom** (`js/appearance.js`): `msgFont` sm/md/lg/xl →
  `body[data-msgfont]` → `--msg-fs`/`--composer-fs`; Ctrl + roda ou
  Ctrl +/−/0. `uiZoom` (0,9–1,5) → `app:setZoom` (`setZoomFactor`); Ctrl +
  Shift +/−/0. Os papéis zoomIn/zoomOut do menu foram tirados para não brigar.
- **Pré-visualização de links**: recebida = `extendedTextMessage` (title,
  description, jpegThumbnail → `messages.thumb`, `extra.link`) → `linkCard`
  na conversa. Enviada: o composer mostra a prévia (`links:preview`, ✕ tira)
  e `messages:sendText(..., {previewUrl})` manda `linkPreview` (`toUrlInfo`)
  — o Baileys não gera sozinho (sem `link-preview-js`). `main/linkpreview.js`
  busca og:/twitter:/<title> da página e a imagem (reduzida a JPEG ≤320 px
  com `nativeImage`); no demo usa uma página de exemplo (sem internet).
- **Editar mensagem**: só texto seu, até 15 min (`editableCheck`);
  `sendMessage(jid, { text, edit: key })`. No composer, `editing` mostra a
  faixa "Editando" (Esc cancela). Fotos abrem em `views/imageviewer.js`
  (zoom com rodinha/pinça, arrastar, girar, ← →).
- Pasta de dados fixa: `%APPDATA%\WhatsAppCRM` (`CRM_DATA_DIR` sobrescreve;
  demo usa `WhatsAppCRM-Demo`). Instância única (`requestSingleInstanceLock`)
  pra não corromper a sessão.
- Usuário final é leigo em terminal: instalação por `Instalar.bat`
  (npm install + atalhos via `scripts/criar-atalho.ps1`), abertura por
  atalho que chama `electron.exe` direto (sem janela de console). Qualquer
  mudança que exija passo manual deve vir com instrução simples.
- Textos da interface e comentários em português.
