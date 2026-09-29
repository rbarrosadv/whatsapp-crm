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
  `quick_replies`, `settings`, `legacy_pending`, `meta`.
- `ogg.js` — remux WebM/Opus (MediaRecorder do Chromium) → OGG/Opus, que
  é o que o WhatsApp aceita como mensagem de voz.
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
  `crmpanel` (ficha), `board` (kanban com drag-and-drop HTML5),
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
- **Não lidas**: contadas por nós (`messages.upsert` tipo `notify`), não
  pelo `unreadCount` incremental do Baileys; `chats.update` com 0 zera,
  -1 marca como não lida; no histórico usamos o valor absoluto.
- **Mensagem crua** (`messages.raw`, BufferJSON) só é guardada para mídia,
  enquetes e mensagens enviadas por nós (necessário para baixar mídia e
  para o `getMessage` de reenvio); texto recebido não guarda raw.
- **Sessão registrada** = `creds.json` com `me.id` e `account` (só existe
  depois que o celular confirma). Sem isso, `start()` apaga `auth/` e a
  tela de conexão fica aberta (QR ou código pelo número via
  `requestPairingCode`). Falhas antes do registro trocam o perfil de
  navegador (`BROWSERS`) e um watchdog de 40 s reinicia se não vier QR.
- Mídia pequena (foto, figurinha, áudio) é baixada automaticamente quando
  chega; o resto sob demanda (botão Baixar), com `reuploadRequest` pra
  mídia expirada.
- Pasta de dados fixa: `%APPDATA%\WhatsAppCRM` (`CRM_DATA_DIR` sobrescreve;
  demo usa `WhatsAppCRM-Demo`). Instância única (`requestSingleInstanceLock`)
  pra não corromper a sessão.
- Usuário final é leigo em terminal: instalação por `Instalar.bat`
  (npm install + atalhos via `scripts/criar-atalho.ps1`), abertura por
  atalho que chama `electron.exe` direto (sem janela de console). Qualquer
  mudança que exija passo manual deve vir com instrução simples.
- Textos da interface e comentários em português.
