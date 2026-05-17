/**
 * سجل تدقيق الإدارة والأحداث
 */

const MAX_AUDIT = 25000;

function logAudit(ctx, entry) {
  if (!Array.isArray(ctx.store.auditEvents)) {
    ctx.store.auditEvents = [];
  }
  const event = {
    id: ctx.id(),
    at: new Date().toISOString(),
    actorType: entry.actorType || 'admin',
    actorId: entry.actorId || '',
    actorName: entry.actorName || '',
    action: entry.action || 'unknown',
    entityType: entry.entityType || '',
    entityId: entry.entityId || '',
    note: entry.note || '',
    meta: entry.meta || {},
  };
  ctx.store.auditEvents.unshift(event);
  if (ctx.store.auditEvents.length > MAX_AUDIT) {
    ctx.store.auditEvents.length = MAX_AUDIT;
  }
  ctx.saveStore();
  return event;
}

function filterAudit(events, query) {
  let list = [...(events || [])];
  if (query.actorId) {
    list = list.filter((e) => e.actorId === query.actorId);
  }
  if (query.action) {
    list = list.filter((e) => e.action === query.action);
  }
  if (query.entityType) {
    list = list.filter((e) => e.entityType === query.entityType);
  }
  if (query.from) {
    const t = new Date(query.from).getTime();
    list = list.filter((e) => new Date(e.at).getTime() >= t);
  }
  if (query.to) {
    const t = new Date(query.to).getTime();
    list = list.filter((e) => new Date(e.at).getTime() <= t);
  }
  if (query.q) {
    const q = String(query.q).toLowerCase();
    list = list.filter(
      (e) =>
        e.action?.toLowerCase().includes(q) ||
        e.entityId?.toLowerCase().includes(q) ||
        e.note?.toLowerCase().includes(q),
    );
  }
  return list;
}

module.exports = { logAudit, filterAudit, MAX_AUDIT };
