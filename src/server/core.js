// Motor do sistema, sem Electron: banco, WhatsApp, Google Agenda, lembretes
// e a tabela `api` que a interface chama. Roda no servidor do escritório
// (ou no próprio computador, no modo local). Eventos para a interface saem
// por `core.events` ('event', canal, dados, destino) e o servidor HTTP os
// repassa às janelas abertas.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as db from '../main/db.js';
import * as auth from './auth.js';
import { WhatsAppService } from '../main/whatsapp.js';
import { DemoWhatsAppService, DemoGoogleService } from '../main/demo.js';
import { GoogleService } from '../main/google.js';
import { CalendarSync } from '../main/calendar-sync.js';
import { webmToOgg } from '../main/ogg.js';
import { diagnoseConnection } from '../main/diag.js';
import { DocsService, guessRoot, templateValues, PLACEHOLDERS, FOLDERS } from '../main/docs.js';
import { seedDemoDocs, demoCourtsFetch } from '../main/demo.js';
import { lookupCep, lookupCnpj, demoLookupFetch } from '../main/lookup.js';
import { reais } from '../main/extenso.js';
import { readSheet } from '../main/sheet.js';
import { sameName } from '../renderer/js/qualify.js';
import {
  detectColumns, parseImport, classifyArea, archiveState, suggestPrescription, partiesFromDjen, isGenericTitle, hearingFromText, CLIENT_WORTHY,
} from '../main/importer.js';
import * as leads from '../main/leads.js';
import * as reports from '../main/reports.js';
import { receiptPdf, externalSign } from '../main/pdf.js';
import { PushService, PUSH_KINDS, PUSH_DEFAULTS, pushKindOf } from '../main/push.js';
import { CourtsService, DATAJUD_PUBLIC_KEY, deadlineFromAvailability, formatCnj, tribunalOf, nameCase } from '../main/courts.js';
import { computeSteps, suggestedChecklist, docsRequestText, addBusinessDays, STEPS, PARTY_ROLES, DEFAULT_DOCS_TEMPLATE } from '../main/workflow.js';

const DAY = 24 * 3600 * 1000;
const ASSETS_DIR = fileURLToPath(new URL('../../assets/', import.meta.url));
const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateBR = (ts) => (ts ? new Date(ts).toLocaleDateString('pt-BR') : 'sem data');

// Preferências de cada pessoa (ficam no usuário) × configurações do escritório (valem para todos).
export const USER_KEYS = ['notifications', 'notificationPreview', 'theme', 'lastView', 'lastPipeline', 'enterToSend',
  'lastFilter', 'agendaHidden', 'agendaView', 'agendaHours', 'discreet', 'discreetMessages', 'spellcheck', 'wordSuggest', 'autocorrect', 'notifyCourts', 'pushKinds'];
export const OFFICE_KEYS = ['sendReadReceipts', 'forgottenHours', 'chargeTemplate', 'pixKey', 'paymentNoticeDays',
  'staleCaseDays', 'googleSync', 'googleCalendarId', 'signMessages', 'docsRoot', 'docsRequestTemplate', 'datajudKey',
  'officeName', 'officeDoc', 'officeAddress', 'officeCity', 'proposalTemplate', 'proposalValidDays', 'prescriptionYears', 'clientUpdateTemplate', 'idleCaseDays', 'waSaveContacts',
  'receiptSigner', 'receiptSignMode', 'courtsNotifyAll'];

export const DEFAULT_CHARGE_TEMPLATE = 'Olá, {nome}! Tudo bem? Passando para lembrar da {parcela} dos honorários referentes a {caso}, '
  + 'no valor de {valor}, com vencimento em {vencimento}.{pix_linha}\nQualquer dúvida, estou à disposição.';

// arquivos que o Windows executaria ao abrir
export const RISKY_EXT = new Set(['exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'lnk', 'hta', 'jar', 'reg', 'pif', 'cpl', 'msc', 'dll', 'appx', 'msix', 'url', 'scf', 'inf', 'sys']);

/** Pasta de dados padrão quando CRM_DATA_DIR não é informado. */
export function defaultDataDir(demo) {
  const base = process.env.APPDATA || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'));
  // própria do sistema novo: o WhatsApp CRM antigo (pasta WhatsAppCRM) continua à parte
  return path.join(base, demo ? 'BarrosAssociados-Demo' : 'BarrosAssociados', 'dados');
}

/** Criptografia do token do Google quando não há o cofre do sistema (servidor). */
function fileSafeStorage(dir) {
  const keyFile = path.join(dir, 'secret.key');
  const key = () => {
    if (!fs.existsSync(keyFile)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    }
    return fs.readFileSync(keyFile);
  };
  return {
    isEncryptionAvailable: () => true,
    encryptString(s) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
      const body = Buffer.concat([c.update(s, 'utf-8'), c.final()]);
      return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
    },
    decryptString(b) {
      if (b[0] !== 1) throw new Error('formato desconhecido');
      const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(1, 13));
      d.setAuthTag(b.subarray(13, 29));
      return Buffer.concat([d.update(b.subarray(29)), d.final()]).toString('utf-8');
    },
  };
}

/**
 * @param {{dataDir: string, demo?: boolean, version?: string, safeStorage?: object,
 *          resolveUpload?: (token: string) => {path: string, name: string}}} opts
 */
const fold = (x) => String(x || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
/** Chama no máximo uma vez a cada `ms` (a última chamada sempre acontece). */
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  const call = () => {
    const wait = last + ms - Date.now();
    if (wait <= 0) { last = Date.now(); fn(); return; }
    clearTimeout(timer);
    timer = setTimeout(() => { last = Date.now(); fn(); }, wait);
  };
  call.cancel = () => clearTimeout(timer);
  return call;
}

export async function createCore({ dataDir, demo = false, version = '', safeStorage, resolveUpload, features = {} }) {
  const events = new EventEmitter();

  db.openDb(dataDir);
  let settings = db.getSettings();

  /** Evento para as janelas abertas. `to`: {conn} | {user} | undefined (todas). */
  const send = (channel, payload, to) => events.emit('event', channel, payload, to);

  /**
   * Aviso (notificação). Vai para as janelas abertas (cada uma decide se mostra,
   * conforme as preferências da pessoa) e para os celulares de quem não está
   * com o sistema aberto e em uso agora (`pushOut`).
   */
  const notify = (n, to) => {
    send('notify', n, to);
    pushOut(n, to).catch((e) => console.error('aviso no celular:', e.message));
  };

  // ---------------------------------------------------- avisos no celular (Web Push)
  const pushOutbox = []; // modo demonstração: o que "teria ido" para os celulares
  const push = new PushService({
    dir: path.join(dataDir, 'push'),
    sender: demo ? async (sub, body) => { pushOutbox.push({ endpoint: sub.endpoint, ...JSON.parse(body) }); if (pushOutbox.length > 50) pushOutbox.shift(); } : undefined,
  });
  /** A pessoa está com uma janela do sistema em foco e mexendo nela nos últimos 10 min. */
  const isActiveAtDesk = (userId) => [...viewers.values()].some((v) => v.userId === userId && v.focused && Date.now() - (v.seen || 0) < 10 * 60e3);
  async function pushOut(n, to) {
    if (to?.conn) return; // aviso só para uma janela (ex.: teste daquela tela)
    const group = pushKindOf(n.kind);
    const users = to?.user ? [auth.getUser(to.user)].filter(Boolean) : db.all('SELECT * FROM users WHERE active = 1');
    await Promise.all(users.map(async (u) => {
      if (!u.active) return;
      if (n.audience === 'finance' && !auth.can(u.role, 'finance:list')) return;
      const prefs = auth.userPrefs(u.id);
      if (!n.force && prefs.notifications === false) return;
      const kinds = { ...PUSH_DEFAULTS, ...(prefs.pushKinds || {}) };
      if (group && !kinds[group]) return;
      if (!n.force && isActiveAtDesk(u.id)) return;
      let { title, body } = n;
      if (n.kind === 'message' && prefs.notificationPreview === false) body = 'Nova mensagem';
      if (prefs.discreet && n.discreet) { title = n.discreet; body = 'Abra o sistema para ver.'; }
      await push.sendTo(u.id, { title, body, tag: `${n.kind}${n.chatJid ? `:${n.chatJid}` : ''}`, action: n.action || null, urgent: group === 'agenda' || group === 'tribunais' });
    }));
  }

  // documentos: pasta do escritório no OneDrive (no demo, uma pasta de exemplo)
  const demoDocs = path.join(dataDir, 'OneDrive (demonstração)', 'BARROS ADVOGADOS');
  if (demo) await seedDemoDocs(demoDocs);
  const docs = new DocsService({ getRoot: () => settings.docsRoot || (demo ? demoDocs : guessRoot()) });
  const docUrl = (rel) => `/docs/file/${rel.split('/').map(encodeURIComponent).join('/')}`;

  // tribunais (DJEN e DataJud); no demo, respostas simuladas no mesmo formato
  const courts = new CourtsService({
    fetch: demo ? demoCourtsFetch(() => db.listCases({ includeClosed: false })) : globalThis.fetch,
    getDatajudKey: () => settings.datajudKey || DATAJUD_PUBLIC_KEY,
  });

  // CEP e CNPJ (serviços públicos); `lookup.fetch` é trocado nos testes
  const lookup = { fetch: demo ? demoLookupFetch : globalThis.fetch, cache: new Map() };
  const cachedLookup = async (key, fn) => {
    const hit = lookup.cache.get(key);
    if (hit && hit.at > Date.now() - 24 * 3600e3) return hit.value;
    const value = await fn();
    if (lookup.cache.size > 500) lookup.cache.clear();
    lookup.cache.set(key, { value, at: Date.now() });
    return value;
  };

  const Service = demo ? DemoWhatsAppService : WhatsAppService;
  const wa = new Service({ dataDir, logFile: path.join(dataDir, 'logs', 'whatsapp.log') });

  // ---------------------------------------------------- quem está vendo o quê
  // Uma entrada por janela aberta: conversa aberta, se a janela está em foco.
  const viewers = new Map();
  wa.isViewing = (jid) => [...viewers.values()].some((v) => v.jid === jid && v.focused);
  const broadcastViewers = () => send('viewers', [...viewers.values()]
    .filter((v) => v.jid).map((v) => ({ jid: v.jid, userId: v.userId, name: v.name })));

  function viewerOf(ctx) {
    if (!ctx.conn) return null;
    if (!viewers.has(ctx.conn)) viewers.set(ctx.conn, { userId: ctx.user.id, name: ctx.user.name, jid: null, focused: true, seen: Date.now() });
    return viewers.get(ctx.conn);
  }

  // ---------------------------------------------------- WhatsApp → janelas
  wa.on('status', (s) => send('wa:status', s));
  wa.on('chats-changed', (jids) => {
    const chats = jids.map((j) => db.getChat(j)).filter(Boolean);
    const removed = jids.filter((j) => !chats.some((c) => c.jid === j));
    send('chats:changed', { chats, removed });
  });
  wa.on('chat-merged', (m) => send('chats:merged', m));
  wa.on('history', (h) => send('wa:history', h));
  wa.on('message', (ev) => {
    const msg = ev.removed ? null : db.getMessage(ev.chatJid, ev.id);
    if (msg) delete msg.raw;
    send('message', { chatJid: ev.chatJid, id: ev.id, isNew: ev.isNew, removed: !!ev.removed, message: msg });
    if (ev.notify && msg) maybeNotifyMessage(ev.chatJid, msg);
    // mensagem sua para o cliente = retorno dado nos casos dele
    if (ev.isNew && msg?.from_me && msg.type !== 'system') {
      try { db.touchCasesOfContact(ev.chatJid); } catch { /* ignore */ }
    }
  });

  function maybeNotifyMessage(chatJid, msg) {
    const chat = db.getChat(chatJid);
    if (!chat) return;
    if (chat.muted_until && (chat.muted_until === -1 || chat.muted_until > Date.now())) return;
    // tipos de contato com aviso desligado (ex.: Pessoal)
    if (chat.type_id && db.get('SELECT notify FROM contact_types WHERE id = ?', chat.type_id)?.notify === 0) return;
    const who = chat.is_group ? `${chat.display_name} — ${msg.sender_name || 'alguém'}` : chat.display_name;
    notify({
      kind: 'message', chatJid, title: who, body: db.previewOf(msg).slice(0, 180),
      discreet: 'Nova mensagem', action: { chat: chatJid },
    });
  }

  // ---------------------------------------------------- avisos periódicos
  function checkForgotten() {
    const hours = Number(settings.forgottenHours ?? 24);
    if (!hours) return;
    const list = db.forgottenChats(hours * 3600 * 1000);
    if (!list.length) return;
    db.markChatsAlerted(list.map((c) => c.jid));
    const names = list.slice(0, 3).map((c) => db.getChat(c.jid)?.display_name).filter(Boolean);
    const more = list.length > 3 ? ` e mais ${list.length - 3}` : '';
    notify({
      kind: 'forgotten', title: `${list.length} conversa(s) aguardando resposta há mais de ${hours} h`,
      body: `${names.join(', ')}${more}`, discreet: '⏳ Conversas aguardando resposta',
      action: list.length === 1 ? { chat: list[0].jid } : { filter: 'awaiting' },
    });
  }

  function checkFinanceAndCases() {
    const days = Number(settings.paymentNoticeDays ?? 3);
    const { upcoming, overdue } = db.paymentsToNotify(days);
    if (upcoming.length) {
      db.markPaymentsNotified(upcoming.map((p) => p.id), 'upcoming');
      const total = upcoming.reduce((a, p) => a + p.amount, 0);
      notify({
        kind: 'finance', audience: 'finance', title: `${upcoming.length} parcela(s) de honorários vencendo em até ${days} dia(s)`,
        body: `Total ${money(total)}`, discreet: 'Honorários vencendo', action: { view: 'finance' },
      });
    }
    if (overdue.length) {
      db.markPaymentsNotified(overdue.map((p) => p.id), 'overdue');
      const total = overdue.reduce((a, p) => a + p.amount, 0);
      notify({
        kind: 'finance', audience: 'finance', title: `${overdue.length} parcela(s) de honorários vencida(s)`,
        body: `Total ${money(total)} — abra o Financeiro para cobrar`, discreet: 'Honorários vencidos', action: { view: 'finance' },
      });
    }
    const staleDays = Number(settings.staleCaseDays ?? 15);
    if (staleDays > 0) {
      const stale = db.staleCases(staleDays * DAY);
      if (stale.length) {
        db.markCasesAlerted(stale.map((c) => c.id));
        const names = stale.slice(0, 3).map((c) => `${db.getChat(c.jid)?.display_name || ''} (${c.title})`);
        notify({
          kind: 'cases', title: `${stale.length} caso(s) sem notícia ao cliente há mais de ${staleDays} dias`,
          body: `${names.join(', ')}${stale.length > 3 ? ` e mais ${stale.length - 3}` : ''}`,
          discreet: 'Casos sem retorno ao cliente',
          action: stale.length === 1 ? { chat: stale[0].jid } : { view: 'board' },
        });
      }
    }
  }

  /** Audiência terminou: lembrar de agendar os prazos que saíram e de conferir as intimações (ata, sentença). */
  function checkHearings() {
    for (const t of db.hearingsToNotify()) {
      db.markHearingNotified(t.id);
      const who = t.client_name || (t.jid ? db.getChat(t.jid)?.display_name : '') || t.case_title || '';
      const n = {
        kind: 'hearing', title: `Audiência terminou${who ? ` — ${who}` : ''}`,
        body: `${t.title}: registre o resultado, agende os prazos que saíram e fique de olho nas intimações.`,
        discreet: 'Audiência: agendar prazos', action: t.case_id ? { case: t.case_id, tab: 'prazos' } : { view: 'today' },
      };
      const to = t.assignee_id || t.responsible_id;
      notify(n, to ? { user: to } : undefined);
    }
  }

  /** Arquivados provisoriamente: avisa 90 e 30 dias antes da data de controle da prescrição, e no dia. */
  function checkPrescriptions() {
    const rows = db.all("SELECT id FROM cases WHERE status = 'aberto' AND archive_state = 'provisorio' AND prescription_at IS NOT NULL");
    const due = [];
    for (const { id } of rows) {
      const k = db.getCase(id);
      const days = Math.ceil((k.prescription_at - Date.now()) / DAY);
      const level = days <= 0 ? 1 : days <= 30 ? 30 : days <= 90 ? 90 : null;
      if (!level || (k.prescription_notified && k.prescription_notified <= level)) continue;
      db.setCaseMeta(id, { prescription_notified: level });
      due.push({ k, days });
    }
    // muitos de uma vez (ex.: logo depois de importar a carteira): um aviso só, por responsável
    if (due.length > 3) {
      const byUser = new Map();
      for (const d of due) { const u = d.k.responsible_id || 0; byUser.set(u, [...(byUser.get(u) || []), d]); }
      for (const [u, list] of byUser) {
        notify({
          kind: 'prescription', title: `${list.length} processo(s) arquivado(s): conferir a prescrição`,
          body: `${list.filter((d) => d.days <= 0).length} com a data de controle vencida. Veja em Jurídico → Processos → Arquivados — vigiar prescrição.`,
          discreet: 'Processos arquivados: conferir prescrição', action: { view: 'legal', tab: 'processos', status: 'vigiar' },
        }, u ? { user: u } : undefined);
      }
      return;
    }
    for (const { k, days } of due) {
      const id = k.id;
      notify({
        kind: 'prescription',
        title: `${days <= 0 ? 'Conferir prescrição hoje' : `Prescrição: faltam ${days} dia(s)`} — ${k.client_name || k.process_number}`,
        body: `${k.title}${k.process_number ? ` (${k.process_number})` : ''} está arquivado provisoriamente desde ${new Date(k.archive_since).toLocaleDateString('pt-BR')}. Confira se é preciso pedir o desarquivamento ou dar andamento.`,
        discreet: 'Processo arquivado: conferir prescrição', action: { case: id },
      }, k.responsible_id ? { user: k.responsible_id } : undefined);
    }
  }

  function chargeText(paymentId) {
    const p = db.getPayment(paymentId);
    if (!p) throw new Error('Parcela não encontrada');
    const chat = db.getChat(p.jid);
    const first = (chat?.display_name || '').split(' ')[0];
    const pix = (settings.pixKey || '').trim();
    const tpl = settings.chargeTemplate || DEFAULT_CHARGE_TEMPLATE;
    const vars = {
      nome: first,
      nome_completo: chat?.display_name || '',
      valor: money(p.amount),
      vencimento: dateBR(p.due_at),
      parcela: p.of_total > 1 ? `parcela ${p.seq}/${p.of_total}` : 'parcela',
      descricao: p.description || 'honorários',
      caso: p.case_title || 'seu atendimento',
      processo: p.process_number || '',
      pix,
      pix_linha: pix ? `\nChave PIX: ${pix}` : '',
    };
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  }

  // ---------------------------------------------------- Google Agenda
  let googleRequester = null; // janela que pediu para conectar (recebe o link de login)
  const google = demo ? new DemoGoogleService() : new GoogleService({
    dir: path.join(dataDir, 'google'),
    fetch: (url, opts) => fetch(url, opts),
    openExternal: (url) => send('ui:open-url', url, googleRequester ? { conn: googleRequester } : undefined),
    safeStorage: safeStorage || fileSafeStorage(path.join(dataDir, 'google')),
  });
  const calSync = new CalendarSync({ google, getSettings: () => settings, onChange: () => send('tasks:changed', null) });
  let warnedReconnect = false;
  google.on('status', (st) => {
    send('google:status', st);
    if (st.needsReconnect && !warnedReconnect) {
      warnedReconnect = true;
      notify({
        kind: 'google', title: 'Reconectar Google Agenda',
        body: 'A conexão com o Google expirou (acontece a cada 7 dias no modo de teste). Clique para reconectar.',
        action: { view: 'agenda' },
      });
    }
    if (!st.needsReconnect) warnedReconnect = false;
  });
  const syncTaskLater = (id) => calSync.syncTask(id).catch((e) => console.error('google: sincronizar', e.message));

  // ---------------------------------------------------- lembretes
  let googleTick = 0;
  const check = () => {
    try {
      for (const t of db.dueTasksToNotify()) {
        db.markTaskNotified(t.id);
        const chat = t.jid ? db.getChat(t.jid) : null;
        notify({
          kind: 'reminder', title: `Lembrete${chat ? ` — ${chat.display_name}` : ''}`, body: t.title,
          discreet: '⏰ Lembrete', action: t.jid ? { chat: t.jid } : { view: 'tasks' },
        });
        send('tasks:changed', null);
      }
      checkForgotten();
      checkFinanceAndCases();
      checkHearings();
      checkPrescriptions();
      // a cada ~10 min traz mudanças de horário feitas no Google
      if (++googleTick % 20 === 1 && google?.status().connected) {
        calSync.agenda(Date.now() - 7 * DAY, Date.now() + 120 * DAY).catch(() => {});
      }
    } catch (e) { console.error(e); }
  };
  const timers = [setInterval(check, 30000), setTimeout(check, 5000),
    setInterval(() => courtsTick(), 30 * 60e3), setTimeout(() => courtsTick(), demo ? 3000 : 60e3)];

  // ---------------------------------------------------- utilidades da API
  function resolveMedia(rel) {
    const base = path.resolve(wa.mediaDir);
    const abs = path.resolve(base, String(rel || ''));
    if (!abs.startsWith(base + path.sep)) throw new Error('caminho inválido');
    return abs;
  }
  const mediaUrl = (rel) => `/media/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
  const stripRaw = (m) => { if (m) delete m.raw; return m; };
  const chatOrThrow = (jid) => { if (!jid) throw new Error('Conversa inválida'); return jid; };
  const uploads = (tokens) => (tokens || []).map((t) => {
    const f = resolveUpload?.(t);
    if (!f) throw new Error('Arquivo enviado não encontrado. Tente de novo.');
    return f;
  });

  /**
   * Aviso de um processo (andamento ou intimação) para quem deve saber,
   * conforme a preferência de cada pessoa (`notifyCourts`): 'mine' (padrão —
   * processos em que é responsável; sem responsável, todos os advogados),
   * 'all' ou 'off'. O clique no aviso abre o processo.
   */
  function notifyCase(k, n, { fallbackUserId } = {}) {
    for (const u of auth.listUsers().filter((x) => x.active)) {
      let pref = auth.userPrefs(u.id).notifyCourts || 'mine';
      if (pref === 'off') continue;
      // o escritório pode mandar avisar toda a equipe (inclusive a estagiária) de tudo
      if (settings.courtsNotifyAll) pref = 'all';
      const owner = k?.responsible_id || fallbackUserId || null;
      if (pref === 'mine' && owner && owner !== u.id) continue;
      if (pref === 'mine' && !owner && u.role === 'estagiario') continue;
      notify({ ...n, action: k ? { case: k.id, tab: 'andamentos' } : { view: 'legal', tab: 'intimacoes' } }, { user: u.id });
    }
  }
  const short = (t, n = 140) => (String(t || '').length > n ? `${String(t).slice(0, n - 1)}…` : String(t || ''));

  // ------------------------------------------------ intimações (DJEN) e andamentos (DataJud)
  let checkingIntimations = null;
  /** Busca as intimações das OABs acompanhadas nos últimos `days` dias. */
  function checkIntimations({ days = 10 } = {}) {
    if (checkingIntimations) return checkingIntimations;
    checkingIntimations = (async () => {
      const result = { new: 0, errors: [], oabs: 0 };
      const touched = new Set();
      for (const o of db.listOabs().filter((x) => x.active)) {
        result.oabs++;
        try {
          const items = await courts.djenByOab({ number: o.number, uf: o.uf, from: Date.now() - days * DAY, to: Date.now() });
          for (const it of items) {
            const id = db.addIntimation(it, o.id);
            if (!id) continue;
            result.new++;
            const row = db.getIntimation(id);
            const kc = row.case_id ? db.getCase(row.case_id) : null;
            if (result.new <= 10) {
              notifyCase(kc, {
                kind: 'intimation',
                title: `Intimação${it.doc_kind ? ` (${it.doc_kind})` : ''} — ${kc ? `${kc.client_name || ''}: ${kc.title}` : it.process_number}`,
                body: short(it.text), discreet: 'Nova intimação',
              }, { fallbackUserId: o.user_id });
            }
            if (row.case_id) {
              db.addMove({ case_id: row.case_id, ts: it.date, text: `${it.kind}${it.doc_kind ? ` (${it.doc_kind})` : ''} — ${it.text.slice(0, 600)}`, source: 'djen', ext_id: `djen:${it.ext_id}` });
              hintsFor(row.case_id, { text: `${it.doc_kind || ''} ${it.text}`, ts: it.date, ref: `djen:${it.ext_id}` });
              touched.add(row.case_id);
            }
          }
          db.markOabChecked(o.id, null);
        } catch (e) {
          db.markOabChecked(o.id, e.message);
          result.errors.push(`OAB ${o.number}/${o.uf}: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, demo ? 10 : 1000));
      }
      db.setSetting('djenLastRun', Date.now());
      settings.djenLastRun = Date.now();
      if (result.new) {
        if (result.new > 10) notify({ kind: 'intimation', title: `${result.new} intimações novas no DJEN`, body: 'Abra Jurídico → Intimações para conferir e criar os prazos.', action: { view: 'legal', tab: 'intimacoes' } });
        send('intimations:changed', null);
        for (const id of touched) { organizeCase(id); caseChanged(db.getCase(id)); }
      }
      return result;
    })().finally(() => { checkingIntimations = null; });
    return checkingIntimations;
  }

  /** Andamentos do DataJud de um processo; completa dados vazios da ficha. */
  async function updateDatajud(caseId) {
    const k = db.getCase(caseId);
    if (!k?.process_number) throw new Error('Informe o nº do processo na ficha.');
    let p;
    try { p = await courts.datajud(k.process_number); } catch (e) { db.markDatajud(caseId, e.message); throw e; }
    if (!p) { db.markDatajud(caseId, 'não encontrado no DataJud'); return { found: false, newMoves: 0 }; }
    const fill = {};
    if (!k.tribunal && p.tribunal) fill.tribunal = p.tribunal;
    if (!k.court && p.orgao) fill.court = p.orgao;
    if (!k.filed_at && p.filed_at) fill.filed_at = p.filed_at;
    if (Object.keys(fill).length) db.saveCase({ id: caseId, ...fill });
    let newMoves = 0;
    for (const mv of p.moves) {
      if (!db.addMove({ case_id: caseId, ts: mv.ts, text: mv.text, source: 'datajud', ext_id: mv.ext_id })) continue;
      newMoves++;
      // só o que chega depois da 1ª consulta (o histórico não vira sugestão)
      if (k.datajud_checked_at && mv.ts > Date.now() - 30 * DAY) hintsFor(caseId, { text: mv.text, ts: mv.ts, ref: mv.ext_id });
    }
    db.markDatajud(caseId, null);
    organizeCase(caseId, { classe: p.classe, assuntos: p.assuntos });
    if (newMoves || Object.keys(fill).length) caseChanged(db.getCase(caseId));
    return { found: true, newMoves, classe: p.classe, updated: p.updated };
  }

  /**
   * Organiza o processo pelos andamentos: área (classe/assunto), título no
   * lugar do genérico, último andamento e situação de arquivamento — provisório
   * ganha data para conferir a prescrição; definitivo só fica sugerido (encerrar
   * é sempre com a confirmação de alguém).
   */
  function organizeCase(caseId, { classe, assuntos } = {}) {
    const k = db.getCase(caseId);
    if (!k) return;
    const moves = db.listMoves(caseId);
    const st = archiveState(moves.map((m) => ({ ts: m.ts, text: m.text, ext_id: m.ext_id })));
    const meta = { last_move_at: st.lastMove || k.last_move_at || null };
    if (classe) meta.classe = classe;
    const area = classifyArea({ tribunal: k.tribunal, number: k.process_number, classe: classe || k.classe, assuntos });
    if (!k.area && area) meta.area = area;
    if (classe && (isGenericTitle(k.title, k.tribunal) || /^Processo\b/.test(k.title))) meta.title = classe;
    if (st.state !== (k.archive_state || null) || (st.state && st.since !== k.archive_since)) {
      meta.archive_state = st.state;
      meta.archive_since = st.since;
      meta.archive_dismissed = null;
      if (st.state === 'provisorio') {
        meta.prescription_at = suggestPrescription(st.since, meta.area || k.area || area, settings.prescriptionYears || {});
        meta.prescription_notified = null;
      }
      if (!st.state) { meta.prescription_at = null; meta.prescription_notified = null; }
    }
    db.setCaseMeta(caseId, meta);
  }

  /**
   * Sugestões a partir de um andamento/intimação novo: audiência marcada (pôr
   * na agenda) e andamento importante (avisar o cliente). Ficam no Hoje e na
   * ficha até alguém conferir.
   */
  function hintsFor(caseId, { text, ts, ref }) {
    const hear = hearingFromText(text);
    if (hear) {
      const dup = db.all("SELECT id FROM tasks WHERE case_id = ? AND kind = 'audiencia' AND ABS(due_at - ?) < 3600000", caseId, hear.ts).length;
      if (!dup) db.addHint({ case_id: caseId, kind: 'hearing', ts: hear.ts, title: hear.title, text: String(text).slice(0, 400), ref });
    }
    if (CLIENT_WORTHY.test(String(text))) {
      const m = CLIENT_WORTHY.exec(String(text));
      db.addHint({ case_id: caseId, kind: 'client', ts, title: m ? m[0].replace(/^./, (c) => c.toUpperCase()) : 'Andamento importante', text: String(text).slice(0, 400), ref });
    }
  }

  const DEFAULT_CLIENT_UPDATE = 'Olá, {nome}! Passando para dar notícia do seu processo{assunto}: {andamento}\n\nQualquer dúvida, estamos à disposição.';
  function clientUpdateText(hint) {
    const k = db.getCase(hint.case_id);
    const cl = k?.client_id ? db.getClient(k.client_id) : null;
    const first = String(cl?.name || '').split(/\s+/)[0] || '';
    const nice = first ? first[0].toUpperCase() + first.slice(1).toLowerCase() : '';
    const vars = {
      nome: nice, nome_completo: cl?.name || '', processo: k?.process_number || '', assunto: k?.title ? ` (${k.title})` : '',
      andamento: explainMove(hint), data: hint.ts ? new Date(hint.ts).toLocaleDateString('pt-BR') : '',
    };
    return String(settings.clientUpdateTemplate || DEFAULT_CLIENT_UPDATE).replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m));
  }
  /** Andamento em linguagem simples para o cliente (o advogado revisa antes de enviar). */
  function explainMove(hint) {
    const t = String(`${hint.title} ${hint.text}`).toLowerCase();
    if (hint.kind === 'hearing' || /audi[eê]ncia/.test(t)) {
      const h = hearingFromText(hint.text);
      return h ? `foi marcada ${h.title.toLowerCase()} para ${new Date(h.ts).toLocaleDateString('pt-BR')}${h.hasTime ? ` às ${new Date(h.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}. Vamos conversar antes para prepararmos tudo.` : 'foi marcada uma audiência. Em breve passamos os detalhes.';
    }
    if (/benef[ií]cio concedido|concedeu o benef/.test(t)) return 'o INSS concedeu o benefício! Vamos acompanhar a implantação e o primeiro pagamento.';
    if (/indefer/.test(t)) return 'o INSS negou o pedido. Vamos analisar o motivo e conversar sobre o recurso ou a ação judicial.';
    if (/improcedente/.test(t)) return 'saiu a sentença, e o pedido não foi aceito pelo juiz. Vamos analisar e conversar sobre o recurso.';
    if (/procedente/.test(t) || /senten/.test(t)) return 'saiu a sentença do processo. Vamos analisar os detalhes e te explicar os próximos passos.';
    if (/acordo/.test(t)) return 'o acordo foi homologado pelo juiz.';
    if (/alvar|libera|rpv|precat/.test(t)) return 'houve andamento sobre o pagamento dos valores. Vamos acompanhar a liberação.';
    if (/tr[aâ]nsito/.test(t)) return 'a decisão transitou em julgado (não cabe mais recurso).';
    if (/per[ií]cia|laudo/.test(t)) return 'houve andamento sobre a perícia. Em breve passamos os detalhes.';
    if (/ac[oó]rd|provid|recurso/.test(t)) return 'o tribunal julgou o recurso. Vamos analisar e te explicar.';
    return `houve um andamento importante (${hint.title.toLowerCase()}).`;
  }

  // ---------------------------------------------------------- INSS (administrativo)
  const INSS_STATUS = { analise: 'Em análise', exigencia: 'Exigência', concedido: 'Concedido', indeferido: 'Indeferido', recurso: 'Em recurso (CRPS)', cancelado: 'Cancelado / desistência' };
  /**
   * Mudou a situação no INSS: exigência → prazo de 30 dias para cumprir;
   * indeferido → prazo de 30 dias para o recurso e sugestão de avisar o
   * cliente; concedido → sugestão de avisar o cliente.
   */
  function inssStatusChanged(id, status, ctx) {
    const k = db.getCase(id);
    if (!k) return;
    db.logActivity(k.jid, 'case', `${k.title}: situação no INSS → ${INSS_STATUS[status] || status}`, ctx.user.name);
    const deadline = (title) => {
      const due = new Date(Date.now() + 30 * DAY); due.setHours(18, 0, 0, 0);
      const t = db.saveTask({ jid: k.jid, case_id: id, kind: 'prazo', title, due_at: due.getTime(), assignee_id: k.responsible_id || ctx.user.id });
      syncTaskLater(t);
      send('tasks:changed', null);
    };
    if (status === 'exigencia') deadline(`Cumprir exigência do INSS${k.inss_benefit ? ` — ${k.inss_benefit}` : ''} (30 dias, confira a data da ciência)`);
    if (status === 'indeferido') deadline(`Recurso ao CRPS ou ação judicial — ${k.inss_benefit || k.title} (30 dias da ciência, confira)`);
    if (status === 'concedido' || status === 'indeferido') {
      db.addHint({ case_id: id, kind: 'client', ts: Date.now(), title: status === 'concedido' ? 'Benefício concedido' : 'Benefício indeferido',
        text: status === 'concedido' ? `O INSS concedeu o benefício${k.inss_benefit ? ` (${k.inss_benefit})` : ''}.` : `O INSS indeferiu o pedido${k.inss_benefit ? ` (${k.inss_benefit})` : ''}.`,
        ref: `inss:${status}:${Date.now()}` });
    }
  }

  // contatos salvos no WhatsApp: em fila, com intervalo (nada de rajada)
  let contactChain = Promise.resolve();
  function queueContactSave(jid, name) {
    contactChain = contactChain.then(async () => {
      try { await wa.saveContact(jid, name); } catch (e) { console.error('salvar contato:', e.message); }
      await new Promise((r) => setTimeout(r, demo ? 10 : 5000));
    });
  }

  /** Dono (usuário) da OAB que recebeu as intimações do processo, se houver um só. */
  function oabOwnerOf(digits) {
    const oabs = new Map(db.listOabs().map((o) => [String(o.id), o.user_id]));
    const owners = new Set();
    for (const i of db.all('SELECT oab_ids FROM intimations WHERE process_digits = ?', String(digits))) {
      for (const oid of String(i.oab_ids || '').split(',').filter(Boolean)) if (oabs.get(oid)) owners.add(oabs.get(oid));
    }
    return owners.size === 1 ? [...owners][0] : null;
  }

  // ---------------------------------------------------------- importar processos
  const importJob = { running: false, phase: '', total: 0, done: 0, created: 0, batch: null, errors: [], userId: null, finishedAt: null };
  const importStatus = () => ({ ...importJob, errors: importJob.errors.slice(-20), withoutClient: db.casesWithoutClient().length });

  function readImportFile(token) {
    const f = resolveUpload?.(token);
    if (!f) throw new Error('Arquivo não encontrado. Envie de novo.');
    const rows = readSheet(fs.readFileSync(f.path), f.name);
    if (rows.length < 2) throw new Error('A planilha não tem linhas de processos.');
    return { name: f.name, header: rows[0], rows: rows.slice(1) };
  }

  /** Busca as partes de um processo no DJEN (para escolher o cliente). */
  async function findParties(caseId) {
    const k = db.getCase(caseId);
    if (!k?.process_number) throw new Error('Processo sem número.');
    const items = await courts.djenByProcess(k.process_number);
    let parties = partiesFromDjen(items, db.listOabs());
    if (!parties.length) {
      // sem comunicação no DJEN: o título da planilha (FULANO x CICLANO), se tinha
      const fromTitle = (k.parties_found || []).filter((p) => p.from === 'titulo');
      parties = fromTitle;
    }
    db.setCaseMeta(caseId, { parties_found: parties, parties_checked_at: Date.now() });
    // a classe e o órgão da comunicação ajudam quando o DataJud não achou
    const it = items[0];
    if (it) {
      const fill = {};
      if (!k.court && it.orgao) fill.court = it.orgao;
      if (isGenericTitle(k.title, k.tribunal) && it.classe) fill.title = nameCase(it.classe);
      if (!k.area) { const a = classifyArea({ tribunal: k.tribunal, number: k.process_number, classe: it.classe }); if (a) fill.area = a; }
      if (Object.keys(fill).length) db.setCaseMeta(caseId, fill);
    }
    db.relinkIntimations(caseId);
    return db.getCase(caseId);
  }

  /** Em segundo plano, um processo por vez: DataJud (andamentos) e DJEN (partes). */
  async function enrichImported(ids) {
    importJob.running = true;
    importJob.phase = 'Consultando os tribunais';
    importJob.total = ids.length;
    importJob.done = 0;
    const pause = demo ? 5 : 1500;
    const tick = throttle(() => send('cases:import', importStatus()), 1000);
    for (const id of ids) {
      if (importJob.stopped) return;
      try { await updateDatajud(id); } catch (e) { importJob.errors.push(`${db.getCase(id)?.process_number}: ${e.message}`); }
      await new Promise((r) => setTimeout(r, pause));
      const k = db.getCase(id);
      if (k?.no_client) {
        try { await findParties(id); } catch (e) {
          // o DJEN pediu para esperar: uma nova tentativa depois de 30 s
          if (/esperar|429/.test(e.message)) {
            await new Promise((r) => setTimeout(r, demo ? 10 : 30000));
            try { await findParties(id); } catch (e2) { importJob.errors.push(`${k.process_number} (partes): ${e2.message}`); }
          } else importJob.errors.push(`${k.process_number} (partes): ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, pause));
      }
      importJob.done++;
      tick();
    }
    tick.cancel();
    importJob.running = false;
    importJob.phase = 'Concluído';
    importJob.finishedAt = Date.now();
    send('cases:import', importStatus());
    send('cases:changed', null);
    const st = importStatus();
    notify({
      kind: 'courts', title: 'Importação dos processos concluída',
      body: `${importJob.created} processo(s) cadastrado(s); ${st.withoutClient} sem cliente para identificar.`,
      action: { view: 'legal', tab: 'processos', status: 'semcliente' },
    }, importJob.userId ? { user: importJob.userId } : undefined);
  }

  let datajudRunning = false;
  /** Uma vez por dia: andamentos novos dos processos abertos (um por vez, com pausa). */
  async function datajudDaily() {
    if (datajudRunning) return;
    datajudRunning = true;
    try {
      const due = db.listCases({ includeClosed: false })
        .filter((k) => k.process_number && !['consultivo', 'inss', 'extrajudicial'].includes(k.kind) && (!k.datajud_checked_at || Date.now() - k.datajud_checked_at > 6 * 3600e3))
        .slice(0, 200);
      const changed = [];
      for (const k of due) {
        try {
          const r = await updateDatajud(k.id);
          // a 1ª consulta traz o histórico inteiro: só avisa o que é novo depois dela
          if (r.newMoves && k.datajud_checked_at) changed.push({ k, n: r.newMoves, last: db.listMoves(k.id).find((m) => m.source === 'datajud') });
        } catch { /* fica registrado no caso */ }
        await new Promise((r) => setTimeout(r, demo ? 10 : 1500));
      }
      for (const { k, n, last } of changed) {
        notifyCase(k, {
          kind: 'moves',
          title: `Andamento novo — ${k.client_name ? `${k.client_name}: ` : ''}${k.title}`,
          body: `${last ? short(last.text) : ''}${n > 1 ? ` (e mais ${n - 1})` : ''}`,
          discreet: 'Andamento novo em processo',
        });
      }
    } finally { datajudRunning = false; }
  }

  /**
   * "Buscar meus processos": percorre o DJEN mês a mês (até 24 meses) pelas OABs
   * e junta os números de processo das publicações. As antigas entram como
   * 'historico' (não vão para "conferir"); os processos que ainda não estão no
   * sistema aparecem em "Processos encontrados" para cadastrar. Devagar, sem rajadas.
   */
  let history = { running: false };
  const historyStatus = () => ({ ...history, processes: history.processes?.size || 0 });
  function scanHistory({ months = 12, userId } = {}) {
    if (history.running) return historyStatus();
    const oabs = db.listOabs().filter((o) => o.active);
    if (!oabs.length) throw new Error('Cadastre a OAB antes de buscar.');
    const n = Math.min(24, Math.max(1, Number(months) || 12));
    history = { running: true, months: n, done: 0, total: oabs.length * n, found: 0, processes: new Set(), errors: [], started: Date.now() };
    const pause = (ms) => new Promise((r) => setTimeout(r, demo ? 5 : ms));
    (async () => {
      for (const o of oabs) {
        for (let w = 0; w < n; w++) {
          const to = Date.now() - w * 30 * DAY;
          const from = to - 30 * DAY + DAY;
          let items = null;
          for (let attempt = 0; attempt < 2 && !items; attempt++) {
            try { items = await courts.djenByOab({ number: o.number, uf: o.uf, from, to, maxPages: 30 }); } catch (e) {
              if (attempt) history.errors.push(`OAB ${o.number}/${o.uf}, ${new Date(from).toLocaleDateString('pt-BR')}: ${e.message}`);
              else await pause(10000); // o DJEN pediu calma: espera e tenta de novo
            }
          }
          for (const it of items || []) {
            const recent = it.date && it.date > Date.now() - 10 * DAY;
            const id = db.addIntimation(it, o.id, recent ? 'nova' : 'historico');
            if (it.process_number) history.processes.add(String(it.process_number).replace(/\D/g, ''));
            if (!id) continue;
            history.found++;
            const row = db.getIntimation(id);
            if (row.case_id) db.addMove({ case_id: row.case_id, ts: it.date, text: `${it.kind}${it.doc_kind ? ` (${it.doc_kind})` : ''} — ${it.text.slice(0, 600)}`, source: 'djen', ext_id: `djen:${it.ext_id}` });
          }
          history.done++;
          send('courts:history', historyStatus());
          await pause(1500);
        }
      }
    })().catch((e) => history.errors.push(e.message)).finally(() => {
      history.running = false;
      history.finished = Date.now();
      const pending = db.unknownProcesses().length;
      send('courts:history', historyStatus());
      send('intimations:changed', null);
      notify({
        kind: 'courts', title: 'Busca dos seus processos concluída',
        body: `${history.processes.size} processo(s) com publicações no DJEN; ${pending} ainda não cadastrado(s) no sistema.`,
        action: { view: 'legal', tab: 'intimacoes' },
      }, userId ? { user: userId } : undefined);
    });
    return historyStatus();
  }

  /** Relógio dos tribunais: DJEN e DataJud a cada 6 h (das 6h às 22h). */
  function courtsTick() {
    const hour = new Date().getHours();
    if (hour < 6 || hour >= 22) return;
    if (db.listOabs().some((o) => o.active) && Date.now() - Number(settings.djenLastRun || 0) > 6 * 3600e3) checkIntimations().catch((e) => console.error('djen:', e.message));
    datajudDaily().catch((e) => console.error('datajud:', e.message));
  }

  /** Dados do recibo de uma parcela recebida ou de uma receita avulsa (`income`). */
  function receiptArgs(id, income = false) {
    if (income) {
      const i = db.getIncome(id);
      if (!i) throw new Error('Receita não encontrada');
      const cl = i.client_id ? db.getClient(i.client_id) : null;
      return {
        no: db.incomeReceiptNumber(id), value: i.amount, at: i.received_at, method: i.method,
        who: i.who || 'cliente', doc: i.cpf ? `${i.client_kind === 'pj' ? 'CNPJ' : 'CPF'} ${i.cpf}` : '',
        ref: [i.description, i.category && !i.description.toLowerCase().includes(i.category.toLowerCase()) ? i.category.toLowerCase() : null].filter(Boolean).join(' — '),
        jid: cl?.jid || null,
      };
    }
    const p = db.getPayment(id);
    if (!p) throw new Error('Parcela não encontrada');
    if (!p.paid_at) throw new Error('Registre o recebimento antes de emitir o recibo.');
    const k = db.getCase(p.case_id);
    const cl = k?.client_id ? db.getClient(k.client_id) : null;
    const desc = p.description || 'honorários advocatícios';
    const ref = [desc, p.of_total > 1 && !/parcela/i.test(desc) ? `parcela ${p.seq}/${p.of_total}` : null, k?.title ? `caso “${k.title}”` : null,
      k?.process_number ? `processo nº ${k.process_number}` : null].filter(Boolean).join(', ');
    return {
      no: db.receiptNumber(id), value: p.paid_amount ?? p.amount, at: p.paid_at, method: p.method,
      who: cl?.name || k?.client_name || 'cliente', doc: cl?.cpf ? `${cl.kind === 'pj' ? 'CNPJ' : 'CPF'} ${cl.cpf}` : '', ref,
      jid: cl?.jid || null,
    };
  }
  const withWho = (a) => ({ ...receiptDoc(a), who: a.who, canSend: !!a.jid, signMode: signMode() });
  const receiptHtml = (id) => withWho(receiptArgs(id));
  const incomeReceiptHtml = (id) => withWho(receiptArgs(id, true));

  // ---------------------------------------------------- recibo em PDF e assinatura
  // Imagem da assinatura em <dados>/assinatura/. A assinatura digital é com o
  // certificado A3 (token) de quem emite, pelo app de desktop.
  const SIGN_DIR = path.join(dataDir, 'assinatura');
  const signatureImage = () => ['assinatura.png', 'assinatura.jpg'].map((f) => path.join(SIGN_DIR, f)).find((f) => fs.existsSync(f)) || null;
  const signMode = () => (settings.receiptSignMode === 'a3' ? 'a3' : 'none');
  const fileNameOf = (a) => `Recibo ${String(a.no).padStart(4, '0')} - ${String(a.who).replace(/[\\/:*?"<>|]+/g, ' ').trim()}.pdf`;
  const pdfArgs = (a, signedBy) => ({
    ...a, words: reais(a.value), signedBy,
    office: { name: settings.officeName || 'Barros Associados', doc: settings.officeDoc, address: settings.officeAddress, city: settings.officeCity },
    logo: path.join(ASSETS_DIR, 'logo-barros.jpg'), signatureImage: signatureImage(), signerName: settings.receiptSigner || null,
  });
  // PDFs prontos (para baixar/enviar) e assinaturas A3 em andamento, por alguns minutos
  const readyPdfs = new Map();
  const pendingA3 = new Map();
  const keep = (map, value, ms = 10 * 60e3) => {
    const token = crypto.randomBytes(12).toString('hex');
    map.set(token, value);
    setTimeout(() => { const v = map.get(token); map.delete(token); v?.cancel?.(); }, ms).unref?.();
    return token;
  };
  const readyResult = (buf, a, signed) => ({ token: keep(readyPdfs, { buf, name: fileNameOf(a), jid: a.jid, no: a.no, who: a.who }), name: fileNameOf(a), pdf: buf.toString('base64'), signed, canSend: !!a.jid });

  function receiptDoc({ no, value, at, method, who, doc, ref }) {
    const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const money = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const date = new Date(at).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
    const office = settings.officeName || 'Barros Associados';
    const methods = { pix: 'Pix', dinheiro: 'dinheiro', transferencia: 'transferência bancária', boleto: 'boleto', cartao: 'cartão', cheque: 'cheque' };
    const sigFile = signatureImage();
    const sigImg = sigFile ? `data:image/${sigFile.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(sigFile).toString('base64')}` : null;
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Recibo nº ${no}</title><style>
      @page { size: A4; margin: 22mm; }
      body { font-family: Georgia, 'Times New Roman', serif; color: #111; font-size: 13.5pt; line-height: 1.6; margin: 0; padding: 24px; background: #fff; }
      .top { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #3d5a6c; padding-bottom: 10px; }
      .top img { height: 64px; }
      .office { text-align: right; font-size: 10.5pt; color: #444; line-height: 1.35; }
      h1 { font-size: 20pt; letter-spacing: .12em; margin: 26px 0 4px; text-align: center; }
      .no { text-align: center; color: #555; font-size: 11pt; }
      .value { margin: 22px auto; width: fit-content; border: 2px solid #3d5a6c; border-radius: 6px; padding: 8px 22px; font-size: 16pt; font-weight: bold; }
      p { text-align: justify; }
      .sign { margin-top: 70px; text-align: center; }
      .sign .line { border-top: 1px solid #111; width: 60%; margin: 0 auto 6px; }
      .small { font-size: 10pt; color: #555; }
    </style></head><body>
      <div class="top"><img src="/assets/logo-barros.jpg" alt=""><div class="office"><b>${esc(office)}</b>${settings.officeDoc ? `<br>${esc(settings.officeDoc)}` : ''}${settings.officeAddress ? `<br>${esc(settings.officeAddress)}` : ''}</div></div>
      <h1>RECIBO</h1><div class="no">Nº ${String(no).padStart(4, '0')}</div>
      <div class="value">${money(value)}</div>
      <p>Recebemos de <b>${esc(who)}</b>${doc ? `, ${esc(doc)}` : ''}, a importância de
      <b>${money(value)}</b> (${esc(reais(value))}), referente a ${esc(ref)}${method ? `, paga em ${esc(methods[method] || method)}` : ''}.</p>
      <p>Para clareza, firmamos o presente recibo, dando plena quitação do valor acima.</p>
      <p style="text-align:right">${esc(settings.officeCity || 'Cuiabá-MT')}, ${esc(date)}.</p>
      <div class="sign">${sigImg ? `<img src="${sigImg}" alt="" style="max-height:70px;max-width:220px;display:block;margin:0 auto 2px">` : ''}<div class="line"></div>${esc(settings.receiptSigner || office)}${settings.receiptSigner && settings.receiptSigner !== office ? `<div class="small">${esc(office)}</div>` : ''}${settings.officeDoc ? `<div class="small">${esc(settings.officeDoc)}</div>` : ''}</div>
    </body></html>`;
    return { number: no, html };
  }

  /** Proposta de honorários em página A4 (mesmo cabeçalho do recibo). */
  function proposalDoc(l, text) {
    const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const office = settings.officeName || 'Barros Associados';
    const date = new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
    const paras = String(text).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Proposta de honorários — ${esc(l.name)}</title><style>
      @page { size: A4; margin: 22mm; }
      body { font-family: Georgia, 'Times New Roman', serif; color: #111; font-size: 12.5pt; line-height: 1.6; margin: 0; padding: 24px; background: #fff; }
      .top { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #3d5a6c; padding-bottom: 10px; }
      .top img { height: 64px; }
      .office { text-align: right; font-size: 10.5pt; color: #444; line-height: 1.35; }
      h1 { font-size: 17pt; letter-spacing: .08em; margin: 26px 0 2px; text-align: center; }
      .to { text-align: center; color: #555; font-size: 11pt; margin-bottom: 18px; }
      p { text-align: justify; }
      .sign { margin-top: 60px; text-align: center; }
      .sign .line { border-top: 1px solid #111; width: 60%; margin: 0 auto 6px; }
    </style></head><body>
      <div class="top"><img src="/assets/logo-barros.jpg" alt=""><div class="office"><b>${esc(office)}</b>${settings.officeDoc ? `<br>${esc(settings.officeDoc)}` : ''}${settings.officeAddress ? `<br>${esc(settings.officeAddress)}` : ''}</div></div>
      <h1>PROPOSTA DE HONORÁRIOS</h1><div class="to">${esc(l.name)}${l.subject ? ` · ${esc(l.subject)}` : ''}</div>
      ${paras}
      <p style="text-align:right">${esc(settings.officeCity || 'Cuiabá-MT')}, ${esc(date)}.</p>
      <div class="sign"><div class="line"></div>${esc(office)}</div>
    </body></html>`;
    return { html };
  }

  /** Etapas do caso (com o que dá para concluir sozinho a partir dos dados). */
  function flowOf(k, checklist) {
    return computeSteps(k, {
      manual: db.listSteps(k.id),
      checklist: checklist || db.listChecklist(k.id),
      payments: db.get('SELECT COUNT(*) AS n FROM payments WHERE case_id = ?', k.id)?.n || 0,
    });
  }
  function caseChanged(k) {
    if (!k) return;
    wa.markChanged(k.jid);
    send('cases:changed', k.jid);
  }
  const send_ = (...a) => send(...a);

  /** Cliente mudou: avisa as janelas (e a conversa ligada a ele, se houver). */
  function clientChanged(id) {
    const cl = db.getClient(id);
    if (cl?.jid) wa.markChanged(cl.jid);
    send('clients:changed', id);
  }

  /** Arquivo anexado ao caso também vai para a pasta dele no OneDrive (se houver). */
  function copyToCaseFolder(caseId, files) {
    const k = db.getCase(caseId);
    if (!k?.folder || !docs.root()) return;
    try { docs.saveFiles(k.folder, files, null); } catch (e) { console.error('pasta do caso:', e.message); }
  }

  function broadcastConfig() {
    send('config:changed', {
      pipelines: db.listPipelines(), tags: db.listTags(), quickReplies: db.listQuickReplies(),
      contactTypes: db.listContactTypes(), filters: db.listChatFilters(),
    });
  }
  const refreshAllChats = () => send('chats:reload', db.listChats());

  /** Configurações vistas por uma pessoa: as do escritório + as preferências dela. */
  function settingsFor(user) {
    const { windowBounds, windowMaximized, trayHintShown, ...office } = settings;
    return { ...office, ...auth.userPrefs(user.id) };
  }

  /** Assinatura "*Nome:*" no início das mensagens enviadas pela equipe. */
  function sign(ctx, text) {
    if (settings.signMessages === false || !ctx.user) return text;
    const sig = (ctx.user.signature || auth.defaultSignature(ctx.user.name)).trim();
    return sig ? `*${sig}:*\n${text}` : text;
  }

  const forMoney = (ctx, v) => (auth.can(ctx.user.role, 'finance:list') ? v : auth.stripMoney(v));
  const who = (ctx) => ctx.user?.name || null;

  const applySettings = () => { wa.sendReadReceipts = settings.sendReadReceipts !== false; };

  // ---------------------------------------------------- API
  // Todo método recebe `ctx` ({user, conn}) e depois os argumentos da interface.
  const api = {
    bootstrap: (ctx) => ({
      demo,
      me: auth.publicUser(ctx.user),
      can: auth.capabilities(ctx.user.role),
      status: wa.getStatus(),
      chats: db.listChats(),
      pipelines: db.listPipelines(),
      tags: db.listTags(),
      quickReplies: db.listQuickReplies(),
      contactTypes: db.listContactTypes(),
      filters: db.listChatFilters(),
      settings: settingsFor(ctx.user),
      dataDir: ctx.user.role === 'socio' ? dataDir : '',
      version,
      canRestore: !!features.restore && ctx.user.role === 'socio',
      viewers: [...viewers.values()].filter((v) => v.jid).map((v) => ({ jid: v.jid, userId: v.userId, name: v.name })),
    }),
    'wa:logout': () => wa.logout(),
    'wa:reconnect': () => wa.reconnectNow(),
    'wa:status': () => wa.getStatus(),
    'wa:reset': () => wa.reset(),
    'wa:repair': () => wa.repair(),
    'wa:diagnose': async () => {
      const r = await diagnoseConnection();
      wa.logger.warn({ diagnostico: r }, 'teste de conexão');
      return r;
    },
    'wa:pairingCode': (_c, phone) => wa.requestPairingCode(phone),
    'wa:checkNumber': (_c, phone) => wa.checkNumber(phone),

    // equipe
    'users:list': () => auth.listUsers(),
    'users:save': (ctx, u) => {
      const id = auth.saveUser(u);
      send('users:changed', null);
      if (id === ctx.user.id) send('me:changed', auth.publicUser(auth.getUser(id)), { user: id });
      return id;
    },
    'users:roles': () => auth.ROLES,
    /** Equipe ativa (para escolher responsável) — qualquer perfil vê. */
    'team:list': () => auth.listUsers().filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })),
    'me:update': (ctx, { name, signature }) => {
      const u = ctx.user;
      auth.saveUser({ id: u.id, name: name ?? u.name, login: u.login, signature: signature ?? u.signature });
      const pub = auth.publicUser(auth.getUser(u.id));
      send('me:changed', pub, { user: u.id });
      send('users:changed', null);
      return pub;
    },
    'me:password': (ctx, current, next) => {
      if (!auth.checkPassword(current, ctx.user.pass_hash)) throw new Error('A senha atual não confere.');
      auth.setPassword(ctx.user.id, next);
    },

    // presença da equipe nas conversas
    'app:focus': (ctx, focused) => {
      const v = viewerOf(ctx);
      if (!v) return null;
      v.focused = !!focused;
      if (v.focused && v.jid) return wa.markRead(v.jid);
      return null;
    },

    // conversas
    'chats:list': () => db.listChats(),
    'chats:get': (_c, jid) => db.getChat(jid),
    'chats:setActive': (ctx, jid) => {
      const v = viewerOf(ctx);
      if (v) { v.jid = jid || null; broadcastViewers(); }
      if (jid && (!v || v.focused)) return wa.markRead(jid);
      return null;
    },
    'chats:typing': (ctx, jid) => { send('chats:typing', { jid, userId: ctx.user.id, name: ctx.user.name }); },
    'chats:markRead': (_c, jid) => wa.markRead(chatOrThrow(jid)),
    'chats:markUnread': (_c, jid) => { db.setChatUnread(jid, 1); wa.markChanged(jid); },
    'chats:start': async (_c, phone, name) => {
      const jid = await wa.checkNumber(phone);
      if (!jid) throw new Error('Este número não tem WhatsApp.');
      db.upsertChat({ jid, is_group: false });
      if (name) db.updateCrmFields(jid, { custom_name: name });
      if (!db.getChat(jid).last_ts) db.run('UPDATE chats SET last_ts = ? WHERE jid = ?', Date.now(), jid);
      wa.markChanged(jid);
      return db.getChat(jid);
    },
    'chats:avatar': async (_c, jid) => {
      const rel = await wa.avatar(jid);
      return rel ? mediaUrl(rel) : null;
    },
    'chats:groupInfo': (_c, jid) => wa.groupInfo(jid),
    'chats:presence': (_c, jid, type) => wa.sendPresence(jid, type),

    // mensagens
    'messages:list': (_c, jid, opts) => db.listMessages(chatOrThrow(jid), opts || {}),
    'messages:search': (_c, q) => db.searchMessages(String(q || '')),
    'messages:sendText': (ctx, jid, text, quotedId) => wa.sendText(chatOrThrow(jid), sign(ctx, text), quotedId),
    /** Arquivos já enviados ao servidor por /upload (cada um vira um token). */
    'messages:sendFiles': async (_c, jid, tokens, caption, quotedId) => {
      const files = uploads(tokens);
      const ids = [];
      try {
        for (let i = 0; i < files.length; i++) {
          ids.push(await wa.sendFile(chatOrThrow(jid), files[i].path, { caption: i === 0 ? caption : undefined, quotedId }));
        }
      } finally {
        files.forEach((f) => fs.rmSync(path.dirname(f.path), { recursive: true, force: true }));
      }
      return ids;
    },
    'messages:sendVoice': (_c, jid, token) => {
      const [f] = uploads([token]);
      try {
        const { ogg, seconds } = webmToOgg(fs.readFileSync(f.path));
        return wa.sendVoice(chatOrThrow(jid), ogg, 'audio/ogg; codecs=opus', seconds);
      } finally {
        fs.rmSync(path.dirname(f.path), { recursive: true, force: true });
      }
    },
    'messages:react': (_c, jid, id, emoji) => wa.react(jid, id, emoji),
    'messages:delete': (_c, jid, id) => wa.deleteForEveryone(jid, id),
    'messages:edit': (_c, jid, id, text) => wa.editMessage(jid, id, text),
    'messages:download': async (_c, jid, id) => {
      const rel = await wa.downloadMedia(jid, id);
      send('message', { chatJid: jid, id, isNew: false, message: stripRaw(db.getMessage(jid, id)) });
      return rel;
    },
    'messages:loadOlder': (_c, jid) => wa.loadOlder(jid),
    'media:check': (_c, rel) => {
      const file = resolveMedia(rel);
      if (!fs.existsSync(file)) throw new Error('Arquivo não encontrado.');
      return { url: mediaUrl(rel), risky: RISKY_EXT.has(path.extname(file).slice(1).toLowerCase()) };
    },

    // CRM
    'crm:setStage': (_c, jid, stageId) => { db.setStage(jid, stageId); wa.markChanged(jid); },
    'crm:update': (_c, jid, fields) => { db.updateCrmFields(jid, fields); wa.markChanged(jid); },
    'crm:setType': (_c, jid, typeId) => { db.setContactType(jid, typeId); wa.markChanged(jid); wa.backfillDownloads([jid]); },
    'types:save': (_c, t) => {
      const id = db.saveContactType(t);
      broadcastConfig();
      if (t.autodownload) wa.backfillDownloads(db.autoDownloadChats(id));
      return id;
    },
    'types:delete': (_c, id) => { db.deleteContactType(id); broadcastConfig(); refreshAllChats(); },
    'types:reorder': (_c, ids) => { db.reorderContactTypes(ids); broadcastConfig(); },
    'filters:save': (_c, f) => { const id = db.saveChatFilter(f); broadcastConfig(); return id; },
    'filters:delete': (_c, id) => { db.deleteChatFilter(id); broadcastConfig(); },
    'filters:reorder': (_c, ids) => { db.reorderChatFilters(ids); broadcastConfig(); },
    'crm:setTags': (_c, jid, tagIds) => { db.setChatTags(jid, tagIds); wa.markChanged(jid); },
    'crm:activity': (_c, jid) => db.listActivity(jid),
    'notes:list': (_c, jid, caseId) => db.listNotes(jid, caseId),
    'notes:add': (ctx, jid, text, caseId) => {
      const id = db.addNote(jid, text, caseId);
      db.logActivity(jid, 'note', 'Nota adicionada', who(ctx));
      return id;
    },
    'notes:delete': (_c, id) => db.deleteNote(id),

    // casos
    // clientes (o centro do sistema; o WhatsApp é um canal ligado a eles)
    'clients:list': (_c, opts) => db.listClients(opts || {}),
    'clients:get': (_c, id) => {
      const cl = db.getClient(id);
      if (!cl) throw new Error('Cliente não encontrado');
      const chat = cl.jid ? db.getChat(cl.jid) : null;
      return { ...cl, chat: chat ? { jid: chat.jid, display_name: chat.display_name, unread: chat.unread, last_ts: chat.last_ts, last_preview: chat.last_preview } : null };
    },
    'clients:lookupCep': async (_c, cep) => {
      const d = String(cep || '').replace(/\D/g, '');
      return cachedLookup(`cep:${d}`, () => lookupCep(d, lookup.fetch));
    },
    'clients:lookupCnpj': async (_c, cnpj) => {
      const d = String(cnpj || '').replace(/\D/g, '');
      return cachedLookup(`cnpj:${d}`, () => lookupCnpj(d, lookup.fetch));
    },
    'clients:similar': (_c, q) => db.similarClients(q || {}),
    'clients:save': (ctx, c) => { const id = db.saveClient({ ...c, userName: ctx.user.name }); clientChanged(id); return id; },
    /** Conversas do WhatsApp que parecem ser deste cliente (telefone ou nome), ainda sem cliente. */
    'clients:suggestChats': (_c, id) => {
      const cl = db.getClient(id);
      if (!cl || cl.jid) return [];
      const phones = [cl.phone, cl.phone2].map((p) => String(p || '').replace(/\D/g, '')).filter((p) => p.length >= 8).map((p) => p.slice(-8));
      const linked = new Set(db.all('SELECT jid FROM clients WHERE jid IS NOT NULL').map((r) => r.jid));
      return db.listChats().filter((c) => !c.is_group && !linked.has(c.jid) && !String(c.jid).endsWith('@g.us'))
        .map((c) => {
          const digits = String(c.jid).endsWith('@s.whatsapp.net') ? c.jid.split('@')[0] : '';
          const byPhone = digits && phones.some((p) => digits.endsWith(p));
          const byName = sameName(cl.name, c.display_name) || (c.contact_name && sameName(cl.name, c.contact_name));
          return byPhone || byName ? { jid: c.jid, name: c.display_name, phone: digits, by: byPhone ? 'telefone' : 'nome', last_ts: c.last_ts } : null;
        })
        .filter(Boolean).sort((a, b) => (a.by === b.by ? (b.last_ts || 0) - (a.last_ts || 0) : a.by === 'telefone' ? -1 : 1)).slice(0, 5);
    },
    /** Salva o contato no WhatsApp do escritório com o nome do cadastro (um por vez). */
    'clients:saveContact': async (_c, id) => {
      const cl = db.getClient(id);
      if (!cl?.jid) throw new Error('Ligue o WhatsApp do cliente primeiro.');
      return wa.saveContact(cl.jid, cl.name);
    },
    'clients:linkChat': (_c, id, jid) => {
      const before = db.getClient(id)?.jid;
      db.linkClientChat(id, jid || null);
      if (before) wa.markChanged(before);
      clientChanged(id);
      // opção do escritório: salvar o contato no WhatsApp com o nome do cadastro
      if (jid && settings.waSaveContacts) queueContactSave(jid, db.getClient(id)?.name);
    },
    'clients:fromChat': (ctx, jid) => { const id = db.ensureClientForChat(chatOrThrow(jid), ctx.user.name); clientChanged(id); return id; },
    'clients:activity': (_c, id) => db.listActivity(db.clientKey(db.getClient(id))),
    // comercial: interessados, atendimentos, proposta e "virar cliente"
    'leads:meta': () => ({ stages: leads.LEAD_STAGES, sources: leads.LEAD_SOURCES, contactKinds: leads.CONTACT_KINDS, feeKinds: leads.FEE_KINDS }),
    'leads:list': (ctx, opts = {}) => {
      const list = leads.listLeads({ ...opts, responsible: opts.responsible === 'me' ? ctx.user.id : opts.responsible });
      return forMoney(ctx, list);
    },
    'leads:get': (ctx, id) => {
      const l = leads.getLead(id);
      if (!l) throw new Error('Interessado não encontrado');
      return forMoney(ctx, {
        ...l,
        contacts: leads.listContacts({ leadId: id }),
        tasks: db.listTasks({ jid: l.client_id && l.case_id ? db.clientKey(db.getClient(l.client_id)) : l.key, includeDone: true }),
        chat: l.jid ? (() => { const c = db.getChat(l.jid); return c ? { jid: c.jid, display_name: c.display_name } : null; })() : null,
      });
    },
    'leads:byJid': (ctx, jid) => forMoney(ctx, leads.leadByJid(jid)),
    'leads:save': (ctx, l) => {
      if (!auth.can(ctx.user.role, 'finance:list')) l = auth.stripMoney(l);
      const before = l.id ? leads.getLead(l.id) : null;
      const id = leads.saveLead(l, ctx.user.name);
      const cur = leads.getLead(id);
      if (!before) db.logActivity(cur.key, 'lead', `Interessado cadastrado${cur.source ? ` (${cur.source})` : ''}`, ctx.user.name);
      // consulta marcada vira compromisso na Agenda
      if (l.consult_at && l.consult_at !== before?.consult_at) {
        const old = db.get("SELECT id FROM tasks WHERE jid = ? AND kind = 'reuniao' AND done = 0 AND title LIKE 'Consulta:%'", cur.key);
        const taskId = db.saveTask({ id: old?.id, jid: cur.key, kind: 'reuniao', title: `Consulta: ${cur.name}`, due_at: Number(l.consult_at),
          end_at: Number(l.consult_at) + 3600e3, assignee_id: cur.responsible_id || ctx.user.id });
        syncTaskLater(taskId);
        if (cur.stage === 'novo') leads.setLeadStage(id, 'consulta');
        send('tasks:changed', null);
      }
      if (cur.jid) wa.markChanged(cur.jid);
      send('leads:changed', id);
      return id;
    },
    'leads:setStage': (ctx, id, stage, opts = {}) => {
      leads.setLeadStage(id, stage, opts);
      const l = leads.getLead(id);
      db.logActivity(l.key, 'lead', `Comercial: ${leads.stageLabel(stage)}${stage === 'perdido' && l.lost_reason ? ` — ${l.lost_reason}` : ''}`, ctx.user.name);
      if (stage === 'perdido') send('tasks:changed', null);
      send('leads:changed', id);
    },
    'leads:delete': (_c, id) => {
      const l = leads.getLead(id);
      leads.deleteLead(id);
      if (l?.jid) wa.markChanged(l.jid);
      send('leads:changed', id);
      send('tasks:changed', null);
    },
    'leads:contacts': (_c, { leadId, clientId } = {}) => leads.listContacts({ leadId, clientId }),
    /** Registro de atendimento; o próximo passo com data vira lembrete na Agenda. */
    'leads:addContact': (ctx, c = {}) => {
      const id = leads.addContact(c, ctx.user.name);
      let key = null;
      if (c.lead_id) {
        const l = leads.getLead(c.lead_id);
        key = l.case_id && l.client_id ? db.clientKey(db.getClient(l.client_id)) : l.key;
      } else key = db.clientKey(db.getClient(c.client_id));
      if (c.next_at) {
        const taskId = db.saveTask({ jid: key, kind: 'tarefa', title: String(c.next_step || '').trim() || 'Retomar contato',
          due_at: Number(c.next_at), assignee_id: c.assignee_id || ctx.user.id });
        syncTaskLater(taskId);
        send('tasks:changed', null);
      }
      db.logActivity(key, 'lead', `Atendimento (${leads.CONTACT_KINDS[c.kind]}): ${String(c.summary).trim().slice(0, 140)}`, ctx.user.name);
      send('leads:changed', c.lead_id || null);
      if (c.client_id) send('clients:changed', c.client_id);
      return id;
    },
    'leads:deleteContact': (_c, id) => {
      const c = leads.getContact(id);
      leads.deleteContact(id);
      send('leads:changed', c?.lead_id || null);
      if (c?.client_id) send('clients:changed', c.client_id);
    },
    'leads:defaultTemplate': () => leads.DEFAULT_PROPOSAL_TEMPLATE,
    'leads:proposalText': (_c, id) => {
      const l = leads.getLead(id);
      if (!l) throw new Error('Interessado não encontrado');
      return leads.proposalText(l, settings.proposalTemplate, { office: settings.officeName || 'Barros Associados', validDays: Number(settings.proposalValidDays) || 15 });
    },
    /** Proposta revisada: envia pelo WhatsApp (se escolher), marca como enviada e agenda o retorno em 3 dias úteis. */
    'leads:proposal': async (ctx, id, { text, send: viaWa } = {}) => {
      const l = leads.getLead(id);
      if (!l) throw new Error('Interessado não encontrado');
      if (!String(text || '').trim()) throw new Error('O texto da proposta está vazio.');
      if (viaWa) {
        if (!l.jid) throw new Error('Este interessado não tem WhatsApp.');
        await api['messages:sendText'](ctx, l.jid, text);
      }
      leads.markProposalSent(id, text);
      const taskId = db.saveTask({ jid: l.key, kind: 'tarefa', title: `Retomar proposta — ${l.name}`,
        due_at: addBusinessDays(Date.now(), 3), assignee_id: l.responsible_id || ctx.user.id });
      syncTaskLater(taskId);
      db.logActivity(l.key, 'lead', `Proposta de honorários ${viaWa ? 'enviada pelo WhatsApp' : 'registrada como enviada'}`, ctx.user.name);
      send('tasks:changed', null);
      send('leads:changed', id);
      return { taskId };
    },
    /** Proposta em página para imprimir / salvar em PDF, com o cabeçalho do escritório. */
    'leads:proposalHtml': (_c, id, text) => {
      const l = leads.getLead(id);
      if (!l) throw new Error('Interessado não encontrado');
      return proposalDoc(l, text || l.proposal_text || '');
    },
    'leads:convert': (ctx, id, opts = {}) => {
      if (!auth.can(ctx.user.role, 'finance:list')) opts = { ...opts, firstDue: null };
      const r = leads.convertLead(id, opts, ctx.user.name);
      const l = leads.getLead(id);
      if (l.jid) wa.markChanged(l.jid);
      clientChanged(r.clientId);
      send('cases:changed', r.key);
      send('tasks:changed', null);
      send('leads:changed', id);
      return r;
    },
    'leads:stats': (ctx, range = {}) => forMoney(ctx, leads.leadStats(range)),
    'cases:list': (ctx, opts = {}) => {
      let list = db.listCases(opts || {});
      if (opts?.responsible === 'me') list = list.filter((k) => k.responsible_id === ctx.user.id);
      else if (opts?.responsible) list = list.filter((k) => k.responsible_id === Number(opts.responsible));
      if (opts?.withFlow) list = list.map((k) => { const f = flowOf(k); return { ...k, next_step: f.next, flow_done: f.done, flow_total: f.total }; });
      return forMoney(ctx, list);
    },
    // ficha completa do processo: dados, partes, andamentos, etapas e documentos
    'cases:full': (ctx, id) => {
      const k = db.getCase(id);
      if (!k) throw new Error('Processo não encontrado');
      const checklist = db.listChecklist(id);
      return {
        case: forMoney(ctx, k),
        parties: db.listParties(id),
        moves: db.listMoves(id),
        hints: db.listHints({ caseId: id }),
        flow: flowOf(k, checklist),
        checklist,
        suggested: checklist.length ? null : suggestedChecklist(k),
        roles: PARTY_ROLES,
        docsTemplate: settings.docsRequestTemplate || DEFAULT_DOCS_TEMPLATE,
      };
    },
    'cases:setStep': (ctx, id, step, status) => {
      if (!STEPS.some((x) => x.key === step)) throw new Error('etapa desconhecida');
      db.setStep(id, step, status === 'done' || status === 'na' ? status : null, ctx.user.name);
      const k = db.getCase(id);
      if (status) db.logActivity(k.jid, 'case', `${k.title}: etapa “${STEPS.find((x) => x.key === step).label}” ${status === 'na' ? 'não se aplica' : 'concluída'}`, ctx.user.name);
      caseChanged(k);
    },
    // tribunais: OABs acompanhadas, intimações do DJEN, andamentos do DataJud
    'oabs:list': () => db.listOabs(),
    'oabs:save': (ctx, o) => {
      // cada advogado cadastra/edita a própria OAB; o sócio, a de qualquer um
      if (ctx.user.role !== 'socio') {
        const cur = o.id ? db.listOabs().find((x) => x.id === o.id) : null;
        if (cur && cur.user_id && cur.user_id !== ctx.user.id) throw new Error('Só o sócio muda a OAB de outra pessoa.');
        o = { ...o, user_id: ctx.user.id };
      } else if (!o.id && o.user_id === undefined) o = { ...o, user_id: ctx.user.id };
      const id = db.saveOab(o);
      send('intimations:changed', null);
      return id;
    },
    'oabs:delete': (ctx, id) => {
      const cur = db.listOabs().find((x) => x.id === id);
      if (ctx.user.role !== 'socio' && cur?.user_id && cur.user_id !== ctx.user.id) throw new Error('Só o sócio exclui a OAB de outra pessoa.');
      db.deleteOab(id);
      send('intimations:changed', null);
    },
    'intimations:list': (_c, opts) => db.listIntimations(opts || {}),
    'intimations:check': async (_c, { days } = {}) => checkIntimations({ days: Math.min(60, Math.max(1, Number(days) || 10)) }),
    'intimations:status': () => ({ lastRun: Number(settings.djenLastRun) || null, running: !!checkingIntimations, oabs: db.listOabs(), history: historyStatus() }),
    'courts:history': (ctx, { months } = {}) => scanHistory({ months, userId: ctx.user.id }),
    'intimations:set': (ctx, ids, status) => {
      for (const id of ids || []) db.setIntimation(id, { status, handled_by: ctx.user.name, handled_at: Date.now() });
      send('intimations:changed', null);
    },
    'intimations:calc': (_c, id, days) => {
      const it = db.getIntimation(id);
      return deadlineFromAvailability(it?.date || Date.now(), Math.max(1, Number(days) || 15));
    },
    /** Cria o prazo na agenda a partir da intimação (a data é conferida pela pessoa). */
    'intimations:deadline': (ctx, id, { due_at, title, assignee_id, case_id } = {}) => {
      const it = db.getIntimation(id);
      if (!it) throw new Error('Intimação não encontrada');
      const caseId = case_id || it.case_id;
      const k = caseId ? db.getCase(caseId) : null;
      if (!due_at) throw new Error('Informe a data do prazo.');
      const taskId = db.saveTask({
        jid: k?.jid || null, case_id: caseId || null, kind: 'prazo', due_at,
        title: title || `Prazo: ${it.doc_kind || it.kind} — ${it.process_number}`,
        assignee_id: assignee_id ?? k?.responsible_id ?? ctx.user.id,
      });
      syncTaskLater(taskId);
      db.setIntimation(id, { status: 'prazo', task_id: taskId, case_id: caseId || null, handled_by: ctx.user.name, handled_at: Date.now() });
      if (k) { db.logActivity(k.jid, 'case', `${k.title}: prazo criado a partir de intimação`, ctx.user.name); caseChanged(k); }
      send('tasks:changed', null);
      send('intimations:changed', null);
      return taskId;
    },
    'intimations:linkCase': (_c, id, caseId) => { db.setIntimation(id, { case_id: caseId }); send('intimations:changed', null); },
    'courts:unknown': () => db.unknownProcesses(),
    'courts:ignore': (_c, digits) => { db.run("UPDATE intimations SET status = 'ignorada' WHERE process_digits = ? AND case_id IS NULL", String(digits)); send('intimations:changed', null); },
    /** Cadastra um processo que apareceu nas intimações (com o cliente escolhido). */
    'courts:import': async (ctx, digits, { client_id, client_name, client_role, title } = {}) => {
      const it = db.listIntimations({}).find((i) => i.process_digits === String(digits));
      if (!it) throw new Error('Processo não encontrado nas intimações.');
      let cid = client_id;
      if (!cid) {
        if (!String(client_name || '').trim()) throw new Error('Escolha ou informe o cliente.');
        cid = db.saveClient({ name: nameCase(client_name), origin: 'Intimação', userName: ctx.user.name });
      }
      const id = db.saveCase({ client_id: cid, title: title || it.classe || 'Processo' });
      // responsável = dono da OAB que recebeu a intimação (não quem clicou)
      const owner = oabOwnerOf(digits);
      db.saveCase({ id, process_number: formatCnj(it.process_number), tribunal: it.tribunal || tribunalOf(it.process_number), court: it.orgao, client_role: client_role || null, responsible_id: owner || ctx.user.id });
      const clientName = db.getClient(cid)?.name || '';
      for (const p of it.parties) {
        if (p.name && p.name.toLowerCase() !== clientName.toLowerCase()) db.saveParty({ case_id: id, role: p.polo === 'A' ? 'autor' : p.polo === 'P' ? 'reu' : 'outro', name: nameCase(p.name) });
      }
      db.relinkIntimations(id);
      for (const i of db.listIntimations({ caseId: id })) db.addMove({ case_id: id, ts: i.date, text: `${i.kind}${i.doc_kind ? ` (${i.doc_kind})` : ''} — ${String(i.text).slice(0, 600)}`, source: 'djen', ext_id: `djen:${i.ext_id}` });
      updateDatajud(id).catch(() => {});
      clientChanged(cid);
      caseChanged(db.getCase(id));
      send('intimations:changed', null);
      return id;
    },
    'cases:datajud': (_c, id) => updateDatajud(id),
    'cases:inssChecked': (ctx, id) => {
      db.run('UPDATE cases SET inss_checked_at = ? WHERE id = ?', Date.now(), id);
      const k = db.getCase(id);
      db.logActivity(k.jid, 'case', `${k.title}: conferido no Meu INSS`, ctx.user.name);
      caseChanged(k);
    },
    'hints:list': (ctx, { caseId, scope } = {}) => db.listHints({ caseId, responsible: scope === 'all' || caseId ? null : ctx.user.id }),
    /** Audiência sugerida → compromisso na agenda do responsável (data conferida pela pessoa). */
    'hints:hearing': (ctx, id, { due_at, title, assignee_id } = {}) => {
      const hint = db.getHint(id);
      if (!hint) throw new Error('Sugestão não encontrada');
      const k = db.getCase(hint.case_id);
      const taskId = db.saveTask({
        jid: k?.jid || null, case_id: hint.case_id, kind: 'audiencia', due_at: Number(due_at || hint.ts),
        end_at: Number(due_at || hint.ts) + 3600e3, title: title || hint.title, assignee_id: assignee_id ?? k?.responsible_id ?? ctx.user.id,
      });
      syncTaskLater(taskId);
      db.setHint(id, 'feita', ctx.user.name);
      send('tasks:changed', null);
      caseChanged(k);
      return taskId;
    },
    'hints:clientText': (_c, id) => {
      const hint = db.getHint(id);
      if (!hint) throw new Error('Sugestão não encontrada');
      const k = db.getCase(hint.case_id);
      return { text: clientUpdateText(hint), jid: k?.client_jid || null, client_name: k?.client_name || null };
    },
    /** Envia a mensagem revisada ao cliente (WhatsApp, se ligado) e marca o retorno. */
    'hints:sendClient': async (ctx, id, text, { via = 'whatsapp' } = {}) => {
      const hint = db.getHint(id);
      if (!hint) throw new Error('Sugestão não encontrada');
      const k = db.getCase(hint.case_id);
      if (via === 'whatsapp') {
        if (!k?.client_jid) throw new Error('O cliente não tem WhatsApp ligado. Copie o texto e envie por outro meio.');
        await api['messages:sendText'](ctx, k.client_jid, String(text || '').trim());
      }
      db.touchCase(hint.case_id);
      db.setHint(id, 'feita', ctx.user.name);
      db.logActivity(k.jid, 'case', `${k.title}: cliente avisado do andamento (${hint.title})`, ctx.user.name);
      caseChanged(db.getCase(hint.case_id));
      return true;
    },
    'hints:dismiss': (ctx, id) => { const hint = db.getHint(id); db.setHint(id, 'ignorada', ctx.user.name); if (hint) caseChanged(db.getCase(hint.case_id)); },
    /** Prévia da planilha: colunas reconhecidas, processos novos/já cadastrados, problemas. */
    'cases:importPreview': (_c, token, map, { mode } = {}) => {
      const f = readImportFile(token);
      const cols = map && Object.keys(map).length ? map : detectColumns(f.header, f.rows, { mode });
      if (cols.number == null) throw new Error('Não encontrei a coluna com o nº do processo. Escolha qual é.');
      const parsed = parseImport(f.rows, cols, { mode });
      const have = new Set(db.listCases({}).map((k) => String(k.process_number || '').replace(/\D/g, '')).filter(Boolean));
      const items = parsed.items.map((it) => ({ ...it, exists: have.has(it.digits) }));
      const byTrib = {};
      for (const it of items) if (!it.exists) byTrib[it.tribunal || '?'] = (byTrib[it.tribunal || '?'] || 0) + 1;
      return {
        file: f.name, header: f.header, map: cols, total: f.rows.length,
        newCount: items.filter((x) => !x.exists).length, existing: items.filter((x) => x.exists).length,
        duplicates: parsed.duplicates, problems: parsed.problems, byTribunal: byTrib,
        sample: items.slice(0, 200),
      };
    },
    'cases:importRun': async (ctx, token, { map, responsibleId, skipClosed, mode } = {}) => {
      if (importJob.running) throw new Error('Já tem uma importação em andamento.');
      const f = readImportFile(token);
      const cols = map && Object.keys(map).length ? map : detectColumns(f.header, f.rows, { mode });
      const { items } = parseImport(f.rows, cols, { mode });
      const inss = mode === 'inss';
      const have = new Set(db.listCases({}).map((k) => String(k.process_number || '').replace(/\D/g, '')).filter(Boolean));
      const users = auth.listUsers();
      const userByName = (n) => (n ? users.find((u) => fold(u.name) && (fold(n).includes(fold(u.name)) || fold(u.name).includes(fold(n)))) : null);
      const batch = `imp-${Date.now()}`;
      const ids = [];
      for (const it of items) {
        if (have.has(it.digits)) continue;
        const closed = /arquiv|encerr|baixad|extint|finaliz/i.test(it.status);
        if (closed && skipClosed) continue;
        const id = db.createCaseWithoutClient({
          title: it.title || (inss ? `INSS${it.benefit ? ` — ${it.benefit}` : ''}` : `Processo ${it.tribunal || ''}`.trim()),
          process_number: it.number, tribunal: inss ? 'INSS (administrativo)' : it.tribunal, area: it.area || (inss ? 'Previdenciário' : null), court: it.court || null,
          kind: inss ? 'inss' : 'judicial', inss_benefit: inss ? it.benefit || null : null,
          responsible_id: userByName(it.responsible)?.id || oabOwnerOf(it.digits) || Number(responsibleId) || ctx.user.id,
          import_batch: batch, status: 'aberto',
        });
        if (it.parties.length) db.setCaseMeta(id, { parties_found: it.parties.map((p) => ({ name: p.name, polo: p.polo === 'A' ? 'ativo' : 'passivo', from: 'titulo' })) });
        if (it.opposing) db.saveCase({ id, opposing_party: it.opposing });
        if (it.client) {
          const found = db.listClients({ q: it.client, status: 'todos' }).find((c) => fold(c.name) === fold(it.client));
          db.setCaseClient(id, found ? found.id : db.saveClient({ name: it.client, origin: `Importação (${f.name})`, userName: ctx.user.name }));
        }
        db.relinkIntimations(id);
        have.add(it.digits);
        ids.push(id);
      }
      Object.assign(importJob, { created: ids.length, batch, errors: [], userId: ctx.user.id, finishedAt: null });
      send('cases:changed', null);
      // INSS não tem consulta pública: só o cadastro (a conferência é no Meu INSS)
      if (inss) { Object.assign(importJob, { running: false, phase: 'Concluído', total: ids.length, done: ids.length, finishedAt: Date.now() }); return importStatus(); }
      enrichImported(ids).catch((e) => { importJob.running = false; importJob.errors.push(e.message); });
      return importStatus();
    },
    'cases:importStatus': () => importStatus(),
    'cases:withoutClient': () => db.casesWithoutClient(),
    'cases:findParties': async (_c, id) => { const k = await findParties(id); caseChanged(k); return k; },
    /** Escolhe o cliente do processo: um cadastrado ou um novo pelo nome; as outras partes viram parte contrária. */
    'cases:assignClient': (ctx, id, { client_id, name, kind, role, opposing = [], others = [] } = {}) => {
      const k = db.getCase(id);
      if (!k) throw new Error('Processo não encontrado');
      let cid = client_id;
      if (!cid) {
        if (!String(name || '').trim()) throw new Error('Escolha o cliente.');
        const same = db.similarClients({ name }).find((c) => fold(c.name) === fold(name));
        cid = same?.id || db.saveClient({ name: nameCase(name), kind: kind === 'pj' ? 'pj' : 'pf', origin: 'Importação de processos', userName: ctx.user.name });
      }
      db.setCaseClient(id, cid, { role: role === 'passivo' ? 'reu' : role === 'ativo' ? 'autor' : null });
      const have = new Set(db.listParties(id).map((p) => fold(p.name)));
      for (const p of opposing) if (p?.name && !have.has(fold(p.name))) db.saveParty({ case_id: id, role: p.polo === 'passivo' ? 'reu' : 'autor', name: nameCase(p.name) });
      for (const p of others) if (p?.name && !have.has(fold(p.name))) db.saveParty({ case_id: id, role: 'outro', name: nameCase(p.name) });
      if (opposing.length && !k.opposing_party) db.saveCase({ id, opposing_party: opposing.map((p) => nameCase(p.name)).join(', ') });
      clientChanged(cid);
      caseChanged(db.getCase(id));
      return { caseId: id, clientId: cid };
    },
    /** Arquivamento: confirmar encerramento, manter ativo ou ajustar a data de controle da prescrição. */
    'cases:archive': (_c, id, { action, prescription_at, note } = {}) => {
      const k = db.getCase(id);
      if (!k) throw new Error('Processo não encontrado');
      if (action === 'close') db.setCaseStatus(id, 'encerrado');
      else if (action === 'dismiss') db.setCaseMeta(id, { archive_dismissed: Date.now() });
      else if (action === 'watch') db.setCaseMeta(id, { archive_state: 'provisorio', archive_since: k.archive_since || Date.now(), archive_dismissed: null, prescription_at: prescription_at ?? suggestPrescription(k.archive_since || Date.now(), k.area, settings.prescriptionYears || {}), prescription_notified: null });
      else if (action === 'clear') db.setCaseMeta(id, { archive_state: null, archive_since: null, prescription_at: null, prescription_notified: null });
      if (prescription_at !== undefined && action !== 'watch') db.setCaseMeta(id, { prescription_at: prescription_at || null, prescription_notified: null });
      if (note !== undefined) db.setCaseMeta(id, { prescription_note: note || null });
      caseChanged(db.getCase(id));
      return db.getCase(id);
    },
    'parties:save': (_c, p) => { const id = db.saveParty(p); caseChanged(db.getCase(p.case_id)); return id; },
    'parties:delete': (_c, id, caseId) => { db.deleteParty(id); caseChanged(db.getCase(caseId)); },
    'moves:add': (ctx, m) => { const id = db.addMove({ ...m, user_name: ctx.user.name }); organizeCase(m.case_id); caseChanged(db.getCase(m.case_id)); return id; },
    'moves:delete': (_c, id, caseId) => { db.deleteMove(id); caseChanged(db.getCase(caseId)); },
    'checklist:add': (_c, caseId, labels) => { const n = db.addChecklistItems(caseId, labels); caseChanged(db.getCase(caseId)); return n; },
    'checklist:delete': (_c, id) => { const i = db.checklistItem(id); db.deleteChecklistItem(id); if (i) caseChanged(db.getCase(i.case_id)); },
    /** Marca como recebido (opcional: arquivos enviados vão para a pasta do caso com o nome do documento). */
    'checklist:set': (ctx, ids, status, tokens) => {
      const first = db.checklistItem(ids?.[0]);
      if (!first) throw new Error('Item não encontrado');
      const k = db.getCase(first.case_id);
      let file = null;
      if (tokens?.length) {
        const files = uploads(tokens);
        try {
          if (k.folder && docs.root()) {
            const saved = docs.saveFiles(k.folder, files.map((f, i) => ({ path: f.path, name: `${first.label.slice(0, 80)}${files.length > 1 ? ` (${i + 1})` : ''}${path.extname(f.name)}` })), ctx.user);
            file = saved[0];
          } else {
            const dir = path.join(wa.mediaDir, '_casos', String(k.id));
            fs.mkdirSync(dir, { recursive: true });
            for (const f of files) {
              const dest = path.join(dir, `${Date.now()}-${path.basename(f.name)}`);
              fs.copyFileSync(f.path, dest);
              db.addCaseDoc({ case_id: k.id, name: `${first.label} - ${path.basename(f.name)}`, file: path.relative(wa.mediaDir, dest), size: fs.statSync(dest).size });
            }
          }
        } finally { files.forEach((f) => fs.rmSync(path.dirname(f.path), { recursive: true, force: true })); }
      }
      db.setChecklistStatus(ids, status, file);
      caseChanged(k);
    },
    'checklist:requestText': (_c, caseId, ids) => {
      const k = db.getCase(caseId);
      const items = db.listChecklist(caseId).filter((i) => ids.includes(i.id));
      return docsRequestText(settings.docsRequestTemplate, { nome: k.client_name, caso: k.title, itens: items.map((i) => i.label) });
    },
    /**
     * Pede os documentos: envia pelo WhatsApp (se o cliente tiver e a pessoa
     * escolher) com o texto revisado, marca como "solicitado" e agenda um
     * lembrete para cobrar em 3 dias úteis.
     */
    'checklist:request': async (ctx, caseId, ids, { text, send } = {}) => {
      const k = db.getCase(caseId);
      if (!k) throw new Error('Processo não encontrado');
      if (!ids?.length) throw new Error('Escolha os documentos.');
      if (send) {
        if (!k.client_jid) throw new Error('Este cliente não tem WhatsApp ligado.');
        if (!String(text || '').trim()) throw new Error('O texto do pedido está vazio.');
        await api['messages:sendText'](ctx, k.client_jid, text);
      }
      db.setChecklistStatus(ids, 'solicitado');
      if (send) db.touchCase(caseId);
      const taskId = db.saveTask({
        jid: k.jid, case_id: caseId, kind: 'tarefa', assignee_id: ctx.user.id,
        title: `Conferir documentos pedidos — ${k.client_name || k.title}`, due_at: addBusinessDays(Date.now(), 3),
      });
      syncTaskLater(taskId);
      db.logActivity(k.jid, 'case', `${k.title}: ${ids.length} documento(s) solicitado(s)${send ? ' pelo WhatsApp' : ''}`, ctx.user.name);
      caseChanged(k);
      send_('tasks:changed', null);
      return { taskId };
    },
    'cases:get': (ctx, id) => forMoney(ctx, db.getCase(id)),
    'cases:save': (ctx, c) => {
      if (!auth.can(ctx.user.role, 'finance:list')) c = auth.stripMoney(c);
      // processo novo sem responsável escolhido fica com quem criou (como as tarefas)
      if (!c.id && c.responsible_id === undefined) c = { ...c, responsible_id: ctx.user.id };
      const before = c.id ? db.getCase(c.id) : null;
      if (c.kind === 'inss' && !before?.inss_status && c.inss_status === undefined) c = { ...c, inss_status: 'analise', inss_check_days: c.inss_check_days ?? 15, tribunal: c.tribunal ?? 'INSS (administrativo)' };
      const id = db.saveCase(c);
      if (c.inss_status !== undefined && c.inss_status !== before?.inss_status) inssStatusChanged(id, c.inss_status, ctx);
      if (c.process_number !== undefined) db.relinkIntimations(id);
      const k = db.getCase(id);
      wa.markChanged(k.jid);
      send('cases:changed', k.jid);
      return id;
    },
    'cases:setStage': (_c, id, stageId) => { db.setCaseStage(id, stageId); const k = db.getCase(id); wa.markChanged(k.jid); send('cases:changed', k.jid); },
    'cases:setStatus': (_c, id, status) => { db.setCaseStatus(id, status); const k = db.getCase(id); wa.markChanged(k.jid); send('cases:changed', k.jid); },
    'cases:touch': (_c, id) => { db.touchCase(id); send('cases:changed', db.getCase(id)?.jid); },
    'cases:delete': (_c, id) => { const jid = db.deleteCase(id); if (jid) { wa.markChanged(jid); send('cases:changed', jid); } },
    'cases:docs': (_c, id) => db.listCaseDocs(id).map((d) => ({ ...d, url: mediaUrl(d.file) })),
    'cases:attachMessage': async (_c, caseId, chatJid, msgId) => {
      const m = db.getMessage(chatJid, msgId);
      if (!m) throw new Error('Mensagem não encontrada');
      const rel = m.media_file && fs.existsSync(resolveMedia(m.media_file)) ? m.media_file : await wa.downloadMedia(chatJid, msgId);
      const name = m.media_name || `${{ image: 'foto', video: 'video', audio: 'audio', ptt: 'audio', sticker: 'figurinha' }[m.type] || 'arquivo'}-${new Date(m.ts).toISOString().slice(0, 10)}${path.extname(rel)}`;
      const id = db.addCaseDoc({ case_id: caseId, name, file: rel, mime: m.media_mime, size: m.media_size, msg_id: msgId });
      copyToCaseFolder(caseId, [{ path: resolveMedia(rel), name }]);
      send('cases:changed', db.getCase(caseId)?.jid);
      return id;
    },
    'cases:addFiles': (_c, caseId, tokens) => {
      const files = uploads(tokens);
      const dir = path.join(wa.mediaDir, '_casos', String(caseId));
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) {
        let name = path.basename(f.name);
        let dest = path.join(dir, name);
        for (let i = 2; fs.existsSync(dest); i++) { name = `${path.parse(f.name).name} (${i})${path.extname(f.name)}`; dest = path.join(dir, name); }
        fs.copyFileSync(f.path, dest);
        fs.rmSync(path.dirname(f.path), { recursive: true, force: true });
        db.addCaseDoc({ case_id: caseId, name, file: path.relative(wa.mediaDir, dest), size: fs.statSync(dest).size });
        copyToCaseFolder(caseId, [{ path: dest, name }]);
      }
      send('cases:changed', db.getCase(caseId)?.jid);
      return files.length;
    },
    // documentos (pasta do escritório no OneDrive)
    'docs:status': () => ({ ...docs.status(), placeholders: PLACEHOLDERS, structure: FOLDERS }),
    'docs:list': (ctx, rel) => {
      const r = docs.list(rel || '', ctx.user);
      for (const e of r.entries) if (!e.dir) e.url = docUrl(e.rel);
      return r;
    },
    'docs:search': async (ctx, q, opts = {}) => {
      if (!docs.root()) return [];
      // índice vazio: espera a 1ª leitura; senão atualiza em segundo plano a cada 10 min
      if (!docs.lastIndex) await docs.reindex();
      else if (Date.now() - docs.lastIndex > 600e3) docs.reindex().catch(() => {});
      return docs.search(q, ctx.user, opts).map((d) => ({ ...d, url: docUrl(d.rel) }));
    },
    'docs:reindex': async () => ({ changed: await docs.reindex(), ...docs.status() }),
    'docs:templates': () => docs.templates().map((t) => ({ ...t, url: docUrl(t.rel) })),
    'docs:clientFolder': (_c, clientId) => {
      const cl = db.getClient(clientId);
      if (!cl) throw new Error('Cliente não encontrado');
      const folder = cl.folder && docs.root() && fs.existsSync(docs.abs(cl.folder)) ? cl.folder : null;
      return { folder, linked: cl.folder || null, suggestion: folder ? null : docs.suggestClientFolder(cl.name) };
    },
    'docs:linkClient': (_c, clientId, rel) => {
      if (rel) docs.abs(rel); // confere que fica dentro da pasta do escritório
      db.saveClient({ id: clientId, folder: rel || null });
      clientChanged(clientId);
      return rel || null;
    },
    'docs:createClientFolder': (_c, clientId) => {
      const cl = db.getClient(clientId);
      if (!cl) throw new Error('Cliente não encontrado');
      const rel = docs.createClientFolder(cl.name);
      db.saveClient({ id: clientId, folder: rel });
      clientChanged(clientId);
      return rel;
    },
    'docs:caseFolder': (_c, caseId) => {
      const k = db.getCase(caseId);
      if (!k) throw new Error('Caso não encontrado');
      const cl = db.getClient(k.client_id);
      const ok = (rel) => rel && docs.root() && fs.existsSync(docs.abs(rel));
      const client = ok(cl?.folder) ? cl.folder : null;
      const suggestion = client ? null : docs.suggestClientFolder(cl?.name || k.client_name || '');
      // pastas que já existem dentro da pasta do cliente (para ligar uma antiga)
      const where = client || suggestion?.rel;
      const options = where ? docs.list(where, null).entries.filter((e) => e.dir && e.name !== '_CADASTRO').map((e) => e.rel) : [];
      return {
        folder: ok(k.folder) ? k.folder : null,
        linked: k.folder || null,
        clientFolder: client,
        clientSuggestion: suggestion,
        newName: DocsService.caseFolderName(k),
        options,
      };
    },
    'docs:createCaseFolder': (_c, caseId, { clientFolder } = {}) => {
      const k = db.getCase(caseId);
      if (!k) throw new Error('Caso não encontrado');
      const cl = db.getClient(k.client_id);
      let client = clientFolder || cl?.folder;
      if (client) docs.mkdir(client);
      else client = docs.createClientFolder(cl?.name || k.client_name || k.title);
      if (cl && client !== cl.folder) { db.saveClient({ id: cl.id, folder: client }); clientChanged(cl.id); }
      const rel = docs.mkdir(`${client}/${DocsService.caseFolderName(k)}`);
      db.saveCase({ id: caseId, folder: rel });
      send('cases:changed', k.jid);
      return rel;
    },
    'docs:linkCase': (_c, caseId, rel) => {
      if (rel) docs.abs(rel);
      db.saveCase({ id: caseId, folder: rel || null });
      // ligou a pasta do caso: a pasta do cliente é a de cima (se ainda não tinha)
      const k = db.getCase(caseId);
      const cl = k && db.getClient(k.client_id);
      if (rel && cl && !cl.folder && rel.split('/').length >= 3) { db.saveClient({ id: cl.id, folder: rel.split('/').slice(0, 2).join('/') }); clientChanged(cl.id); }
      send('cases:changed', db.getCase(caseId)?.jid);
      return rel || null;
    },
    /**
     * Ao encerrar: o que mover para o 03 ARQUIVO MORTO. Sem outro processo
     * aberto do cliente, a pasta inteira do cliente; senão só a do processo.
     * Ao reabrir (`back`): o caminho de volta para o 02 CLIENTES.
     */
    'docs:archivePlan': (_c, caseId, { back = false } = {}) => {
      const k = db.getCase(caseId);
      if (!k) throw new Error('Processo não encontrado');
      const cl = k.client_id ? db.getClient(k.client_id) : null;
      const exists = (rel) => rel && docs.root() && fs.existsSync(docs.abs(rel));
      const hasFolder = !!(k.folder || cl?.folder);
      if (!docs.root()) return { can: false, hasFolder, reason: 'A pasta do OneDrive não está ligada a este servidor.' };
      const [CLI, ARQ] = [FOLDERS.clientes, FOLDERS.arquivo];
      if (!back) {
        const others = cl ? db.listCases({ clientId: cl.id, status: 'aberto' }).filter((x) => x.id !== k.id).length : 0;
        if (!others && exists(cl?.folder) && cl.folder.startsWith(`${CLI}/`)) {
          return { can: true, mode: 'client', from: cl.folder, to: `${ARQ}/${cl.folder.slice(CLI.length + 1)}` };
        }
        if (exists(k.folder) && k.folder.startsWith(`${CLI}/`)) {
          return { can: true, mode: 'case', from: k.folder, to: `${ARQ}/${k.folder.slice(CLI.length + 1)}`, others };
        }
        return { can: false, hasFolder, reason: hasFolder ? 'A pasta não está em 02 CLIENTES.' : 'Este processo não tem pasta no OneDrive.' };
      }
      if (exists(cl?.folder) && cl.folder.startsWith(`${ARQ}/`)) return { can: true, mode: 'client', from: cl.folder, to: `${CLI}/${cl.folder.slice(ARQ.length + 1)}` };
      if (exists(k.folder) && k.folder.startsWith(`${ARQ}/`)) return { can: true, mode: 'case', from: k.folder, to: `${CLI}/${k.folder.slice(ARQ.length + 1)}` };
      return { can: false, hasFolder };
    },
    'docs:archiveFolder': (ctx, caseId, { back = false } = {}) => {
      const plan = api['docs:archivePlan'](ctx, caseId, { back });
      if (!plan.can) throw new Error(plan.reason || 'Nada para mover.');
      const to = docs.move(plan.from, plan.to);
      db.renameFolderPrefix(plan.from, to);
      const k = db.getCase(caseId);
      db.logActivity(k.jid, 'case', `Pasta movida para ${to.split('/')[0]}: ${to.split('/').slice(1).join('/')}`, ctx.user.name);
      if (k.client_id) clientChanged(k.client_id);
      caseChanged(db.getCase(caseId));
      return to;
    },
    'docs:mkdir': (ctx, rel) => { docs.check(rel, ctx.user); return docs.mkdir(rel); },
    'docs:upload': (ctx, dirRel, tokens) => {
      const files = uploads(tokens);
      const saved = docs.saveFiles(dirRel, files, ctx.user);
      for (const f of files) fs.rmSync(path.dirname(f.path), { recursive: true, force: true });
      return saved;
    },
    'docs:values': (_c, { clientId, caseId } = {}) => {
      const k = caseId ? db.getCase(caseId) : null;
      return templateValues(db.getClient(clientId || k?.client_id), k);
    },
    'docs:useAsBase': (ctx, srcRel, { caseId, clientId, dirRel, name } = {}) => {
      const k = caseId ? db.getCase(caseId) : null;
      const cl = db.getClient(clientId || k?.client_id);
      const dest = dirRel || k?.folder || cl?.folder;
      if (!dest) throw new Error('Este caso ainda não tem pasta. Crie ou ligue a pasta do caso primeiro.');
      const rel = docs.copyAsBase(srcRel, dest, templateValues(cl, k), ctx.user, name);
      if (k) db.logActivity(k.jid, 'doc', `Documento criado: ${rel.split('/').pop()}`, ctx.user.name);
      return { rel, url: docUrl(rel), path: docs.abs(rel) };
    },
    'docs:path': (ctx, rel) => ({ path: docs.check(rel || '', ctx.user), url: docUrl(rel || '') }),
    'cases:deleteDoc': (_c, id) => { const d = db.deleteCaseDoc(id); if (d) send('cases:changed', db.getCase(d.case_id)?.jid); },

    // honorários / financeiro
    // financeiro completo: recebimento, recibo, contas a pagar, fluxo de caixa
    'finance:register': (ctx, id, r = {}) => {
      db.registerPayment(id, { ...r, user_name: ctx.user.name });
      const p = db.getPayment(id);
      if (p) { wa.markChanged(p.jid); send('cases:changed', p.jid); }
      send('finance:changed');
    },
    'finance:receipt': (_c, id) => receiptHtml(id),
    /**
     * Recibo em PDF (`income` = receita avulsa). Sem certificado: devolve
     * o PDF pronto {token, name, pdf (base64), canSend}. Com `a3` ({name, issuer} do
     * certificado escolhido no app de desktop): devolve {pending, data (base64)} para
     * o app assinar; depois `finance:receiptSign(pending, cms)` devolve o PDF.
     */
    'finance:receiptPdf': async (_c, id, { income = false, a3 = null } = {}) => {
      const a = receiptArgs(id, income);
      const mode = signMode();
      if (a3 && mode === 'a3') {
        const pdf = await receiptPdf(pdfArgs(a, { name: String(a3.name || '').split(':')[0], issuer: a3.issuer }));
        const ext = await externalSign(pdf, { reason: `Recibo nº ${a.no}`, location: settings.officeCity || '', name: a3.name || '' });
        const pending = keep(pendingA3, { ...ext, a }, 5 * 60e3);
        return { pending, data: ext.data.toString('base64') };
      }
      return readyResult(await receiptPdf(pdfArgs(a, null)), a, false);
    },
    'finance:receiptSign': async (_c, pending, cmsBase64) => {
      const p = pendingA3.get(pending);
      if (!p) throw new Error('A assinatura demorou demais. Gere o recibo de novo.');
      pendingA3.delete(pending);
      const buf = await p.finish(Buffer.from(String(cmsBase64 || ''), 'base64'));
      return readyResult(buf, p.a, true);
    },
    'finance:receiptCancel': (_c, pending) => { pendingA3.get(pending)?.cancel(); pendingA3.delete(pending); },
    /** Envia ao cliente, pelo WhatsApp, o PDF gerado agora há pouco. */
    'finance:sendReceipt': async (ctx, token, text) => {
      const r = readyPdfs.get(token);
      if (!r) throw new Error('O recibo expirou. Gere de novo.');
      if (!r.jid) throw new Error('Este cliente não tem WhatsApp ligado.');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recibo-'));
      const file = path.join(dir, r.name);
      try {
        fs.writeFileSync(file, r.buf);
        await wa.sendFile(r.jid, file, { caption: String(text || '').trim() ? sign(ctx, String(text).trim()) : undefined, asDocument: true });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      db.logActivity(r.jid, 'finance', `Recibo nº ${String(r.no).padStart(4, '0')} enviado pelo WhatsApp`, ctx.user.name);
    },
    /** O que está configurado para assinar os recibos. */
    // avisos no celular: chave pública, inscrição deste aparelho, aparelhos da pessoa, teste
    /** Acompanhamento depois da audiência feito (prazos agendados, intimações conferidas) ou desfeito. */
    'hearings:followUp': (_c, taskId, done = true) => { db.setHearingFollowUp(taskId, done); send('tasks:changed', null); },
    'push:info': (ctx) => ({ key: push.publicKey, kinds: PUSH_KINDS, prefs: { ...PUSH_DEFAULTS, ...(auth.userPrefs(ctx.user.id).pushKinds || {}) }, devices: push.list(ctx.user.id) }),
    'push:subscribe': (ctx, sub, agent) => { push.subscribe(ctx.user.id, sub, agent); return push.list(ctx.user.id); },
    'push:unsubscribe': (ctx, endpointOrId) => { push.unsubscribe(ctx.user.id, endpointOrId); return push.list(ctx.user.id); },
    'push:test': async (ctx) => {
      const n = await push.sendTo(ctx.user.id, { title: 'Barros Associados — teste', body: 'Os avisos estão chegando neste aparelho.', tag: 'test', action: { view: 'today' } });
      if (!n) throw new Error('Nenhum aparelho com avisos ativados.');
      return n;
    },
    ...(demo ? { 'push:outbox': () => pushOutbox } : {}),
    'receipts:status': () => {
      const img = signatureImage();
      return {
        mode: signMode(), signer: settings.receiptSigner || '',
        image: img ? `data:image/${img.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(img).toString('base64')}` : null,
      };
    },
    'receipts:setImage': (_c, token) => {
      const [f] = uploads([token]);
      try {
        const ext = path.extname(f.name).toLowerCase();
        if (!['.png', '.jpg', '.jpeg'].includes(ext)) throw new Error('Use uma imagem PNG ou JPG da assinatura (de preferência com fundo transparente).');
        if (fs.statSync(f.path).size > 3e6) throw new Error('Imagem grande demais (até 3 MB).');
        fs.mkdirSync(SIGN_DIR, { recursive: true });
        for (const old of ['assinatura.png', 'assinatura.jpg']) fs.rmSync(path.join(SIGN_DIR, old), { force: true });
        fs.copyFileSync(f.path, path.join(SIGN_DIR, ext === '.png' ? 'assinatura.png' : 'assinatura.jpg'));
      } finally { fs.rmSync(path.dirname(f.path), { recursive: true, force: true }); }
      return api['receipts:status']();
    },
    'receipts:clearImage': () => { fs.rmSync(SIGN_DIR, { recursive: true, force: true }); return api['receipts:status'](); },
    // receitas avulsas (sem processo)
    'finance:incomes': (_c, opts) => db.listIncomes(opts || {}),
    'finance:saveIncome': (ctx, i) => { const id = db.saveIncome({ ...i, created_by: ctx.user.name }); if (i.client_id) clientChanged(i.client_id); send('finance:changed'); return id; },
    'finance:deleteIncome': (_c, id) => { db.deleteIncome(id); send('finance:changed'); },
    'finance:incomeReceipt': (_c, id) => incomeReceiptHtml(id),
    'finance:expenses': (_c, opts) => db.listExpenses(opts || {}),
    'finance:saveExpense': (ctx, e) => {
      const ids = db.saveExpense({ ...e, created_by: ctx.user.name });
      if (e.case_id) caseChanged(db.getCase(e.case_id));
      send('finance:changed');
      return ids;
    },
    'finance:expensePaid': (_c, id, paid, method) => { db.setExpensePaid(id, paid, method); const e = db.getExpense(id); if (e?.case_id) caseChanged(db.getCase(e.case_id)); send('finance:changed'); },
    'finance:reimbursed': (_c, id, yes) => { db.setExpenseReimbursed(id, yes); const e = db.getExpense(id); if (e?.case_id) caseChanged(db.getCase(e.case_id)); send('finance:changed'); },
    'finance:deleteExpense': (_c, id, opts) => { const e = db.getExpense(id); db.deleteExpense(id, opts || {}); if (e?.case_id) caseChanged(db.getCase(e.case_id)); send('finance:changed'); },
    'finance:cashflow': (_c, { from, to } = {}) => {
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('período inválido');
      return db.cashflow(from, to);
    },
    'finance:months': (_c, n) => db.cashflowMonths(Math.min(24, Math.max(1, Number(n) || 12))),
    'finance:defaulters': () => db.defaulters(),
    /** Tudo o que o painel do financeiro mostra, numa chamada (datas no fuso de quem vê). */
    'finance:dashboard': (_c, { monthFrom, monthTo, yearFrom } = {}) => {
      if (![monthFrom, monthTo, yearFrom].every(Number.isFinite)) throw new Error('período inválido');
      const prevFrom = new Date(monthFrom); prevFrom.setMonth(prevFrom.getMonth() - 1);
      const prev = db.cashflow(prevFrom.getTime(), monthFrom);
      const cur = db.cashflow(monthFrom, monthTo);
      return {
        summary: db.financeSummary(),
        month: { in: cur.totalIn, out: cur.totalOut, toReceive: cur.toReceive, toPay: cur.toPay },
        prevMonth: { in: prev.totalIn, out: prev.totalOut },
        months: db.cashflowMonths(12, monthFrom),
        defaulters: db.defaulters().slice(0, 6),
        ...db.financeBreakdown(monthFrom, monthTo, yearFrom),
      };
    },
    'finance:summary': () => db.financeSummary(),
    'finance:list': (_c, opts) => db.listPayments(opts || {}),
    'finance:save': (_c, p) => { const id = db.savePayment(p); const k = db.getCase(p.case_id || db.getPayment(id)?.case_id); if (k) { wa.markChanged(k.jid); send('cases:changed', k.jid); } send('finance:changed'); return id; },
    'finance:generate': (_c, caseId, opts) => { const ids = db.generateInstallments(caseId, opts); const k = db.getCase(caseId); wa.markChanged(k.jid); send('cases:changed', k.jid); send('finance:changed'); return ids; },
    'finance:setPaid': (_c, id, paid) => { db.setPaymentPaid(id, paid); const p = db.getPayment(id); if (p) { wa.markChanged(p.jid); send('cases:changed', p.jid); } send('finance:changed'); },
    'finance:delete': (_c, id) => { const p = db.getPayment(id); db.deletePayment(id); if (p) { wa.markChanged(p.jid); send('cases:changed', p.jid); } send('finance:changed'); },
    'finance:chargeText': (_c, id) => chargeText(id),
    'finance:sendCharge': async (ctx, id, text) => {
      const p = db.getPayment(id);
      if (!p) throw new Error('Parcela não encontrada');
      await wa.sendText(p.jid, sign(ctx, text || chargeText(id)));
      db.markPaymentCharged(id);
      db.logActivity(p.jid, 'charge', `Cobrança enviada: ${p.description || 'honorários'} (${money(p.amount)})`, who(ctx));
      send('finance:changed');
    },
    'finance:defaultTemplate': () => DEFAULT_CHARGE_TEMPLATE,

    // tarefas
    'tasks:list': (_c, opts) => db.listTasks(opts || {}),
    'tasks:save': async (ctx, task) => {
      // tarefa nova sem responsável escolhido fica com quem criou (nada fica sem dono)
      if (!task.id && task.assignee_id === undefined) task = { ...task, assignee_id: ctx.user.id };
      const id = db.saveTask(task);
      if (task.calendar_id) {
        // escolheu outra agenda do Google: move o evento para lá
        const cur = db.getTask(id);
        if (cur.gcal_event_id && cur.gcal_calendar_id !== task.calendar_id) {
          await calSync.removeTask(cur).catch(() => {});
          db.setTaskGcal(id, null, null);
        }
        db.run('UPDATE tasks SET gcal_calendar_id = ? WHERE id = ? AND gcal_event_id IS NULL', task.calendar_id, id);
      }
      syncTaskLater(id);
      const cid = task.case_id ?? db.get('SELECT case_id FROM tasks WHERE id = ?', id)?.case_id;
      if (cid) send('cases:changed', db.getCase(cid)?.jid);
      const jid = task.jid || db.get('SELECT jid FROM tasks WHERE id = ?', id)?.jid;
      if (jid) wa.markChanged(jid);
      send('tasks:changed', null);
      return id;
    },
    'tasks:delete': (_c, id) => {
      const t = db.getTask(id);
      calSync.removeTask(t).catch((e) => console.error('google: apagar evento', e.message));
      db.deleteTask(id);
      if (t?.jid) wa.markChanged(t.jid);
      send('tasks:changed', null);
    },

    /** Muda a data de várias tarefas de uma vez (ex.: passar as pendentes para amanhã). */
    'tasks:reschedule': (_c, list) => {
      for (const { id, due_at } of list || []) {
        if (!id || !due_at) continue;
        db.saveTask({ id, due_at });
        syncTaskLater(id);
        const jid = db.getTask(id)?.jid;
        if (jid) wa.markChanged(jid);
      }
      send('tasks:changed', null);
    },

    // painel "Hoje": o que cada pessoa precisa ver ao abrir o sistema.
    // As faixas de data vêm da janela (fuso de quem está usando, não do servidor).
    'today:summary': (ctx, { dayStart, dayEnd, weekStart, weekEnd, scope } = {}) => {
      if (![dayStart, dayEnd, weekStart, weekEnd].every(Number.isFinite)) throw new Error('período inválido');
      const assignee = scope === 'all' ? null : ctx.user.id;
      const tasks = db.tasksForDay({ dayStart, dayEnd, weekStart, weekEnd, assignee });
      const staleDays = Number(settings.staleCaseDays ?? 15);
      // documentos pedidos ao cliente há mais de 3 dias e ainda não recebidos
      const docRequests = db.pendingDocRequests(3 * DAY).filter((r) => scope === 'all' || !r.responsible_id || r.responsible_id === ctx.user.id);
      const out = {
        ...tasks,
        staleCases: staleDays > 0 ? db.casesWithoutUpdate(staleDays * DAY) : [],
        staleDays,
        payments: null,
        docRequests,
        // interessados do comercial em negociação sem nenhum próximo passo marcado
        leadsIdle: leads.listLeads({ open: true, responsible: scope === 'all' ? null : ctx.user.id }).filter((l) => !l.next_task)
          .map((l) => ({ id: l.id, name: l.name, subject: l.subject || l.area, stage_label: l.stage_label, jid: l.jid, since: l.last_contact_at || l.created_at })),
        hearings: db.hearingsToFollowUp({ assignee }),
        hints: db.listHints({ responsible: assignee }),
        idleCases: Number(settings.idleCaseDays ?? 90) > 0 ? db.idleCases(Number(settings.idleCaseDays ?? 90) * DAY, { responsible: assignee }).slice(0, 30) : [],
        idleDays: Number(settings.idleCaseDays ?? 90),
        inss: db.inssToCheck({ responsible: assignee }).slice(0, 20).map((k) => ({ id: k.id, title: k.title, client_name: k.client_name, client_id: k.client_id, process_number: k.process_number, inss_benefit: k.inss_benefit, inss_status: k.inss_status, since: k.inss_checked_at || k.created_at })),
        prescriptions: db.all("SELECT id FROM cases WHERE status = 'aberto' AND archive_state = 'provisorio' AND prescription_at IS NOT NULL AND prescription_at < ?", Date.now() + 90 * DAY)
          .map((r) => db.getCase(r.id)).filter((k) => !assignee || !k.responsible_id || k.responsible_id === assignee)
          .sort((a, b) => a.prescription_at - b.prescription_at).slice(0, 30)
          .map((k) => ({ id: k.id, title: k.title, process_number: k.process_number, client_name: k.client_name, prescription_at: k.prescription_at, archive_since: k.archive_since })),
        intimations: db.listIntimations({ status: 'nova', limit: 50 }).filter((i) => scope === 'all' || !i.responsible_id || i.responsible_id === ctx.user.id),
      };
      if (auth.can(ctx.user.role, 'finance:list')) {
        const soon = dayStart + 8 * DAY;
        const open = db.listPayments({ status: 'open' });
        out.payments = {
          overdue: open.filter((p) => p.due_at && p.due_at < dayStart),
          dueSoon: open.filter((p) => p.due_at && p.due_at >= dayStart && p.due_at < soon),
          weekTotal: open.filter((p) => p.due_at && p.due_at >= weekStart && p.due_at < weekEnd).reduce((a, p) => a + p.amount, 0),
        };
      }
      return out;
    },

    // configurações do CRM
    'pipelines:list': () => db.listPipelines(),
    'pipelines:save': (_c, p) => { const id = db.savePipeline(p); broadcastConfig(); return id; },
    'pipelines:delete': (_c, id) => { db.deletePipeline(id); broadcastConfig(); refreshAllChats(); },
    'pipelines:reorder': (_c, ids) => { db.reorderPipelines(ids); broadcastConfig(); },
    'tags:save': (_c, t) => { const id = db.saveTag(t); broadcastConfig(); return id; },
    'tags:delete': (_c, id) => { db.deleteTag(id); broadcastConfig(); refreshAllChats(); },
    'quick:save': (_c, q) => { const id = db.saveQuickReply(q); broadcastConfig(); return id; },
    'quick:delete': (_c, id) => { db.deleteQuickReply(id); broadcastConfig(); },
    /** Relatórios por período (sócio e advogado; o financeiro só para quem vê dinheiro). */
    'reports:get': (ctx, section, { from, to } = {}) => {
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 3 * 366 * DAY) throw new Error('Período inválido.');
      const range = { from, to };
      switch (section) {
        case 'overview': return reports.overview(range);
        case 'team': return reports.team(range);
        case 'commercial': return forMoney(ctx, reports.commercial(range));
        case 'whatsapp': return reports.whatsapp(range);
        case 'finance':
          if (!auth.can(ctx.user.role, 'finance:list')) throw new Error('Sem permissão para o financeiro.');
          return reports.finance(range);
        default: throw new Error('Relatório desconhecido');
      }
    },
    // palavras mais usadas nas mensagens enviadas (sugestão ao digitar)
    'words:vocab': () => db.vocabulary(),

    'settings:set': (ctx, key, value) => {
      if (USER_KEYS.includes(key)) {
        auth.setUserPref(ctx.user.id, key, value);
      } else if (OFFICE_KEYS.includes(key)) {
        if (ctx.user.role !== 'socio') throw new Error('Só um sócio pode mudar as configurações do escritório.');
        if (key === 'docsRoot') {
          value = String(value || '').trim().replace(/^"|"$/g, '') || null;
          if (value && !(fs.existsSync(value) && fs.statSync(value).isDirectory())) {
            throw new Error('Pasta não encontrada neste computador. Copie o endereço da pasta "BARROS ADVOGADOS" no Explorador de Arquivos.');
          }
          // outra pasta: refaz o índice da busca do zero
          db.run('DELETE FROM doc_index');
          docs.lastIndex = 0;
        }
        settings[key] = value;
        db.setSetting(key, value);
        applySettings();
        send('settings:office', null);
      } else {
        throw new Error('configuração desconhecida');
      }
      return settingsFor(ctx.user);
    },
    'settings:get': (ctx) => settingsFor(ctx.user),

    // agenda / Google
    'google:status': () => google.status(),
    'google:importClient': (_c, token) => {
      const [f] = uploads([token]);
      try { google.importClient(f.path); } finally { fs.rmSync(path.dirname(f.path), { recursive: true, force: true }); }
      return google.status();
    },
    'google:connect': async (ctx) => {
      googleRequester = ctx.conn;
      const st = await google.connect();
      calSync.syncAll().then((n) => {
        if (n) notify({ kind: 'google', title: 'Google Agenda conectado', body: `${n} compromisso(s) do CRM enviados para a sua agenda.` }, { conn: ctx.conn });
      }).catch(() => {});
      return st;
    },
    'google:disconnect': () => google.disconnect(),
    'google:calendars': (_c, force) => google.calendars(force),
    'google:syncAll': () => calSync.syncAll(),
    'agenda:events': async (_c, from, to, calendarIds) => {
      // o que foi criado com o Google desconectado vai agora
      if (calSync.enabled() && db.tasksToSync().length) await calSync.syncAll().catch(() => {});
      return calSync.agenda(from, to, calendarIds);
    },
    'agenda:saveEvent': (_c, calendarId, ev, eventId) => google.saveEvent(calendarId, ev, eventId),
    'agenda:deleteEvent': (_c, calendarId, eventId) => google.deleteEvent(calendarId, eventId),

    'app:testNotification': (ctx) => {
      notify({ kind: 'test', title: 'Barros Associados — teste', body: 'Se você está vendo isto, as notificações estão funcionando. 👍', force: true }, { conn: ctx.conn });
    },
  };

  if (demo) {
    api['demo:incoming'] = (_c, phone, text, name) => wa.simulateIncoming(phone, text, name);
    api['demo:simulateStuck'] = () => wa.setStatus({ state: 'reconnecting', registered: true, error: 'conexão fechada, código 428', suggestRepair: true });
  }

  /** Chama um método da API em nome de alguém (confere a permissão do perfil). */
  async function call(method, args, ctx) {
    const fn = api[method];
    if (!fn) throw new Error(`Método desconhecido: ${method}`);
    if (!auth.can(ctx.user.role, method)) throw new Error('Seu perfil não tem permissão para isso.');
    if (ctx.conn && viewers.has(ctx.conn)) viewers.get(ctx.conn).seen = Date.now();
    return fn(ctx, ...(args || []));
  }

  /** Uma janela fechou: some da lista de quem está vendo conversas. */
  function dropConn(conn) {
    if (viewers.delete(conn)) broadcastViewers();
  }

  /** Cópia do banco para o backup (o chamador apaga o arquivo depois). */
  function backupFile(file = path.join(os.tmpdir(), `backup-barros-${Date.now()}.sqlite`)) {
    db.run('VACUUM INTO ?', file);
    return file;
  }

  applySettings();
  wa.logger.warn({ versaoApp: version, dados: dataDir, node: process.versions.node }, 'sistema iniciado');
  wa.start().catch((e) => {
    console.error(e);
    send('wa:status', { state: 'reconnecting', error: e.message });
    wa.scheduleReconnect(10000);
  });

  return {
    events, api, call, dropConn, backupFile, resolveMedia, wa, google, docs, dataDir, demo, lookup, courts,
    /** Roda agora a busca dos tribunais (DJEN + DataJud), como o relógio faria. */
    runCourts: () => Promise.all([checkIntimations(), datajudDaily()]),
    /** Roda agora os avisos periódicos (lembretes, audiências, financeiro…), como o relógio faria. */
    runChecks: () => check(),
    /** O computador voltou da suspensão (modo local): a conexão antiga morreu. */
    onResume() {
      if (!wa.hasSession()) return;
      setTimeout(() => wa.reconnectNow().catch((e) => console.error(e)), 1500);
    },
    logFile: path.join(dataDir, 'logs', 'whatsapp.log'),
    async stop() {
      importJob.stopped = true;
      timers.forEach((t) => clearInterval(t));
      await wa.stop();
      // nada mais pode tocar no banco depois de fechado (avisos atrasados do WhatsApp)
      clearTimeout(wa.flushTimer);
      wa.removeAllListeners();
      google.removeAllListeners?.();
      db.closeDb();
    },
  };
}
