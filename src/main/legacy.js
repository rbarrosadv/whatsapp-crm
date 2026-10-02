// Importa o quadro do app antigo (Kanban CRM v3, que rodava por cima do
// WhatsApp Web). Ele identificava as conversas pelo NOME, então as
// classificações ficam "pendentes" e são aplicadas assim que aparecer
// uma conversa com o mesmo nome aqui.
import path from 'node:path';
import fs from 'node:fs';

export function legacyStateFile(appDataDir) {
  return path.join(appDataDir, 'KanbanCRMWhatsApp', 'kanban-state.json');
}

export function importLegacy(db, file) {
  if (!fs.existsSync(file)) throw new Error('Não encontrei o arquivo do Kanban antigo neste computador.');
  const state = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const categories = state.categoryList || [];
  const columns = state.categoryColumns || {};

  const existing = new Set(db.listPipelines().map((p) => p.id));
  let pipelines = 0;
  for (const cat of categories) {
    const pid = `legado_${cat.id}`;
    const cols = columns[cat.id] || [];
    if (!existing.has(pid)) pipelines++;
    db.savePipeline({
      id: pid,
      name: cat.label || cat.id,
      icon: cat.icon || '📁',
      stages: cols.map((c) => ({ id: `${pid}.${c.id}`, name: c.name, color: c.accent || '#94a3b8' })),
    });
  }

  const pending = new Map();
  const nameOf = (chatId) => (String(chatId).startsWith('name:') ? String(chatId).slice(5) : null);
  for (const [chatId, catId] of Object.entries(state.categories || {})) {
    const name = nameOf(chatId);
    const col = (state.assignments || {})[`${catId}:${chatId}`];
    if (!name || !col) continue;
    pending.set(name, { name, pipeline_id: `legado_${catId}`, stage_id: `legado_${catId}.${col}` });
  }
  for (const [chatId, note] of Object.entries(state.notes || {})) {
    const name = nameOf(chatId);
    if (!name || (!note?.text && !note?.deadline)) continue;
    const row = pending.get(name) || { name };
    row.note = note.text || null;
    row.deadline = note.deadline || null;
    pending.set(name, row);
  }
  const applied = db.addLegacyPending([...pending.values()]);
  return { pipelines, conversations: pending.size, applied, waiting: db.legacyPendingCount() };
}
