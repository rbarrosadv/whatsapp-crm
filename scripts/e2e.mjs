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

  // tema claro
  await page.selectOption('.settings-grid select', 'light');
  await page.click('.rail-btn[title="Conversas"]');
  await page.locator('.chat-row', { hasText: 'Mariana Souza' }).click();
  await page.waitForSelector('.msg');
  await shot(page, '10-light');
  await page.click('.rail-btn[title="Configurações"]');
  await page.selectOption('.settings-grid select', 'dark');
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
