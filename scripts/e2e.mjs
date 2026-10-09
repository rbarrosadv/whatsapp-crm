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

/** Certificado de teste e assinatura CMS destacada (o que o Windows faz com o token A3). */
function makeTestCert() {
  const forge = createRequire(import.meta.url)('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 365 * 864e5);
  cert.setSubject([{ name: 'commonName', value: 'RAFAEL TESTE' }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC Teste' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    sign(data) {
      const p7 = forge.pkcs7.createSignedData();
      p7.content = forge.util.createBuffer(data.toString('binary'));
      p7.addCertificate(cert);
      p7.addSigner({ key: keys.privateKey, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
        authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest }, { type: forge.pki.oids.signingTime, value: new Date() }] });
      p7.sign({ detached: true });
      return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
    },
  };
}

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

  // busca dentro das mensagens: clicar no resultado abre a conversa no ponto da mensagem
  await page.locator('.chat-row', { hasText: 'Ana Beatriz' }).click();
  await page.waitForSelector('.chat-head:has-text("Ana Beatriz")');
  await page.fill('input.search', 'anúncio');
  await page.locator('.chat-row.search-hit', { hasText: 'Mariana Souza' }).first().click();
  await page.waitForSelector('.chat-head:has-text("Mariana Souza")');
  await page.locator('.msg', { hasText: 'Vi o anúncio de vocês' }).locator('mark.found').waitFor({ timeout: 5000 });
  check(true, 'resultado da busca abre a conversa na mensagem encontrada (com a palavra destacada)');
  // conversa longa: mensagem antiga encontrada → abre lá e oferece voltar às mais recentes
  await page.evaluate(async () => {
    await window.api.call('demo:incoming', '5511977776666', 'Protocolo XPTO-4471 do pedido', 'Cliente Antigo');
    for (let i = 1; i <= 130; i++) await window.api.call('demo:incoming', '5511977776666', `atualização número ${i}`, 'Cliente Antigo');
  });
  await page.fill('input.search', 'XPTO-4471');
  await page.locator('.chat-row.search-hit', { hasText: 'Cliente Antigo' }).first().click();
  await page.locator('.msg', { hasText: 'Protocolo XPTO-4471' }).locator('mark.found').waitFor({ timeout: 5000 });
  // innerText separa o texto do horário (no textContent, "número 13" + "01:26" viraria "1301:26")
  check(!(await page.evaluate(() => [...document.querySelectorAll('.msg')].some((m) => /número 130(?!\d)/.test(m.innerText)))), 'mensagem antiga: abre lá, sem carregar a conversa inteira');
  await page.waitForSelector('.new-msgs-btn:not(.hidden):has-text("mais recentes")');
  await shot(page, '03-busca-mensagem-antiga');
  await page.click('.new-msgs-btn');
  await page.waitForFunction(() => [...document.querySelectorAll('.msg')].some((m) => /número 130(?!\d)/.test(m.innerText)));
  check(true, '"Ir para as mensagens mais recentes" volta ao fim da conversa');
  await page.fill('input.search', '');
  await page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await page.waitForSelector('.chat-head:has-text("Mariana Souza")');

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
  await page.locator('.popup-item', { hasText: 'Documentação' }).click();
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
  await page.locator('.modal:not(.modal-case) .field:has-text("Forma") select').selectOption('pix');
  await page.click('.modal:not(.modal-case) button:has-text("Registrar e emitir recibo")');
  await page.waitForSelector('.modal iframe.receipt-frame');
  const receipt = await page.locator('.modal iframe.receipt-frame').evaluate((f) => f.contentDocument.body.innerText);
  check(/RECIBO/.test(receipt) && /mil cento e noventa e quatro reais/.test(receipt) && /Pix/.test(receipt), 'recibo com valor por extenso e forma de pagamento');
  await shot(page, '04c-recibo');
  const [pdfDl] = await Promise.all([page.waitForEvent('download'), page.click('.modal:has(iframe.receipt-frame) button:has-text("Baixar PDF")')]);
  check(/^Recibo \d{4} - Mariana Souza\.pdf$/.test(pdfDl.suggestedFilename())
    && fs.readFileSync(await pdfDl.path()).subarray(0, 5).toString() === '%PDF-', 'recibo baixado em PDF');
  await page.click('.modal:has(iframe.receipt-frame) button:has-text("Enviar pelo WhatsApp")');
  await page.click('.modal:has-text("Enviar recibo a") button:has-text("Enviar")');
  await page.waitForSelector('.toast:has-text("Recibo enviado a Mariana Souza")');
  check(true, 'recibo em PDF enviado pelo WhatsApp');
  await page.click('.modal:has(iframe.receipt-frame) button:has-text("Fechar")');
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
  await page.locator('.crm-panel .tag-chip.toggle', { hasText: 'Urgente' }).click();
  await page.waitForSelector('.crm-panel .tag-chip.toggle.on:has-text("Urgente")');
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
  await page.click('.board-head .tab:has-text("Casos em andamento")');
  await page.waitForSelector('.col .card');
  await shot(page, '04-board');
  const card = page.locator('.card', { hasText: 'Plano anual' });
  check(await card.count() === 1, 'caso aparece no funil');
  const target = page.locator('.col').filter({ has: page.locator('.col-title', { hasText: /^Protocolo \/ Petição\d*$/ }) });
  await card.dragTo(target);
  await target.locator('.card:has-text("Plano anual")').waitFor({ timeout: 5000 });
  check(true, 'caso arrastado para "Protocolo / Petição"');
  check((await target.locator('.col-total').innerText()).includes('2.388'), 'total da coluna soma os honorários');
  // novo caso pela coluna
  await page.click('.col:has-text("Documentação") .col-add');
  // cliente novo direto do "novo processo"
  await page.fill('.modal input[type=search]', 'Ana Beatriz');
  await page.click('.modal .picker-item:has-text("Cadastrar novo cliente")');
  await page.waitForSelector('.modal .picker-item.active:has-text("Ana Beatriz")');
  await page.fill('.modal .field:has-text("Assunto") input', 'Consulta inventário');
  await page.click('.modal button:has-text("Criar")');
  await page.waitForSelector('.modal-case');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.col:has-text("Documentação") .card:has-text("Consulta inventário")');
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
  // horário fixo no meio do dia (perto da meia-noite o evento ocuparia dois dias da semana)
  const slot = await page.evaluate(() => { const d = new Date(); d.setHours(11, 0, 0, 0); const p = (n) => String(n).padStart(2, '0'); return [`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T11:00`, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T12:00`]; });
  await page.locator('.modal input[type="datetime-local"]').nth(0).fill(slot[0]);
  await page.locator('.modal input[type="datetime-local"]').nth(1).fill(slot[1]);
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

  // 6b) financeiro: painel, despesas, fluxo de caixa, inadimplência
  await page.click('.rail-btn[title="Financeiro"]');
  await page.waitForSelector('.view-page.active .fin-grid .viz-svg');
  check(await page.locator('.view.active .viz-svg path.viz-mark').count() > 0, 'painel do financeiro com o gráfico de 12 meses');
  check((await page.locator('.view.active .fin-alert').allInnerTexts()).some((t) => /vencida/.test(t)), 'destaque das parcelas vencidas no painel');
  await page.locator('.view.active .viz-hit').last().hover();
  await page.waitForSelector('.view.active .viz-tip.on');
  check((await page.locator('.view.active .viz-tip').innerText()).includes('Entradas'), 'valor ao passar o mouse no gráfico');
  await shot(page, '05a-financeiro-painel');
  await page.click('.view.active .page-head button:has-text("Despesa")');
  await page.fill('.modal label:has-text("Descrição") input', 'Aluguel da sala');
  await page.locator('.modal label:has-text("Categoria") select').selectOption('Aluguel');
  await page.fill('.modal label:has-text("Valor") input', '2.500,00');
  await page.locator('.modal label:has-text("Conta fixa") select').selectOption('3');
  await page.click('.modal button:has-text("Salvar")');
  await page.click('.view.active .seg:has-text("A pagar")');
  await page.waitForSelector('.view.active .table tbody tr:has-text("Aluguel da sala")');
  check(await page.locator('.view.active .table tbody tr:has-text("Aluguel da sala")').count() === 3, 'conta fixa lançada para 3 meses');
  await page.locator('.view.active .table tbody tr:has-text("Aluguel da sala")').first().locator('button:has-text("Paguei")').click();
  await page.click('.view.active .seg:has-text("Fluxo de caixa")');
  await page.waitForSelector('.view.active .table tbody tr:has-text("Aluguel da sala")');
  check(true, 'despesa paga entra no fluxo de caixa');
  // receita avulsa (sem processo), com recibo
  await page.click('.view.active .page-head button:has-text("Receita")');
  await page.fill('.modal .field:has-text("Quem pagou") input', 'João Avulso');
  await page.fill('.modal label:has-text("Descrição") input', 'Consulta sobre inventário');
  await page.fill('.modal label:has-text("Valor") input', '350,00');
  await page.click('.modal button:has-text("Salvar e emitir recibo")');
  await page.waitForSelector('.modal iframe.receipt-frame');
  const rec2 = await page.locator('.modal iframe.receipt-frame').evaluate((f) => f.contentDocument.body.innerText);
  check(/João Avulso/.test(rec2) && /trezentos e cinquenta reais/.test(rec2), 'receita avulsa com recibo');
  await page.click('.modal:has(iframe.receipt-frame) button:has-text("Fechar")');
  await page.waitForSelector('.view.active .table tbody tr:has-text("Consulta sobre inventário")');
  check(true, 'receita avulsa entra no fluxo de caixa');
  await shot(page, '05m-fluxo-caixa');

  // recibo assinado com certificado A3 (o app de desktop é simulado; o "token" assina com node-forge)
  const testCert = makeTestCert();
  await page.exposeFunction('__signCms', (b64) => testCert.sign(Buffer.from(b64, 'base64')).toString('base64'));
  await page.addInitScript(() => {
    let chosen = null;
    window.desktop = { certs: {
      list: async () => [{ thumb: 'A'.repeat(40), name: 'RAFAEL TESTE', issuer: 'AC Teste', icp: true, validTo: Date.now() + 300 * 864e5 }],
      get: async () => chosen || JSON.parse(localStorage.getItem('__a3') || 'null'),
      choose: async (c) => { chosen = c; localStorage.setItem('__a3', JSON.stringify(c)); return c; },
      sign: (b64) => window.__signCms(b64),
    } };
  });
  await page.reload();
  await page.click('.rail-btn[title="Configurações"]');
  await page.locator('.receipts-cfg select').selectOption('a3');
  await page.click('.receipts-cfg button:has-text("Escolher certificado deste computador")');
  await page.click('.modal .picker-item:has-text("RAFAEL TESTE")');
  await page.waitForSelector('.receipts-cfg .cert-box:has-text("RAFAEL TESTE")');
  await shot(page, '05n-recibo-a3');
  await page.click('.rail-btn[title="Financeiro"]');
  await page.click('.view.active .seg:has-text("Fluxo de caixa")');
  await page.locator('.view.active .table tbody tr:has-text("Consulta sobre inventário")').locator('button[title="Recibo"]').click();
  const [signedDl] = await Promise.all([page.waitForEvent('download'), page.click('.modal:has(iframe.receipt-frame) button:has-text("Baixar PDF")')]);
  const signedPdf = fs.readFileSync(await signedDl.path()).toString('latin1');
  check(/\/ByteRange \[0 \d+ \d+ \d+\]/.test(signedPdf) && /adbe\.pkcs7\.detached/.test(signedPdf) && /RAFAEL TESTE/.test(signedPdf), 'recibo assinado com o certificado A3 do computador');
  await page.click('.modal:has(iframe.receipt-frame) button:has-text("Fechar")');
  await page.click('.rail-btn[title="Configurações"]');
  await page.locator('.receipts-cfg select').selectOption('none');
  await page.click('.rail-btn[title="Financeiro"]');
  await page.click('.view.active .seg:has-text("Inadimplência")');
  await page.waitForSelector('.view.active .table tbody tr:has-text("Carlos Pereira")');
  check(true, 'inadimplência por cliente');
  await page.click('.view.active .seg:has-text("A receber")');
  await page.click('.chips .chip:has-text("Vencidas")');
  await page.waitForSelector('.view.active .table tbody tr:has-text("Carlos Pereira")');
  check(true, 'parcela vencida aparece no Financeiro');
  await shot(page, '05b-financeiro');
  await page.click('.chips .chip:has-text("Pagas")');
  await page.waitForSelector('.view.active .table tbody tr:has-text("Mariana Souza")');
  check(true, 'parcela recebida aparece em Pagas');

  // 7) painel Hoje com o que foi criado até aqui (e uma audiência que já aconteceu)
  await page.evaluate(() => window.api.call('tasks:save', { title: 'Audiência de instrução (ontem)', kind: 'audiencia', due_at: Date.now() - 26 * 3600e3 }));
  await page.click('.rail-btn[title="Hoje"]');
  await page.waitForSelector('.today-grid');
  check(await page.locator('.view-today .stat').count() >= 5, 'painel Hoje com os números do dia (sócio vê o a receber)');
  await page.waitForSelector('.today-group .action-row:has-text("Responder"), .today-group .task', { timeout: 5000 });
  check(true, 'painel Hoje lista as próximas ações');
  await shot(page, '05b-hoje');
  const hearingRow = page.locator('.today-group:has-text("Audiências realizadas") .action-row:has-text("Audiência de instrução (ontem)")');
  await hearingRow.waitFor();
  await hearingRow.locator('button:has-text("Agendar prazo")').click();
  check((await page.locator('.modal select').first().inputValue()) === 'prazo', 'depois da audiência: agendar prazo já abre como prazo');
  await page.click('.modal button:has-text("Cancelar")');
  await hearingRow.locator('button:has-text("Feito")').click();
  await hearingRow.waitFor({ state: 'detached' });
  check(true, 'audiência realizada sai da lista ao marcar Feito');
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
  // PDF escaneado: depois do OCR a busca acha pelo texto da imagem; "Ver" abre o PDF na tela
  await page.evaluate(() => window.api.call('docs:ocrNow'));
  await page.fill('.docs-search', 'energisa consumo kwh');
  await page.waitForSelector('.search-hit:has-text("Comprovante de residência")', { timeout: 15000 });
  check(true, 'busca acha o PDF escaneado pelo conteúdo (OCR)');
  await page.locator('.search-hit:has-text("Comprovante de residência") button:has-text("Ver")').click();
  await page.waitForSelector('.modal-preview iframe.doc-frame');
  const pdfOk = await page.evaluate(async () => { const f = document.querySelector('.modal-preview iframe.doc-frame'); const r = await fetch(f.src); return r.status === 200 && r.headers.get('content-type') === 'application/pdf'; });
  check(pdfOk, 'PDF abre dentro do sistema (sem baixar)');
  await page.waitForTimeout(2500);
  await shot(page, '05d2-ver-pdf');
  await page.keyboard.press('Escape');
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
  // endereço pelo CEP e qualificação pronta
  await page.locator('.client-sec label:has-text("CEP") input').fill('78043-306');
  await page.waitForFunction(() => [...document.querySelectorAll('.client-sec input')].some((i) => i.value.includes('Rubens de Mendonça')));
  check(true, 'CEP preenche rua, bairro e cidade');
  await page.locator('.client-sec input[placeholder="nº ou s/n"]').fill('1500');
  await page.locator('.client-sec label:has-text("Sexo") select').selectOption('m');
  await page.locator('.client-sec label:has-text("Estado civil") select').selectOption('casado');
  await page.locator('.client-sec label:has-text("Profissão") input').fill('Motorista');
  await page.waitForSelector('.qualif-text:has-text("CARLOS PEREIRA, brasileiro, casado, motorista")');
  check(await page.locator('.qualif-text:has-text("residente e domiciliado na Avenida Historiador Rubens de Mendonça, nº 1500, Bairro Bosque da Saúde, Cuiabá/MT")').count() === 1, 'qualificação pronta com o endereço completo');
  await shot(page, '05i-ficha-dados');
  await page.click('.view-legal .panel button:has-text("Salvar")');
  await page.waitForSelector('.toast:has-text("Dados salvos")');
  const qv = await page.evaluate(() => window.api.call('clients:list', { q: 'Carlos Pereira' }));
  check(/^Avenida Historiador Rubens de Mendonça, nº 1500/.test(qv[0]?.address || ''), 'endereço salvo em campos e em uma linha');
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
  // abre para ver dentro do sistema (sem baixar), já preenchida
  await page.waitForSelector('.modal-preview .doc-page:has-text("CARLOS PEREIRA")', { timeout: 8000 });
  check(true, 'documento novo aparece dentro do sistema, sem baixar');
  await shot(page, '05g2-ver-documento');
  await page.click('.modal-preview .modal-actions button:has-text("Fechar")');
  await shot(page, '05g-caso-pasta');
  const made = await page.evaluate(() => window.api.call('docs:search', 'procuracao 123.456.789-00'));
  check(made.some((d) => /PROCURAÇÃO AD JUDICIA/.test(d.name)), 'procuração preenchida com o CPF da ficha');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // Documentos → Recentes mostra o que acabou de ser criado
  await page.click('.rail-btn[title="Documentos"]');
  await page.click('.view-docs .seg:has-text("Recentes")');
  await page.waitForSelector('.view-docs .recent-list .doc-row:has-text("PROCURAÇÃO AD JUDICIA")');
  const firstRecent = await page.locator('.view-docs .recent-list .doc-row').first().innerText();
  check(firstRecent.includes('criado'), `Recentes: o documento criado aparece primeiro (${firstRecent.replace(/\s+/g, ' ')})`);
  await page.locator('.view-docs .recent-list .doc-row').first().locator('button:has-text("Ver")').click();
  await page.waitForSelector('.modal-preview .doc-page');
  await page.keyboard.press('Escape');
  await page.click('.view-docs .seg:has-text("Buscar")');

  // 7c) cliente sem WhatsApp: cadastro, processo, busca no Jurídico
  await page.click('.rail-btn[title="Jurídico"]');
  if (await page.locator('.view-legal .back-btn').count()) await page.click('.view-legal .back-btn');
  await page.click('.view-legal .page-head button:text-is("Cliente")');
  await page.fill('.modal label:has-text("Nome") input', 'Joana Lima');
  await page.fill('.modal label:has-text("CPF") input', '987.654.321-00');
  await page.click('.modal button:has-text("Cadastrar")');
  await page.waitForSelector('.view-legal .client-head:has-text("Joana Lima")');
  check(await page.locator('.view-legal .client-head button:has-text("Ligar WhatsApp")').count() === 1, 'cliente existe sem WhatsApp (ligar é opcional)');
  // empresa pelo CNPJ (Receita) e aviso de cliente repetido
  await page.click('.view-legal .back-btn');
  await page.click('.view-legal .page-head button:text-is("Cliente")');
  await page.fill('.modal label:has-text("Nome") input', 'joana lima');
  await page.waitForSelector('.modal .dup-box:has-text("Joana Lima")');
  check(true, 'avisa que o cliente pode já existir');
  await page.fill('.modal label:has-text("Nome") input', '');
  await page.fill('.modal label:has-text("CPF") input', '12.345.678/0001-90');
  await page.waitForFunction(() => document.querySelector('.modal label input')?.value === 'PAPELARIA NOBRE COMERCIO LTDA');
  check(true, 'CNPJ traz a razão social da Receita');
  await page.click('.modal button:has-text("Cadastrar")');
  await page.waitForSelector('.view-legal .client-head:has-text("PAPELARIA NOBRE")');
  await page.waitForSelector('.qualif-text:has-text("PAPELARIA NOBRE COMERCIO LTDA, nome fantasia Papel Nobre, pessoa jurídica de direito privado")');
  check(await page.locator('.qualif-text:has-text("neste ato representada por seu(sua) sócio-administrador, MARIA DAS GRACAS NOBRE")').count() === 1
    || await page.locator('.qualif-text:has-text("MARIA DAS GRACAS NOBRE")').count() === 1, 'empresa com sede e representante da Receita');
  await shot(page, '05j-ficha-empresa');
  await page.click('.view-legal .back-btn');
  await page.locator('.view-legal .clients-table tr', { hasText: 'Joana Lima' }).first().click().catch(async () => {
    await page.fill('.view-legal .page-head input', 'Joana Lima');
    await page.locator('.view-legal tr', { hasText: 'Joana Lima' }).first().click();
  });
  await page.waitForSelector('.view-legal .client-head:has-text("Joana Lima")');
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
  // visão por cliente: cliente → processos dele → processo (fase, o que fazer agora, linha do tempo)
  await page.evaluate(async () => {
    const k = (await window.api.call('cases:list', {})).find((x) => x.title === 'Revisional de aluguel');
    await window.api.call('cases:save', { id: k.id, process_number: '1001234-55.2026.8.11.0041' });
    const d = (n) => Date.now() - n * 864e5;
    await window.api.call('moves:add', { case_id: k.id, ts: d(6), text: 'Distribuído por sorteio' });
    await window.api.call('moves:add', { case_id: k.id, ts: d(5), text: 'Juntada de petição' });
    await window.api.call('moves:add', { case_id: k.id, ts: d(4), text: 'Conclusos para despacho' });
    await window.api.call('moves:add', { case_id: k.id, ts: d(1), text: 'Sentença — julgado procedente o pedido de revisão do aluguel' });
  });
  await page.fill('.legal-search', '');
  await page.click('.view-legal .seg:has-text("Por cliente")');
  await page.fill('.lv-search', 'Joana');
  await page.click('.lv-client:has-text("Joana Lima")');
  await page.click('.lv-c2 .lv-card:has-text("Revisional de aluguel")');
  await page.waitForSelector('.lv-c3 .cp-step.cur:has-text("Sentença")');
  check(true, 'fase deduzida dos andamentos (sentença) na régua');
  check(await page.locator('.lv-c3 .cp-routine').count() === 1, 'movimentos de rotina ficam recolhidos');
  await page.locator('.lv-c3 .cp-item.big', { hasText: 'Sentença' }).locator('button:has-text("Explicar ao cliente")').click();
  await page.waitForSelector('.lv-c3 .cp-explain textarea');
  check((await page.locator('.lv-c3 .cp-explain textarea').inputValue()).includes('Joana'), 'explicar ao cliente: mensagem pronta com o nome');
  await shot(page, '05l-juridico-por-cliente');
  await page.click('.lv-c3 .cp-explain button:has-text("Avisei por outro meio")');
  await page.waitForSelector('.lv-c3 .cp-sent');
  check(true, 'andamento marcado como "cliente avisado"');
  await page.click('.lv-c3 button:has-text("Mudar fase")');
  await page.click('.popup-menu button:has-text("Recurso")');
  await page.waitForSelector('.lv-c3 .cp-step.cur:has-text("Recurso")');
  check(true, 'fase mudada à mão');
  // quadro por fase: arrastar muda a fase
  await page.click('.view-legal .seg:has-text("Quadro por fase")');
  await page.waitForSelector('.lv-bcol[data-phase="recurso"] .lv-card:has-text("Revisional de aluguel")');
  await page.dragAndDrop('.lv-bcol[data-phase="recurso"] .lv-card:has-text("Revisional de aluguel")', '.lv-bcol[data-phase="transito"] .lv-bscroll');
  await page.waitForSelector('.lv-bcol[data-phase="transito"] .lv-card:has-text("Revisional de aluguel")');
  check(true, 'quadro por fase: arrastar o cartão muda a fase');
  await shot(page, '05m-quadro-fases');
  // ficha do processo: aba Visão geral (mesma régua e linha do tempo)
  await page.locator('.lv-bcol[data-phase="transito"] .lv-card:has-text("Revisional de aluguel")').click();
  await page.waitForSelector('.modal-case .tab.active:has-text("Visão geral")');
  await page.waitForSelector('.modal-case .cp-step.cur:has-text("Trânsito em julgado")');
  check(true, 'ficha do processo abre na Visão geral com a fase');
  await shot(page, '05m2-ficha-visao-geral');
  await page.keyboard.press('Escape');
  // celular: uma coluna por vez (cliente → processos → processo)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.view-legal .seg:has-text("Por cliente")');
  await page.fill('.lv-search', 'Joana');
  await page.click('.lv-client:has-text("Joana Lima")');
  await page.click('.lv-c2 .lv-card:has-text("Revisional de aluguel")');
  await page.waitForSelector('.lv-c3 .cp-ruler');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= 392), 'celular: processo em uma coluna, sem rolar de lado');
  await shot(page, '05m3-celular-processo');
  await page.setViewportSize({ width: 1400, height: 860 });
  // atividade da equipe
  await page.click('.view-legal .seg:has-text("Atividade")');
  await page.waitForSelector('.lv-feed-row:has-text("Trânsito em julgado")');
  check(await page.locator('.lv-feed-row:has-text("cliente avisado")').count() >= 1, 'atividade da equipe: quem fez o quê');
  await shot(page, '05n-atividade');
  // devolve o processo sem nº (as intimações de demonstração usam os primeiros processos com nº)
  await page.evaluate(async () => {
    const k = (await window.api.call('cases:list', {})).find((x) => x.title === 'Revisional de aluguel');
    await window.api.call('cases:save', { id: k.id, process_number: '' });
  });
  await page.click('.view-legal .seg:has-text("Lista de processos")');
  // cadastros repetidos: marcados na lista; "Juntar" deixa um só, com o processo
  await page.evaluate(async () => {
    const id1 = await window.api.call('clients:save', { name: 'Elvira Maria Palma', cpf: '293.355.071-72' });
    const id2 = await window.api.call('clients:save', { name: 'ELVIRA MARIA PALMA', cpf: '293.355.071-72' });
    await window.api.call('cases:save', { client_id: id2, title: 'Revisão de aposentadoria' });
    return [id1, id2];
  });
  await page.click('.view-legal .seg:has-text("Por cliente")');
  await page.fill('.lv-search', 'elvira');
  await page.waitForFunction(() => document.querySelectorAll('.lv-client .dup-pill').length === 2);
  check(true, 'cadastros repetidos aparecem marcados');
  await page.locator('.lv-client', { hasText: 'Elvira' }).first().click();
  await page.locator('.lv-c2 .dup-btn').click();
  await page.waitForSelector('.modal .radio-row');
  await shot(page, '05k-juntar-cadastros');
  await page.click('.modal button:text-is("Juntar")');
  await page.click('.modal button:text-is("Juntar") >> nth=-1');
  await page.waitForSelector('.view-legal .client-head:has-text("ELVIRA MARIA PALMA")');
  const elvira = await page.evaluate(() => window.api.call('clients:list', { q: 'elvira' }));
  check(elvira.length === 1 && elvira[0].cases_open === 1, 'juntar deixa um cadastro só, com o processo');
  await page.click('.view-legal .back-btn');

  // 7d) intimações: cadastrar OAB, buscar no DJEN (simulado), criar prazo, cadastrar processo encontrado
  await page.click('.view-legal .seg:has-text("Intimações")');
  await page.click('.view-legal button:has-text("Cadastrar OAB")');
  await page.fill('.modal label:has-text("Advogado(a)") input', 'Rafael Augusto de Barros Correa');
  await page.fill('.modal label:has-text("Número da OAB") input', '14.271');
  await page.click('.modal button:has-text("Salvar")');
  await page.waitForSelector('.oab-row:has-text("OAB 14.271/MT")');
  check(true, 'OAB cadastrada (14.271/MT)');
  await page.click('.view-legal button:has-text("Buscar agora")');
  await page.waitForSelector('.intim.intim-nova', { timeout: 15000 });
  check(await page.locator('.intim.intim-nova').count() >= 2, 'intimações do DJEN para conferir');
  await shot(page, '05k-intimacoes');
  await page.locator('.notify-who select').selectOption('all');
  await page.waitForFunction(() => document.querySelector('.notify-who select')?.value === 'all');
  check(await page.evaluate(() => window.api.call('settings:get').then((s) => s.courtsNotifyAll === true)), 'intimações: opção de avisar toda a equipe');
  await page.locator('.notify-who select').selectOption('mine');
  await page.locator('.hist-panel select').selectOption('6');
  await page.click('.hist-panel button:has-text("Buscar meus processos")');
  await page.waitForSelector('.hist-panel:has-text("Última busca")', { timeout: 20000 });
  check(true, 'buscar meus processos no DJEN (6 meses, mês a mês)');
  await page.locator('.intim.intim-nova', { hasText: 'Plano anual' }).locator('button:has-text("Criar prazo")').click();
  await page.waitForSelector('.modal .field:has-text("Vence em") input');
  check((await page.locator('.modal .field:has-text("Vence em") input').inputValue()).length > 0, 'vencimento sugerido em dias úteis');
  await page.click('.modal button:has-text("Criar prazo na Agenda")');
  await page.waitForSelector('.toast:has-text("Prazo criado")');
  check(true, 'intimação vira prazo na Agenda');
  await page.click('.unknown-procs summary').catch(() => {});
  await page.locator('.unknown-row', { hasText: '1002345-67.2026.8.11.0041' }).locator('button:has-text("Cadastrar")').click();
  await page.click('.modal .picker-item:has-text("ELISA MARTINS")');
  await page.click('.modal button:has-text("Cadastrar processo")');
  await page.waitForSelector('.modal-case .tl-item', { timeout: 10000 });
  check(true, 'processo encontrado pela OAB cadastrado, com andamentos');
  await shot(page, '05l-processo-importado');
  await page.keyboard.press('Escape');

  // comercial: funil, novo interessado, atendimento, proposta e virar cliente
  await page.click('.rail-btn[title="Atendimento"]');
  await page.click('.chatlist-head .atend-switch button:has-text("Comercial")');
  await page.waitForSelector('.view-commercial .col[data-stage="proposta"] .card:has-text("Fernanda Dias")');
  check(await page.locator('.view-commercial .col[data-stage="consulta"] .card:has-text("Roberto Lima")').count() === 1, 'funil do comercial com os interessados por etapa');
  await shot(page, '05n-comercial');
  await page.click('.view-commercial .page-head button:has-text("Novo interessado")');
  let dlg = page.locator('.modal').last();
  await dlg.locator('label.field:has-text("Nome") input').fill('Lucas Prado');
  await dlg.locator('label.field:has-text("Como chegou") select').selectOption('Google');
  await dlg.locator('label.field:has-text("Área") input').fill('Cível');
  await dlg.locator('label.field:has-text("Assunto") input').fill('Revisão de contrato');
  await dlg.locator('label.field:has-text("Tipo") select').selectOption('fixo');
  await dlg.locator('label.field:has-text("Valor total") input').fill('2500');
  await dlg.locator('label.field:has-text("Parcelas") input').fill('2');
  await dlg.locator('button:has-text("Salvar")').click();
  await page.waitForSelector('.lead-sheet .lead-head');
  check(await page.locator('.lead-sheet .stage-pill:has-text("Primeiro contato")').count() === 1, 'interessado cadastrado e ficha aberta');
  await page.click('.lead-sheet button:has-text("Registrar atendimento")');
  dlg = page.locator('.modal').last();
  await dlg.locator('textarea').fill('Contrato de financiamento com juros abusivos. Vai mandar o contrato.');
  await dlg.locator('.chip:has-text("Amanhã")').click();
  await dlg.locator('button:has-text("Registrar")').click();
  await page.waitForSelector('.lead-sheet .att-item:has-text("juros abusivos")');
  await page.waitForSelector('.lead-sheet .task:has-text("Retomar contato")');
  check(true, 'atendimento registrado com próximo passo na Agenda');
  await shot(page, '05o-interessado');
  await page.click('.lead-sheet button:has-text("Proposta")');
  dlg = page.locator('.modal').last();
  check((await dlg.locator('textarea').inputValue()).includes('R$ 2.500,00'.replace(' ', '\u00a0')) || (await dlg.locator('textarea').inputValue()).includes('2.500,00'), 'proposta preenchida com os honorários');
  await shot(page, '05p-proposta');
  await dlg.locator('button:has-text("Copiar e marcar enviada")').click();
  await page.waitForSelector('.lead-sheet .stage-pill:has-text("Proposta enviada")');
  check(true, 'proposta marcada como enviada');
  await page.click('.lead-sheet button:has-text("Virar cliente")');
  dlg = page.locator('.modal').last();
  await dlg.locator('.modal-actions button:has-text("Virar cliente")').click();
  await page.waitForSelector('.modal-case:has-text("Revisão de contrato")', { timeout: 10000 });
  check(true, 'virou cliente: processo aberto com os dados da proposta');
  await page.keyboard.press('Escape');
  await page.click('.rail-btn[title="Jurídico"]');
  await page.click('.view-legal .seg:has-text("Por cliente")');
  await page.fill('.lv-search', 'Lucas');
  await page.click('.lv-client:has-text("Lucas Prado")');
  await page.click('.lv-c2 button:has-text("Ficha do cliente")');
  await page.click('.view-legal .tab:has-text("Atendimentos")');
  await page.waitForSelector('.view-legal .att-item:has-text("juros abusivos")');
  check(true, 'atendimentos do comercial aparecem na ficha do cliente');
  await page.click('.view-legal .back-btn');
  await page.click('.rail-btn[title="Atendimento"]');
  await page.click('.view-commercial .atend-switch button:has-text("Conversas")').catch(() => {});
  await page.click('.chat-row[data-jid="5548999990000@s.whatsapp.net"]');
  await page.waitForSelector('.crm-panel .lead-chip:has-text("Interessado no Comercial")');
  check(true, 'conversa mostra que é um interessado do comercial');

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
  await page.waitForSelector('.view.active .viz-svg');
  await shot(page, '08-dashboard');
  check(await page.locator('.view.active .stat-label:has-text("Processos abertos no período")').count() === 1, 'relatórios: visão geral do período');
  for (const [tabName, probe] of [['Equipe', 'table'], ['Comercial', '.stat'], ['Atendimento', '.viz-svg'], ['Financeiro', '.viz-bars, .viz-svg']]) {
    await page.click(`.view.active .tab:has-text("${tabName}")`);
    await page.waitForSelector(`.view.active .report-body ${probe.split(', ').join(`, .view.active .report-body `)}`);
  }
  await shot(page, '08b-relatorio-financeiro');
  check(true, 'relatórios: equipe, comercial, atendimento e financeiro');
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('.view.active .panel button[title^="Baixar em CSV"]')]);
  check(/\.csv$/.test(csv.suggestedFilename()), 'relatório exportado em CSV');
  await page.click('.view.active .tab:has-text("Equipe")');
  await page.waitForSelector('.view.active .report-body table');
  await shot(page, '08c-relatorio-equipe');
  await page.click('.view.active .tab:has-text("Visão geral")');
  await page.click('.rail-btn[title="Configurações"]');
  await page.waitForSelector('.settings-grid');
  await shot(page, '09-settings');
  await page.waitForSelector('.push-cfg label.check', { timeout: 10000 });
  const pushUi = await page.evaluate(() => ({ sw: 'serviceWorker' in navigator, pm: 'PushManager' in window, text: document.querySelector('.push-cfg').innerText }));
  check(await page.locator('.push-cfg label.check').count() >= 4
    && (pushUi.pm ? /Ativar avisos neste aparelho/.test(pushUi.text) : /não recebe avisos/.test(pushUi.text)), 'avisos no celular: ativar e escolher o que receber');

  await page.click('.settings-grid button:has-text("Testar conexão")');
  await page.waitForSelector('.modal .diag-step', { timeout: 40000 });
  await shot(page, '09b-diagnostico');
  await page.click('.modal button:has-text("Fechar")');
  check(true, 'teste de conexão mostra o resultado passo a passo');
  check(true, 'painel e configurações');
  check(await page.locator('.settings-grid .list-row', { hasText: 'Cliente' }).locator('text=baixa arquivos').count() === 1,
    'tipo Cliente baixa arquivos automaticamente');
  // ícone do tipo: escolhido entre desenhos (não emoji)
  await page.locator('.settings-grid .list-row', { hasText: 'Empresa' }).first().locator('button:has-text("Editar")').click();
  await page.waitForSelector('.modal .icon-picker .icon-pick.on');
  await page.click('.modal .icon-pick:nth-child(10)');
  await shot(page, '09c-icone-tipo');
  await page.click('.modal button:has-text("Salvar")');
  await page.waitForSelector('.modal', { state: 'detached' });
  check(await page.locator('.settings-grid .list-row', { hasText: 'Empresa' }).first().locator('svg.ico').count() === 1, 'tipo de contato com ícone desenhado');

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

  // 7e) importar a lista do LinkLei (CSV), escolher o cliente pelas partes, arquivado provisório
  const csvPath = path.join(dataDir, 'relatorio-processos.csv');
  fs.writeFileSync(csvPath, [
    'Processo;Situação;Atualizado em;Nº do processo;Tribunal',
    'Tribunal de Justiça do Mato Grosso - TJMT;Ativo;07/10/2026;1001556-08.2023.8.11.0042;Tribunal de Justiça do Mato Grosso - TJMT',
    'TRT da 23ª Região - TRT23;Ativo;07/10/2026;0001095-63.2026.5.23.0107;TRT da 23ª Região - TRT23',
    'ELSON FERREIRA BARROS x CLEBERSON DA ROCHA;Ativo;07/10/2026;1012345-10.2022.8.11.0003;Tribunal de Justiça do Mato Grosso - TJMT',
  ].join('\n'));
  await page.click('.rail-btn[title="Jurídico"]');
  if (await page.locator('.view-legal .back-btn').count()) await page.click('.view-legal .back-btn');
  await page.click('.view-legal .seg:has-text("Processos")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.view-legal button:has-text("Importar lista")')]);
  await chooser.setFiles(csvPath);
  await page.waitForSelector('.import-stats .stat-value:text-is("3")');
  check(true, 'prévia da importação conta os processos novos');
  await shot(page, '15-importar-previa');
  await page.click('.modal button:has-text("Importar")');
  await page.waitForFunction(() => window.api.call('cases:importStatus').then((st) => !st.running && st.done === 3), null, { timeout: 20000 });
  check(true, 'importação consulta os tribunais em segundo plano');
  await page.fill('.view-legal .legal-search', '');
  await page.selectOption('.view-legal .legal-tools select >> nth=0', 'semcliente');
  await page.waitForSelector('.no-client-card');
  check(await page.locator('.no-client-card').count() === 3, 'processos importados ficam "sem cliente"');
  await shot(page, '15b-sem-cliente');
  const trtCard = page.locator('.no-client-card', { hasText: '0001095-63.2026.5.23.0107' });
  await trtCard.locator('.party-row.cliente').first().waitFor();
  const clientName = (await trtCard.locator('.party-row.cliente b').first().innerText()).trim();
  await trtCard.locator('button:has-text("Confirmar")').click();
  await page.waitForSelector(`.toast:has-text("Cliente: ${clientName}")`);
  await page.waitForFunction(() => document.querySelectorAll('.no-client-card').length === 2);
  check(true, 'escolher o cliente pelas partes do DJEN cria o cadastro');
  await page.selectOption('.view-legal .legal-tools select >> nth=0', 'vigiar');
  await page.locator('.cases-table tr', { hasText: '1001556-08.2023.8.11.0042' }).click();
  await page.waitForSelector('.modal-case .case-banner.danger:has-text("Arquivado provisoriamente")');
  check(await page.locator('.modal-case .case-banner.warn:has-text("Cliente a identificar")').count() === 1, 'ficha mostra cliente a identificar e o controle de prescrição');
  await shot(page, '15c-arquivado-vigiar');
  await page.keyboard.press('Escape');
  await page.selectOption('.view-legal .legal-tools select >> nth=0', 'aberto');

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
  await page.waitForSelector('.chat-head .stage-btn:has-text("Protocolo")');
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
