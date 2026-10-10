// Avisos no celular (Web Push, padrão dos navegadores): cada aparelho em que a
// pessoa "ativa os avisos" vira uma inscrição (`push_subs`). As chaves VAPID do
// servidor são criadas uma vez em <dados>/push/vapid.json. Funciona com o app
// instalado na tela inicial (Android, e iPhone a partir do iOS 16.4) e no
// navegador do computador. Exige HTTPS (ou localhost).
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import * as db from './db.js';

// O que cada pessoa pode escolher receber no celular (padrão entre parênteses).
export const PUSH_KINDS = {
  agenda: 'Prazos, audiências e lembretes',
  tribunais: 'Intimações e andamentos dos tribunais',
  financeiro: 'Honorários vencendo e vencidos',
  mensagens: 'Mensagens do WhatsApp do escritório',
  outros: 'Conversas e casos esquecidos, Google Agenda',
};
export const PUSH_DEFAULTS = { agenda: true, tribunais: true, financeiro: true, mensagens: false, outros: true };

/** Em que grupo cai cada tipo de aviso do sistema. */
export function pushKindOf(kind) {
  if (['reminder', 'hearing', 'prescription', 'deadline', 'secret-check', 'session'].includes(kind)) return 'agenda';
  if (['intimation', 'court', 'case-move', 'courts', 'intimation-late', 'moves', 'client-watch'].includes(kind)) return 'tribunais';
  if (kind === 'finance') return 'financeiro';
  if (kind === 'message') return 'mensagens';
  if (kind === 'test') return null; // sempre vai
  return 'outros';
}

export class PushService {
  /** `sender` troca o envio de verdade (testes e modo demonstração). */
  constructor({ dir, subject = 'mailto:sistema@barrosassociados.adv.br', sender } = {}) {
    this.dir = dir;
    this.subject = subject;
    this.sender = sender || null;
    this.keys = this.loadKeys();
  }

  loadKeys() {
    const file = path.join(this.dir, 'vapid.json');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* cria abaixo */ }
    const keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    return keys;
  }

  get publicKey() { return this.keys.publicKey; }

  subscribe(userId, sub, agent = '') {
    const endpoint = String(sub?.endpoint || '');
    const p256dh = String(sub?.keys?.p256dh || '');
    const auth = String(sub?.keys?.auth || '');
    if (!/^https?:\/\//.test(endpoint) || !p256dh || !auth) throw new Error('Inscrição de aviso inválida.');
    db.run(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
              agent = excluded.agent, fails = 0`, userId, endpoint, p256dh, auth, String(agent).slice(0, 200), Date.now());
  }

  unsubscribe(userId, endpointOrId) {
    db.run('DELETE FROM push_subs WHERE user_id = ? AND (endpoint = ? OR id = ?)', userId, String(endpointOrId), Number(endpointOrId) || -1);
  }

  list(userId) {
    return db.all('SELECT id, endpoint, agent, created_at, last_ok, fails FROM push_subs WHERE user_id = ? ORDER BY created_at', userId);
  }

  /** Manda para todos os aparelhos da pessoa. Inscrição recusada (404/410) é apagada. */
  async sendTo(userId, payload) {
    const subs = db.all('SELECT * FROM push_subs WHERE user_id = ?', userId);
    const body = JSON.stringify(payload);
    let ok = 0;
    await Promise.all(subs.map(async (s) => {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        if (this.sender) await this.sender(sub, body);
        else {
          await webpush.sendNotification(sub, body, {
            TTL: 24 * 3600, urgency: payload.urgent ? 'high' : 'normal', topic: payload.tag ? String(payload.tag).replace(/[^\w-]/g, '').slice(0, 32) : undefined,
            vapidDetails: { subject: this.subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
          });
        }
        ok++;
        db.run('UPDATE push_subs SET last_ok = ?, fails = 0 WHERE id = ?', Date.now(), s.id);
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) db.run('DELETE FROM push_subs WHERE id = ?', s.id);
        else {
          db.run('UPDATE push_subs SET fails = fails + 1 WHERE id = ?', s.id);
          db.run('DELETE FROM push_subs WHERE id = ? AND fails >= 20', s.id);
          console.error('aviso no celular:', e.statusCode || '', e.body || e.message);
        }
      }
    }));
    return ok;
  }
}
