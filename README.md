# WhatsApp CRM (v4)

CRM de desktop para Windows com o **WhatsApp integrado de verdade**: você
lê o QR code **uma única vez**, o app fica conectado como um "aparelho
conectado" (igual ao WhatsApp Web) e **todas as conversas ficam guardadas
no seu computador**. Ao abrir de novo, ele entra direto, sem pedir login.

> ⚠️ Usa uma conexão **não oficial** com o WhatsApp (biblioteca
> [Baileys](https://github.com/WhiskeySockets/Baileys)). É o mesmo
> protocolo do WhatsApp Web, mas não é um produto da Meta. Use com bom
> senso: nada de disparo em massa ou spam, pra não arriscar bloqueio do
> número.

## O que ele faz

- **Conversas** — lista igual à do WhatsApp, com busca (inclusive dentro
  das mensagens), filtros (não lidas, sem etapa, com tarefa, grupos, por
  etapa do funil ou por etiqueta) e envio de:
  - texto (com *negrito*, _itálico_, ~riscado~), resposta a uma mensagem,
    reações e "apagar para todos";
  - fotos, vídeos e documentos (botão 📎, arrastar e soltar na conversa ou
    colar com Ctrl+V);
  - **áudio gravado no microfone** (🎤), que chega como mensagem de voz;
  - **respostas rápidas**: digite `/` + o atalho (ex.: `/ola`). Use
    `{nome}` no texto pra colocar o primeiro nome do contato.
- **Tipos de contato e filtros editáveis** — classifique cada conversa
  (Pessoal, Cliente, Empresa ou os tipos que você criar) e use os filtros
  no topo da lista: *Tudo, Trabalho, Pessoal, Para classificar, Aguardando
  resposta, Não lidas* — ou crie os seus. Cada filtro mostra quantas não
  lidas tem; nenhuma mensagem some. O app avisa quando um contato de
  trabalho está há muito tempo sem resposta.
- **Ficha do contato (CRM)** ao lado da conversa: nome, empresa, e-mail,
  valor do negócio, etapa do funil, etiquetas, **notas**, **tarefas com
  lembrete** (aviso do Windows na hora marcada) e histórico de
  movimentações.
- **Casos** — cada cliente pode ter vários casos (processos, consultas,
  consultorias). A ficha do caso tem abas: **Dados** (nº do processo, área,
  vara/órgão, parte contrária), **Honorários** (fixo, parcelado e/ou êxito,
  parcelas com vencimento, "Recebi" e **📤 Cobrar** pelo WhatsApp),
  **Prazos** (prazos, audiências, reuniões, com aviso), **Documentos**
  (arquivos do computador ou "Anexar ao caso" direto da mensagem) e
  **Notas**. Mostra também o **último retorno ao cliente** e avisa quando
  passa de X dias sem notícia.
- **Funil (Kanban)** — os cartões são os casos: **Captação**, **Casos em
  andamento** e **Consultoria** (todos editáveis), com **arrastar e soltar**,
  total de honorários por coluna, parcelas vencidas e próximo prazo.
- **💰 Financeiro** — todas as parcelas: vencidas, a vencer, pagas, totais do
  mês e cobrança com um clique (ou várias vencidas de uma vez, com
  intervalo). Modelo da mensagem e chave PIX em Configurações.
- **📅 Agenda** — dia, semana e mês com **todas as suas agendas do Google**
  juntas (pessoal, escritório, feriados…), cada uma com sua cor, para ver os
  horários livres. Prazos, audiências e reuniões criados no CRM vão para o
  Google sozinhos (e chegam no celular); se mudar o horário no Google, o CRM
  acompanha. Configuração: veja "Conectar o Google Agenda" abaixo.
- **Contatos** — tabela com filtros e **exportação para planilha** (CSV,
  abre no Excel).
- **Tarefas** — tudo que está atrasado, pra hoje e próximo.
- **Painel** — números do atendimento e do funil.
- Avisos de novas mensagens, contador de não lidas, continua rodando perto
  do relógio ao fechar a janela (opcional), abrir junto com o Windows
  (opcional), tema claro/escuro, backup com um clique.
- **Importa o Kanban antigo** (v3): categorias, colunas, notas e prazos.

## Instalação — só clicar

1. Extraia esta pasta num lugar fixo, **fora do OneDrive** (ex.:
   `C:\whatsapp-crm`).
2. Dê **duplo-clique em `Instalar.bat`**.
   - Se o Windows avisar "o editor não foi verificado", clique em **Mais
     informações → Executar assim mesmo**.
   - Se faltar o Node.js, ele avisa e manda pra https://nodejs.org —
     instale a versão LTS e clique em `Instalar.bat` de novo.
   - No final ele cria o atalho **WhatsApp CRM** na Área de Trabalho e já
     abre o app.
3. No celular: WhatsApp → **⋮ (Android) ou Configurações (iPhone) →
   Dispositivos conectados → Conectar dispositivo** → leia o QR code da
   tela. Se preferir, use a aba **Conectar com número de telefone**: o app
   mostra um código de 8 letras para digitar no celular.
4. Pronto. Na primeira conexão o histórico de conversas é sincronizado (a
   faixa azul no topo mostra o progresso).

Da próxima vez, abra pelo atalho **WhatsApp CRM** (ou
`Iniciar WhatsApp CRM.bat`). Não pede QR code de novo.

Quer conhecer antes de conectar seu número? Abra `Demonstracao.bat`:
ele simula uma conta com conversas de exemplo (dados separados dos reais).

## Conectar o Google Agenda

1. Crie a chave gratuita no Google Cloud (projeto → ativar **Google Calendar
   API** → **Google Auth Platform** → público **Externo** → adicionar o seu
   e-mail em **Usuários de teste** → **Clientes → Criar cliente → App para
   computador** → **Baixar JSON**).
2. No app: **Agenda → 1. Escolher a chave (.json)** → **2. Entrar com o
   Google**. No aviso "O Google não verificou este app", clique em
   **Avançado → Acessar**.
3. Com o app em **modo de teste** no Google, a autorização vence a cada 7
   dias: o app avisa e é só clicar em **Reconectar Google**.

## Onde ficam os dados

Tudo fica no seu computador, em `%APPDATA%\WhatsAppCRM`:

| Arquivo / pasta | O que é |
| --- | --- |
| `crm.sqlite` | conversas, mensagens, contatos e todo o CRM |
| `auth\` | a sessão do WhatsApp (é o que evita pedir QR code de novo) |
| `media\` | fotos, áudios e documentos baixados/enviados |
| `logs\` | registro de erros da conexão |

- **Backup**: Configurações → *Fazer backup do CRM* (gera uma cópia do
  banco).
- **Trocar de número**: Configurações → *Desconectar WhatsApp*. As
  conversas antigas continuam guardadas.
- Nunca envie a pasta `auth` pra ninguém: ela dá acesso ao seu WhatsApp.

## Se algo não funcionar

- **Notificações não aparecem**: Configurações → *Testar notificação*. Se
  não aparecer, clique em *Abrir notificações do Windows* e confira se
  **WhatsApp CRM** está ligado e se o *Não perturbe / Assistente de foco*
  está desligado.

- **O QR code não aparece (fica "Conectando ao WhatsApp…")**: o app não
  está conseguindo falar com os servidores do WhatsApp. Confira a internet
  e se o antivírus/firewall não está bloqueando o "Electron" (libere o
  app). Clique em *Gerar novo código* para tentar de novo e, se continuar,
  clique em *Abrir registros de erro* e mande o arquivo `whatsapp.log`.

- **Faixa "Sem conexão — tentando reconectar" (ex.: código 428)**: a
  ligação com o WhatsApp caiu (internet oscilou, computador saiu da
  suspensão, ou o próprio WhatsApp fechou). A sessão continua salva e o
  app reconecta sozinho; a faixa só aparece se demorar mais de 10 s. Se
  ficar muito tempo assim, confira a internet e se o antivírus (proteção
  web/HTTPS) não está bloqueando o app.
- **Pediu QR code de novo**: acontece se você remover o aparelho pelo
  celular (Aparelhos conectados) ou se ficar muitos dias sem abrir o app
  — é regra do WhatsApp. É só ler de novo; as conversas salvas continuam.
- **Foto/áudio antigo não abre**: clique em *Baixar*. Mídias muito antigas
  podem já ter sido apagadas dos servidores do WhatsApp.
- **Mensagens antigas faltando numa conversa**: role até o topo e clique
  em *Buscar mensagens mais antigas no celular* (o celular precisa estar
  com internet).
- **Outro erro**: aperte **F12**, veja a aba *Console* e mande o texto em
  vermelho, junto com o arquivo `%APPDATA%\WhatsAppCRM\logs\whatsapp.log`.

## Para desenvolvedores

```
npm install
npm start          # app normal
npm run demo       # modo demonstração (conta simulada, dados em WhatsAppCRM-Demo)
npm test           # testes do núcleo (banco + processamento das mensagens)
npm i --no-save playwright-core && npm run test:e2e   # testa a interface no modo demo
```

Detalhes da arquitetura em [`CLAUDE.md`](CLAUDE.md).
