// Liga os prazos/audiências/reuniões/tarefas do CRM ao Google Agenda:
// cria/atualiza/apaga o evento correspondente e traz de volta mudanças
// de horário feitas no Google (celular, site…).
import * as db from './db.js';

const KIND = {
  prazo: { icon: '⚠️', label: 'Prazo', minutes: 30 },
  audiencia: { icon: '⚖️', label: 'Audiência', minutes: 120 },
  reuniao: { icon: '🤝', label: 'Reunião', minutes: 60 },
  tarefa: { icon: '✅', label: 'Tarefa', minutes: 30 },
};

export function taskDuration(t) {
  return t.end_at && t.end_at > t.due_at ? t.end_at - t.due_at : (KIND[t.kind]?.minutes || 30) * 60000;
}

export function taskToEvent(t) {
  const k = KIND[t.kind] || KIND.tarefa;
  const who = t.jid ? db.getChat(t.jid)?.display_name : null;
  const lines = [
    `${k.label} — WhatsApp CRM`,
    who ? `Cliente: ${who}` : null,
    t.case_title ? `Caso: ${t.case_title}` : null,
    t.process_number ? `Processo: ${t.process_number}` : null,
    t.court ? `Vara/Órgão: ${t.court}` : null,
  ].filter(Boolean);
  return {
    title: `${t.done ? '✔ ' : ''}${k.icon} ${t.title}${who ? ` — ${who}` : ''}`,
    description: lines.join('\n'),
    start: t.due_at,
    end: t.due_at + taskDuration(t),
    allDay: false,
    taskId: t.id,
  };
}

export class CalendarSync {
  constructor({ google, getSettings, onChange }) {
    this.google = google;
    this.getSettings = getSettings;
    this.onChange = onChange || (() => {});
  }

  enabled() {
    return this.google?.status().connected && this.getSettings().googleSync !== false;
  }

  async targetCalendar() {
    const wanted = this.getSettings().googleCalendarId;
    if (wanted) return wanted;
    const cals = await this.google.calendars();
    return (cals.find((c) => c.primary) || cals.find((c) => c.writable))?.id || 'primary';
  }

  /** Envia (ou atualiza) um compromisso do CRM no Google. */
  async syncTask(id) {
    if (!this.enabled()) return;
    const t = db.getTask(id);
    if (!t) return;
    if (!t.due_at) {
      if (t.gcal_event_id) {
        await this.google.deleteEvent(t.gcal_calendar_id, t.gcal_event_id);
        db.setTaskGcal(id, null, null);
      }
      return;
    }
    const cal = t.gcal_calendar_id || await this.targetCalendar();
    try {
      const ev = await this.google.saveEvent(cal, taskToEvent(t), t.gcal_event_id || undefined);
      db.setTaskGcal(id, ev.id, cal);
    } catch (e) {
      if (t.gcal_event_id && (e.status === 404 || e.status === 410)) {
        // o evento foi apagado no Google: cria de novo
        const ev = await this.google.saveEvent(cal, taskToEvent(t));
        db.setTaskGcal(id, ev.id, cal);
      } else throw e;
    }
  }

  /** Apaga do Google o evento de uma tarefa que vai ser excluída. */
  async removeTask(task) {
    if (!task?.gcal_event_id || !this.google?.status().connected) return;
    await this.google.deleteEvent(task.gcal_calendar_id, task.gcal_event_id);
  }

  /** Manda para o Google tudo que ainda não foi (usado logo após conectar). */
  async syncAll() {
    if (!this.enabled()) return 0;
    let n = 0;
    for (const { id } of db.tasksToSync()) {
      try { await this.syncTask(id); n++; } catch (e) { console.error('sync tarefa', id, e.message); }
    }
    if (n) this.onChange();
    return n;
  }

  /**
   * Eventos para a tela de agenda: tudo do Google (agendas escolhidas) +
   * compromissos do CRM que ainda não estão no Google.
   */
  async agenda(from, to, calendarIds) {
    let events = [];
    let error = null;
    const status = this.google?.status() || { connected: false };
    if (status.connected) {
      try {
        events = await this.google.events(calendarIds, from, to);
        this.pullChanges(events);
      } catch (e) {
        error = e.message;
      }
    }
    const inGoogle = new Set(events.filter((e) => e.taskId).map((e) => e.taskId));
    const local = db.tasksInRange(from, to)
      .filter((t) => !inGoogle.has(t.id) && (!status.connected || !t.gcal_event_id || error))
      .map((t) => ({
        id: `task-${t.id}`,
        source: 'crm',
        calendarId: 'crm',
        calendarName: 'WhatsApp CRM',
        color: '#00a884',
        writable: true,
        title: `${t.done ? '✔ ' : ''}${KIND[t.kind]?.icon || ''} ${t.title}`,
        description: taskToEvent(t).description,
        start: t.due_at,
        end: t.due_at + taskDuration(t),
        allDay: false,
        taskId: t.id,
      }));
    // eventos do Google ligados a uma tarefa ganham dados do CRM
    for (const e of events) {
      if (!e.taskId) continue;
      const t = db.getTask(e.taskId);
      if (t) Object.assign(e, { jid: t.jid, caseId: t.case_id, kind: t.kind, done: !!t.done });
    }
    for (const e of local) {
      const t = db.getTask(e.taskId);
      Object.assign(e, { jid: t?.jid, caseId: t?.case_id, kind: t?.kind, done: !!t?.done });
    }
    return { events: [...events, ...local], error, status };
  }

  /** Se o horário foi mudado no Google, atualiza o compromisso no CRM. */
  pullChanges(events) {
    let changed = false;
    for (const e of events) {
      if (!e.taskId || e.allDay) continue;
      const t = db.getTask(e.taskId);
      if (!t || t.gcal_event_id !== e.id) continue;
      if (Math.abs((t.due_at || 0) - e.start) > 60000 || Math.abs(taskDuration(t) - (e.end - e.start)) > 60000) {
        db.saveTask({ id: t.id, due_at: e.start, end_at: e.end });
        db.setTaskGcal(t.id, e.id, e.calendarId);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }
}
