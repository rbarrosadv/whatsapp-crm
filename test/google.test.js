// Testes da integração com o Google Agenda, com respostas simuladas do Google.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/main/db.js';
import { GoogleService, fromEvent, toEvent } from '../src/main/google.js';
import { CalendarSync, taskToEvent } from '../src/main/calendar-sync.js';
import { DemoGoogleService } from '../src/main/demo.js';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-google-')); db.openDb(dir); });
after(() => { db.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [re, handler] of routes) {
      if (re.test(url)) {
        const { status = 200, body = {} } = await handler(url, opts);
        return { ok: status < 400, status, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
  };
  fn.calls = calls;
  return fn;
}

test('importa a chave, renova o token e lista agendas e eventos', async () => {
  const gdir = path.join(dir, 'g1');
  const keyFile = path.join(dir, 'client.json');
  fs.writeFileSync(keyFile, JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } }));
  const fetch = fakeFetch([
    [/oauth2\.googleapis\.com\/token/, () => ({ body: { access_token: 'AT', expires_in: 3600 } })],
    [/calendarList/, () => ({ body: { items: [
      { id: 'me@x', summary: 'Minha agenda', primary: true, accessRole: 'owner', backgroundColor: '#123456' },
      { id: 'h@x', summary: 'Feriados', accessRole: 'reader' },
    ] } })],
    [/calendars\/me%40x\/events/, () => ({ body: { items: [
      { id: 'e1', summary: 'Audiência', start: { dateTime: '2030-01-10T14:00:00-03:00' }, end: { dateTime: '2030-01-10T16:00:00-03:00' }, extendedProperties: { private: { crmTaskId: '7' } } },
      { id: 'e2', status: 'cancelled', start: { date: '2030-01-11' }, end: { date: '2030-01-12' } },
    ] } })],
    [/calendars\/h%40x\/events/, () => ({ body: { items: [{ id: 'f', summary: 'Feriado', start: { date: '2030-01-11' }, end: { date: '2030-01-12' } }] } })],
  ]);
  const g = new GoogleService({ dir: gdir, fetch, openExternal: () => {} });
  assert.throws(() => g.importClient(keyFile), /App para computador/);
  fs.writeFileSync(keyFile, JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } }));
  g.importClient(keyFile);
  assert.equal(g.status().configured, true);
  assert.equal(g.status().connected, false);
  g.writeToken({ refresh_token: 'RT' });
  assert.equal(g.status().connected, true);

  const cals = await g.calendars();
  assert.deepEqual(cals.map((c) => [c.name, c.writable, c.primary]), [['Minha agenda', true, true], ['Feriados', false, false]]);
  const evs = await g.events(null, Date.parse('2030-01-01'), Date.parse('2030-02-01'));
  assert.equal(evs.length, 2, 'cancelado não aparece');
  const aud = evs.find((e) => e.id === 'e1');
  assert.equal(aud.taskId, 7);
  assert.equal(aud.end - aud.start, 2 * 3600e3);
  assert.equal(evs.find((e) => e.id === 'f').allDay, true);
  // o token de acesso é reaproveitado (só 1 renovação)
  assert.equal(fetch.calls.filter((c) => /token$/.test(c.url)).length, 1);
  assert.match(fetch.calls.find((c) => /calendarList/.test(c.url)).opts.headers.Authorization, /Bearer AT/);
});

test('autorização vencida (modo de teste, 7 dias) pede para reconectar', async () => {
  const gdir = path.join(dir, 'g2');
  const fetch = fakeFetch([[/token/, () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } })]]);
  const g = new GoogleService({ dir: gdir, fetch, openExternal: () => {} });
  fs.writeFileSync(g.clientFile, JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } }));
  g.writeToken({ refresh_token: 'RT' });
  const statuses = [];
  g.on('status', (s) => statuses.push(s));
  await assert.rejects(() => g.calendars(), /Reconectar Google/);
  assert.equal(g.status().needsReconnect, true);
  assert.equal(g.status().connected, false);
  assert.equal(statuses.at(-1).needsReconnect, true);
});

test('formato dos eventos enviados ao Google', () => {
  const start = new Date(2030, 0, 10, 9, 0).getTime();
  const b = fromEvent({ title: 'X', start, end: start + 3600e3, taskId: 5 });
  assert.equal(b.summary, 'X');
  assert.equal(new Date(b.start.dateTime).getTime(), start);
  assert.equal(b.extendedProperties.private.crmTaskId, '5');
  const allDay = fromEvent({ title: 'Y', start, allDay: true });
  assert.deepEqual(allDay.start, { date: '2030-01-10' });
  assert.deepEqual(allDay.end, { date: '2030-01-11' });
  const back = toEvent({ id: 'a', start: { date: '2030-01-10' }, end: { date: '2030-01-11' } }, { id: 'c', name: 'C', color: '#000', writable: true });
  assert.equal(back.allDay, true);
  assert.equal(back.title, '(sem título)');
});

test('prazos do CRM vão para o Google e mudanças de horário voltam', async () => {
  const J = '5511977776666@s.whatsapp.net';
  db.upsertChat({ jid: J, name: 'Cliente Agenda', last_ts: Date.now() });
  const caseId = db.saveCase({ jid: J, title: 'Ação de cobrança', stage_id: 'casos.protocolo', process_number: '123' });
  const due = Date.now() + 2 * 86400e3;
  const taskId = db.saveTask({ case_id: caseId, kind: 'audiencia', title: 'Audiência', due_at: due });
  const google = new DemoGoogleService();
  const sync = new CalendarSync({ google, getSettings: () => ({ googleCalendarId: 'escritorio@demo' }) });

  const ev = taskToEvent(db.getTask(taskId));
  assert.match(ev.title, /Audiência — Cliente Agenda/);
  assert.match(ev.description, /Processo: 123/);
  assert.equal(ev.end - ev.start, 120 * 60000, 'audiência dura 2 h por padrão');

  await sync.syncTask(taskId);
  const t = db.getTask(taskId);
  assert.ok(t.gcal_event_id);
  assert.equal(t.gcal_calendar_id, 'escritorio@demo');
  // aparece uma vez só na agenda (vem do Google, com dados do CRM)
  let ag = await sync.agenda(Date.now(), Date.now() + 7 * 86400e3);
  const mine = ag.events.filter((e) => e.taskId === taskId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].source, 'google');
  assert.equal(mine[0].caseId, caseId);

  // mudou o horário no Google (celular) → CRM acompanha, mantendo a duração
  const item = google.items.find((e) => e.id === t.gcal_event_id);
  item.start += 3600e3; item.end += 3600e3;
  ag = await sync.agenda(Date.now(), Date.now() + 7 * 86400e3);
  assert.equal(db.getTask(taskId).due_at, due + 3600e3);

  // concluir mantém o evento, com ✔ no título
  db.saveTask({ id: taskId, done: true });
  await sync.syncTask(taskId);
  assert.match(google.items.find((e) => e.id === t.gcal_event_id).title, /^✔/);

  // excluir a tarefa apaga o evento
  await sync.removeTask(db.getTask(taskId));
  assert.equal(google.items.find((e) => e.id === t.gcal_event_id), undefined);

  // sem Google: compromissos do CRM aparecem na agenda mesmo assim
  const off = new CalendarSync({ google: { status: () => ({ connected: false }) }, getSettings: () => ({}) });
  const t2 = db.saveTask({ jid: J, kind: 'reuniao', title: 'Reunião', due_at: Date.now() + 86400e3 });
  const ag2 = await off.agenda(Date.now(), Date.now() + 7 * 86400e3);
  assert.ok(ag2.events.some((e) => e.taskId === t2 && e.source === 'crm'));
});
