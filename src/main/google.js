// Integração com o Google Agenda (API oficial, com a chave do próprio
// usuário). Login pelo navegador com retorno para um endereço local
// (127.0.0.1) e PKCE; o token fica criptografado na pasta de dados.
import { EventEmitter } from 'node:events';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCOPE = 'https://www.googleapis.com/auth/calendar';
const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class GoogleService extends EventEmitter {
  /**
   * @param {{dir: string, fetch: typeof fetch, openExternal: (url: string) => any,
   *          safeStorage?: {isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string}}} opts
   */
  constructor({ dir, fetch: fetchFn, openExternal, safeStorage }) {
    super();
    this.dir = dir;
    this.fetch = fetchFn;
    this.openExternal = openExternal;
    this.safeStorage = safeStorage;
    this.clientFile = path.join(dir, 'client.json');
    this.tokenFile = path.join(dir, 'token.bin');
    this.access = null; // { token, expiresAt }
    this.needsReconnect = false;
    this.email = null;
    this.calendarsCache = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  // ------------------------------------------------------------ estado

  client() {
    try {
      const j = JSON.parse(fs.readFileSync(this.clientFile, 'utf-8'));
      const c = j.installed || j.web;
      if (!c?.client_id) return null;
      return c;
    } catch {
      return null;
    }
  }

  readToken() {
    try {
      const raw = fs.readFileSync(this.tokenFile);
      const text = this.safeStorage?.isEncryptionAvailable() && raw[0] !== 0x7b ? this.safeStorage.decryptString(raw) : raw.toString('utf-8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  writeToken(t) {
    const text = JSON.stringify(t);
    const data = this.safeStorage?.isEncryptionAvailable() ? this.safeStorage.encryptString(text) : Buffer.from(text);
    fs.writeFileSync(this.tokenFile, data);
  }

  status() {
    const tok = this.readToken();
    return {
      configured: !!this.client(),
      connected: !!tok?.refresh_token && !this.needsReconnect,
      needsReconnect: this.needsReconnect,
      email: tok?.email || this.email || null,
    };
  }

  emitStatus() { this.emit('status', this.status()); }

  /** Copia o arquivo JSON baixado do Google Cloud para a pasta do app. */
  importClient(file) {
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { throw new Error('Esse arquivo não é o JSON da chave do Google.'); }
    const c = j.installed || j.web;
    if (!c?.client_id || !c?.client_secret) throw new Error('Esse arquivo não parece ser a chave do Google (client_secret…json).');
    if (!j.installed) throw new Error('A chave precisa ser do tipo "App para computador" (Desktop app). Crie outra em Google Cloud → Clientes.');
    fs.writeFileSync(this.clientFile, JSON.stringify(j));
    this.emitStatus();
  }

  // ----------------------------------------------------------- login

  /** Abre o navegador para o login e espera o Google devolver o código. */
  async connect() {
    const c = this.client();
    if (!c) throw new Error('Primeiro escolha o arquivo da chave do Google.');
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/') { res.writeHead(404).end(); return; }
        const ok = u.searchParams.get('code') && u.searchParams.get('state') === state;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:Segoe UI,sans-serif;text-align:center;padding:60px">
          <h2>${ok ? '✅ Google Agenda conectado!' : '❌ Não foi possível conectar'}</h2>
          <p>${ok ? 'Pode fechar esta aba e voltar para o WhatsApp CRM.' : (u.searchParams.get('error') || 'Tente de novo pelo app.')}</p></body></html>`);
        clearTimeout(timer);
        server.close();
        if (ok) resolve({ code: u.searchParams.get('code'), redirectUri: `http://127.0.0.1:${server.address()?.port || port}` });
        else reject(new Error(u.searchParams.get('error') === 'access_denied' ? 'Acesso não permitido no Google.' : 'O Google não autorizou a conexão.'));
      });
      let port;
      const timer = setTimeout(() => { server.close(); reject(new Error('Tempo esgotado esperando o login no navegador.')); }, 5 * 60 * 1000);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        const params = new URLSearchParams({
          client_id: c.client_id,
          redirect_uri: `http://127.0.0.1:${port}`,
          response_type: 'code',
          scope: SCOPE,
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
        });
        this.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
      });
      server.on('error', reject);
    });

    const tok = await this.tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
    });
    if (!tok.refresh_token) throw new Error('O Google não devolveu a autorização completa. Tente conectar de novo.');
    this.access = { token: tok.access_token, expiresAt: Date.now() + (tok.expires_in - 60) * 1000 };
    this.needsReconnect = false;
    const saved = { refresh_token: tok.refresh_token, connected_at: Date.now() };
    this.writeToken(saved);
    try {
      const primary = await this.request('/calendars/primary');
      saved.email = primary.id;
      this.email = primary.id;
      this.writeToken(saved);
    } catch { /* ignore */ }
    this.calendarsCache = null;
    this.emitStatus();
    return this.status();
  }

  async disconnect() {
    const tok = this.readToken();
    if (tok?.refresh_token) {
      try { await this.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tok.refresh_token)}`, { method: 'POST' }); } catch { /* ignore */ }
    }
    try { fs.rmSync(this.tokenFile, { force: true }); } catch { /* ignore */ }
    this.access = null;
    this.calendarsCache = null;
    this.needsReconnect = false;
    this.emitStatus();
  }

  async tokenRequest(params) {
    const c = this.client();
    const body = new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, ...params });
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(j.error_description || j.error || `Erro ${res.status} no Google`);
      err.code = j.error;
      throw err;
    }
    return j;
  }

  async accessToken() {
    if (this.access && this.access.expiresAt > Date.now()) return this.access.token;
    const tok = this.readToken();
    if (!tok?.refresh_token || !this.client()) throw new Error('Google Agenda não está conectado.');
    try {
      const r = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token });
      this.access = { token: r.access_token, expiresAt: Date.now() + (r.expires_in - 60) * 1000 };
      if (this.needsReconnect) { this.needsReconnect = false; this.emitStatus(); }
      return this.access.token;
    } catch (e) {
      if (e.code === 'invalid_grant' || e.code === 'unauthorized_client') {
        // no modo de teste do Google a autorização vence a cada 7 dias
        this.needsReconnect = true;
        this.emitStatus();
        throw new Error('A conexão com o Google Agenda expirou. Clique em "Reconectar Google".');
      }
      throw e;
    }
  }

  async request(p, { method = 'GET', query, body } = {}) {
    const token = await this.accessToken();
    const url = `${API}${p}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const res = await this.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { this.access = null; }
    if (!res.ok) {
      const err = new Error(j.error?.message || `Erro ${res.status} no Google Agenda`);
      err.status = res.status;
      throw err;
    }
    return j;
  }

  // ------------------------------------------------------------ agenda

  async calendars(force = false) {
    if (this.calendarsCache && !force) return this.calendarsCache;
    const j = await this.request('/users/me/calendarList', { query: { maxResults: '250' } });
    this.calendarsCache = (j.items || []).filter((c) => !c.deleted).map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary,
      color: c.backgroundColor || '#4285f4',
      primary: !!c.primary,
      writable: ['owner', 'writer'].includes(c.accessRole),
      selected: c.selected !== false,
    })).sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
    return this.calendarsCache;
  }

  async events(calendarIds, fromTs, toTs) {
    const cals = await this.calendars();
    const wanted = cals.filter((c) => !calendarIds || calendarIds.includes(c.id));
    const out = [];
    await Promise.all(wanted.map(async (cal) => {
      let pageToken;
      do {
        const j = await this.request(`/calendars/${encodeURIComponent(cal.id)}/events`, {
          query: {
            singleEvents: 'true', orderBy: 'startTime', maxResults: '2500',
            timeMin: new Date(fromTs).toISOString(), timeMax: new Date(toTs).toISOString(),
            ...(pageToken ? { pageToken } : {}),
          },
        });
        for (const e of j.items || []) {
          if (e.status === 'cancelled') continue;
          out.push(toEvent(e, cal));
        }
        pageToken = j.nextPageToken;
      } while (pageToken);
    }));
    return out;
  }

  async saveEvent(calendarId, ev, eventId) {
    const body = fromEvent(ev);
    const cal = encodeURIComponent(calendarId);
    const r = eventId
      ? await this.request(`/calendars/${cal}/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body })
      : await this.request(`/calendars/${cal}/events`, { method: 'POST', body });
    return r;
  }

  async deleteEvent(calendarId, eventId) {
    try {
      await this.request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e; // já não existia
    }
  }
}

/** Evento do Google → formato usado pela interface. */
export function toEvent(e, cal) {
  const allDay = !!e.start?.date;
  const start = allDay ? new Date(`${e.start.date}T00:00:00`).getTime() : new Date(e.start?.dateTime).getTime();
  const end = allDay ? new Date(`${e.end.date}T00:00:00`).getTime() : new Date(e.end?.dateTime || e.start?.dateTime).getTime();
  const priv = e.extendedProperties?.private || {};
  return {
    id: e.id,
    source: 'google',
    calendarId: cal.id,
    calendarName: cal.name,
    color: cal.color,
    writable: cal.writable,
    title: e.summary || '(sem título)',
    description: e.description || '',
    location: e.location || '',
    start,
    end: end > start ? end : start + 30 * 60000,
    allDay,
    htmlLink: e.htmlLink,
    taskId: priv.crmTaskId ? Number(priv.crmTaskId) : null,
  };
}

/** Formato da interface → corpo da API do Google. */
export function fromEvent(ev) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = {};
  if (ev.title !== undefined) body.summary = ev.title;
  if (ev.description !== undefined) body.description = ev.description;
  if (ev.location !== undefined) body.location = ev.location;
  if (ev.start !== undefined) {
    if (ev.allDay) {
      const d = (ts) => { const x = new Date(ts); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
      const endTs = ev.end && ev.end > ev.start ? ev.end : ev.start + 24 * 3600 * 1000;
      body.start = { date: d(ev.start) };
      body.end = { date: d(endTs) };
    } else {
      body.start = { dateTime: new Date(ev.start).toISOString(), timeZone: tz };
      body.end = { dateTime: new Date(ev.end || ev.start + 3600 * 1000).toISOString(), timeZone: tz };
    }
  }
  if (ev.taskId) body.extendedProperties = { private: { crmTaskId: String(ev.taskId) } };
  return body;
}
