// Servidor do sistema: entrega a interface, atende a API (/api/<método>),
// avisa as janelas abertas pelo WebSocket (/events), serve a mídia (/media)
// e recebe arquivos (/upload). Login por cookie de sessão.
//
// Uso:  node src/server/server.js [--demo] [--port 3210] [--host 127.0.0.1]
// Pasta de dados: CRM_DATA_DIR (padrão: a mesma do app antigo).
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as auth from './auth.js';
import { createCore, defaultDataDir } from './core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const ASSETS = path.join(ROOT, 'assets');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
const COOKIE = 'bsess';
const MAX_UPLOAD = 100 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
  + "media-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isHttps = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

function sessionCookie(req, token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Conteúdo grande demais'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const b = await readBody(req);
  try { return JSON.parse(b.toString('utf-8') || '{}'); } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}

/** Serve um arquivo (com suporte a Range, para áudio e vídeo poderem avançar). */
function serveFile(req, res, file, { download, cache = 'no-cache', csp } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404); res.end('não encontrado'); return; }
  if (!st.isFile()) { res.writeHead(404); res.end('não encontrado'); return; }
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };
  if (csp) headers['Content-Security-Policy'] = csp;
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

/** Caminho dentro de `base` (nunca fora dela). */
function inside(base, rel) {
  const abs = path.resolve(base, rel);
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}

// tentativas de login erradas por IP (trava por 15 min após 10 erros)
const failures = new Map();
function tooMany(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > 15 * 60 * 1000) { failures.delete(ip); return false; }
  return f.n >= 10;
}
function failed(ip) {
  const f = failures.get(ip) || { n: 0, since: Date.now() };
  f.n++;
  failures.set(ip, f);
}

/** Se há um backup esperando (restaurar.sqlite), ele vira o banco; o atual fica guardado. */
function applyPendingRestore(dataDir) {
  const pending = path.join(dataDir, 'restaurar.sqlite');
  if (!fs.existsSync(pending)) return;
  const db = path.join(dataDir, 'crm.sqlite');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  if (fs.existsSync(db)) fs.renameSync(db, path.join(dataDir, `crm-antes-da-restauracao-${stamp}.sqlite`));
  for (const ext of ['-wal', '-shm']) fs.rmSync(db + ext, { force: true });
  fs.renameSync(pending, db);
  console.log('backup restaurado; o banco anterior ficou guardado como', `crm-antes-da-restauracao-${stamp}.sqlite`);
}

/**
 * Sobe o servidor. Devolve { url, core, close }.
 * @param {{dataDir?: string, demo?: boolean, port?: number, host?: string, safeStorage?: object}} opts
 */
export async function startServer({
  dataDir, demo = false, port = 3210, host = '127.0.0.1', safeStorage, requireSetupCode = false, restartable = false,
} = {}) {
  dataDir = dataDir || defaultDataDir(demo);
  applyPendingRestore(dataDir);
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  // envios que ficaram para trás (mais de 1 dia)
  const cleanUploads = () => {
    for (const d of fs.readdirSync(uploadDir)) {
      const p = path.join(uploadDir, d);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
  cleanUploads();

  const resolveUpload = (token) => {
    if (!/^[a-f0-9]{32}$/.test(String(token))) return null;
    const dir = path.join(uploadDir, token);
    const [name] = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    return name ? { path: path.join(dir, name), name } : null;
  };

  const core = await createCore({ dataDir, demo, version: VERSION, safeStorage, resolveUpload, features: { restore: restartable } });

  // Num servidor na internet, quem chegasse primeiro criaria o sócio: o primeiro
  // acesso pede um código que só aparece para quem instalou (tela e arquivo).
  let setupCode = null;
  const setupFile = path.join(dataDir, 'codigo-primeiro-acesso.txt');
  if (requireSetupCode && auth.countUsers() === 0) {
    setupCode = String(crypto.randomInt(100000, 1000000));
    fs.writeFileSync(setupFile, `${setupCode}\n`, { mode: 0o600 });
    console.log(`Código de primeiro acesso: ${setupCode} (também em ${setupFile})`);
  }
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set();

  core.events.on('event', (channel, payload, to) => {
    const msg = JSON.stringify({ ch: channel, data: payload ?? null });
    for (const ws of sockets) {
      if (to?.conn && ws.conn !== to.conn) continue;
      if (to?.user && ws.userId !== to.user) continue;
      if (channel === 'notify' && payload?.audience === 'finance') {
        const u = auth.getUser(ws.userId);
        if (!u || !auth.can(u.role, 'finance:list')) continue;
      }
      if (ws.readyState === 1) ws.send(msg);
    }
    // alguém foi desativado: fecha as janelas dele
    if (channel === 'users:changed') {
      for (const ws of sockets) if (!auth.getUser(ws.userId)?.active) ws.close(4001, 'sessão encerrada');
    }
  });

  const userOf = (req) => auth.sessionUser(cookies(req)[COOKIE]);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    // atrás do proxy (Caddy) o endereço real vem no X-Forwarded-For
    const loopback = /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '');
    const ip = (loopback && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
    // aberto no próprio computador do servidor (não veio pelo proxy): quem está
    // ali já tem acesso ao arquivo do código, então o primeiro acesso não pede
    const sameMachine = loopback && !req.headers['x-forwarded-for'];
    const needsCode = !!setupCode && !sameMachine;
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');

    // ---------------------------------------------------- login
    if (p === '/auth/state' && req.method === 'GET') {
      const u = userOf(req);
      const setup = auth.countUsers() === 0;
      return sendJson(res, 200, { setup, setupCode: setup && needsCode, user: auth.publicUser(u), demo });
    }
    if (p.startsWith('/auth/') && req.method === 'POST') {
      if (req.headers['x-crm'] !== '1') return sendJson(res, 403, { error: 'requisição recusada' });
      const body = await readJson(req);
      if (p === '/auth/login') {
        if (tooMany(ip)) return sendJson(res, 429, { error: 'Muitas tentativas erradas. Espere 15 minutos e tente de novo.' });
        const u = auth.authenticate(body.login, body.password);
        if (!u) { failed(ip); return sendJson(res, 401, { error: 'Login ou senha incorretos.' }); }
        failures.delete(ip);
        const token = auth.createSession(u.id, req.headers['user-agent']);
        return sendJson(res, 200, { user: auth.publicUser(u) }, { 'Set-Cookie': sessionCookie(req, token, 30 * 24 * 3600) });
      }
      if (p === '/auth/setup') {
        if (needsCode && auth.countUsers() === 0) {
          if (tooMany(ip)) return sendJson(res, 429, { error: 'Muitas tentativas erradas. Espere 15 minutos e tente de novo.' });
          if (String(body.code || '').trim() !== setupCode) { failed(ip); return sendJson(res, 400, { error: 'Código de primeiro acesso incorreto.' }); }
        }
        try {
          const id = auth.setupFirstUser(body);
          fs.rmSync(setupFile, { force: true });
          const token = auth.createSession(id, req.headers['user-agent']);
          return sendJson(res, 200, { user: auth.publicUser(auth.getUser(id)) }, { 'Set-Cookie': sessionCookie(req, token, 30 * 24 * 3600) });
        } catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      if (p === '/auth/logout') {
        auth.endSession(cookies(req)[COOKIE]);
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
      }
      return sendJson(res, 404, { error: 'não encontrado' });
    }

    // ---------------------------------------------------- páginas públicas
    if (p === '/login.html' || p === '/login.js' || p === '/styles.css' || p.startsWith('/assets/')) {
      const file = p.startsWith('/assets/') ? inside(ASSETS, p.slice(8)) : path.join(RENDERER, p.slice(1));
      if (!file) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, file, { csp: CSP, cache: p.startsWith('/assets/') ? 'max-age=86400' : 'no-cache' });
    }
    if (p === '/manifest.webmanifest' || p === '/sw.js') {
      return serveFile(req, res, path.join(RENDERER, p.slice(1)), { csp: CSP });
    }

    const user = userOf(req);
    if (!user) {
      if (p === '/' || p.endsWith('.html')) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
      return sendJson(res, 401, { error: 'Sessão expirada. Entre de novo.', login: true });
    }

    // ---------------------------------------------------- API
    if (p.startsWith('/api/') && req.method === 'POST') {
      if (req.headers['x-crm'] !== '1') return sendJson(res, 403, { error: 'requisição recusada' });
      const method = p.slice(5);
      try {
        const body = await readJson(req);
        let conn = String(req.headers['x-conn'] || '') || null;
        if (conn && ![...sockets].some((ws) => ws.conn === conn && ws.userId === user.id)) conn = null;
        const result = await core.call(method, body.args || [], { user, conn });
        return sendJson(res, 200, { ok: true, result: result ?? null });
      } catch (e) {
        if (!/permissão|desconhecid/.test(e.message)) console.error(`api ${method}:`, e.message);
        return sendJson(res, e.status || 200, { ok: false, error: e.message || String(e) });
      }
    }

    // ---------------------------------------------------- arquivos
    if (p === '/upload' && req.method === 'POST') {
      if (req.headers['x-crm'] !== '1') return sendJson(res, 403, { error: 'requisição recusada' });
      const name = path.basename(decodeURIComponent(String(req.headers['x-file-name'] || 'arquivo'))).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'arquivo';
      if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return sendJson(res, 413, { error: 'Arquivo maior que 100 MB.' });
      const token = crypto.randomBytes(16).toString('hex');
      const dir = path.join(uploadDir, token);
      fs.mkdirSync(dir);
      const file = path.join(dir, name);
      let size = 0;
      const out = fs.createWriteStream(file);
      try {
        await new Promise((resolve, reject) => {
          req.on('data', (c) => {
            size += c.length;
            if (size > MAX_UPLOAD) { reject(Object.assign(new Error('Arquivo maior que 100 MB.'), { status: 413 })); req.destroy(); }
          });
          req.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          req.on('error', reject);
        });
      } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        return sendJson(res, e.status || 500, { error: e.message });
      }
      return sendJson(res, 200, { token, name, size });
    }
    if (p.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      let file;
      try { file = core.resolveMedia(p.slice(7)); } catch { res.writeHead(404); return res.end(); }
      return serveFile(req, res, file, { download: url.searchParams.get('download') || undefined, cache: 'private, max-age=3600', csp: "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" });
    }
    // volta do login da Microsoft (OneDrive do escritório) — só sócio
    if (p === '/onedrive/callback' && req.method === 'GET') {
      const back = (q) => { res.writeHead(302, { Location: `/?${q}`, 'Cache-Control': 'no-store' }); res.end(); };
      if (user.role !== 'socio') return back('onedrive=erro&msg=' + encodeURIComponent('Só um sócio conecta o OneDrive.'));
      if (url.searchParams.get('error')) return back('onedrive=erro&msg=' + encodeURIComponent(url.searchParams.get('error_description') || url.searchParams.get('error')));
      try {
        await core.onedriveCallback(url.searchParams.get('code'), url.searchParams.get('state'));
        return back('onedrive=ok');
      } catch (e) { return back('onedrive=erro&msg=' + encodeURIComponent(e.message)); }
    }
    // arquivos da pasta do escritório (OneDrive), com a mesma regra de quem vê o quê
    if (p.startsWith('/docs/file/') && (req.method === 'GET' || req.method === 'HEAD')) {
      let rel;
      try { rel = core.docs.check(p.slice(11), user); } catch { res.writeHead(404); return res.end(); }
      const file = core.docs.localPath(rel);
      if (file) return serveFile(req, res, file, { download: url.searchParams.get('download') || undefined, csp: "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" });
      // OneDrive pela API: link temporário da Microsoft (o arquivo vem direto de lá)
      try {
        const link = await core.docs.store()?.downloadUrl?.(rel);
        if (!link) { res.writeHead(404); return res.end(); }
        res.writeHead(302, { Location: link, 'Cache-Control': 'no-store' });
        return res.end();
      } catch (e) { return sendJson(res, 502, { error: e.message }); }
    }
    if (p === '/download/backup' && user.role === 'socio') {
      const file = core.backupFile();
      res.on('close', () => fs.rmSync(file, { force: true }));
      return serveFile(req, res, file, { download: `backup-barros-associados-${new Date().toISOString().slice(0, 10)}.sqlite` });
    }
    // restaurar um backup (ex.: trazer os dados do computador para o servidor):
    // guarda o arquivo e reinicia; a troca acontece antes de abrir o banco.
    if (p === '/admin/restore' && req.method === 'POST' && user.role === 'socio' && restartable) {
      if (req.headers['x-crm'] !== '1') return sendJson(res, 403, { error: 'requisição recusada' });
      const tmp = path.join(dataDir, 'restaurar.parcial');
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
      const head = Buffer.alloc(16);
      const fd = fs.openSync(tmp, 'r');
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      if (head.toString('latin1') !== 'SQLite format 3\0') {
        fs.rmSync(tmp, { force: true });
        return sendJson(res, 400, { error: 'Este arquivo não é um backup do sistema (.sqlite).' });
      }
      fs.renameSync(tmp, path.join(dataDir, 'restaurar.sqlite'));
      sendJson(res, 200, { ok: true });
      console.log('backup recebido para restaurar: reiniciando');
      setTimeout(() => process.exit(0), 500); // o systemd liga de novo
      return undefined;
    }
    if (p === '/download/logs' && user.role === 'socio') {
      return serveFile(req, res, core.logFile, { download: 'registro-whatsapp.log' });
    }

    // ---------------------------------------------------- interface
    if (req.method === 'GET' || req.method === 'HEAD') {
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const file = inside(RENDERER, rel);
      if (file) return serveFile(req, res, file, { csp: CSP });
    }
    res.writeHead(404);
    res.end('não encontrado');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
      else res.end();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const origin = req.headers.origin;
    const user = url.pathname === '/events' ? userOf(req) : null;
    // só janelas do próprio sistema (mesmo endereço) podem abrir o canal de eventos
    const sameOrigin = !origin || new URL(origin).host === req.headers.host;
    if (!user || !sameOrigin) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.conn = crypto.randomBytes(12).toString('hex');
      ws.userId = user.id;
      ws.alive = true;
      sockets.add(ws);
      ws.on('pong', () => { ws.alive = true; });
      ws.on('close', () => { sockets.delete(ws); core.dropConn(ws.conn); });
      ws.on('error', () => {});
      ws.send(JSON.stringify({ ch: 'hello', data: { conn: ws.conn } }));
    });
  });

  // derruba conexões mortas (rede caiu sem fechar)
  const ping = setInterval(() => {
    for (const ws of sockets) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  const cleaner = setInterval(cleanUploads, 3600 * 1000);
  // backup automático: um por dia em backups/, guarda os últimos 14
  const dailyBackup = () => {
    try {
      const dir = path.join(dataDir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `crm-${new Date().toISOString().slice(0, 10)}.sqlite`);
      if (!fs.existsSync(file)) core.backupFile(file);
      const old = fs.readdirSync(dir).filter((f) => /^crm-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -14);
      old.forEach((f) => fs.rmSync(path.join(dir, f), { force: true }));
    } catch (e) { console.error('backup automático:', e.message); }
  };
  const backupTimer = demo ? null : setInterval(dailyBackup, 3600 * 1000);
  if (!demo) setTimeout(dailyBackup, 60 * 1000);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}`;

  return {
    url, core, server,
    async close() {
      clearInterval(ping);
      clearInterval(cleaner);
      clearInterval(backupTimer);
      for (const ws of sockets) ws.terminate();
      await new Promise((r) => server.close(r));
      await core.stop();
    },
  };
}

// ------------------------------------------------------------ linha de comando
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const demo = process.argv.includes('--demo') || process.env.CRM_DEMO === '1';
  const srv = await startServer({
    demo,
    dataDir: process.env.CRM_DATA_DIR || undefined,
    port: Number(arg('port', process.env.PORT || 3210)),
    host: arg('host', process.env.HOST || '127.0.0.1'),
    requireSetupCode: !demo,
    restartable: process.env.CRM_RESTARTABLE === '1',
  });
  console.log(`Barros Associados ${VERSION}${demo ? ' (demonstração)' : ''} — abra ${srv.url}`);
  const stop = async () => { await srv.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
