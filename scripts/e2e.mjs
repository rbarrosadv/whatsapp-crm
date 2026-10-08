// Teste de ponta a ponta no modo demonstração (sem WhatsApp real).
// Uso: npm i --no-save playwright-core && npm run test:e2e
// Salva capturas de tela em test-results/.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
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
const { _electron: electron } = loadPlaywright();

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'test-results');
fs.mkdirSync(OUT, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-e2e-'));
const errors = [];

async function launch(extraEnv = {}, dir = dataDir) {
  const app = await electron.launch({
    executablePath: require(path.join(ROOT, 'node_modules', 'electron')),
    args: [ROOT, '--demo', '--no-sandbox'],
    env: { ...process.env, CRM_DATA_DIR: dir, CRM_DEMO_QR_MS: '1500', ...extraEnv },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
  return { app, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
function check(cond, msg) { if (!cond) throw new Error(`FALHOU: ${msg}`); console.log(`✔ ${msg}`); }

let { app, page } = await launch();
try {
  // 1) primeira vez: QR code
  await page.waitForSelector('.connect-overlay:not(.hidden) img.qr', { timeout: 15000 });
  await shot(page, '01-qr');
  check(true, 'mostra o QR code na primeira vez');

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
    await window.api.call('messages:sendFiles', jid, files);
  }, { jid: jidMari, files: [path.join(ROOT, 'assets', 'icon.png'), path.join(ROOT, 'assets', 'tray.png')] });
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

  // pré-visualização de links: aparece ao escrever, vai junto no envio, ✕ tira
  await page.fill('.composer-input', 'Veja a notícia https://exemplo.com.br/noticia');
  await page.waitForSelector('.link-compose:not(.hidden) .link-card-title:has-text("Notícia de exemplo")', { timeout: 8000 });
  check(await page.locator('.link-compose img.link-card-img').count() === 1, 'ao escrever um link aparece a prévia com imagem e título');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const linkMsg = page.locator('.msg.out', { hasText: 'Veja a notícia' }).last();
  await linkMsg.locator('.link-card img.link-card-img').waitFor();
  check((await linkMsg.locator('.link-card-site').textContent()) === 'exemplo.com.br', 'mensagem enviada mostra o cartão do link (imagem, título e site)');
  await page.evaluate(() => [...document.querySelectorAll('.link-card')].pop()?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await shot(page, '03e-cartao-link');
  await page.fill('.composer-input', 'Sem cartão https://exemplo.com.br/outra');
  await page.waitForSelector('.link-compose:not(.hidden)', { timeout: 8000 });
  await page.click('.link-compose .icon-btn');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.out:has-text("Sem cartão")');
  check(await page.locator('.msg.out:has-text("Sem cartão") .link-card').count() === 0, '✕ envia o link sem a pré-visualização');

  // encaminhar: menu da mensagem → escolher contatos → aparece "Encaminhada" no destino
  const toFwd = page.locator('.msg.in', { hasText: 'Tem desconto pra pagamento anual?' }).first();
  await toFwd.hover();
  await toFwd.locator('.msg-menu-btn').click();
  await page.locator('.popup-item', { hasText: 'Encaminhar' }).click();
  await page.waitForSelector('.modal .forward-preview:has-text("Tem desconto")');
  await page.locator('.modal .picker-item', { hasText: 'Ana Beatriz' }).click();
  await page.locator('.modal .picker-item', { hasText: 'João (Fornecedor)' }).click();
  check((await page.textContent('.modal-actions .btn-primary')) === 'Encaminhar (2)', 'escolhe para quem encaminhar (2 conversas)');
  await shot(page, '03f-encaminhar');
  await page.click('.modal-actions .btn-primary');
  await page.locator('.chat-row', { hasText: 'Ana Beatriz' }).click();
  await page.waitForSelector('.msg.out:has-text("Tem desconto pra pagamento anual?") .forwarded');
  check(true, 'mensagem encaminhada aparece no destino com "↪ Encaminhada"');
  await page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await page.waitForSelector('.chat-head:has-text("Mariana Souza")');

  // apagar para mim (mensagem recebida) e para todos (mensagem sua)
  const recv = page.locator('.msg.in', { hasText: 'Queria saber o valor do plano mensal' }).first();
  await recv.hover();
  await recv.locator('.msg-menu-btn').click();
  await page.locator('.popup-item', { hasText: 'Apagar' }).click();
  check(await page.locator('.modal-actions .btn', { hasText: 'Apagar para todos' }).count() === 0, 'mensagem recebida: só "Apagar para mim"');
  await page.locator('.modal-actions .btn', { hasText: 'Apagar para mim' }).click();
  await page.waitForSelector('.msg:has-text("Queria saber o valor do plano mensal")', { state: 'detached' });
  check(true, '"Apagar para mim" tira a mensagem recebida da conversa');
  const mine = page.locator('.msg.out', { hasText: 'Sem cartão' }).first();
  await mine.hover();
  await mine.locator('.msg-menu-btn').click();
  await page.locator('.popup-item', { hasText: 'Apagar' }).click();
  await page.locator('.modal-actions .btn', { hasText: 'Apagar para todos' }).click();
  await page.waitForSelector('.msg.out .deleted');
  check(await page.locator('.msg:has-text("Sem cartão")').count() === 0, 'mensagem sua tem também "Apagar para todos"');

  // rascunho: fica guardado ao trocar de conversa e aparece na lista
  await page.locator('.chat-row', { hasText: 'Ana Beatriz' }).click();
  await page.waitForSelector('.chat-head:has-text("Ana Beatriz")');
  await page.fill('.composer-input', 'Minuta do contrato em revisão');
  await page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await page.waitForSelector('.chat-row:has-text("Ana Beatriz") .draft-label');
  check((await page.textContent('.chat-row:has-text("Ana Beatriz") .chat-preview')).includes('Minuta do contrato'), 'lista mostra "✏️ Rascunho" da conversa que ficou para trás');
  await page.locator('.chat-row', { hasText: 'Ana Beatriz' }).click();
  await page.waitForSelector('.chat-head:has-text("Ana Beatriz")');
  check(await page.inputValue('.composer-input') === 'Minuta do contrato em revisão', 'ao voltar, o rascunho está na caixa de mensagem');
  await page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await page.waitForSelector('.chat-head:has-text("Mariana Souza")');

  // balão com a mensagem completa ao passar o mouse, sem marcar como lida
  const unreadRow = page.locator('.chat-row.unread').filter({ hasNotText: 'Mariana' }).first();
  const badgeBefore = await unreadRow.locator('.badge').textContent();
  await unreadRow.hover();
  await page.waitForSelector('.chat-tip:not(.hidden)', { timeout: 3000 });
  const tipTxt = await page.textContent('.chat-tip');
  check(tipTxt.length > 10, 'balão com a mensagem aparece ao parar o mouse na conversa');
  await shot(page, '03c-balao-lista');
  await page.mouse.move(700, 400);
  await page.waitForSelector('.chat-tip.hidden', { state: 'attached' });
  check(await unreadRow.locator('.badge').textContent() === badgeBefore, 'passar o mouse não marca como lida');

  // tamanho da letra (Ctrl + roda / Ctrl + "+") e zoom do programa (Ctrl + Shift + "+")
  const fs = () => page.$eval('.msg .text', (el) => parseFloat(getComputedStyle(el).fontSize));
  const fsNormal = await fs();
  await page.mouse.move(700, 400);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await page.waitForFunction(() => document.body.dataset.msgfont === 'lg');
  check(await fs() > fsNormal, `Ctrl + roda aumenta a letra das conversas (${fsNormal}px → ${await fs()}px)`);
  await page.keyboard.press('Control+Equal');
  await page.waitForFunction(() => document.body.dataset.msgfont === 'xl');
  await shot(page, '03d-letra-grande');
  await page.keyboard.press('Control+0');
  await page.waitForFunction(() => document.body.dataset.msgfont === 'md');
  check(await fs() === fsNormal, 'Ctrl + 0 volta a letra ao normal');
  await page.keyboard.press('Control+Shift+Equal');
  await page.waitForFunction(() => window.__crm.state.settings.uiZoom === 1.1);
  await page.waitForTimeout(200);
  check(Math.abs(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()) - 1.1) < 0.01, 'Ctrl + Shift + "+" aumenta o zoom do programa');
  await page.keyboard.press('Control+Shift+Digit0');
  await page.waitForFunction(() => window.__crm.state.settings.uiZoom === 1);

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
  await page.click('.modal button:has-text("Criar caso")');
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
  await page.click('.rail-btn[title="Funil"]');
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
  await page.locator('.modal .picker-item', { hasText: 'Ana Beatriz' }).click();
  await page.fill('.modal .field:has-text("Nome do caso") input', 'Consulta inventário');
  await page.click('.modal button:has-text("Criar caso")');
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
  await page.click('.segmented .seg:has-text("Mês")');
  await page.waitForSelector('.mo-grid .ev-chip');
  await shot(page, '05a-agenda-mes');
  check(true, 'visão de mês');
  await page.click('.segmented .seg:has-text("Semana")');
  await page.locator('.tg-event:has-text("Audiência Carlos x Transportes")').click();
  await page.waitForSelector('.modal button:has-text("Carlos Pereira")');
  check(true, 'detalhes do compromisso ligam ao cliente');
  await page.keyboard.press('Escape');

  // 6a2) modo discreto
  await page.click('.rail-btn[title="Conversas"]');
  await page.keyboard.press('Control+Shift+D');
  await page.waitForSelector('body.discreet');
  const blur = await page.locator('.chat-row .chat-preview').first().evaluate((el) => getComputedStyle(el).filter);
  check(blur.includes('blur'), 'modo discreto embaça as prévias (Ctrl+Shift+D)');
  await page.click('.rail-btn[title="Financeiro"]');
  await page.waitForSelector('.stat-value');
  check((await page.locator('.stat-value').first().evaluate((el) => getComputedStyle(el).filter)).includes('blur'), 'modo discreto embaça os valores');
  await shot(page, '05c-modo-discreto');
  await page.click('.rail-btn[title^="Modo discreto"]');
  await page.waitForSelector('body:not(.discreet)');
  check(true, 'botão 🕶 desliga o modo discreto');

  // 6b) financeiro
  await page.click('.rail-btn[title="Financeiro"]');
  await page.waitForSelector('.stat');
  await page.click('.chips .chip:has-text("Vencidas")');
  await page.waitForSelector('.table tbody tr:has-text("Carlos Pereira")');
  check(true, 'parcela vencida aparece no Financeiro');
  await shot(page, '05b-financeiro');
  await page.click('.chips .chip:has-text("Pagas")');
  await page.waitForSelector('.table tbody tr:has-text("Mariana Souza")');
  check(true, 'parcela recebida aparece em Pagas');

  // 7) outras telas
  await page.click('.rail-btn[title="Contatos"]');
  await page.waitForSelector('.table tbody tr');
  await shot(page, '06-contacts');
  check(await page.locator('.table tbody tr').count() >= 5, 'tabela de contatos');
  await page.click('.rail-btn[title="Tarefas"]');
  await page.waitForSelector('.task-group .task');
  await shot(page, '07-tasks');
  check(true, 'tela de tarefas');
  await page.click('.rail-btn[title="Painel"]');
  await page.waitForSelector('.stat');
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
  await page.selectOption('.settings-grid select:has(option[value="light"])', 'light');
  await page.click('.rail-btn[title="Conversas"]');
  await page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await page.waitForSelector('.msg');
  await shot(page, '10-light');
  await page.click('.rail-btn[title="Configurações"]');
  await page.selectOption('.settings-grid select:has(option[value="light"])', 'dark');
  await page.click('.rail-btn[title="Conversas"]');
  await page.waitForTimeout(300);
  await shot(page, '12-dark');

  // 8) nova conversa por número
  await page.click('.rail-btn[title="Conversas"]');
  await page.click('.chatlist-head button[title^="Nova conversa"]');
  await page.fill('.modal input >> nth=0', '(11) 91234-5678');
  await page.fill('.modal input >> nth=1', 'Paulo Novo');
  await page.click('.modal button:has-text("Abrir conversa")');
  await page.waitForSelector('.chat-head-name:has-text("Paulo Novo")');
  check(true, 'nova conversa aberta pelo número');
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
  check((await page.textContent('.chat-row:has-text("Ana Beatriz") .chat-preview')).includes('Rascunho: Minuta do contrato'), 'rascunho continua guardado depois de fechar e abrir o programa');
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
  await page.waitForSelector('.connect-overlay:not(.hidden) img.qr', { timeout: 15000 });
  await page.click('.connect-tabs .tab:has-text("número")');
  await page.fill('.connect-overlay input', '11 98765-4321');
  await page.click('.connect-overlay button:has-text("Gerar código")');
  await page.waitForSelector('.pairing-code:has-text("DEMO-1234")');
  await shot(page, '13-pairing');
  check(true, 'mostra código de pareamento pelo número');
  await page.waitForSelector('.connect-overlay.hidden', { state: 'attached', timeout: 10000 });
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
  process.exit(1);
}
await app.close();
fs.rmSync(dir2, { recursive: true, force: true });

const relevant = errors.filter((e) => !/Autofill|DevTools|favicon/i.test(e));
if (relevant.length) {
  console.error('Erros no console:\n' + relevant.join('\n'));
  process.exit(1);
}
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('\nTodos os testes passaram. Capturas em test-results/');
