// Ponte do WhatsApp pelo computador do escritório.
//
// O servidor fica num data center (Oracle); para o WhatsApp, uma conexão que sai
// de lá parece robô e o número já foi suspenso por isso. Com a ponte, o app de
// desktop de um computador do escritório abre um WebSocket com o servidor
// (/bridge) e é por ele que saem as conexões do WhatsApp: o servidor pede
// "abre web.whatsapp.com:443", o computador abre e repassa os bytes. A
// criptografia (TLS) continua de ponta a ponta entre o servidor e o WhatsApp — o
// computador só carrega bytes — e para o WhatsApp a conexão vem da internet do
// escritório, como um WhatsApp Web comum.
//
// Só endereços do WhatsApp na porta 443 (dos dois lados).
//
// Quadros binários: [tipo 1 byte][id 4 bytes][dados]
//   OPEN  servidor → computador  {host, port} em JSON
//   OK    computador → servidor  conexão aberta
//   DATA  os dois lados          bytes
//   END   os dois lados          terminou de enviar
//   CLOSE os dois lados          fechou (dados = motivo, se houver erro)
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { Agent as UndiciAgent } from 'undici';

export const T = { OPEN: 1, OK: 2, DATA: 3, END: 4, CLOSE: 5 };

/** Só o WhatsApp (conexão, mídia, fotos) e só HTTPS. */
export function bridgeAllowed(host, port) {
  return Number(port) === 443 && /(^|\.)whatsapp\.(net|com)$/i.test(String(host || ''));
}

export function frame(type, id, payload) {
  const body = payload == null ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(id, 1);
  return Buffer.concat([head, body]);
}

export function unframe(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 5) return null;
  return { type: b[0], id: b.readUInt32BE(1), data: b.subarray(5) };
}

/** Uma conexão (host:porta) aberta pelo computador do escritório, vista do servidor. */
class BridgeStream extends Duplex {
  constructor(bridge, id, host, port) {
    super({ allowHalfOpen: false });
    this.bridge = bridge;
    this.id = id;
    this.host = host;
    this.port = port;
    this.remoteClosed = false;
  }

  _write(chunk, _enc, cb) {
    if (!this.bridge.send(T.DATA, this.id, chunk, cb)) cb(new Error('ponte do escritório desligada'));
  }

  _final(cb) {
    this.bridge.send(T.END, this.id);
    cb();
  }

  _read() { /* os dados chegam quando chegam (ws) */ }

  _destroy(err, cb) {
    this.bridge.streams.delete(this.id);
    if (!this.remoteClosed) this.bridge.send(T.CLOSE, this.id);
    cb(err);
  }

  // o http/tls às vezes chama estes como se fosse um socket de verdade
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setTimeout(ms, fn) { if (fn) this.once('timeout', fn); return this; }
  ref() { return this; }
  unref() { return this; }
}

/**
 * Lado do servidor. `attach(ws, info)` recebe o WebSocket do computador do
 * escritório (só um por vez); `open(host, port)` devolve um Duplex; `agent()` e
 * `dispatcher()` servem para o Baileys (WebSocket, envio de mídia) e para o
 * fetch (download de mídia, fotos).
 */
export class Bridge extends EventEmitter {
  constructor({ allow = bridgeAllowed, tlsOptions = {} } = {}) {
    super();
    this.allow = allow;
    this.tlsOptions = tlsOptions; // testes: certificado próprio
    this.ws = null;
    this.info = null;
    this.streams = new Map();
    this.nextId = 1;
    this._agent = null;
    this._dispatcher = null;
  }

  get up() { return !!this.ws && this.ws.readyState === 1; }

  status() {
    return { up: this.up, ...(this.info || {}) };
  }

  attach(ws, info = {}) {
    // o mais novo vale (ex.: o computador reconectou antes de a conexão antiga cair)
    if (this.ws && this.ws !== ws) this.detach(this.ws, 'substituída');
    this.ws = ws;
    this.info = { ...info, since: Date.now() };
    this.alive = true;
    ws.on('message', (data, isBinary) => { if (isBinary) this.onFrame(data); });
    ws.on('pong', () => { this.alive = true; });
    ws.on('close', () => this.detach(ws, 'fechada'));
    ws.on('error', () => {});
    clearInterval(this.pinger);
    this.pinger = setInterval(() => {
      if (this.ws !== ws) return;
      if (!this.alive) { ws.terminate(); this.detach(ws, 'sem resposta'); return; }
      this.alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }, 20000);
    this.pinger.unref?.();
    this.emit('up', this.status());
  }

  detach(ws, reason) {
    if (this.ws !== ws) return;
    clearInterval(this.pinger);
    this.ws = null;
    try { ws.close(); } catch { /* ignore */ }
    const err = new Error(`ponte do escritório ${reason || 'desligada'}`);
    for (const s of [...this.streams.values()]) { s.remoteClosed = true; s.destroy(err); }
    this.streams.clear();
    this.info = this.info ? { ...this.info, lastSeen: Date.now() } : null;
    this.emit('down', reason);
  }

  /** Fecha a ponte (ex.: o sócio desligou ou trocou o computador). */
  close(reason = 'desligada') { if (this.ws) this.detach(this.ws, reason); }

  send(type, id, payload, cb) {
    if (!this.up) return false;
    this.ws.send(frame(type, id, payload), { binary: true }, cb);
    return true;
  }

  onFrame(data) {
    const f = unframe(data);
    if (!f) return;
    const s = this.streams.get(f.id);
    if (!s) return;
    if (f.type === T.OK) s.emit('bridge-open');
    else if (f.type === T.DATA) s.push(f.data);
    else if (f.type === T.END) s.push(null);
    else if (f.type === T.CLOSE) {
      s.remoteClosed = true;
      s.destroy(f.data.length ? new Error(f.data.toString()) : undefined);
    }
  }

  open(host, port = 443) {
    if (!this.allow(host, port)) throw new Error(`endereço não permitido pela ponte: ${host}:${port}`);
    if (!this.up) throw new Error('O computador do escritório que conecta o WhatsApp está desligado.');
    const id = this.nextId++;
    if (this.nextId > 0xfffffff0) this.nextId = 1;
    const s = new BridgeStream(this, id, host, port);
    this.streams.set(id, s);
    this.send(T.OPEN, id, JSON.stringify({ host, port }));
    return s;
  }

  /** TLS por cima da ponte (o computador do escritório não vê o conteúdo). */
  tlsOpen(host, port, extra = {}) {
    return tls.connect({ ...this.tlsOptions, ...extra, socket: this.open(host, port), servername: extra.servername || host });
  }

  /** Para o `ws` do Baileys e o envio de mídia (https). */
  agent() {
    if (this._agent) return this._agent;
    const bridge = this;
    class BridgeAgent extends https.Agent {
      createConnection(opts) {
        return bridge.tlsOpen(opts.host || opts.hostname, Number(opts.port) || 443, {
          servername: opts.servername, ALPNProtocols: ['http/1.1'],
        });
      }
    }
    this._agent = new BridgeAgent({ keepAlive: false });
    return this._agent;
  }

  /** Para o fetch (download de mídia, fotos de perfil, versão do WhatsApp Web). */
  dispatcher() {
    if (this._dispatcher) return this._dispatcher;
    this._dispatcher = new UndiciAgent({
      connect: (opts, cb) => {
        let sock;
        try {
          sock = this.tlsOpen(opts.hostname, Number(opts.port) || 443, { servername: opts.servername || opts.hostname, ALPNProtocols: ['http/1.1'] });
        } catch (e) { cb(e, null); return; }
        let done = false;
        sock.once('secureConnect', () => { if (!done) { done = true; cb(null, sock); } });
        sock.once('error', (e) => { if (!done) { done = true; cb(e, null); } });
      },
    });
    return this._dispatcher;
  }
}

/**
 * Lado do computador do escritório: recebe os pedidos de conexão pelo
 * WebSocket e abre cada um na internet daqui. `ws` = WebSocket já aberto
 * (pacote `ws`). Devolve uma função que fecha tudo.
 */
export function serveBridge(ws, { allow = bridgeAllowed, connect = (o) => net.connect(o), log = () => {} } = {}) {
  const socks = new Map();
  const send = (type, id, payload) => {
    if (ws.readyState !== 1) return;
    ws.send(frame(type, id, payload), { binary: true });
  };
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const f = unframe(data);
    if (!f) return;
    if (f.type === T.OPEN) {
      let target;
      try { target = JSON.parse(f.data.toString()); } catch { target = {}; }
      if (!allow(target.host, target.port)) { send(T.CLOSE, f.id, 'endereço não permitido'); return; }
      const sock = connect({ host: target.host, port: Number(target.port) });
      socks.set(f.id, sock);
      sock.on('connect', () => send(T.OK, f.id));
      sock.on('data', (chunk) => {
        send(T.DATA, f.id, chunk);
        // o servidor está lento para receber: segura a leitura daqui
        if (ws.bufferedAmount > 4 * 1024 * 1024) {
          sock.pause();
          const wait = setInterval(() => {
            if (ws.readyState !== 1 || ws.bufferedAmount < 1024 * 1024) { clearInterval(wait); sock.resume(); }
          }, 50);
        }
      });
      sock.on('end', () => send(T.END, f.id));
      sock.on('error', (e) => { log(`ponte: ${target.host} ${e.message}`); });
      sock.on('close', () => { if (socks.delete(f.id)) send(T.CLOSE, f.id); });
    } else {
      const sock = socks.get(f.id);
      if (!sock) return;
      if (f.type === T.DATA) sock.write(f.data);
      else if (f.type === T.END) sock.end();
      else if (f.type === T.CLOSE) { socks.delete(f.id); sock.destroy(); }
    }
  });
  const closeAll = () => { for (const s of socks.values()) s.destroy(); socks.clear(); };
  ws.on('close', closeAll);
  return closeAll;
}

/**
 * App de desktop do computador do escritório: mantém a ponte ligada com o
 * servidor (reconecta sozinho, mais devagar se a chave for recusada).
 * `WebSocket` = classe do pacote `ws`. Devolve { stop() }.
 */
export function runBridgeClient({ url, token, name = '', WebSocket, onStatus = () => {}, log = () => {}, connect } = {}) {
  const wsUrl = `${String(url).replace(/\/+$/, '').replace(/^http/i, 'ws')}/bridge`;
  let ws = null;
  let stopped = false;
  let timer = null;
  let delay = 2000;
  let lastPing = 0;
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(open, delay);
    delay = Math.min(delay * 2, 60000);
  };
  function open() {
    if (stopped) return;
    let refused = false;
    ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}`, 'X-Bridge-Name': encodeURIComponent(name) },
      handshakeTimeout: 15000,
    });
    ws.on('open', () => { delay = 2000; lastPing = Date.now(); onStatus({ up: true, error: null }); });
    ws.on('ping', () => { lastPing = Date.now(); });
    ws.on('error', (e) => {
      // 401 = chave trocada/desligada por um sócio: tenta de novo só a cada 10 min
      if (/401/.test(e.message)) { refused = true; delay = 10 * 60e3; }
      log(`ponte: ${e.message}`);
    });
    ws.on('close', () => {
      onStatus({ up: false, error: refused ? 'O servidor recusou este computador (foi escolhido outro?).' : null });
      schedule();
    });
    serveBridge(ws, { connect, log });
  }
  // o servidor manda ping a cada 20 s; sem nenhum há 70 s, a conexão morreu sem avisar
  const watch = setInterval(() => {
    if (ws?.readyState === 1 && Date.now() - lastPing > 70000) ws.terminate();
  }, 15000);
  watch.unref?.();
  open();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(watch);
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
