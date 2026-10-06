// Teste de ponta a ponta no modo demonstração (sem WhatsApp real): sobe o
// servidor e usa o sistema pelo navegador (Chromium), como a equipe usaria.
// Uso: npm i --no-save playwright-core && npm run test:e2e
// Salva capturas de tela em test-results/.
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const name of ['playwright-core', 'playwright']) {
    try { return require(name); } catch { /* tenta o próximo */ }
    try {
      const globalRoot = execSync('npm root -g').toString().trim();
      return require(path.join(globalRoot, name));
    } catch { /* tenta o próximo */ }
  }
  throw new Error('Instale o playwright-core: npm i --no-save playwright-core');
}
const { chromium } = loadPlaywright();

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'test-results');
fs.mkdirSync(OUT, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-e2e-'));
const errors = [];
let nextPort = 3400 + Math.floor(Math.random() * 400);
const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium')
  ? { executablePath: fs.readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).map((d) => path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome')).find((f) => fs.existsSync(f)) }
  : {});

const SOCIO = { name: 'Rafael Barros', login: 'barros', password: 'segredo1' };

async function startServer(extraEnv, dir) {
  const port = nextPort++;
  const srv = spawn(process.execPath, ['src/server/server.js', '--demo', '--port', String(port)], {
    cwd: ROOT, env: { ...process.env, CRM_DATA_DIR: dir, CRM_DEMO_QR_MS: '5000', ...extraEnv },
  });
  srv.stderr.on('data', (d) => { const t = String(d); if (/Error|erro/i.test(t) && !/Experimental/.test(t)) errors.push(`servidor: ${t.trim()}`); });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${port}/auth/state`); return { srv, url: `http://127.0.0.1:${port}` }; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('servidor não subiu');
}

async function newPage(url) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(`${url}/`);
  return { context, page };
}

/** Entra no sistema (no primeiro acesso, cria o sócio). */
async function login(page, who = SOCIO) {
  await page.waitForSelector('#login');
  if (await page.locator('#name-row:not([hidden])').count()) {
    await page.fill('#name', who.name);
    await page.fill('#again', who.password);
  }
  await page.fill('#login', who.login);
  await page.fill('#password', who.password);
  await page.click('#go');
  await page.waitForURL((u) => !u.pathname.endsWith('login.html'));
}

async function launch(extraEnv = {}, dir = dataDir) {
  const { srv, url } = await startServer(extraEnv, dir);
  const { context, page } = await newPage(url);
  await login(page);
  const app = { url, close: async () => { await context.close(); srv.kill(); await new Promise((r) => srv.once('exit', r)); } };
  return { app, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
function check(cond, msg) { if (!cond) throw new Error(`FALHOU: ${msg}`); console.log(`✔ ${msg}`); }

let { app, page } = await launch();
try {
  // 1) abre no painel Hoje, sem a tela do WhatsApp na frente (o WhatsApp é um módulo)
  await page.waitForSelector('.view-today.active .today-alert', { timeout: 15000 });
  check(await page.locator('.connect-overlay img.qr:visible').count() === 0, 'abre no painel Hoje sem depender do WhatsApp');
  // o QR code fica no Atendimento
  await page.click('.rail-btn[title="Atendimento"]');
  await page.waitForSelector('.connect-overlay:not(.hidden) img.qr', { timeout: 15000 });
  await shot(page, '01-qr');
  check(true, 'mostra o QR code no Atendimento na primeira vez');

  // 2) conecta e sincroniza conversas
  await page.waitForSelector('.connect-overlay.hidden', { state: 'attached', timeout: 15000 });
  await page.waitForSelector('.chat-row', { timeout: 15000 });
  const rows = await page.locator('.chat-row').count();
  check(rows >= 5, `lista de conversas sincronizada (${rows})`);
  await shot(page, '02-inbox');

  // 3) abre a conversa e envia mensagem
  await page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await page.waitForSelector('.msg');
  check(await page.locator('.msg').count() >= 4, 'mensagens carregadas do banco');
  await page.fill('.composer-input', 'Temos sim! No anual sai 10% mais barato 😉');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.out:has-text("10% mais barato")');
  await page.waitForSelector('.msg.out:last-child .tick-read', { timeout: 5000 });
  check(true, 'mensagem enviada e confirmada como lida');
  await page.waitForSelector('.msg.in:has-text("Perfeito, obrigado")', { timeout: 6000 });
  check(true, 'resposta recebida aparece na conversa');
  check((await page.locator('.msg.out', { hasText: '10% mais barato' }).innerText()).includes('Rafael:'),
    'mensagem sai assinada com o nome de quem enviou');

  // resposta rápida com "/"
  await page.fill('.composer-input', '/ola');
  await page.waitForSelector('.quick-suggest:not(.hidden) .quick-item');
  await page.keyboard.press('Enter');
  const val = await page.inputValue('.composer-input');
  check(val.startsWith('Olá!'), 'resposta rápida inserida pelo atalho /ola');
  await page.fill('.composer-input', '');

  // editar mensagem enviada
  await page.fill('.composer-input', 'Reunião amanhã às 14h');
  await page.keyboard.press('Enter');
  const sentMsg = page.locator('.msg.out', { hasText: 'Reunião amanhã às 14h' });
  await sentMsg.waitFor();
  await sentMsg.hover();
  await sentMsg.locator('.msg-menu-btn').click();
  await page.locator('.popup-item', { hasText: 'Editar' }).click();
  await page.waitForSelector('.edit-bar');
  check(await page.inputValue('.composer-input') === 'Reunião amanhã às 14h', 'editar coloca o texto na caixa');
  await page.fill('.composer-input', 'Reunião amanhã às 15h');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.out:has-text("Reunião amanhã às 15h") .edited');
  check(await page.locator('.msg.out:has-text("às 14h")').count() === 0 && await page.locator('.edit-bar').count() === 0,
    'mensagem editada mostra o texto novo com "Editada"');
  const inMsg = page.locator('.msg.in').first();
  await inMsg.hover();
  await inMsg.locator('.msg-menu-btn').click();
  check(await page.locator('.popup-item', { hasText: 'Editar' }).count() === 0, 'mensagens recebidas não podem ser editadas');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);

  // sugestão de palavras ao digitar (aprende com o que você enviou)
  await page.fill('.composer-input', 'Preciso da procuração assinada');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.out:has-text("procuração assinada")');
  await page.click('.composer-input');
  await page.keyboard.type('Segue a proc');
  await page.waitForSelector('.word-suggest:not(.hidden) .word-chip.first:has-text("procuração")');
  await shot(page, '03a-sugestao-palavra');
  await page.keyboard.press('Tab');
  check(await page.inputValue('.composer-input') === 'Segue a procuração ', 'Tab completa a palavra sugerida');
  check(await page.getAttribute('.composer-input', 'spellcheck') !== 'false', 'corretor ortográfico ligado na caixa de mensagem');
  await page.fill('.composer-input', '');

  // correção automática (pt-BR) ao terminar a palavra; Backspace desfaz
  await page.click('.composer-input');
  await page.keyboard.type('voce nao ');
  check(await page.inputValue('.composer-input') === 'você não ', 'corrige acentos ao digitar (voce nao → você não)');
  await page.waitForSelector('.word-suggest:not(.hidden) .word-fixed');
  await shot(page, '03b-correcao');
  await page.keyboard.press('Backspace');
  check(await page.inputValue('.composer-input') === 'você nao ', 'Backspace logo depois desfaz a correção');
  await page.keyboard.type('procuracao');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.out:has-text("você nao procuração")');
  check(true, 'última palavra é corrigida ao enviar (e a desfeita fica como digitada)');

  // visualizador de imagens com zoom
  const jidMari = await page.evaluate(() => document.querySelector('.chat-row.active')?.dataset.jid || null);
  await page.evaluate(async ({ jid, files }) => {
    const tokens = [];
    for (const f of files) tokens.push(await window.api.upload(await (await fetch(f)).blob(), f.split('/').pop()));
    await window.api.call('messages:sendFiles', jid, tokens);
  }, { jid: jidMari, files: ['/assets/icon.png', '/assets/tray.png'] });
  await page.waitForSelector('.msg.out img.media-img', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('.msg.out img.media-img').length >= 2);
  await page.locator('.msg.out img.media-img').last().click();
  await page.waitForSelector('.iv-overlay .iv-img');
  check((await page.textContent('.iv-counter')).includes('2 de'), 'visualizador abre na foto clicada');
  const box = await page.locator('.iv-stage').boundingBox();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(150);
  const zoom = parseInt(await page.textContent('.iv-zoom'), 10);
  check(zoom > 150, `zoom com a rodinha do mouse (${zoom}%)`);
  await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 100, { steps: 4 }); await page.mouse.up();
  check((await page.getAttribute('.iv-img', 'style')).includes('translate('), 'arrastar move a imagem ampliada');
  await shot(page, '03b-visualizador');
  await page.keyboard.press('ArrowLeft');
  check((await page.textContent('.iv-counter')).startsWith('1 de') && (await page.textContent('.iv-zoom')) === '100%',
    'seta ← volta para a foto anterior, ajustada à tela');
  await page.keyboard.press('Escape');
  check(await page.locator('.iv-overlay').count() === 0, 'Esc fecha o visualizador');

  // 3b) classificação: faixa "Quem é este contato?" e filtros
  await page.waitForSelector('.classify-bar');
  await page.click('.classify-bar button:has-text("Cliente")');
  await page.waitForSelector('.chat-head .stage-btn:has-text("Cliente")');
  check(await page.locator('.classify-bar').count() === 0, 'contato classificado como Cliente pela faixa');
  await page.locator('.chat-row', { hasText: 'João (Fornecedor)' }).click();
  await page.click('.classify-bar button:has-text("Pessoal")');
  await page.waitForSelector('.chat-head .stage-btn:has-text("Pessoal")');
  await page.click('.chips .chip:has-text("Trabalho")');
  await page.waitForTimeout(200);
  check(await page.locator('.chat-row:has-text("João (Fornecedor)")').count() === 0, 'filtro Trabalho esconde conversa pessoal');
  check(await page.locator('.chat-row:has-text("Mariana Souza")').count() === 1, 'filtro Trabalho mostra cliente');
  check(await page.locator('.chat-row:has-text("Ana Beatriz")').count() === 1, 'filtro Trabalho mostra não classificados');
  await page.click('.chips .chip:has-text("Para classificar")');
  await page.waitForTimeout(200);
  check(await page.locator('.chat-row:has-text("Mariana Souza")').count() === 0, 'Para classificar não mostra classificados');
  await page.click('.chips .chip:has-text("Aguardando resposta")');
  await page.waitForTimeout(200);
  check(await page.locator('.chat-row:has-text("Carlos Pereira") .waiting').count() === 1, 'Aguardando resposta mostra há quanto tempo');
  await shot(page, '03a-filtros');
  // novo filtro personalizado
  await page.click('.chips .chip-edit');
  await page.fill('.modal .field.grow input', 'Clientes');
  await page.locator('.modal label.check', { hasText: 'Cliente' }).first().locator('input').check();
  await page.click('.modal button:has-text("Salvar")');
  await page.click('.chips .chip:has-text("Clientes")');
  await page.waitForTimeout(200);
  check(await page.locator('.chat-row').count() === 2
    && await page.locator('.chat-row:has-text("Mariana Souza")').count() === 1
    && await page.locator('.chat-row:has-text("João (Fornecedor)")').count() === 0, 'filtro criado pelo usuário funciona');
  await page.click('.chips .chip:has-text("Tudo")');
  await page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await page.waitForSelector('.chat-head .stage-btn:has-text("Cliente")');

  // 4) caso novo pelo cabeçalho
  await page.click('.chat-head .stage-btn:has-text("Novo caso")');
  await page.fill('.modal input.input', 'Plano anual');
  await page.click('.modal .stage-btn.wide');
  await page.locator('.popup-item', { hasText: 'Proposta de honorários' }).click();
  await page.click('.modal button:has-text("Criar")');
  await page.waitForSelector('.modal-case .case-head');
  check(true, 'caso criado e ficha do caso aberta');
  await page.fill('.modal-case .field:has-text("Nº do processo") input', '0001234-56.2026.8.26.0100');
  await page.locator('.modal-case .field:has-text("Nº do processo") input').press('Tab');
  // honorários: parcelado, gera 2 parcelas, recebe a 1ª, cobra a 2ª
  await page.click('.modal-case .tab:has-text("Honorários")');
  await page.click('.modal-case .fee-type:has-text("Parcelado")');
  await page.waitForSelector('.modal-case .fee-type.on:has-text("Parcelado")');
  const feeInput = page.locator('.modal-case .field:has-text("Valor contratado") input');
  await feeInput.fill('2388');
  await feeInput.press('Tab');
  await page.waitForTimeout(300);
  await page.click('.modal-case button:has-text("Gerar parcelas")');
  await page.fill('.modal:not(.modal-case) .field:has-text("Nº de parcelas") input', '2');
  await page.click('.modal:not(.modal-case) button:has-text("Gerar")');
  await page.waitForSelector('.modal-case table tbody tr >> nth=1');
  check(await page.locator('.modal-case table tbody tr').count() === 2, 'parcelas geradas (2× R$ 1.194,00)');
  await page.locator('.modal-case table tbody tr').first().locator('button:has-text("Recebi")').click();
  await page.waitForSelector('.modal-case .status-pill.ok:has-text("Paga")');
  check((await page.locator('.modal-case .fee-summary').innerText()).includes('1.194,00'), 'parcela recebida entra no resumo');
  await page.locator('.modal-case table tbody tr').nth(1).locator('button:has-text("Cobrar")').click();
  await page.waitForSelector('.modal textarea');
  const chargeMsg = await page.locator('.modal textarea').last().inputValue();
  check(chargeMsg.includes('Mariana') && chargeMsg.includes('1.194,00') && chargeMsg.includes('parcela 2/2'), 'mensagem de cobrança preenchida');
  await page.locator('.modal button:has-text("Enviar")').last().click();
  await shot(page, '03b-caso-honorarios');
  // prazo / audiência do caso
  await page.click('.modal-case .tab:has-text("Prazos")');
  await page.click('.modal-case button:has-text("Audiência")');
  await page.fill('.modal:not(.modal-case) .field.grow input', 'Audiência de conciliação');
  await page.click('.modal:not(.modal-case) .chip:has-text("Em 3 dias")');
  await page.click('.modal:not(.modal-case) button:has-text("Salvar")');
  await page.waitForSelector('.modal-case .task-title:has-text("Audiência de conciliação")');
  check(true, 'audiência criada no caso');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.msg.out:has-text("parcela 2/2")');
  check(true, 'cobrança enviada aparece na conversa');
  await page.waitForSelector('.crm-panel .case-card:has-text("Plano anual")');
  check(true, 'caso aparece na ficha do contato');

  // etiqueta, nota
  await page.locator('.crm-panel .tag-chip.toggle', { hasText: 'Lead quente' }).click();
  await page.waitForSelector('.crm-panel .tag-chip.toggle.on:has-text("Lead quente")');
  check(true, 'etiqueta aplicada');
  await page.fill('.crm-panel textarea', 'Quer plano anual, decidir até sexta.');
  await page.click('.crm-panel button:has-text("Salvar nota")');
  await page.waitForSelector('.note-text:has-text("plano anual")');
  check(true, 'nota salva');

  // tarefa avulsa
  await page.click('.crm-panel button:has-text("Nova")');
  await page.fill('.modal .field.grow input', 'Ligar para fechar o plano anual');
  await page.click('.modal .chip:has-text("Em 1 hora")');
  await page.click('.modal button:has-text("Salvar")');
  await page.waitForSelector('.crm-panel .task-title:has-text("fechar o plano")');
  check(true, 'tarefa criada');
  await shot(page, '03-chat-crm');

  // 5) mensagem recebida em outra conversa: não lida + reordenação
  await page.waitForTimeout(3500); // deixa chegar a resposta automática do demo à cobrança
  await page.evaluate(() => window.api.call('demo:incoming', '5521991234567', 'Fechado! Pode mandar o contrato.', 'Carlos Pereira'));
  await page.waitForSelector('.chat-row.unread:has-text("Pode mandar o contrato") .badge');
  const first = await page.locator('.chat-row').first().innerText();
  check(first.includes('Carlos Pereira'), 'nova mensagem sobe a conversa e marca como não lida');

  // 6) funil (kanban) com casos, arrastar e soltar
  await page.click('.rail-btn[title="Jurídico"]');
  await page.click('.view-legal .seg:has-text("Processos")');
  await page.waitForSelector('.view-legal .cases-table tbody tr');
  check(true, 'Jurídico lista os processos');
  await page.click('.view-legal button:has-text("Funil")');
  await page.click('.board-head .tab:has-text("Captação")');
  await page.waitForSelector('.col .card');
  await shot(page, '04-board');
  const card = page.locator('.card', { hasText: 'Plano anual' });
  check(await card.count() === 1, 'caso aparece no funil');
  const target = page.locator('.col', { hasText: 'Contratou ✔' });
  await card.dragTo(target);
  await page.waitForSelector('.col:has-text("Contratou ✔") .card:has-text("Plano anual")', { timeout: 5000 });
  check(true, 'caso arrastado para "Contratou ✔"');
  check((await page.locator('.col:has-text("Contratou ✔") .col-total').innerText()).includes('2.388'), 'total da coluna soma os honorários');
  // novo caso pela coluna
  await page.click('.col:has-text("Primeiro contato") .col-add');
  // cliente novo direto do "novo processo"
  await page.fill('.modal input[type=search]', 'Ana Beatriz');
  await page.click('.modal .picker-item:has-text("Cadastrar novo cliente")');
  await page.waitForSelector('.modal .picker-item.active:has-text("Ana Beatriz")');
  await page.fill('.modal .field:has-text("Assunto") input', 'Consulta inventário');
  await page.click('.modal button:has-text("Criar")');
  await page.waitForSelector('.modal-case');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.col:has-text("Primeiro contato") .card:has-text("Consulta inventário")');
  check(true, 'caso criado pela coluna do funil');
  await page.click('.board-head .tab:has-text("Casos em andamento")');
  await page.waitForSelector('.card:has-text("Reclamação trabalhista")');
  check(true, 'caso de exemplo em "Casos em andamento"');
  await shot(page, '05-board-after');

  // 6a) agenda (Google de demonstração)
  await page.click('.rail-btn[title="Agenda"]');
  await page.waitForSelector('.gcard.ok');
  await page.waitForSelector('.tg-event:has-text("Reunião com sócio")');
  check(true, 'agenda mostra os eventos do Google (semana)');
  await page.click('.agenda-side button:has-text("Novo compromisso")');
  await page.click('.modal .seg:has-text("Audiência")');
  await page.fill('.modal .field:has-text("Título") input', 'Audiência Carlos x Transportes');
  await page.selectOption('.modal .field:has-text("Cliente") select', { label: 'Carlos Pereira' });
  await page.click('.modal button:has-text("Salvar")');
  await page.waitForSelector('.tg-event:has-text("Audiência Carlos x Transportes")', { timeout: 8000 });
  check(await page.locator('.tg-event:has-text("Audiência Carlos x Transportes")').count() === 1, 'audiência criada na agenda vai para o Google (sem duplicar)');
  await shot(page, '05a-agenda-semana');
  await page.locator('.cal-item', { hasText: 'Escritório' }).locator('input').uncheck();
  await page.waitForTimeout(300);
  check(await page.locator('.tg-event:has-text("Reunião com sócio")').count() === 0, 'esconder uma agenda some com os eventos dela');
  await page.locator('.cal-item', { hasText: 'Escritório' }).locator('input').check();
  await page.click('.view-agenda .segmented .seg:has-text("Mês")');
  await page.waitForSelector('.mo-grid .ev-chip');
  await shot(page, '05a-agenda-mes');
  check(true, 'visão de mês');
  await page.click('.view-agenda .segmented .seg:has-text("Semana")');
  await page.locator('.tg-event:has-text("Audiência Carlos x Transportes")').click();
  await page.waitForSelector('.modal button:has-text("Carlos Pereira")');
  check(true, 'detalhes do compromisso ligam ao cliente');
  await page.keyboard.press('Escape');

  // 6a2) modo discreto
  await page.click('.rail-btn[title="Atendimento"]');
  await page.keyboard.press('Control+Shift+D');
  await page.waitForSelector('body.discreet');
  const blur = await page.locator('.chat-row .chat-preview').first().evaluate((el) => getComputedStyle(el).filter);
  check(blur.includes('blur'), 'modo discreto embaça as prévias (Ctrl+Shift+D)');
  await page.click('.rail-btn[title="Financeiro"]');
  await page.waitForSelector('.view.active .stat-value');
  check((await page.locator('.view.active .stat-value').first().evaluate((el) => getComputedStyle(el).filter)).includes('blur'), 'modo discreto embaça os valores');
  await shot(page, '05c-modo-discreto');
  await page.click('.rail-btn[title^="Modo discreto"]');
  await page.waitForSelector('body:not(.discreet)');
  check(true, 'botão 🕶 desliga o modo discreto');

  // 6b) financeiro
  await page.click('.rail-btn[title="Financeiro"]');
  await page.waitForSelector('.view.active .stat');
  await page.click('.chips .chip:has-text("Vencidas")');
  await page.waitForSelector('.view.active .table tbody tr:has-text("Carlos Pereira")');
  check(true, 'parcela vencida aparece no Financeiro');
  await shot(page, '05b-financeiro');
  await page.click('.chips .chip:has-text("Pagas")');
  await page.waitForSelector('.view.active .table tbody tr:has-text("Mariana Souza")');
  check(true, 'parcela recebida aparece em Pagas');

  // 7) painel Hoje com o que foi criado até aqui
  await page.click('.rail-btn[title="Hoje"]');
  await page.waitForSelector('.today-grid');
  check(await page.locator('.view-today .stat').count() >= 5, 'painel Hoje com os números do dia (sócio vê o a receber)');
  await page.waitForSelector('.today-group .action-row:has-text("Responder"), .today-group .task', { timeout: 5000 });
  check(true, 'painel Hoje lista as próximas ações');
  await shot(page, '05b-hoje');
  await page.click('.view-today .seg:has-text("Minha semana")');
  await page.waitForSelector('.week-cols .week-col.today');
  await shot(page, '05c-semana');
  check(await page.locator('.week-cols .week-col').count() >= 5, 'semana com os dias úteis');
  await page.click('.view-today .seg:has-text("Meu dia")');
  await page.waitForSelector('.today-grid');

  // 7b) documentos (pasta do OneDrive de exemplo da demonstração)
  await page.click('.rail-btn[title="Documentos"]');
  await page.waitForSelector('.docs-search');
  await page.fill('.docs-search', 'atraso voo guarulhos');
  await page.waitForSelector('.search-hit mark', { timeout: 15000 });
  check((await page.locator('.search-hit').first().innerText()).includes('Guarulhos'), 'busca encontra pelo conteúdo do documento');
  await shot(page, '05d-docs-busca');
  await page.click('.view-docs .seg:has-text("Modelos")');
  await page.waitForSelector('.placeholder-grid');
  check(await page.locator('.view-docs .doc-row').count() >= 4, 'modelos listados por área');
  await shot(page, '05e-docs-modelos');
  // conversa → ficha do cliente → dados → processo → pasta → documento do modelo
  await page.click('.rail-btn[title="Atendimento"]');
  await page.locator('.chat-row', { hasText: 'Carlos Pereira' }).click();
  await page.click('.crm-panel button:has-text("Abrir ficha do cliente")');
  await page.waitForSelector('.view-legal .client-head:has-text("Carlos Pereira")');
  check(true, 'conversa do WhatsApp leva à ficha do cliente');
  await page.click('.view-legal .tab:has-text("Dados")');
  await page.locator('.client-form label:has-text("CPF") input').fill('123.456.789-00');
  await page.click('.view-legal .panel button:has-text("Salvar")');
  await page.waitForSelector('.toast:has-text("Dados salvos")');
  await page.click('.view-legal .tab:has-text("Processos")');
  await shot(page, '05h-ficha-cliente');
  await page.locator('.view-legal .case-card').first().click();
  await page.click('.modal-case .tab:has-text("Documentos")');
  await page.waitForSelector('.modal-case .docs-empty:has-text("CARLOS PEREIRA")');
  check(true, 'reconhece a pasta antiga do cliente no OneDrive');
  await shot(page, '05f-caso-sem-pasta');
  await page.click('.modal-case button:has-text("Criar pasta do caso")');
  await page.waitForSelector('.modal-case .docs-toolbar');
  await page.click('.modal-case button:has-text("Novo do modelo")');
  await page.click('.tpl-item:has-text("PROCURAÇÃO AD JUDICIA")');
  await page.waitForSelector('.modal-case .doc-row:has-text("PROCURAÇÃO AD JUDICIA")', { timeout: 8000 });
  check(true, 'cria a procuração do modelo na pasta do caso');
  await shot(page, '05g-caso-pasta');
  const made = await page.evaluate(() => window.api.call('docs:search', 'procuracao 123.456.789-00'));
  check(made.some((d) => /PROCURAÇÃO AD JUDICIA/.test(d.name)), 'procuração preenchida com o CPF da ficha');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // 7c) cliente sem WhatsApp: cadastro, processo, busca no Jurídico
  await page.click('.rail-btn[title="Jurídico"]');
  if (await page.locator('.view-legal .back-btn').count()) await page.click('.view-legal .back-btn');
  await page.click('.view-legal .page-head button:has-text("＋ Cliente")');
  await page.fill('.modal label:has-text("Nome") input', 'Joana Lima');
  await page.fill('.modal label:has-text("CPF") input', '987.654.321-00');
  await page.click('.modal button:has-text("Cadastrar")');
  await page.waitForSelector('.view-legal .client-head:has-text("Joana Lima")');
  check(await page.locator('.view-legal .client-head button:has-text("Ligar WhatsApp")').count() === 1, 'cliente existe sem WhatsApp (ligar é opcional)');
  await page.click('.view-legal .client-head button:has-text("Processo")');
  await page.fill('.modal label:has-text("Assunto") input', 'Revisional de aluguel');
  await page.fill('.modal label:has-text("Parte contrária") input', 'Imobiliária Centro');
  await page.click('.modal button:has-text("Criar")');
  await page.waitForSelector('.modal-case .case-client:has-text("Joana Lima")');
  check(true, 'processo criado para o cliente, sem conversa');
  // ficha do processo: responsável, partes, fluxo, documentos e andamentos
  await page.locator('.modal-case .field:has-text("Advogado(a) responsável") select').selectOption({ label: 'Rafael Barros' });
  await page.locator('.modal-case .field:has-text("Área") input').fill('Imobiliário');
  await page.locator('.modal-case .field:has-text("Área") input').press('Tab');
  await page.fill('.modal-case .parties input[placeholder="Nome da parte"]', 'Imobiliária Centro Ltda');
  await page.click('.modal-case .parties button:has-text("Adicionar")');
  await page.waitForSelector('.modal-case .parties td:has-text("Imobiliária Centro Ltda")');
  check((await page.locator('.modal-case .case-resp').innerText()).includes('Rafael Barros'), 'responsável aparece no topo da ficha');
  await page.click('.modal-case .tab:has-text("Fluxo")');
  await page.waitForSelector('.modal-case .flow-step.next');
  check(await page.locator('.modal-case .flow-step').count() === 10, 'as 10 etapas do caso');
  await page.click('.modal-case button:has-text("Usar esta lista")');
  await page.waitForSelector('.modal-case .check-row:has-text("Matrícula atualizada")');
  check(true, 'lista de documentos sugerida pela área (imobiliário)');
  await page.click('.modal-case button:has-text("Solicitar selecionados")');
  await page.waitForSelector('.modal textarea');
  check((await page.locator('.modal:not(.modal-case) textarea').inputValue()).includes('Olá, Joana!'), 'pedido de documentos com o nome do cliente');
  await page.click('.modal:not(.modal-case) button:has-text("Copiar e marcar como pedido")');
  await page.waitForSelector('.modal-case .check-row .status-pill:has-text("pedido")');
  await page.locator('.modal-case .check-row', { hasText: 'CPF' }).locator('button:has-text("Recebido")').click();
  await page.click('.modal:not(.modal-case) button:has-text("Marcar como recebido")');
  await page.waitForSelector('.modal-case .check-row.recebido:has-text("CPF")');
  check(true, 'documento pedido e depois marcado como recebido');
  await shot(page, '05j-processo-fluxo');
  await page.click('.modal-case .tab:has-text("Andamentos")');
  await page.fill('.modal-case textarea', 'Citação expedida');
  await page.click('.modal-case button:has-text("Registrar andamento")');
  await page.waitForSelector('.modal-case .tl-item:has-text("Citação expedida")');
  check(true, 'andamento registrado na linha do tempo');
  const lembrete = await page.evaluate(() => window.api.call('tasks:list', {}));
  check(lembrete.some((t) => /Conferir documentos pedidos — Joana Lima/.test(t.title)), 'lembrete para conferir os documentos pedidos');
  await page.keyboard.press('Escape');
  await page.click('.view-legal .back-btn');
  await page.click('.view-legal .seg:has-text("Processos")');
  await page.fill('.legal-search', 'imobiliária');
  await page.waitForFunction(() => document.querySelectorAll('.cases-table tbody tr').length === 1);
  check((await page.locator('.cases-table tbody tr').innerText()).includes('Joana Lima'), 'busca de processos pela parte contrária');
  await shot(page, '05i-juridico-processos');

  // outras telas
  await page.click('.rail-btn[title="Atendimento"]');
  await page.click('.chatlist-head button[title^="Contatos do WhatsApp"]');
  await page.waitForSelector('.view.active .table tbody tr');
  await shot(page, '06-contacts');
  check(await page.locator('.view.active .table tbody tr').count() >= 5, 'tabela de contatos');
  await page.click('.rail-btn[title="Agenda"]');
  await page.click('.view-agenda .seg:has-text("Lista")');
  await page.waitForSelector('.task-group .task');
  await shot(page, '07-tasks');
  check(true, 'tela de tarefas');
  await page.click('.rail-btn[title="Relatórios"]');
  await page.waitForSelector('.view.active .stat');
  await shot(page, '08-dashboard');
  await page.click('.rail-btn[title="Configurações"]');
  await page.waitForSelector('.settings-grid');
  await shot(page, '09-settings');
  await page.click('.settings-grid button:has-text("Testar conexão")');
  await page.waitForSelector('.modal .diag-step', { timeout: 40000 });
  await shot(page, '09b-diagnostico');
  await page.click('.modal button:has-text("Fechar")');
  check(true, 'teste de conexão mostra o resultado passo a passo');
  check(true, 'painel e configurações');
  check(await page.locator('.settings-grid .list-row', { hasText: 'Cliente' }).locator('text=baixa arquivos').count() === 1,
    'tipo Cliente baixa arquivos automaticamente');

  // tema claro
  await page.selectOption('.settings-grid select', 'light');
  await page.click('.rail-btn[title="Atendimento"]');
  await page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await page.waitForSelector('.msg');
  await shot(page, '10-light');
  await page.click('.rail-btn[title="Configurações"]');
  await page.selectOption('.settings-grid select', 'dark');
  await page.click('.rail-btn[title="Atendimento"]');
  await page.waitForTimeout(300);
  await shot(page, '12-dark');

  // 8) nova conversa por número
  await page.click('.rail-btn[title="Atendimento"]');
  await page.click('.chatlist-head button[title^="Nova conversa"]');
  await page.fill('.modal input >> nth=0', '(11) 91234-5678');
  await page.fill('.modal input >> nth=1', 'Paulo Novo');
  await page.click('.modal button:has-text("Abrir conversa")');
  await page.waitForSelector('.chat-head-name:has-text("Paulo Novo")');
  check(true, 'nova conversa aberta pelo número');

  // 8b) equipe: o sócio cadastra a estagiária; ela entra e não vê o financeiro
  await page.click('.rail-btn[title="Configurações"]');
  await page.click('.settings-grid button:has-text("Adicionar pessoa")');
  const form = page.locator('.modal');
  await form.locator('label:has-text("Nome") input').fill('Isabella Costa');
  await form.locator('label:has-text("Login") input').fill('isabella');
  await form.locator('label:has-text("Perfil") select').selectOption('estagiario');
  await form.locator('label:has-text("Senha inicial") input').fill('estagio1');
  await form.locator('button:has-text("Salvar")').click();
  await page.waitForSelector('.settings-grid .list-row:has-text("Isabella Costa")');
  check(true, 'sócio cadastra a estagiária na equipe');
  await shot(page, '15-equipe');
  const est = await newPage(app.url);
  await login(est.page, { login: 'isabella', password: 'estagio1' });
  await est.page.waitForSelector('.view-today .stats');
  check(await est.page.locator('.view-today .stat:has-text("A receber")').count() === 0, 'painel da estagiária sem valores');
  await est.page.click('.rail-btn[title="Atendimento"]');
  await est.page.waitForSelector('.chat-row');
  check(await est.page.locator('.rail-btn[title="Financeiro"]').count() === 0, 'estagiária não vê o Financeiro');
  const denied = await est.page.evaluate(() => window.api.call('finance:list').then(() => 'ok', (e) => e.message));
  check(/permissão/.test(denied), 'servidor recusa o financeiro para a estagiária');
  await page.click('.rail-btn[title="Atendimento"]');
  await page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await est.page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await page.waitForSelector('.team-presence:has-text("Isabella Costa")', { timeout: 8000 });
  check(true, 'sócio vê que a estagiária está com a mesma conversa aberta');
  await est.page.fill('.composer-input', 'Bom dia, Mariana!');
  await page.waitForSelector('.team-presence:has-text("está respondendo")', { timeout: 8000 });
  check(true, 'aviso "está respondendo" para não responderem em dobro');
  await est.page.keyboard.press('Enter');
  await page.waitForSelector('.msg.out:has-text("Isabella:")', { timeout: 8000 });
  check(true, 'mensagem da estagiária aparece assinada para o sócio');
  await shot(est.page, '16-estagiaria');
  await est.context.close();
} catch (e) {
  await shot(page, 'zz-failure').catch(() => {});
  await app.close();
  console.error(e);
  console.error(errors.join('\n'));
  process.exit(1);
}
await app.close();

// 9) reabre: deve entrar direto (sessão salva), com tudo guardado
({ app, page } = await launch());
try {
  await page.click('.rail-btn[title="Atendimento"]');
  await page.waitForSelector('.chat-row', { timeout: 15000 });
  const overlayVisible = await page.locator('.connect-overlay:not(.hidden)').count();
  check(overlayVisible === 0, 'ao reabrir, entra direto sem pedir QR code');
  await page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await page.waitForSelector('.msg.out:has-text("10% mais barato")');
  check(true, 'mensagens continuam armazenadas após reabrir');
  await page.waitForSelector('.chat-head .stage-btn:has-text("Contratou")');
  check(true, 'caso e etapa continuam salvos');
  await page.waitForSelector('.chat-head .stage-btn:has-text("Cliente")');
  check(true, 'classificação continua salva');
  await shot(page, '11-reopen');
} catch (e) {
  await shot(page, 'zz-failure-reopen').catch(() => {});
  await app.close();
  console.error(e);
  console.error(errors.join('\n'));
  process.exit(1);
}
await app.close();

// 10) conexão pelo número de telefone (código de pareamento)
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-e2e-pair-'));
({ app, page } = await launch({ CRM_DEMO_QR_MS: '0' }, dir2));
try {
  await page.click('.rail-btn[title="Atendimento"]');
  await page.waitForSelector('.connect-overlay:not(.hidden) img.qr', { timeout: 15000 });
  await page.click('.connect-tabs .tab:has-text("número")');
  await page.fill('.connect-overlay input', '11 98765-4321');
  await page.click('.connect-overlay button:has-text("Gerar código")');
  await page.waitForSelector('.pairing-code:has-text("DEMO-1234")');
  await shot(page, '13-pairing');
  check(true, 'mostra código de pareamento pelo número');
  await page.waitForSelector('.connect-overlay.hidden', { state: 'attached', timeout: 10000 });
  await page.click('.rail-btn[title="Atendimento"]');
  await page.waitForSelector('.chat-row');
  check(true, 'conecta após digitar o código no celular');
  // sessão recusada pelo WhatsApp → botão para ler o QR code de novo
  await page.evaluate(() => window.api.call('demo:simulateStuck'));
  await page.waitForSelector('.banner button:has-text("Conectar de novo")');
  await shot(page, '14-conectar-de-novo');
  await page.click('.banner button:has-text("Conectar de novo")');
  await page.click('.modal button:has-text("Mostrar QR code")');
  await page.waitForSelector('.connect-overlay:not(.hidden) img.qr', { timeout: 10000 });
  check(true, 'botão "Conectar de novo" volta para o QR code');
  check(await page.locator('.chat-row').count() > 0, 'conversas continuam salvas');
} catch (e) {
  await shot(page, 'zz-failure-pair').catch(() => {});
  await app.close();
  console.error(e);
  console.error(errors.join('\n'));
  process.exit(1);
}
await app.close();
fs.rmSync(dir2, { recursive: true, force: true });
await browser.close();

const relevant = errors.filter((e) => !/Autofill|DevTools|favicon/i.test(e));
if (relevant.length) {
  console.error('Erros no console:\n' + relevant.join('\n'));
  process.exit(1);
}
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('\nTodos os testes passaram. Capturas em test-results/');
