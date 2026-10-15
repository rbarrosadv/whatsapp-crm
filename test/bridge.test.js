// Ponte do WhatsApp pelo computador do escritório (src/main/bridge.js): o
// servidor abre conexões pelo WebSocket do app de desktop. Aqui um "WhatsApp"
// local (HTTPS + WebSocket com certificado próprio) faz o papel do real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { Bridge, serveBridge, bridgeAllowed } from '../src/main/bridge.js';

const big = Buffer.alloc(5 * 1024 * 1024, 7);
let wa; let waPort; let hub; let hubPort; let bridge; let pc; let opened = [];

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.whatsapp.com',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  // o "WhatsApp": GET /x, GET /grande, POST /upload (eco do tamanho) e WebSocket de eco
  wa = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    if (req.url === '/grande') { res.end(big); return; }
    if (req.method === 'POST') {
      let n = 0;
      req.on('data', (c) => { n += c.length; });
      req.on('end', () => res.end(JSON.stringify({ got: n, host: req.headers.host })));
      return;
    }
    res.end(`ola ${req.headers.host}`);
  });
  const wss = new WebSocketServer({ server: wa });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`eco:${m}`)));
  await new Promise((ok) => wa.listen(0, '127.0.0.1', ok));
  waPort = wa.address().port;

  // o servidor do sistema, com a rota /bridge
  bridge = new Bridge({ allow: () => true, tlsOptions: { rejectUnauthorized: false } });
  hub = http.createServer();
  const hubWss = new WebSocketServer({ server: hub });
  hubWss.on('connection', (ws) => bridge.attach(ws, { name: 'PC-ESCRITORIO' }));
  await new Promise((ok) => hub.listen(0, '127.0.0.1', ok));
  hubPort = hub.address().port;

  // o computador do escritório: tudo vai para o "WhatsApp" local
  const up = new Promise((ok) => bridge.once('up', ok));
  pc = new WebSocket(`ws://127.0.0.1:${hubPort}/bridge`);
  serveBridge(pc, {
    allow: () => true,
    connect: (o) => { opened.push(`${o.host}:${o.port}`); return net.connect({ host: '127.0.0.1', port: waPort }); },
  });
  await up;
});

after(async () => {
  pc?.close();
  bridge?.close();
  await new Promise((ok) => hub.close(ok));
  await new Promise((ok) => { wa.closeAllConnections?.(); wa.close(ok); });
});

test('só endereços do WhatsApp na porta 443', () => {
  assert.ok(bridgeAllowed('web.whatsapp.com', 443));
  assert.ok(bridgeAllowed('mmg.whatsapp.net', 443));
  assert.ok(bridgeAllowed('media-gru2-1.cdn.whatsapp.net', 443));
  assert.ok(!bridgeAllowed('web.whatsapp.com', 80));
  assert.ok(!bridgeAllowed('whatsapp.com.evil.io', 443));
  assert.ok(!bridgeAllowed('google.com', 443));
  const b = new Bridge();
  assert.throws(() => b.open('google.com', 443), /não permitido/);
  assert.throws(() => b.open('web.whatsapp.com', 443), /desligado/);
});

test('fetch (download de mídia, fotos) sai pelo computador do escritório', async () => {
  opened = [];
  const dispatcher = bridge.dispatcher();
  const r = await fetch('https://mmg.whatsapp.net/x', { dispatcher });
  assert.equal(await r.text(), 'ola mmg.whatsapp.net');
  assert.deepEqual(opened, ['mmg.whatsapp.net:443']);
  const g = Buffer.from(await (await fetch('https://mmg.whatsapp.net/grande', { dispatcher })).arrayBuffer());
  assert.equal(g.length, big.length);
  assert.ok(g.equals(big));
});

test('WebSocket do Baileys (ws com agent) sai pela ponte', async () => {
  opened = [];
  const ws = new WebSocket('wss://web.whatsapp.com/ws/chat', { agent: bridge.agent() });
  const reply = await new Promise((ok, fail) => {
    ws.on('open', () => ws.send('oi'));
    ws.on('message', (m) => ok(String(m)));
    ws.on('error', fail);
  });
  assert.equal(reply, 'eco:oi');
  assert.deepEqual(opened, ['web.whatsapp.com:443']);
  ws.close();
});

test('envio de mídia (https com agent) sai pela ponte', async () => {
  const body = Buffer.alloc(2 * 1024 * 1024, 1);
  const out = await new Promise((ok, fail) => {
    const req = https.request('https://mmg.whatsapp.net/upload', { method: 'POST', agent: bridge.agent() }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => ok(JSON.parse(s)));
    });
    req.on('error', fail);
    req.end(body);
  });
  assert.equal(out.got, body.length);
  assert.equal(out.host, 'mmg.whatsapp.net');
});

test('computador desligado: conexões abertas caem e novas são recusadas', async () => {
  const ws = new WebSocket('wss://web.whatsapp.com/ws/chat', { agent: bridge.agent() });
  await new Promise((ok) => ws.on('open', ok));
  const closed = new Promise((ok) => ws.on('close', ok));
  ws.on('error', () => {});
  const down = new Promise((ok) => bridge.once('down', ok));
  pc.close();
  await down;
  await closed;
  assert.equal(bridge.up, false);
  assert.equal(bridge.streams.size, 0);
  assert.throws(() => bridge.open('web.whatsapp.com', 443), /desligado/);
});
