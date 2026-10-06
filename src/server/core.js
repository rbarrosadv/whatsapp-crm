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
import * as db from '../main/db.js';
import * as auth from './auth.js';
import { WhatsAppService } from '../main/whatsapp.js';
import { DemoWhatsAppService, DemoGoogleService } from '../main/demo.js';
import { GoogleService } from '../main/google.js';
import { CalendarSync } from '../main/calendar-sync.js';
import { webmToOgg } from '../main/ogg.js';
import { importLegacy, legacyStateFile } from '../main/legacy.js';
import { diagnoseConnection } from '../main/diag.js';
import { DocsService, guessRoot, templateValues, PLACEHOLDERS, FOLDERS } from '../main/docs.js';
import { seedDemoDocs, demoCourtsFetch } from '../main/demo.js';
import { reais } from '../main/extenso.js';
import { CourtsService, DATAJUD_PUBLIC_KEY, deadlineFromAvailability, formatCnj, tribunalOf, nameCase } from '../main/courts.js';
import { computeSteps, suggestedChecklist, docsRequestText, addBusinessDays, STEPS, PARTY_ROLES, DEFAULT_DOCS_TEMPLATE } from '../main/workflow.js';

const DAY = 24 * 3600 * 1000;
const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateBR = (ts) => (ts ? new Date(ts).toLocaleDateString('pt-BR') : 'sem data');

// Preferências de cada pessoa (ficam no usuário) × configurações do escritório (valem para todos).
export const USER_KEYS = ['notifications', 'notificationPreview', 'theme', 'lastView', 'lastPipeline', 'enterToSend',
  'lastFilter', 'agendaHidden', 'agendaView', 'agendaHours', 'discreet', 'discreetMessages', 'spellcheck', 'wordSuggest', 'autocorrect', 'notifyCourts'];
export const OFFICE_KEYS = ['sendReadReceipts', 'forgottenHours', 'chargeTemplate', 'pixKey', 'paymentNoticeDays',
  'staleCaseDays', 'googleSync', 'googleCalendarId', 'signMessages', 'docsRoot', 'docsRequestTemplate', 'datajudKey',
  'officeName', 'officeDoc', 'officeAddress', 'officeCity'];

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
export async function createCore({ dataDir, demo = false, version = '', safeStorage, resolveUpload, features = {} }) {
  const events = new EventEmitter();
  const LEGACY_STATE_FILE = legacyStateFile(process.env.APPDATA || path.join(os.homedir(), '.config'));

  db.openDb(dataDir);
  let settings = db.getSettings();

  /** Evento para as janelas abertas. `to`: {conn} | {user} | undefined (todas). */
  const send = (channel, payload, to) => events.emit('event', channel, payload, to);

  /** Aviso (notificação). Cada janela decide se mostra, conforme as preferências da pessoa. */
  const notify = (n, to) => send('notify', n, to);

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
    if (!viewers.has(ctx.conn)) viewers.set(ctx.conn, { userId: ctx.user.id, name: ctx.user.name, jid: null, focused: true });
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
      discreet: '💬 Nova mensagem', action: { chat: chatJid },
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
      kind: 'forgotten', title: `⏳ ${list.length} conversa(s) aguardando resposta há mais de ${hours} h`,
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
        kind: 'finance', audience: 'finance', title: `💰 ${upcoming.length} parcela(s) de honorários vencendo em até ${days} dia(s)`,
        body: `Total ${money(total)}`, discreet: '💰 Honorários vencendo', action: { view: 'finance' },
      });
    }
    if (overdue.length) {
      db.markPaymentsNotified(overdue.map((p) => p.id), 'overdue');
      const total = overdue.reduce((a, p) => a + p.amount, 0);
      notify({
        kind: 'finance', audience: 'finance', title: `⚠ ${overdue.length} parcela(s) de honorários vencida(s)`,
        body: `Total ${money(total)} — abra o Financeiro para cobrar`, discreet: '⚠ Honorários vencidos', action: { view: 'finance' },
      });
    }
    const staleDays = Number(settings.staleCaseDays ?? 15);
    if (staleDays > 0) {
      const stale = db.staleCases(staleDays * DAY);
      if (stale.length) {
        db.markCasesAlerted(stale.map((c) => c.id));
        const names = stale.slice(0, 3).map((c) => `${db.getChat(c.jid)?.display_name || ''} (${c.title})`);
        notify({
          kind: 'cases', title: `📣 ${stale.length} caso(s) sem notícia ao cliente há mais de ${staleDays} dias`,
          body: `${names.join(', ')}${stale.length > 3 ? ` e mais ${stale.length - 3}` : ''}`,
          discreet: '📣 Casos sem retorno ao cliente',
          action: stale.length === 1 ? { chat: stale[0].jid } : { view: 'board' },
        });
      }
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
        kind: 'google', title: '📅 Reconectar Google Agenda',
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
          kind: 'reminder', title: `⏰ Lembrete${chat ? ` — ${chat.display_name}` : ''}`, body: t.title,
          discreet: '⏰ Lembrete', action: t.jid ? { chat: t.jid } : { view: 'tasks' },
        });
        send('tasks:changed', null);
      }
      checkForgotten();
      checkFinanceAndCases();
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
      const pref = auth.userPrefs(u.id).notifyCourts || 'mine';
      if (pref === 'off') continue;
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
                title: `📣 Intimação${it.doc_kind ? ` (${it.doc_kind})` : ''} — ${kc ? `${kc.client_name || ''}: ${kc.title}` : it.process_number}`,
                body: short(it.text), discreet: '📣 Nova intimação',
              }, { fallbackUserId: o.user_id });
            }
            if (row.case_id) {
              db.addMove({ case_id: row.case_id, ts: it.date, text: `${it.kind}${it.doc_kind ? ` (${it.doc_kind})` : ''} — ${it.text.slice(0, 600)}`, source: 'djen', ext_id: `djen:${it.ext_id}` });
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
        if (result.new > 10) notify({ kind: 'intimation', title: `📣 ${result.new} intimações novas no DJEN`, body: 'Abra Jurídico → Intimações para conferir e criar os prazos.', action: { view: 'legal', tab: 'intimacoes' } });
        send('intimations:changed', null);
        for (const id of touched) caseChanged(db.getCase(id));
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
    for (const mv of p.moves) if (db.addMove({ case_id: caseId, ts: mv.ts, text: mv.text, source: 'datajud', ext_id: mv.ext_id })) newMoves++;
    db.markDatajud(caseId, null);
    if (newMoves || Object.keys(fill).length) caseChanged(db.getCase(caseId));
    return { found: true, newMoves, classe: p.classe, updated: p.updated };
  }

  let datajudRunning = false;
  /** Uma vez por dia: andamentos novos dos processos abertos (um por vez, com pausa). */
  async function datajudDaily() {
    if (datajudRunning) return;
    datajudRunning = true;
    try {
      const due = db.listCases({ includeClosed: false })
        .filter((k) => k.process_number && k.kind !== 'consultivo' && (!k.datajud_checked_at || Date.now() - k.datajud_checked_at > 6 * 3600e3))
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
          title: `📜 Andamento novo — ${k.client_name ? `${k.client_name}: ` : ''}${k.title}`,
          body: `${last ? short(last.text) : ''}${n > 1 ? ` (e mais ${n - 1})` : ''}`,
          discreet: '📜 Andamento novo em processo',
        });
      }
    } finally { datajudRunning = false; }
  }

  /** Relógio dos tribunais: DJEN e DataJud a cada 6 h (das 6h às 22h). */
  function courtsTick() {
    const hour = new Date().getHours();
    if (hour < 6 || hour >= 22) return;
    if (db.listOabs().some((o) => o.active) && Date.now() - Number(settings.djenLastRun || 0) > 6 * 3600e3) checkIntimations().catch((e) => console.error('djen:', e.message));
    datajudDaily().catch((e) => console.error('datajud:', e.message));
  }

  /** Recibo de uma parcela recebida (HTML para imprimir ou salvar em PDF). */
  function receiptHtml(id) {
    const p = db.getPayment(id);
    if (!p) throw new Error('Parcela não encontrada');
    if (!p.paid_at) throw new Error('Registre o recebimento antes de emitir o recibo.');
    const k = db.getCase(p.case_id);
    const cl = k?.client_id ? db.getClient(k.client_id) : null;
    const desc = p.description || 'honorários advocatícios';
    const ref = [desc, p.of_total > 1 && !/parcela/i.test(desc) ? `parcela ${p.seq}/${p.of_total}` : null, k?.title ? `caso “${k.title}”` : null,
      k?.process_number ? `processo nº ${k.process_number}` : null].filter(Boolean).join(', ');
    return receiptDoc({
      no: db.receiptNumber(id), value: p.paid_amount ?? p.amount, at: p.paid_at, method: p.method,
      who: cl?.name || k?.client_name || 'cliente', doc: cl?.cpf ? `${cl.kind === 'pj' ? 'CNPJ' : 'CPF'} ${cl.cpf}` : '', ref,
    });
  }

  /** Recibo de receita avulsa (consulta, parecer…). */
  function incomeReceiptHtml(id) {
    const i = db.getIncome(id);
    if (!i) throw new Error('Receita não encontrada');
    return receiptDoc({
      no: db.incomeReceiptNumber(id), value: i.amount, at: i.received_at, method: i.method,
      who: i.who || 'cliente', doc: i.cpf ? `${i.client_kind === 'pj' ? 'CNPJ' : 'CPF'} ${i.cpf}` : '',
      ref: [i.description, i.category && !i.description.toLowerCase().includes(i.category.toLowerCase()) ? i.category.toLowerCase() : null].filter(Boolean).join(' — '),
    });
  }

  function receiptDoc({ no, value, at, method, who, doc, ref }) {
    const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const money = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const date = new Date(at).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
    const office = settings.officeName || 'Barros Associados';
    const methods = { pix: 'Pix', dinheiro: 'dinheiro', transferencia: 'transferência bancária', boleto: 'boleto', cartao: 'cartão', cheque: 'cheque' };
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
      <div class="sign"><div class="line"></div>${esc(office)}${settings.officeDoc ? `<div class="small">${esc(settings.officeDoc)}</div>` : ''}</div>
    </body></html>`;
    return { number: no, html };
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
      legacyAvailable: !demo && ctx.user.role === 'socio' && fs.existsSync(LEGACY_STATE_FILE),
      legacyPending: db.legacyPendingCount(),
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
    'clients:save': (ctx, c) => { const id = db.saveClient({ ...c, userName: ctx.user.name }); clientChanged(id); return id; },
    'clients:linkChat': (_c, id, jid) => {
      const before = db.getClient(id)?.jid;
      db.linkClientChat(id, jid || null);
      if (before) wa.markChanged(before);
      clientChanged(id);
    },
    'clients:fromChat': (ctx, jid) => { const id = db.ensureClientForChat(chatOrThrow(jid), ctx.user.name); clientChanged(id); return id; },
    'clients:activity': (_c, id) => db.listActivity(db.clientKey(db.getClient(id))),
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
    'oabs:save': (_c, o) => { const id = db.saveOab(o); send('intimations:changed', null); return id; },
    'oabs:delete': (_c, id) => { db.deleteOab(id); send('intimations:changed', null); },
    'intimations:list': (_c, opts) => db.listIntimations(opts || {}),
    'intimations:check': async (_c, { days } = {}) => checkIntimations({ days: Math.min(60, Math.max(1, Number(days) || 10)) }),
    'intimations:status': () => ({ lastRun: Number(settings.djenLastRun) || null, running: !!checkingIntimations, oabs: db.listOabs() }),
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
      db.saveCase({ id, process_number: formatCnj(it.process_number), tribunal: it.tribunal || tribunalOf(it.process_number), court: it.orgao, client_role: client_role || null, responsible_id: ctx.user.id });
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
    'parties:save': (_c, p) => { const id = db.saveParty(p); caseChanged(db.getCase(p.case_id)); return id; },
    'parties:delete': (_c, id, caseId) => { db.deleteParty(id); caseChanged(db.getCase(caseId)); },
    'moves:add': (ctx, m) => { const id = db.addMove({ ...m, user_name: ctx.user.name }); caseChanged(db.getCase(m.case_id)); return id; },
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
      const id = db.saveCase(c);
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
    stats: () => db.stats(),
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
    'legacy:import': () => {
      const res = importLegacy(db, LEGACY_STATE_FILE);
      broadcastConfig();
      refreshAllChats();
      return res;
    },

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
        if (n) notify({ kind: 'google', title: '📅 Google Agenda conectado', body: `${n} compromisso(s) do CRM enviados para a sua agenda.` }, { conn: ctx.conn });
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
    events, api, call, dropConn, backupFile, resolveMedia, wa, google, docs, dataDir, demo,
    /** Roda agora a busca dos tribunais (DJEN + DataJud), como o relógio faria. */
    runCourts: () => Promise.all([checkIntimations(), datajudDaily()]),
    /** O computador voltou da suspensão (modo local): a conexão antiga morreu. */
    onResume() {
      if (!wa.hasSession()) return;
      setTimeout(() => wa.reconnectNow().catch((e) => console.error(e)), 1500);
    },
    logFile: path.join(dataDir, 'logs', 'whatsapp.log'),
    async stop() {
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
