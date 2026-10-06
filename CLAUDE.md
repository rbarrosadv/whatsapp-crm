# Barros Associados — contexto do projeto

Sistema de gestão do escritório Barros Associados (sucessor do "WhatsApp
CRM" v4, que por sua vez sucedeu o "Kanban CRM" v3). **O centro é a gestão
do escritório** — clientes, processos, prazos/agenda, intimações, financeiro,
documentos. O WhatsApp (via **Baileys**, `@whiskeysockets/baileys`, não
oficial: QR code uma vez, sessão salva em disco) é só o módulo de
**Atendimento**, um canal ligado ao cliente: o sistema funciona inteiro sem ele.

Desde a v5 é **cliente-servidor, para a equipe toda** (sócios, advogados,
estagiária): um **servidor** (Node, `src/server`) guarda banco, sessão do
WhatsApp e mídia; cada pessoa entra com login e usa pelo **app de desktop**
(Electron, só uma "moldura"), pelo **navegador** ou pelo **celular** (PWA).
Projeto/decisões com o usuário: documento "Barros Associados — Projeto do
Sistema de Gestão" (claude.ai) e protótipo visual das telas.

## Como rodar

```
npm install
npm start            # app de desktop (1ª vez: escolhe servidor do escritório ou "neste computador")
npm run demo         # app de desktop + servidor local com conta simulada (dados separados)
npm run server       # só o servidor (http://127.0.0.1:3210); --host 0.0.0.0 --port N; CRM_DATA_DIR
npm run server:demo  # servidor no modo demonstração (abre no navegador)
npm test             # node --test: banco, mensagens, login/permissões e API HTTP (sem navegador)
npm i --no-save playwright-core && npm run test:e2e   # servidor demo + Chromium (Playwright)
```

O ambiente de desenvolvimento na nuvem **não alcança web.whatsapp.com**
(bloqueado pelo proxy), então mudanças na interface devem ser validadas
com `npm run test:e2e` (servidor demo + navegador) e mudanças no
processamento das mensagens com `npm test`, que alimenta o
`WhatsAppService` com objetos no mesmo formato que o Baileys entrega. O app
de desktop roda aqui com `xvfb-run` (Playwright `_electron`) se precisar.

## Arquitetura

Servidor (`src/server`, ESM, Node ≥ 22.13 — usa `node:sqlite`):

- `server.js` — `startServer()`: HTTP sem framework. Entrega a interface
  (`src/renderer`) e `/assets`; `/auth/state|login|logout|setup` (cookie
  `bsess`, HttpOnly, SameSite=Lax); `POST /api/<método>` `{args}` → `{ok,result}`
  (exige cabeçalho `X-CRM: 1` contra CSRF; `X-Conn` = id da janela);
  WebSocket `/events` (mesma origem; 1ª mensagem `hello {conn}`; depois
  `{ch, data}`); `GET /media/<rel>` (Range, `?download=nome`, CSP sandbox);
  `POST /upload` (corpo cru + `X-File-Name`, até 100 MB → `token`, usado
  nos métodos da API); `/download/backup|logs` (só sócio). Linha de comando
  pede **código de primeiro acesso** (console + `codigo-primeiro-acesso.txt`)
  para criar o sócio num servidor público (`requireSetupCode`) — só para
  quem chega pelo proxy/rede; aberto no próprio computador do servidor
  (loopback sem `X-Forwarded-For`) não pede.
- `core.js` — `createCore()`: o antigo processo principal sem Electron.
  Tabela `api` (todo método recebe `ctx` = `{user, conn}` + argumentos),
  `call()` confere a permissão do perfil, lembretes/avisos periódicos,
  Google Agenda (token cifrado com chave em `google/secret.key` quando não há
  `safeStorage`), quem está vendo cada conversa (`viewers` por janela →
  `wa.isViewing(jid)` para não contar como não lida / marcar lida).
  Eventos para as janelas: `core.events.emit('event', canal, dados, destino)`
  (`{conn}` | `{user}` | todos). Avisos = evento `notify` `{kind, title, body,
  discreet, action, audience?}`; cada janela decide se mostra (`notify.js`).
- `auth.js` — usuários (`users`), sessões (`sessions`, token só em hash),
  senhas scrypt, perfis `socio`/`advogado`/`estagiario`, `can(role, método)`
  (lista do que cada perfil NÃO pode), `stripMoney` (estagiário não recebe
  valores dos casos).

Motor (`src/main`, sem Electron apesar do nome da pasta):

- `whatsapp.js` — `WhatsAppService` (EventEmitter): conexão Baileys,
  reconexão com backoff, logout (401 apaga `auth/` e volta ao QR),
  tradução dos eventos do Baileys para o banco, envio (texto, arquivos,
  voz), download de mídia, fotos de perfil, grupos, histórico sob demanda.
  Emite `status`, `chats-changed` (debounced, lista de jids), `message`,
  `history`, `chat-merged`.
- `demo.js` — `DemoWhatsAppService` (subclasse) que simula tudo; os
  métodos de envio geram mensagens no formato do Baileys e passam pelo
  mesmo `onMessages`, então o caminho de parse/gravação é o real. Timers
  via `this.later()` (cancelados no `stop()`).
- `parse.js` — WAMessage (protobuf) → linha da tabela `messages`, ou
  `reaction` / `revoke` / `edit` / `ignore`.
- `db.js` — `node:sqlite`. Tabelas: `chats`, `contacts`, `aliases`,
  `messages`, `pipelines`, `stages`, `crm`, `tags`, `chat_tags`, `notes`,
  `tasks`, `activity` (com `user_name`), `quick_replies`, `settings`,
  `legacy_pending`, `meta`, `contact_types`, `chat_filters`, `cases`,
  `payments`, `case_docs`, `users`, `sessions`, `doc_index`, `clients`,
  `case_parties`, `case_moves`, `case_steps`, `case_checklist`, `oabs`,
  `intimations`, `expenses`, `incomes`, `leads`, `lead_contacts` (migrações por versão em
  `migrate()`; `meta.schema` guarda a versão atual).
- `docs.js` — `DocsService`: pasta "BARROS ADVOGADOS" do OneDrive lida
  direto do disco (`settings.docsRoot`, ou `guessRoot()` em
  `%OneDrive%\BARROS ADVOGADOS`; demo cria uma de exemplo em
  `<dados>/OneDrive (demonstração)` via `seedDemoDocs`). Tudo guardado como
  caminho relativo (`crm.folder`, `cases.folder`), sempre conferido por
  `abs()` para não sair da pasta. Estrutura `FOLDERS` (00 ENTRADA … 07
  EQUIPE); `allowed()`: 05/06 só sócio, 07 EQUIPE só a pasta da própria
  pessoa. Pasta do cliente `02 CLIENTES/NOME`(+`_CADASTRO`), do caso
  `ASSUNTO x PARTE - nº` (`caseFolderName`); arquivos novos `AAAA-MM-DD - …`.
  Modelos em `04 MODELOS/<área>`; `fillDocx` troca `{marcador}` mesmo
  quebrado em vários pedaços pelo Word (`{NOME}` → maiúsculas);
  `templateValues` = ficha do cliente (`CLIENT_FIELDS`: cpf, rg…) + caso.
  Busca: `doc_index` (texto de .docx/.pdf simples/.txt, `fold` sem acento,
  incremental por data; PDFs > 8 MB e outros > 15 MB só pelo nome, porque ler
  arquivo "sob demanda" faz o OneDrive baixá-lo). `zip.js` = zip mínimo.
  Rota `GET /docs/file/<rel>`; no app de desktop em modo local
  `desktop.openDoc/showDoc` abre o arquivo original (Word/Explorador). Num
  servidor remoto vai precisar do Microsoft Graph (ainda não feito).
- `workflow.js` — as **10 etapas do caso** (`STEPS`, do documento do projeto)
  e `computeSteps(caso, {manual, checklist, payments})`: etapas que se
  concluem sozinhas pelos dados (triagem = tem cliente; proposta = honorários;
  documentos = checklist todo recebido; pasta = `cases.folder`; petição = nº
  do processo; cobrança = parcelas; encerramento = caso encerrado), o resto à
  mão (`case_steps`: feito / não se aplica). `next` = próximo passo. Checklists
  de documentos por área (`suggestedChecklist`), texto do pedido
  (`docsRequestText`, configurável em `docsRequestTemplate`) e `addBusinessDays`.
- `courts.js` — tribunais pelas **APIs públicas do CNJ** (sem login no PJe):
  `CourtsService.djenByOab` (DJEN, `comunicaapi.pje.jus.br`, paginado, 0,7 s
  entre páginas) e `.datajud(nº)` (`api-publica.datajud.cnj.jus.br`, índice
  pelo nº CNJ via `tribunalOf`/`datajudIndex`, chave pública
  `DATAJUD_PUBLIC_KEY` ou `settings.datajudKey`); `parseDjenItem` /
  `parseDatajudHit` aceitam as variações de nome dos campos;
  `deadlineFromAvailability` = publicação no dia útil seguinte à
  disponibilização + N dias úteis (feriados nacionais, Carnaval, Sexta Santa,
  Corpus Christi, recesso 20/12–20/01; locais não — a tela pede para conferir);
  `nameCase` (nomes do DJEN vêm em maiúsculas). **O ambiente de
  desenvolvimento na nuvem não alcança esses hosts** (proxy): testes usam
  respostas no formato real (`test/courts.test.js`) e o demo usa
  `demoCourtsFetch` (`demo.js`). No servidor (`core.js`): `checkIntimations`
  (OABs ativas, últimos 10 dias, a cada 6 h das 6h às 22h, `settings.djenLastRun`)
  grava `intimations` (ligadas ao processo pelos dígitos do nº; também viram
  `case_moves` source `djen`), `updateDatajud` (andamentos source `datajud`,
  completa tribunal/vara/distribuição vazios) e `datajudDaily` (processos
  abertos, 1 por vez com 1,5 s). Intimação → prazo (`intimations:deadline`,
  tarefa `kind='prazo'` do responsável do processo); processo só visto nas
  intimações → `courts:import` (cria cliente/caso/partes, religa intimações).
  **Avisos** (`notifyCase`): um por processo com andamento/intimação nova,
  `{user}` conforme a preferência `notifyCourts` (`mine` = responsável — ou,
  sem responsável, o dono da OAB/todos menos estagiário; `all`; `off`); a 1ª
  consulta do DataJud (histórico) não avisa; clique abre o processo
  (`action.case`, `notify.js`). DJEN e DataJud rodam a cada 6 h (6h–22h);
  `core.runCourts()` roda na hora (testes).
- `extenso.js` — valor em reais por extenso (recibo).
- **Financeiro** (v12): parcelas ganham `method`, `paid_amount`, `paid_by`,
  `receipt_no` (`registerPayment`, `receiptNumber` sequencial na 1ª emissão);
  `expenses` = contas a pagar (`kind` escritorio | custa; custa ligada ao
  processo e `reimbursable` → "reembolso pendente" até `reimbursed_at`;
  `repeat` cria a conta fixa mês a mês com o mesmo `series`); `cashflow(from,to)`
  (entradas = parcelas recebidas + reembolsos; saídas = despesas pagas;
  previsto em aberto), `cashflowMonths`, `defaulters`, `financeBreakdown`
  (categorias do mês, recebido por área em 12 meses, vencimentos de 15 dias,
  previsão de 3 meses) → `finance:dashboard`. Recibo = HTML de
  `finance:receipt` (core `receiptHtml`, dados do escritório `officeName/Doc/
  Address/City`) mostrado num iframe `srcdoc` e impresso/salvo em PDF pela
  janela de impressão. **Receita avulsa** (`incomes`, v13): entrada sem
  processo (consulta, parecer…), cliente opcional (`client_id` ou só
  `payer_name`); entra no resumo, no caixa (`type='avulsa'`), nos 12 meses e
  no "recebido por área" como `Avulsa: <categoria>`; recibo pela mesma
  numeração (`lastReceiptNo` olha parcelas e avulsas). Tudo `finance:*`
  (estagiário não vê); excluir despesa/receita só sócio.
- `leads.js` — **Comercial** (v15): `leads` = interessados que ainda não são
  clientes (origem, indicação, área, assunto, responsável, consulta,
  honorários da proposta `fee_kind` fixo|parcelado|exito|fixo_exito), funil fixo
  `LEAD_STAGES` novo → consulta → proposta → ganho/perdido (`lost_reason`).
  `lead_contacts` = registros de atendimento (ligação, presencial, e-mail,
  WhatsApp, vídeo) do interessado **ou do cliente** (aba Atendimentos da ficha).
  Lembretes de interessado são tarefas com a chave `lead:<id>` na coluna `jid`
  (`TASK_SELECT` traz `lead_id`/`lead_name`); consulta marcada vira `reuniao`;
  próximo passo com data vira tarefa. Proposta = texto do modelo
  (`proposalTemplate`/`proposalValidDays`, `{nome}` `{assunto}` `{honorarios}`…)
  revisado → WhatsApp, copiar ou PDF (`leads:proposalHtml`); marca enviada e
  agenda "Retomar proposta" em 3 dias úteis. `convertLead` ("Virar cliente"):
  cria/usa o cliente, abre o processo com área/resumo/responsável/honorários,
  gera parcelas se informada a 1ª data, leva tarefas/notas/histórico/atendimentos
  para a chave do cliente. `leadStats` (novos, fechados, conversão, origem,
  motivos de perda, propostas em aberto). Estagiário vê o funil sem valores e
  não faz proposta; excluir interessado só sócio. O funil de casos "Captação"
  antigo continua existindo, mas o comercial novo não depende dele.
- `ogg.js` — remux WebM/Opus (MediaRecorder) → OGG/Opus (mensagem de voz).
- `google.js` — `GoogleService`: Google Agenda pela API oficial com a chave
  (client_secret JSON, tipo "App para computador") do próprio usuário;
  login no navegador com retorno em `http://127.0.0.1:<porta>` + PKCE (só
  funciona com o servidor no mesmo computador — num servidor remoto vai
  precisar de cliente "Aplicativo da Web" com redirect no domínio);
  `invalid_grant` → `needsReconnect`.
- `calendar-sync.js` — `CalendarSync`: tarefas/prazos/audiências/reuniões do
  CRM viram eventos no Google (`tasks.gcal_event_id`, marcados com
  `extendedProperties.private.crmTaskId`); horário mudado no Google volta
  para o CRM (`pullChanges`); `agenda()` junta eventos do Google + tarefas
  ainda não sincronizadas. No demo, `DemoGoogleService` (em `demo.js`).
- `legacy.js` — importa `%APPDATA%\KanbanCRMWhatsApp\kanban-state.json`.

App de desktop (`src/desktop`, Electron 44): `main.js` abre uma janela
própria com o sistema. Modo **remote** (endereço do servidor) ou **local**
(liga `startServer` no próprio processo com os dados de
`%APPDATA%\WhatsAppCRM`, porta 3210 — continuidade com o app antigo; a 1ª
vez escolhe sozinho se já há `crm.sqlite`). Config em
`%APPDATA%\BarrosAssociados\desktop.json` (modo, url, bandeja, abrir com o
Windows, janela). `setup.html`/`offline.html` = telas de escolher servidor e
"sem conexão". Abrir/salvar arquivos do servidor: `session.downloadURL` +
`will-download` (abrir = baixa no temp e `shell.openPath`). Bandeja,
AppUserModelID `com.barrosassociados.sistema` + atalho no Menu Iniciar
(`ensureStartMenuShortcut`). `preload.cjs` expõe só `window.desktop`
(openUrl, saveUrl, openExternal, focus, flash, setBadge, get/setSetting,
setup.*); a página funciona igual sem ele.

Interface (`src/renderer`, JS puro em módulos ES, sem build):

- `js/bridge.js` — define `window.api` (`call` por fetch, `on` pelo
  WebSocket com reconexão, `upload`, `logout`, `ready`). 401 → `/login.html`.
  Evento `bridge:reconnected` → `store` recarrega conversas.
- `login.html`/`login.js` — entrar, ou primeiro acesso (cria o sócio). No app
  de desktop mostra "Trocar servidor / usar neste computador" (`desktop.setup.change`).
- `js/store.js` — estado (`state.chats` Map jid → conversa com campos do CRM;
  `state.me`, `state.can` {finance, admin, configure, deleteCases},
  `state.viewers`, `state.typing`), event bus `on/emit`, `api()`; manda
  `app:focus` em foco/blur.
- `js/notify.js` — avisos (Notification do navegador/Electron, respeitando as
  preferências da pessoa e o modo discreto) e contador no título.
- `js/util.js` — `h()` pra criar elementos, `fill()` (limpa e preenche
  ignorando null — **não use `el.append(null)`**, imprime "null"),
  formatação, modais, menus, toasts, e arquivos: `mediaUrl`, `openMedia`,
  `saveMedia`, `pickFiles`, `uploadFiles`, `downloadUrl/Blob`, `openExternal`.
- Menu (`NAV` em `app.js`, com `also` = sub-telas que acendem o mesmo
  botão): Hoje · Agenda (`agenda` calendário + `tasks` lista) · Jurídico
  (`legal` + `board`) · Atendimento (`inbox` + `commercial` + `contacts`) · Documentos ·
  Financeiro · Relatórios (`dashboard`). `body[data-view]`: a tela do QR e a
  faixa de conexão só aparecem no Atendimento.
- `js/views/legal.js` — **Jurídico**: abas Clientes · Processos · Intimações
  (`views/intimations.js`: OABs acompanhadas, Buscar agora, conferir / criar
  prazo, processos encontrados para cadastrar), busca no topo; ficha do cliente
  (Processos, Dados — que preenchem os modelos —, Documentos, Financeiro,
  Notas e histórico; botão WhatsApp ou "Ligar WhatsApp"). `openClient(id)` /
  `openLegal(tab)` em `store.js` navegam para cá de qualquer tela.
- `js/views/tasks.js` — Agenda em lista (tarefas, prazos, audiências,
  reuniões), filtro por tipo e responsável; `showTasks()` abre filtrada.
- `js/views/today.js` — tela **Hoje** (entrada do sistema, sempre a 1ª ao
  abrir): Meu dia (agenda + próximas ações: atrasados, para hoje, clientes
  aguardando, cobranças — só com `can.finance` —, casos sem retorno) e Minha
  semana (colunas por dia); "Meus compromissos" × "Escritório todo";
  fechamento do dia passa pendências para amanhã (`tasks:reschedule`; prazos
  e audiências não mudam). As faixas de data são calculadas na página (fuso
  de quem usa) e mandadas para `today:summary`.
- `js/views/finance.js` — **Financeiro** em abas: Painel (destaques que pedem
  ação, KPIs do mês, gráfico de entradas × saídas de 12 meses, previsão,
  despesas por categoria, recebido por área, inadimplentes, vencimentos) · A
  receber · A pagar · Fluxo de caixa (mês, saldo acumulado) · Inadimplência.
  `js/charts.js` = gráficos SVG próprios (colunas agrupadas e barras; legenda,
  dica ao passar o mouse/foco, "ver tabela"); cores `--viz-1/--viz-2`
  validadas para os dois temas (skill dataviz). "Recebi" abre `receiveDialog`
  (data, valor, forma) → `showReceipt`; custas na aba Honorários do processo.
- `js/views/commercial.js` — **Comercial**, a 2ª tela do Atendimento
  (`atendimentoSwitch`: Conversas · Comercial, também no topo da lista de
  conversas): números do mês, funil (arrastar; "Fechou" abre o "Virar cliente",
  "Não fechou" pede o motivo) ou lista; ficha do interessado (`openLead`, abre
  por cima de qualquer tela via `store.openLead`) com dados, próximos passos,
  atendimentos, proposta e virar cliente. `contactDialog`/`contactList` também
  na ficha do cliente. Na ficha do WhatsApp (`crmpanel`) aparece "Interessado no
  Comercial" ou "Registrar como interessado"; no Hoje, "Interessados sem próximo
  passo" (`today:summary.leadsIdle`).
- `js/views/docs.js` — tela **Documentos** (Buscar · Modelos · Pastas),
  `folderBrowser`, `templatePicker` ("Novo do modelo"), `useAsBaseDialog`,
  `caseFolderPanel` (aba Documentos do caso) e `clientFolderDialog` (ficha do
  contato tem "Dados para documentos" e "Pasta no OneDrive").
- `js/views/*` — `chatlist`, `chatview` (mensagens + composer + gravação;
  faixa "Fulano está respondendo / também está com esta conversa aberta"),
  `crmpanel` (ficha do contato, com a lista de casos), `casemodal` (ficha do
  processo em tela grande: Resumo — dados do processo, responsável, partes —,
  Fluxo — etapas + documentos do cliente com "Solicitar" (revisa o texto, envia
  pelo WhatsApp se houver ou copia; marca pedido e cria lembrete em 3 dias
  úteis) e "Recebido" (arquivo vai para a pasta do caso) —, Andamentos (linha
  do tempo; manual por enquanto, `source` datajud/djen depois), Prazos,
  Documentos, Honorários só com `can.finance`, Notas; dados via `cases:full`), `finance`, `agenda`,
  `board` (kanban de CASOS), `contacts`, `tasks`, `dashboard`, `settings`
  (Minha conta, Equipe — só sócio —, conexão, notificações…), `connect`.
- `js/icons.js` — ícones de traço em SVG (`icon(nome)`), sem emoji na
  interface. Funis, tipos de contato e filtros guardam o **nome** do ícone
  (`PICK_ICONS`, escolhido no `iconPicker` dos Ajustes); `dataIcon`/`named`
  desenham e aceitam emoji antigo (v14 converteu os gravados via
  `db.emojiToIcon`). Emojis só no conteúdo das mensagens (seletor e reações).
- Estilos em `styles.css` com variáveis e `[data-theme=light|dark]`; cor da
  marca em `--accent` (azul-ardósia da logo). Cores por item via `--c`.
- `manifest.webmanifest` — instalar no celular como app.

## Decisões importantes

- **Equipe e perfis**: sócio (tudo, inclusive equipe, configurações do
  escritório, backup, desconectar WhatsApp, excluir casos/parcelas),
  advogado (tudo menos isso), estagiário (sem financeiro/painel, sem
  configurar funis/tipos/filtros/etiquetas, sem apagar mensagem). A regra
  vale no servidor (`auth.can`); a interface só esconde. Preferências de
  cada pessoa (`core.USER_KEYS`: tema, avisos, modo discreto…) ficam em
  `users.prefs`; as do escritório (`OFFICE_KEYS`) em `settings`, só sócio muda.
  Opções do computador (bandeja, abrir com o Windows) ficam no app de desktop.
- **Responsável** (`tasks.assignee_id`, padrão = quem criou; vazio =
  qualquer pessoa da equipe; `tasks.done_at` conta o que foi feito no dia).
  `team:list` (todos os perfis) dá nomes para o seletor.
- **Assinatura**: mensagens enviadas pela equipe saem com `*Assinatura:*` na
  1ª linha (`users.signature`, padrão = primeiro nome; `signMessages` desliga).
  Ao editar, a interface tira e recoloca a assinatura original.
- **Arquivos**: a interface nunca passa caminhos do disco; envia por
  `/upload` e passa os tokens (`messages:sendFiles`, `messages:sendVoice`,
  `cases:addFiles`, `google:importClient`).

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
  após acordar) não conta como queda rápida: tenta de 3 em 3 s. 403/406 no
  login = WhatsApp não aceita mais a sessão (celular reinstalado/trocado,
  aparelho removido, número restrito): 2ª vez seguida apaga `auth/` e volta ao
  QR com `status.notice` explicando (conversas ficam). 402 = suspensão
  temporária: tenta de novo só a cada 30 min. Só existe
  uma conexão por vez: `start()` tem um número (`startGen`) e desiste se
  outro começou no meio (timer de reconexão + `powerMonitor.resume` juntos
  abriam duas conexões com a mesma sessão e as mensagens paravam) e um watchdog de 40 s reinicia se não vier QR.
- **Tipos de contato** (`contact_types`, `crm.type_id`) e **filtros da
  lista** (`chat_filters`, regras em JSON aplicadas por `chatMatchesRules`
  em `store.js`) são editáveis pelo usuário. Filtros nunca escondem
  mensagens de verdade: a lista "Tudo" existe por padrão e os chips mostram
  quantas não lidas há em cada filtro. `personal` no tipo = fora de
  "Aguardando resposta" e do aviso de conversa esquecida (`checkForgotten`
  em `server/core.js`, configurável em horas; `chats.alerted_ts` evita repetir).
- **Cliente no centro** (`clients`, v9): cadastro próprio (CPF/CNPJ, RG,
  endereço, telefones…, `folder` no OneDrive), WhatsApp opcional em
  `clients.jid`. Casos, notas, tarefas e histórico continuam com a coluna
  `jid`, que guarda a **chave do cliente** (`clientKey`): o jid do WhatsApp dele
  ou `cliente:<id>`; `linkClientChat` troca a chave em tudo quando liga/desliga
  o WhatsApp. `cases.client_id` é obrigatório para casos novos (vindo de uma
  conversa, `ensureClientForChat` cria o cliente). `migrateV9` converteu quem
  tinha caso ou era do tipo "Cliente". `caseRow` traz `client_name`/`client_jid`;
  tarefas e parcelas trazem `client_id`/`client_name`. Na ficha do WhatsApp
  (`crmpanel`) só aparece "Abrir ficha do cliente" ou "Cadastrar/Ligar".
- **Casos**: o funil é de casos, não de contatos — um cliente pode ter
  vários. `listChats` traz `stage_ids`/`pipeline_ids` dos casos
  abertos; `stage_id`/`pipeline_id` da conversa = caso mais recente (compat.).
  Honorários: tipos fixo/parcelado/êxito no caso; valores em `payments`
  (parcelas geradas por `generateInstallments`, centavos certos na última).
  Cobrança = texto do modelo (`chargeTemplate` + `pixKey` nas configurações,
  variáveis `{nome}` `{valor}` …) revisado e enviado pelo usuário; nada é
  enviado sozinho. `cases.last_update_at` ("último retorno ao cliente") é
  atualizado quando você manda mensagem ao contato; avisos de parcelas e de
  casos sem retorno em `checkFinanceAndCases` (`server/core.js`).
- **Notificações**: o servidor manda `notify` para as janelas; a página
  mostra com a `Notification` da web (no app de desktop vira aviso do Windows
  pelo AppUserModelID `com.barrosassociados.sistema` + atalho no Menu
  Iniciar). Avisos de dinheiro (`audience: 'finance'`) só vão a quem vê o
  financeiro.
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
- **Evitar "atividade suspeita"** (o número do escritório já foi posto em
  análise uma vez): nada de rajadas ao WhatsApp. Fotos de perfil em fila única
  (`avatarLookup`, 1,5 s entre consultas, ≤150/dia); downloads automáticos com
  1,5 s de intervalo e **sem** pedir reenvio ao celular (`downloadMedia(…, {auto})`
  — só o clique em Baixar pede). Qualquer recurso novo que consulte o WhatsApp
  em lote deve seguir a mesma regra.
- **Visualização única**: o conteúdo nunca chega aos aparelhos conectados; o
  Baileys descarta o aviso (`unavailable type=view_once…`), então
  `onRawMessageNode` escuta `CB:message` no socket e grava um texto
  "👁 … abra no celular" (`parse.viewOnceKind`, `extra.viewOnce`).
- **Ligações**: o Baileys só grava as perdidas; `onCalls` (evento `call`)
  grava/atualiza uma linha `type='call'` com o id da chamada (recebida →
  atendida/recusada/perdida) e avisa a ligação recebida.
- **Corretor e sugestões ao digitar**: corretor do Chromium em pt-BR
  (`setupSpellcheck` em `src/desktop/main.js` monta o menu do botão direito
  com as sugestões — o Chromium só sublinha; no navegador o menu é o nativo);
  preferências por pessoa `spellcheck` (atributo da caixa de texto) e
  `wordSuggest` (`USER_KEYS`), API `words:vocab`. Correção automática pt-BR
  (`js/autocorrect.js`, preferência `autocorrect`): ao digitar espaço/pontuação
  troca acentos esquecidos e erros comuns (lista + terminações -ção/-são/
  -ência/-ável/-ível); só casos sem ambiguidade; Backspace logo depois desfaz
  (e a palavra não é mais corrigida na sessão); a última palavra é corrigida
  ao enviar. Sugestão de palavras = `js/wordsuggest.js` (puro, testado no
  Node) sobre `db.vocabulary()` — palavras das SUAS mensagens enviadas e
  respostas rápidas, por frequência (≥2 usos), aprende na hora ao enviar;
  Tab ou clique completa.
- **Editar mensagem**: só texto seu, até 15 min (`editableCheck`);
  `sendMessage(jid, { text, edit: key })`. No composer, `editing` mostra a
  faixa "Editando" (Esc cancela). Fotos abrem em `views/imageviewer.js`
  (zoom com rodinha/pinça, arrastar, girar, ← →).
- Pasta de dados do servidor: `CRM_DATA_DIR` ou `%APPDATA%\WhatsAppCRM`
  (`~/.config/WhatsAppCRM` no Linux; demo usa `WhatsAppCRM-Demo`). Só um
  servidor por pasta de dados (senão corrompe a sessão do WhatsApp); o app de
  desktop é instância única.
- Usuário final é leigo em terminal: instalação por `Instalar.bat`
  (npm install + atalhos "Barros Associados" via `scripts/criar-atalho.ps1`,
  que apaga o atalho antigo "WhatsApp CRM"), abertura por atalho que chama
  `electron.exe` direto (sem janela de console). Qualquer mudança que exija
  passo manual deve vir com instrução simples.
- Textos da interface e comentários em português.
