// App de desktop "Barros Associados": uma janela própria (com ícone, bandeja
// e notificações do Windows) que abre o sistema do servidor do escritório.
//
// Dois modos (escolhidos na primeira vez, trocáveis pelo menu):
// - servidor: abre o endereço do servidor do escritório (ex.: https://sistema.barrosassociados.adv.br);
// - local: liga o servidor neste mesmo computador (dados em
//   %APPDATA%\BarrosAssociados\dados) e abre ele.
import {
  app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, powerMonitor, safeStorage, session, dialog, screen,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listCerts, signCms } from './certificados.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DEMO = process.argv.includes('--demo') || process.env.CRM_DEMO === '1';
const NAME = 'Barros Associados';
const LOCAL_PORT = Number(process.env.CRM_PORT || (DEMO ? 3211 : 3210));

// Pasta de dados do modo local: própria do sistema novo. NÃO usa a do
// WhatsApp CRM antigo (%APPDATA%\WhatsAppCRM), que continua rodando à parte
// com outro WhatsApp (o pessoal).
const DATA_DIR = process.env.CRM_DATA_DIR
  || path.join(app.getPath('appData'), DEMO ? 'BarrosAssociados-Demo' : 'BarrosAssociados', 'dados');
app.setPath('userData', path.join(app.getPath('appData'), DEMO ? 'BarrosAssociados-Demo' : 'BarrosAssociados'));

// Identidade no Windows: faz as notificações aparecerem como "Barros Associados".
// Precisa de um atalho no Menu Iniciar com o mesmo id (ensureStartMenuShortcut).
const AUMID = 'com.barrosassociados.sistema';
app.setAppUserModelId(AUMID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const ICON = path.join(ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'desktop.json');

let win = null;
let tray = null;
let quitting = false;
let local = null; // servidor local, quando o modo é "local"
let baseUrl = null;
let config = {};

function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf-8')); } catch { config = {}; }
  if (!config.mode && DEMO) config.mode = 'local';
}
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2));
}

// ------------------------------------------------------------ janela

// Corretor ortográfico em português e menu do botão direito com as sugestões
// (o Chromium sublinha as palavras, mas o menu com sugestões é a gente que monta).
// Ligar/desligar é preferência de cada pessoa: a interface muda o atributo spellcheck.
function setupSpellcheck() {
  const ses = win.webContents.session;
  try {
    const langs = ses.availableSpellCheckerLanguages || [];
    ses.setSpellCheckerLanguages([['pt-BR', 'pt'].find((l) => langs.includes(l)) || 'pt-BR']);
  } catch (e) { console.warn('corretor:', e.message); }
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    if (p.misspelledWord) {
      const sug = (p.dictionarySuggestions || []).slice(0, 6);
      sug.forEach((w) => items.push({ label: w, click: () => win.webContents.replaceMisspelling(w) }));
      if (!sug.length) items.push({ label: 'Sem sugestões', enabled: false });
      items.push({ label: `Adicionar “${p.misspelledWord}” ao dicionário`, click: () => ses.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) {
      items.push({ role: 'cut', label: 'Recortar', enabled: p.editFlags.canCut });
      items.push({ role: 'copy', label: 'Copiar', enabled: p.editFlags.canCopy });
      items.push({ role: 'paste', label: 'Colar', enabled: p.editFlags.canPaste });
      items.push({ type: 'separator' }, { role: 'selectAll', label: 'Selecionar tudo' });
    } else if (p.selectionText) {
      items.push({ role: 'copy', label: 'Copiar' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function createWindow() {
  const bounds = config.windowBounds || { width: 1360, height: 860 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 980,
    minHeight: 600,
    show: false,
    title: `${NAME}${DEMO ? ' (demonstração)' : ''}`,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#0b141a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  // Maximizar só depois de mostrar: maximizada ainda escondida, o Windows às
  // vezes deixa a página com o tamanho antigo (faixa vazia do lado direito).
  win.once('show', () => { if (config.windowMaximized) setTimeout(() => win && !win.isDestroyed() && win.maximize(), 50); });
  // no modo "neste computador" o título avisa: os dados ficam só nesta máquina
  win.on('page-title-updated', (e, title) => {
    if (config.mode !== 'local' || DEMO) return;
    e.preventDefault();
    win.setTitle(`${title} — só neste computador`);
  });
  setupSpellcheck();
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'notifications', 'clipboard-sanitized-write'].includes(permission));
  });
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });

  const sameOrigin = (url) => baseUrl && url.startsWith(baseUrl);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) { openFromServer(url, 'open'); return { action: 'deny' }; }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (sameOrigin(url) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) showOffline(desc);
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  const saveBounds = debounce(() => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    config.windowMaximized = win.isMaximized();
    if (!win.isMaximized()) config.windowBounds = win.getBounds();
    saveConfig();
  }, 500);
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  const displayCheck = debounce(applyDisplayZoom, 300);
  win.on('move', displayCheck);
  win.on('show', displayCheck);
  win.webContents.on('did-finish-load', () => { zoomDisplay = null; applyDisplayZoom(); });
  win.webContents.on('zoom-changed', (_e, dir) => zoomBy(dir === 'in' ? 0.5 : -0.5));
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (e) => {
    if (!quitting && config.minimizeToTray !== false && tray) {
      e.preventDefault();
      win.hide();
      if (!config.trayHintShown) {
        config.trayHintShown = true;
        saveConfig();
        tray.displayBalloon?.({ title: `${NAME} continua aberto`, content: 'Segue avisando de mensagens e lembretes perto do relógio.' });
      }
    }
  });
}

// ------------------------------------------------------------ zoom por monitor
// Notebook com escala 150% + monitor externo a 100%: ao passar a janela de um
// para o outro, cada um volta com o zoom que a pessoa escolheu nele.
let zoomDisplay = null;
const displayOf = () => { try { return String(screen.getDisplayMatching(win.getBounds()).id); } catch { return null; } };
function rememberZoom() {
  if (!win || win.isDestroyed() || zoomDisplay == null) return;
  config.zoomByDisplay = { ...(config.zoomByDisplay || {}), [zoomDisplay]: win.webContents.getZoomLevel() };
  saveConfig();
}
function zoomBy(step) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  wc.setZoomLevel(step === 0 ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + step)));
  zoomDisplay = zoomDisplay ?? displayOf();
  rememberZoom();
}
function applyDisplayZoom() {
  if (!win || win.isDestroyed()) return;
  const id = displayOf();
  if (id == null || id === zoomDisplay) return;
  zoomDisplay = id;
  const level = config.zoomByDisplay?.[id];
  win.webContents.setZoomLevel(typeof level === 'number' ? level : 0);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showSetup() {
  baseUrl = null;
  win.loadFile(path.join(__dirname, 'setup.html'));
}

function showOffline(reason) {
  win.loadFile(path.join(__dirname, 'offline.html'), { query: { reason: String(reason || ''), url: baseUrl || '' } });
}

async function openSystem() {
  if (config.mode === 'local') {
    try {
      if (!local) {
        const { startServer } = await import('../server/server.js');
        local = await startServer({ dataDir: DATA_DIR, demo: DEMO, port: LOCAL_PORT, host: '127.0.0.1', safeStorage });
      }
      baseUrl = local.url;
    } catch (e) {
      dialog.showErrorBox(NAME, `Não foi possível ligar o sistema neste computador:\n${e.message}`);
      showSetup();
      return;
    }
  } else if (config.mode === 'remote' && config.url) {
    // passou a usar o servidor do escritório: desliga o servidor deste computador
    // (senão o WhatsApp ficaria conectado em dois lugares com dados diferentes)
    if (local) { const srv = local; local = null; await srv.close().catch(() => {}); }
    baseUrl = config.url.replace(/\/+$/, '');
  } else {
    showSetup();
    return;
  }
  win.loadURL(`${baseUrl}/`);
}

// ------------------------------------------------------------ abrir / salvar arquivos do servidor

const pendingDownloads = new Map(); // url → { mode: 'open'|'save', name }

function openFromServer(url, mode, name) {
  const abs = new URL(url, baseUrl).toString();
  pendingDownloads.set(abs, { mode, name });
  win.webContents.downloadURL(abs);
}

function setupDownloads() {
  session.defaultSession.on('will-download', (_e, item) => {
    const url = item.getURL();
    const intent = pendingDownloads.get(url) || { mode: 'save' };
    pendingDownloads.delete(url);
    const name = (intent.name || item.getFilename()).replace(/[<>:"/\\|?*]/g, '_');
    if (intent.mode === 'open') {
      const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'barros-'));
      item.setSavePath(path.join(dir, name));
      item.once('done', (_ev, state) => {
        if (state === 'completed') shell.openPath(item.getSavePath()).then((err) => { if (err) dialog.showErrorBox(NAME, err); });
      });
    } else {
      item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), name) });
    }
  });
}

// ------------------------------------------------------------ ponte com a página

ipcMain.handle('desktop', async (_e, action, ...args) => {
  switch (action) {
    case 'openUrl': openFromServer(args[0], 'open', args[1]); return null;
    case 'saveUrl': openFromServer(args[0], 'save', args[1]); return null;
    case 'openExternal': if (/^https?:/i.test(args[0])) shell.openExternal(args[0]); return null;
    // Word/Excel/PowerPoint do computador abrindo o arquivo do próprio OneDrive (salva lá)
    case 'openOffice': if (/^ms-(word|excel|powerpoint):ofe\|u\|https:\/\/[^\s"]+$/i.test(String(args[0]))) { await shell.openExternal(args[0]); return true; } return false;
    // documento da pasta do escritório: no modo "neste computador" abre o
    // arquivo de verdade (no Word, no Explorador), para editar e salvar no OneDrive
    case 'openDoc': {
      if (config.mode !== 'local' || !local?.core?.docs) return false;
      const abs = local.core.docs.localPath(String(args[0] || ''));
      if (/\.(exe|bat|cmd|com|scr|msi|ps1|vbs|js|jse|wsf|lnk|hta|jar|reg|pif|cpl|dll)$/i.test(abs)) throw new Error('arquivo executável');
      if (!fs.existsSync(abs)) throw new Error('Arquivo não encontrado na pasta do escritório.');
      const err = await shell.openPath(abs);
      if (err) throw new Error(err);
      return true;
    }
    case 'showDoc': {
      if (config.mode !== 'local' || !local?.core?.docs) return false;
      shell.showItemInFolder(local.core.docs.localPath(String(args[0] || '')));
      return true;
    }
    case 'focus': showWindow(); return null;
    case 'flash': if (win && !win.isFocused()) win.flashFrame(true); return null;
    case 'setBadge': {
      const n = Number(args[0]) || 0;
      if (process.platform !== 'win32') app.setBadgeCount(n);
      tray?.setToolTip(n ? `${NAME} — ${n} conversa(s) não lida(s)` : NAME);
      return null;
    }
    case 'getSetting': return { minimizeToTray: config.minimizeToTray !== false, openAtLogin: !!config.openAtLogin }[args[0]];
    case 'setSetting': {
      const [key, value] = args;
      if (!['minimizeToTray', 'openAtLogin'].includes(key)) throw new Error('opção desconhecida');
      config[key] = !!value;
      saveConfig();
      applyLoginItem();
      return null;
    }
    // certificado A3 deste computador (recibos assinados digitalmente)
    case 'certs:list': return listCerts();
    case 'certs:get': return config.a3 || null;
    case 'certs:choose': {
      const c = args[0];
      config.a3 = c ? { thumb: String(c.thumb), name: String(c.name || ''), issuer: String(c.issuer || ''), validTo: Number(c.validTo) || null } : null;
      saveConfig();
      return config.a3;
    }
    case 'certs:sign': {
      if (!config.a3) throw new Error('Escolha o certificado em Ajustes → Recibos.');
      showWindow();
      const cms = await signCms(Buffer.from(String(args[0] || ''), 'base64'), config.a3.thumb);
      return cms.toString('base64');
    }
    case 'openNotificationSettings': if (process.platform === 'win32') shell.openExternal('ms-settings:notifications'); return null;
    // Plano B dos tribunais: se o DJEN/DataJud recusar o servidor (ex.: bloqueio de
    // servidores na nuvem), o servidor pede para este computador buscar. Só os
    // endereços públicos do CNJ; nada mais pode ser pedido por aqui.
    case 'courtFetch': {
      const req = args[0] || {};
      const u = new URL(String(req.url || ''));
      if (u.protocol !== 'https:' || !['comunicaapi.pje.jus.br', 'api-publica.datajud.cnj.jus.br'].includes(u.hostname)) throw new Error('endereço não permitido');
      const method = req.method === 'POST' ? 'POST' : 'GET';
      const headers = {};
      for (const [k, v] of Object.entries(req.headers || {})) if (/^(authorization|content-type|accept)$/i.test(k)) headers[k] = String(v);
      const r = await fetch(u, { method, headers, body: method === 'POST' ? String(req.body || '') : undefined, signal: AbortSignal.timeout(30000) });
      const body = await r.text();
      return { status: r.status, body: body.slice(0, 20 * 1024 * 1024), contentType: r.headers.get('content-type') || '' };
    }
    // tela de primeira vez / sem conexão
    case 'setup:get': return { mode: config.mode || null, url: config.url || '', hasLocalData: fs.existsSync(path.join(DATA_DIR, 'crm.sqlite')) };
    case 'setup:choose': {
      const [mode, url] = args;
      if (mode === 'remote') {
        let u = String(url || '').trim();
        if (!u) throw new Error('Informe o endereço do servidor.');
        if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
        const parsed = new URL(u);
        config.url = parsed.origin;
      }
      config.mode = mode === 'remote' ? 'remote' : 'local';
      saveConfig();
      await openSystem();
      return null;
    }
    case 'setup:retry': await openSystem(); return null;
    case 'setup:change': showSetup(); return null;
    default: throw new Error(`ação desconhecida: ${action}`);
  }
});

// ------------------------------------------------------------ bandeja, atalhos, início

function createTray() {
  const trayIcon = path.join(ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'tray.png');
  if (!fs.existsSync(trayIcon)) return;
  tray = new Tray(nativeImage.createFromPath(trayIcon));
  tray.setToolTip(NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Abrir ${NAME}`, click: showWindow },
    { label: 'Trocar o servidor do escritório…', click: () => { showWindow(); showSetup(); } },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

function applyLoginItem() {
  if (!(app.isPackaged || process.platform === 'win32')) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!config.openAtLogin,
      path: process.execPath,
      args: app.isPackaged ? ['--hidden'] : [ROOT, '--hidden'],
    });
  } catch { /* ignore */ }
}

/** Atalho no Menu Iniciar com a identidade do app (sem ele o Windows não mostra as notificações direito). */
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32' || DEMO) return;
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NAME}.lnk`);
    const options = {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${ROOT}"`,
      cwd: ROOT,
      icon: path.join(ROOT, 'assets', 'icon.ico'),
      iconIndex: 0,
      description: NAME,
      appUserModelId: AUMID,
    };
    let current = null;
    try { current = shell.readShortcutLink(lnk); } catch { /* não existe */ }
    const same = current && current.target === options.target && current.args === options.args && current.appUserModelId === AUMID;
    if (!same) shell.writeShortcutLink(lnk, current ? 'replace' : 'create', options);
  } catch (e) {
    console.error('não foi possível criar o atalho do Menu Iniciar:', e);
  }
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ------------------------------------------------------------ ciclo de vida

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  loadConfig();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: NAME,
      submenu: [
        { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
        { label: 'Trocar o servidor do escritório…', click: () => showSetup() },
        { label: 'Ferramentas do desenvolvedor', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Aumentar zoom', accelerator: 'CmdOrCtrl+=', click: () => zoomBy(0.5) },
        { label: 'Aumentar zoom', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => zoomBy(0.5) },
        { label: 'Diminuir zoom', accelerator: 'CmdOrCtrl+-', click: () => zoomBy(-0.5) },
        { label: 'Zoom normal', accelerator: 'CmdOrCtrl+0', click: () => zoomBy(0) },
        { type: 'separator' },
        { label: 'Sair', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' }, { role: 'redo', label: 'Refazer' }, { type: 'separator' },
        { role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
      ],
    },
  ]));

  // ao voltar da suspensão, a conexão do WhatsApp do modo local morreu: reconecta
  powerMonitor.on('resume', () => {
    local?.core.onResume();
    if (win && baseUrl && config.mode === 'remote') win.webContents.reload();
  });

  ensureStartMenuShortcut();
  applyLoginItem();
  setupDownloads();
  createWindow();
  createTray();
  await openSystem();
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || quitting) app.quit();
});
app.on('will-quit', async (e) => {
  if (!local) return;
  e.preventDefault();
  const srv = local;
  local = null;
  await srv.close().catch(() => {});
  app.exit(0);
});
app.on('activate', showWindow);
