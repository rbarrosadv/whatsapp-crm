// Diagnóstico da conexão com o WhatsApp, passo a passo: endereço (DNS),
// conexão segura (TLS, e quem assinou o certificado — se for um antivírus,
// ele está interceptando) e abertura do canal (WebSocket).
import dns from 'node:dns/promises';
import tls from 'node:tls';
import WebSocket from 'ws';

const HOST = 'web.whatsapp.com';

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: sem resposta em ${ms / 1000} s`)), ms); }),
  ]);
}

async function checkDns() {
  const { address } = await withTimeout(dns.lookup(HOST), 8000, 'DNS');
  return `endereço encontrado (${address})`;
}

function checkTls() {
  return withTimeout(new Promise((resolve, reject) => {
    const sock = tls.connect({ host: HOST, port: 443, servername: HOST }, () => {
      const cert = sock.getPeerCertificate();
      const issuer = [cert?.issuer?.O, cert?.issuer?.CN].filter(Boolean).join(' / ');
      sock.end();
      resolve({ issuer, authorized: sock.authorized });
    });
    sock.on('error', reject);
  }), 10000, 'Conexão segura');
}

function checkWebSocket() {
  return withTimeout(new Promise((resolve, reject) => {
    const started = Date.now();
    const ws = new WebSocket(`wss://${HOST}/ws/chat`, { origin: 'https://web.whatsapp.com', handshakeTimeout: 10000 });
    let opened = false;
    ws.on('open', () => {
      opened = true;
      // espera um pouco: se algo no caminho derrubar a conexão, fecha logo
      setTimeout(() => { ws.terminate(); resolve(Date.now() - started); }, 2500);
    });
    ws.on('close', (code) => { if (opened) reject(new Error(`aberto, mas derrubado logo em seguida (código ${code})`)); });
    ws.on('error', (e) => reject(e));
  }), 15000, 'Canal do WhatsApp');
}

/** @returns {Promise<{ok:boolean, steps:{label:string, ok:boolean, detail:string}[], hint:string|null}>} */
export async function diagnoseConnection() {
  const steps = [];
  let hint = null;

  try {
    steps.push({ label: 'Encontrar o servidor do WhatsApp', ok: true, detail: await checkDns() });
  } catch (e) {
    steps.push({ label: 'Encontrar o servidor do WhatsApp', ok: false, detail: e.message });
    return {
      ok: false,
      steps,
      hint: 'O computador não conseguiu achar o endereço web.whatsapp.com. Confira se a internet está funcionando. Se estiver, a VPN/“Conexão segura” da McAfee, o roteador ou a rede (ex.: filtro de empresa) podem estar bloqueando o WhatsApp.',
    };
  }

  try {
    const { issuer, authorized } = await checkTls();
    const intercepted = !/digicert|meta|facebook|whatsapp|globalsign|sectigo|let'?s encrypt/i.test(issuer || '');
    steps.push({
      label: 'Conexão segura',
      ok: authorized && !intercepted,
      detail: `certificado emitido por: ${issuer || 'desconhecido'}${authorized ? '' : ' (não confiável)'}`,
    });
    if (intercepted || !authorized) {
      hint = `A conexão segura está sendo interceptada por “${issuer || 'um programa'}”. Normalmente é a proteção web/HTTPS do antivírus (ex.: McAfee). Libere o WhatsApp CRM (Electron) ou desative a verificação de conexões seguras.`;
    }
  } catch (e) {
    steps.push({ label: 'Conexão segura', ok: false, detail: e.message });
    return {
      ok: false,
      steps,
      hint: 'O endereço foi encontrado, mas a conexão foi recusada. Normalmente é o firewall do antivírus (McAfee) bloqueando o “Electron”, ou uma VPN.',
    };
  }

  try {
    const ms = await checkWebSocket();
    steps.push({ label: 'Canal do WhatsApp', ok: true, detail: `aberto em ${ms} ms e estável` });
  } catch (e) {
    steps.push({ label: 'Canal do WhatsApp', ok: false, detail: e.message });
    hint = hint || 'A conexão segura funciona, mas o canal do WhatsApp é derrubado logo depois de abrir. Isso costuma ser o firewall/proteção web do antivírus (McAfee) ou uma VPN. Libere o “Electron” no firewall ou teste com o firewall desligado por alguns minutos.';
  }

  return { ok: steps.every((s) => s.ok), steps, hint };
}
