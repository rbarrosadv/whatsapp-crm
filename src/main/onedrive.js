// OneDrive pessoal pela API oficial da Microsoft (Graph), para o servidor do
// escritório: uma conta Microsoft do escritório entra uma vez (OAuth, com o
// cadastro do app no portal da Microsoft: "Aplicativo Web", contas pessoais),
// e a pasta "BARROS ADVOGADOS" compartilhada com ela é usada como a pasta de
// documentos. O token fica cifrado em <dados>/onedrive/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GRAPH } from './storage.js';

export const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPES = 'offline_access User.Read Files.ReadWrite.All';

/** Link de compartilhamento → id para a API (/shares/u!…). */
export function shareId(url) {
  return `u!${Buffer.from(String(url).trim()).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

export class OneDriveAuth {
  /** @param {{ dir: string, crypt: {encryptString, decryptString}, fetch?: typeof fetch }} o */
  constructor({ dir, crypt, fetch: f = globalThis.fetch }) {
    this.dir = dir;
    this.crypt = crypt;
    this.fetch = f;
    this.pending = new Map(); // state → { verifier, redirectUri, at }
    this.data = this.load();
  }

  file() { return path.join(this.dir, 'onedrive.bin'); }
  load() {
    try { return JSON.parse(this.crypt.decryptString(fs.readFileSync(this.file()))); } catch { return {}; }
  }
  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(), this.crypt.encryptString(JSON.stringify(this.data)), { mode: 0o600 });
  }

  status() {
    const d = this.data;
    return {
      configured: !!(d.clientId && d.clientSecret),
      clientId: d.clientId || '',
      connected: !!d.refreshToken,
      account: d.account || null,
      folder: d.driveId && d.itemId ? { driveId: d.driveId, itemId: d.itemId, name: d.folderName || 'BARROS ADVOGADOS' } : null,
      error: d.error || null,
    };
  }

  setApp({ clientId, clientSecret }) {
    if (!/^[0-9a-f-]{36}$/i.test(String(clientId || '').trim())) throw new Error('O "ID do aplicativo (cliente)" tem o formato 00000000-0000-0000-0000-000000000000.');
    if (!String(clientSecret || '').trim() && !this.data.clientSecret) throw new Error('Cole o "Valor" do segredo do cliente.');
    this.data.clientId = String(clientId).trim();
    if (String(clientSecret || '').trim()) this.data.clientSecret = String(clientSecret).trim();
    this.save();
  }

  /** Endereço para a pessoa entrar com a conta Microsoft do escritório. */
  authUrl(redirectUri) {
    if (!this.data.clientId) throw new Error('Primeiro informe o ID do aplicativo e o segredo.');
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    for (const [k, v] of this.pending) if (Date.now() - v.at > 15 * 60e3) this.pending.delete(k);
    this.pending.set(state, { verifier, redirectUri, at: Date.now() });
    const q = new URLSearchParams({
      client_id: this.data.clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
      scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    });
    return `${AUTHORITY}/authorize?${q}`;
  }

  async tokenRequest(params) {
    const body = new URLSearchParams({ client_id: this.data.clientId, client_secret: this.data.clientSecret, scope: SCOPES, ...params });
    const r = await this.fetch(`${AUTHORITY}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.error_description?.split('\r\n')[0] || j.error || `Microsoft respondeu ${r.status}`);
      e.code = j.error;
      throw e;
    }
    this.data.accessToken = j.access_token;
    this.data.expiresAt = Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60e3;
    if (j.refresh_token) this.data.refreshToken = j.refresh_token;
    this.data.error = null;
    this.save();
    return j.access_token;
  }

  /** Volta do login da Microsoft (código → tokens) e guarda o nome da conta. */
  async finish(code, state) {
    const p = this.pending.get(state);
    if (!p) throw new Error('O login demorou ou foi aberto em outra janela. Tente "Conectar" de novo.');
    this.pending.delete(state);
    await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
    try {
      const me = await this.graph('/me?$select=displayName,userPrincipalName,mail');
      this.data.account = me.mail || me.userPrincipalName || me.displayName || null;
      this.save();
    } catch { /* nome da conta é só para mostrar */ }
  }

  async token() {
    if (!this.data.refreshToken) throw new Error('O OneDrive não está conectado. Em Ajustes → Documentos, clique em "Conectar ao OneDrive".');
    if (this.data.accessToken && Date.now() < this.data.expiresAt) return this.data.accessToken;
    try {
      return await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.data.refreshToken });
    } catch (e) {
      if (e.code === 'invalid_grant') { this.data.refreshToken = null; this.data.error = 'A conexão com o OneDrive expirou. Conecte de novo.'; this.save(); }
      throw e;
    }
  }

  async graph(pathOrUrl, init = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    const r = await this.fetch(url, { ...init, headers: { Authorization: `Bearer ${await this.token()}`, ...(init.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `OneDrive respondeu ${r.status}`);
    return j;
  }

  /** Escolhe a pasta pelo link de compartilhamento (o que o OneDrive dá em "Compartilhar → Copiar link"). */
  async useShareLink(url) {
    if (!/^https:\/\/(1drv\.ms|onedrive\.live\.com|[\w.-]+\.sharepoint\.com|[\w.-]*onedrive\.com)\//i.test(String(url).trim())) {
      throw new Error('Cole o link de compartilhamento da pasta (começa com https://1drv.ms/ ou https://onedrive.live.com/).');
    }
    const it = await this.graph(`/shares/${shareId(url)}/driveItem?$select=id,name,folder,parentReference,remoteItem`);
    const target = it.remoteItem || it;
    if (!target.folder && !it.folder) throw new Error('Esse link é de um arquivo. Compartilhe a pasta "BARROS ADVOGADOS".');
    return this.setFolder({ driveId: target.parentReference?.driveId || it.parentReference?.driveId, itemId: target.id || it.id, name: target.name || it.name });
  }

  /** Pastas compartilhadas com a conta do escritório (para escolher sem link). */
  async sharedFolders() {
    const j = await this.graph('/me/drive/sharedWithMe?$top=200');
    return (j.value || []).filter((x) => x.folder || x.remoteItem?.folder).map((x) => {
      const t = x.remoteItem || x;
      return { name: t.name || x.name, driveId: t.parentReference?.driveId, itemId: t.id, owner: t.shared?.owner?.user?.displayName || x.shared?.owner?.user?.displayName || '' };
    }).filter((x) => x.driveId && x.itemId);
  }

  setFolder({ driveId, itemId, name }) {
    if (!driveId || !itemId) throw new Error('Não foi possível identificar a pasta.');
    Object.assign(this.data, { driveId, itemId, folderName: name || 'BARROS ADVOGADOS' });
    this.save();
    return this.status();
  }

  disconnect() {
    for (const k of ['accessToken', 'refreshToken', 'expiresAt', 'account', 'driveId', 'itemId', 'folderName', 'error']) delete this.data[k];
    this.save();
  }
}
