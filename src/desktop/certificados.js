// Certificado digital A3 (token/cartão) no Windows: lista os certificados e
// assina com o escolhido, por meio do PowerShell (certificados.ps1). Quem pede
// o PIN é o próprio driver do token. Só existe no app de desktop do Windows.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'certificados.ps1');

function ps(args, timeout) {
  if (process.platform !== 'win32') return Promise.reject(new Error('A assinatura com certificado A3 funciona no app de desktop do Windows.'));
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message).split(/\r?\n/).find((l) => l.trim() && !/^(At |No |\+|CategoryInfo|FullyQualified)/.test(l.trim())) || err.message;
          return reject(new Error(/cancel|canceled|cancelad/i.test(msg) ? 'Assinatura cancelada.' : msg.replace(/^.*?:\s*/, '').trim() || 'Não foi possível usar o certificado.'));
        }
        resolve(stdout);
      });
  });
}

/** Certificados pessoais com chave e ainda válidos (os do token aparecem com ele conectado). */
export async function listCerts() {
  const out = (await ps(['-Acao', 'listar'], 30000)).trim();
  const list = out ? JSON.parse(out) : [];
  return (Array.isArray(list) ? list : [list]).map((c) => ({ ...c, validTo: Date.parse(c.validTo) || null }));
}

/** Assina `data` (bytes) com o certificado da impressão digital `thumb`; devolve o CMS (DER). */
export async function signCms(data, thumb) {
  if (!/^[0-9A-Fa-f]{40}$/.test(String(thumb || ''))) throw new Error('Escolha o certificado em Ajustes → Recibos.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assinar-'));
  try {
    const inp = path.join(dir, 'dados.bin');
    const out = path.join(dir, 'assinatura.p7s');
    fs.writeFileSync(inp, data);
    await ps(['-Acao', 'assinar', '-Entrada', inp, '-Saida', out, '-Digital', thumb], 180000);
    return fs.readFileSync(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
