// App de desktop "Barros Associados": uma janela própria (com ícone, bandeja
// e notificações do Windows) que abre o sistema do servidor do escritório.
//
// Dois modos (escolhidos na primeira vez, trocáveis pelo menu):
// - servidor: abre o endereço do servidor do escritório (ex.: https://sistema.barrosassociados.adv.br);
// - local: liga o servidor neste mesmo computador (o jeito do app antigo,
//   com os mesmos dados de %APPDATA%\WhatsAppCRM) e abre ele.
import {
  app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, powerMonitor, safeStorage, session, dialog,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DEMO = process.argv.includes('--demo') || process.env.CRM_DEMO === '1';
const NAME = 'Barros Associados';
const LOCAL_PORT = Number(process.env.CRM_PORT || (DEMO ? 3211 : 3210));

// Pasta de dados do modo local: a mesma do app antigo (nada se perde).
const DATA_DIR = process.env.CRM_DATA_DIR
  || path.join(app.getPath('appData'), DEMO ? 'WhatsAppCRM-Demo' : 'WhatsAppCRM');
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
  // primeira vez num computador que já usava o app antigo: continua local, com os mesmos dados
  if (!config.mode && (DEMO || fs.existsSync(path.join(DATA_DIR, 'crm.sqlite')))) config.mode = 'local';
}
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2));
}

// ------------------------------------------------------------ janela

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
  if (config.windowMaximized) win.maximize();
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
    case 'openNotificationSettings': if (process.platform === 'win32') shell.openExternal('ms-settings:notifications'); return null;
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
        { role: 'zoomIn', label: 'Aumentar zoom' },
        { role: 'zoomOut', label: 'Diminuir zoom' },
        { role: 'resetZoom', label: 'Zoom normal' },
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
