// Ligação da interface com o servidor: API por HTTP (/api/<método>) e
// eventos pelo WebSocket (/events). Funciona igual no navegador, no celular
// e no app de desktop (que só abre esta página numa janela própria).

const listeners = new Map();
let conn = null;
let ws = null;
let retry = 0;
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });

function dispatch(channel, payload) {
  for (const cb of listeners.get(channel) || []) {
    try { cb(payload); } catch (err) { console.error(err); }
  }
}

function toLogin() {
  if (!location.pathname.endsWith('/login.html')) location.href = '/login.html';
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/events`);
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.ch === 'hello') {
      const again = conn !== null;
      conn = msg.data.conn;
      retry = 0;
      readyResolve();
      if (again) dispatch('bridge:reconnected', null);
      dispatch('bridge:online', true);
      return;
    }
    dispatch(msg.ch, msg.data);
  };
  ws.onclose = (e) => {
    if (e.code === 4001) { toLogin(); return; }
    dispatch('bridge:online', false);
    // servidor reiniciando ou internet caiu: tenta de novo (1 s, 2 s, … até 15 s)
    const wait = Math.min(15000, 1000 * 2 ** retry++);
    setTimeout(async () => {
      try {
        const r = await fetch('/auth/state', { cache: 'no-store' });
        const st = await r.json();
        if (!st.user) { toLogin(); return; }
      } catch { /* sem rede: tenta de novo */ }
      connect();
    }, wait);
  };
  ws.onerror = () => {};
}

async function call(method, ...args) {
  let r;
  try {
    r = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CRM': '1', ...(conn ? { 'X-Conn': conn } : {}) },
      body: JSON.stringify({ args }),
    });
  } catch {
    throw new Error('Sem conexão com o servidor do escritório. Verifique a internet.');
  }
  if (r.status === 401) { toLogin(); throw new Error('Sessão expirada. Entre de novo.'); }
  const data = await r.json().catch(() => ({ ok: false, error: `Erro ${r.status}` }));
  if (!data.ok) throw new Error(data.error || 'Erro no servidor');
  return data.result;
}

/** Envia um arquivo (File/Blob) ao servidor; devolve o token usado nos métodos da API. */
async function upload(file, name = file.name || 'arquivo') {
  const r = await fetch('/upload', {
    method: 'POST',
    headers: { 'X-CRM': '1', 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (r.status === 401) { toLogin(); throw new Error('Sessão expirada. Entre de novo.'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Falha ao enviar ${name}`);
  return data.token;
}

window.api = {
  call,
  upload,
  ready: Promise.race([ready, new Promise((r) => setTimeout(r, 4000))]),
  on(channel, cb) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    return () => listeners.get(channel).delete(cb);
  },
  async logout() {
    await fetch('/auth/logout', { method: 'POST', headers: { 'X-CRM': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    location.href = '/login.html';
  },
};

connect();
