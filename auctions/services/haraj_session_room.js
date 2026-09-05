'use strict';

/**
 * G5 — concrete Haraj Session + Room model.
 * Uses existing 009/010 tables. Does not generate recurrence (G6),
 * activate live rooms (G8), or manage queues.
 */

const { isAuctionApproved } = require('./approval_flow');
const { isHarajAuctioneer, applyStagingAuctioneerBootstrap } = require('./haraj_auctioneer_auth');
const { listQueue } = require('./haraj_auctioneer_review');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TZ = 'Asia/Riyadh';
const CATEGORY_CODES = ['horse', 'camel', 'falcon'];
const SESSION_EDITABLE = new Set(['planned', 'upcoming']);
const SESSION_TERMINAL = new Set(['closed', 'cancelled', 'archived']);
const ROOM_CATALOG_EDITABLE = new Set(['disabled', 'idle']);

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

function correlationId(req) {
  const h = req && (req.headers?.['x-request-id'] || req.headers?.['x-correlation-id'] || req.headers?.['idempotency-key']);
  if (h) return String(h).slice(0, 80);
  return `g5-${Date.now().toString(36)}`;
}

function assertTimezone(tz) {
  const value = String(tz || DEFAULT_TZ).trim() || DEFAULT_TZ;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    fail(400, 'HARAJ_TIMEZONE_INVALID', 'Timezone must be a valid IANA name');
  }
  return value;
}

function assertCategoryCode(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!CATEGORY_CODES.includes(c)) {
    fail(400, 'HARAJ_CATEGORY_INVALID', 'Category must be horse, camel, or falcon');
  }
  return c;
}

function parseTime(value, field) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    fail(400, 'HARAJ_TIME_INVALID', `${field} must be an ISO-8601 timestamp`);
  }
  return d;
}

function assertTimeRange(start, end) {
  if (!(end > start)) {
    fail(400, 'HARAJ_TIME_RANGE_INVALID', 'scheduledEndAt must be after scheduledStartAt');
  }
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function canEditSession(status) {
  return SESSION_EDITABLE.has(String(status || ''));
}

function mapCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    nameAr: row.name_ar,
    nameEn: row.name_en,
    status: row.status,
  };
}

function mapRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    categoryId: row.category_id,
    categoryCode: row.category_code || null,
    code: row.code,
    nameAr: row.name_ar,
    nameEn: row.name_en,
    status: row.status,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    financialAuthority: false,
    bidAuthority: false,
  };
}

function mapSession(row, rooms = []) {
  return {
    id: row.id,
    categoryId: row.category_id,
    categoryCode: row.category_code || null,
    policyId: row.policy_id || null,
    overrideId: row.override_id || null,
    scheduledStartAt: row.scheduled_start_at,
    scheduledEndAt: row.scheduled_end_at,
    actualStartAt: row.actual_start_at,
    actualEndAt: row.actual_end_at,
    timezone: row.timezone,
    status: row.status,
    generationSource: row.generation_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rooms,
    financialAuthority: false,
    bidAuthority: false,
  };
}

function mapRoomSession(row) {
  return {
    id: row.id,
    sessionId: row.haraj_session_id,
    roomId: row.room_id,
    status: row.status,
    auctioneerUserId: row.auctioneer_user_id,
    backupAuctioneerUserId: row.backup_auctioneer_user_id,
    activeLotId: row.active_lot_id,
    queueStatus: row.queue_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    room: row.room_code
      ? {
          id: row.room_id,
          code: row.room_code,
          nameAr: row.room_name_ar,
          categoryCode: row.room_category_code,
          status: row.room_status,
        }
      : undefined,
    financialAuthority: false,
    liveActivated: false,
  };
}

async function ensureCategories(client) {
  await client.query(
    `INSERT INTO haraj_categories (code, name_ar, name_en, sort_order, status)
     VALUES
       ('horse', 'خيل', 'Horses', 1, 'active'),
       ('camel', 'إبل', 'Camels', 2, 'active'),
       ('falcon', 'صقور', 'Falcons', 3, 'active')
     ON CONFLICT (code) DO NOTHING`,
  );
}

async function listCategories(client) {
  await ensureCategories(client);
  const { rows } = await client.query(
    `SELECT * FROM haraj_categories ORDER BY sort_order ASC`,
  );
  return rows.map(mapCategory);
}

async function categoryByCode(client, code) {
  await ensureCategories(client);
  const c = assertCategoryCode(code);
  const { rows } = await client.query(
    `SELECT * FROM haraj_categories WHERE code = $1`,
    [c],
  );
  if (!rows[0]) fail(400, 'HARAJ_CATEGORY_INVALID', 'Category not found');
  return rows[0];
}

async function audit(client, { entityType, entityId, eventType, actorUserId, actorRole, payload }) {
  await client.query(
    `INSERT INTO haraj_audit_events (entity_type, entity_id, event_type, actor_user_id, actor_role, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [entityType, entityId, eventType, actorUserId || null, actorRole || 'admin', JSON.stringify(payload || {})],
  );
}

async function findByIdempotency(client, eventType, key) {
  if (!key) return null;
  const { rows } = await client.query(
    `SELECT entity_id, payload FROM haraj_audit_events
     WHERE event_type = $1 AND payload->>'idempotencyKey' = $2
     ORDER BY created_at DESC LIMIT 1`,
    [eventType, String(key)],
  );
  return rows[0] || null;
}

function assertAuctioneer(store, userId, claimedFromBody) {
  const id = String(userId || '').trim();
  if (!id) fail(400, 'HARAJ_AUCTIONEER_REQUIRED', 'auctioneerUserId is required');
  if (claimedFromBody && String(claimedFromBody) !== id) {
    fail(403, 'AUCTIONEER_IDENTITY_FORBIDDEN', 'Client-supplied auctioneer identity is not authoritative');
  }
  const raw = store?.users?.get?.(id) || { id, capabilities: [] };
  const user = applyStagingAuctioneerBootstrap({ ...raw, id });
  if (!isHarajAuctioneer(user, id)) {
    fail(400, 'HARAJ_AUCTIONEER_INVALID', 'Assigned user is not an authorized auctioneer');
  }
  return id;
}

function assertUuid(id, code = 'HARAJ_NOT_FOUND') {
  if (!UUID_RE.test(String(id || ''))) {
    fail(404, code, 'Not found');
  }
}

async function lockSession(client, sessionId) {
  assertUuid(sessionId, 'HARAJ_SESSION_NOT_FOUND');
  const { rows } = await client.query(
    `SELECT s.*, c.code AS category_code
     FROM haraj_sessions s
     JOIN haraj_categories c ON c.id = s.category_id
     WHERE s.id = $1
     FOR UPDATE`,
    [sessionId],
  );
  if (!rows[0]) fail(404, 'HARAJ_SESSION_NOT_FOUND', 'Session not found');
  return rows[0];
}

async function listRoomSessions(client, sessionId) {
  const { rows } = await client.query(
    `SELECT rs.*, r.code AS room_code, r.name_ar AS room_name_ar, r.status AS room_status,
            c.code AS room_category_code
     FROM haraj_room_sessions rs
     JOIN haraj_rooms r ON r.id = rs.room_id
     JOIN haraj_categories c ON c.id = r.category_id
     WHERE rs.haraj_session_id = $1
     ORDER BY r.sort_order ASC, r.created_at ASC`,
    [sessionId],
  );
  return rows.map(mapRoomSession);
}

async function getSession(client, sessionId) {
  assertUuid(sessionId, 'HARAJ_SESSION_NOT_FOUND');
  const { rows } = await client.query(
    `SELECT s.*, c.code AS category_code
     FROM haraj_sessions s
     JOIN haraj_categories c ON c.id = s.category_id
     WHERE s.id = $1`,
    [sessionId],
  );
  if (!rows[0]) fail(404, 'HARAJ_SESSION_NOT_FOUND', 'Session not found');
  const rooms = await listRoomSessions(client, sessionId);
  return mapSession(rows[0], rooms);
}

async function listSessions(client, { status, category, limit = 50 } = {}) {
  const cap = Math.min(Number(limit) || 50, 100);
  const params = [];
  const clauses = [];
  let n = 1;
  if (status) {
    clauses.push(`s.status = $${n++}`);
    params.push(String(status));
  }
  if (category) {
    clauses.push(`c.code = $${n++}`);
    params.push(assertCategoryCode(category));
  }
  params.push(cap);
  const { rows } = await client.query(
    `SELECT s.*, c.code AS category_code
     FROM haraj_sessions s
     JOIN haraj_categories c ON c.id = s.category_id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY s.scheduled_start_at DESC
     LIMIT $${n}`,
    params,
  );
  const out = [];
  for (const row of rows) {
    out.push(mapSession(row, await listRoomSessions(client, row.id)));
  }
  return out;
}

async function createSession(client, {
  category,
  scheduledStartAt,
  scheduledEndAt,
  timezone,
  idempotencyKey,
  actorUserId,
  clientCreatedBy,
}) {
  if (clientCreatedBy) {
    fail(403, 'HARAJ_ACTOR_FORBIDDEN', 'Client-supplied createdBy is not authoritative');
  }
  const tz = assertTimezone(timezone);
  const start = parseTime(scheduledStartAt, 'scheduledStartAt');
  const end = parseTime(scheduledEndAt, 'scheduledEndAt');
  assertTimeRange(start, end);
  const cat = await categoryByCode(client, category);

  if (idempotencyKey) {
    const prior = await findByIdempotency(client, 'haraj.session.created', idempotencyKey);
    if (prior) return getSession(client, prior.entity_id);
  }

  const existing = await client.query(
    `SELECT id FROM haraj_sessions
     WHERE category_id = $1 AND scheduled_start_at = $2 AND scheduled_end_at = $3
       AND timezone = $4 AND status IN ('planned', 'upcoming')
     LIMIT 1`,
    [cat.id, start.toISOString(), end.toISOString(), tz],
  );
  if (existing.rows[0]) {
    return getSession(client, existing.rows[0].id);
  }

  const { rows } = await client.query(
    `INSERT INTO haraj_sessions (
        category_id, scheduled_start_at, scheduled_end_at, timezone,
        status, generation_source
     ) VALUES ($1, $2, $3, $4, 'planned', 'manual_admin')
     RETURNING *`,
    [cat.id, start.toISOString(), end.toISOString(), tz],
  );
  const row = rows[0];
  await audit(client, {
    entityType: 'haraj_session',
    entityId: row.id,
    eventType: 'haraj.session.created',
    actorUserId,
    payload: {
      category: cat.code,
      scheduledStartAt: row.scheduled_start_at,
      scheduledEndAt: row.scheduled_end_at,
      timezone: tz,
      status: 'planned',
      generationSource: 'manual_admin',
      idempotencyKey: idempotencyKey || null,
      recurrenceEngine: false,
    },
  });
  return getSession(client, row.id);
}

async function updateSession(client, {
  sessionId,
  scheduledStartAt,
  scheduledEndAt,
  timezone,
  status,
  expectedStatus,
  actorUserId,
}) {
  const row = await lockSession(client, sessionId);
  if (expectedStatus && String(expectedStatus) !== String(row.status)) {
    fail(409, 'HARAJ_SESSION_CONFLICT', 'Session state changed; refresh and retry');
  }
  if (!canEditSession(row.status)) {
    fail(409, 'HARAJ_SESSION_IMMUTABLE', 'Session is no longer safely editable');
  }
  if (status && !['planned', 'upcoming', 'cancelled'].includes(status)) {
    fail(400, 'HARAJ_SESSION_STATUS_FORBIDDEN', 'G5 cannot activate live/closing session states');
  }
  const nextStart = scheduledStartAt ? parseTime(scheduledStartAt, 'scheduledStartAt') : new Date(row.scheduled_start_at);
  const nextEnd = scheduledEndAt ? parseTime(scheduledEndAt, 'scheduledEndAt') : new Date(row.scheduled_end_at);
  assertTimeRange(nextStart, nextEnd);
  const tz = timezone != null ? assertTimezone(timezone) : row.timezone;
  const nextStatus = status || row.status;
  if (SESSION_TERMINAL.has(nextStatus) && nextStatus !== 'cancelled') {
    fail(400, 'HARAJ_SESSION_STATUS_FORBIDDEN', 'Illegal terminal transition');
  }

  const { rows } = await client.query(
    `UPDATE haraj_sessions
     SET scheduled_start_at = $2, scheduled_end_at = $3, timezone = $4,
         status = $5, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [sessionId, nextStart.toISOString(), nextEnd.toISOString(), tz, nextStatus],
  );
  await audit(client, {
    entityType: 'haraj_session',
    entityId: sessionId,
    eventType: 'haraj.session.updated',
    actorUserId,
    payload: {
      fromStatus: row.status,
      toStatus: nextStatus,
      scheduledStartAt: rows[0].scheduled_start_at,
      scheduledEndAt: rows[0].scheduled_end_at,
      timezone: tz,
    },
  });
  return getSession(client, sessionId);
}

async function cancelSession(client, { sessionId, reason, expectedStatus, actorUserId }) {
  const row = await lockSession(client, sessionId);
  if (expectedStatus && String(expectedStatus) !== String(row.status)) {
    fail(409, 'HARAJ_SESSION_CONFLICT', 'Session state changed; refresh and retry');
  }
  if (row.status === 'cancelled') {
    return getSession(client, sessionId);
  }
  if (SESSION_TERMINAL.has(row.status) && row.status !== 'cancelled') {
    fail(409, 'HARAJ_SESSION_IMMUTABLE', 'Completed sessions cannot be cancelled destructively');
  }
  await client.query(
    `UPDATE haraj_sessions SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
    [sessionId],
  );
  await audit(client, {
    entityType: 'haraj_session',
    entityId: sessionId,
    eventType: 'haraj.session.cancelled',
    actorUserId,
    payload: {
      fromStatus: row.status,
      toStatus: 'cancelled',
      reason: reason || null,
      lotsDeleted: false,
      auctionsDeleted: false,
      bidHistoryDeleted: false,
    },
  });
  return getSession(client, sessionId);
}

async function listRooms(client, { category, limit = 50 } = {}) {
  const cap = Math.min(Number(limit) || 50, 100);
  const params = [];
  let n = 1;
  let where = '';
  if (category) {
    where = `WHERE c.code = $${n++}`;
    params.push(assertCategoryCode(category));
  }
  params.push(cap);
  const { rows } = await client.query(
    `SELECT r.*, c.code AS category_code
     FROM haraj_rooms r
     JOIN haraj_categories c ON c.id = r.category_id
     ${where}
     ORDER BY r.sort_order ASC, r.created_at ASC
     LIMIT $${n}`,
    params,
  );
  return rows.map(mapRoom);
}

async function getRoom(client, roomId) {
  assertUuid(roomId, 'HARAJ_ROOM_NOT_FOUND');
  const { rows } = await client.query(
    `SELECT r.*, c.code AS category_code
     FROM haraj_rooms r
     JOIN haraj_categories c ON c.id = r.category_id
     WHERE r.id = $1`,
    [roomId],
  );
  if (!rows[0]) fail(404, 'HARAJ_ROOM_NOT_FOUND', 'Room not found');
  return mapRoom(rows[0]);
}

async function createRoom(client, { category, code, nameAr, nameEn, idempotencyKey, actorUserId }) {
  const cat = await categoryByCode(client, category);
  const roomCode = String(code || `${cat.code}-${Date.now().toString(36)}`).trim();
  if (!roomCode) fail(400, 'HARAJ_ROOM_CODE_REQUIRED', 'Room code is required');

  if (idempotencyKey) {
    const prior = await findByIdempotency(client, 'haraj.room.created', idempotencyKey);
    if (prior) return getRoom(client, prior.entity_id);
  }

  const existing = await client.query(`SELECT * FROM haraj_rooms WHERE code = $1`, [roomCode]);
  if (existing.rows[0]) {
    if (String(existing.rows[0].category_id) !== String(cat.id)) {
      fail(409, 'HARAJ_ROOM_CODE_CONFLICT', 'Room code already used by another category');
    }
    return getRoom(client, existing.rows[0].id);
  }

  const { rows } = await client.query(
    `INSERT INTO haraj_rooms (category_id, code, name_ar, name_en, status)
     VALUES ($1, $2, $3, $4, 'idle')
     RETURNING *`,
    [cat.id, roomCode, String(nameAr || roomCode), String(nameEn || roomCode)],
  );
  await audit(client, {
    entityType: 'haraj_room',
    entityId: rows[0].id,
    eventType: 'haraj.room.created',
    actorUserId,
    payload: {
      category: cat.code,
      code: roomCode,
      status: 'idle',
      idempotencyKey: idempotencyKey || null,
    },
  });
  return getRoom(client, rows[0].id);
}

async function updateRoom(client, { roomId, nameAr, nameEn, status, actorUserId }) {
  const current = await getRoom(client, roomId);
  if (status && !ROOM_CATALOG_EDITABLE.has(status)) {
    fail(400, 'HARAJ_ROOM_STATUS_FORBIDDEN', 'G5 cannot set live/pre_live room catalog states');
  }
  if (!ROOM_CATALOG_EDITABLE.has(current.status) && status && status !== current.status) {
    fail(409, 'HARAJ_ROOM_IMMUTABLE', 'Operational room catalog status is protected');
  }
  const { rows } = await client.query(
    `UPDATE haraj_rooms
     SET name_ar = COALESCE($2, name_ar),
         name_en = COALESCE($3, name_en),
         status = COALESCE($4, status),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [roomId, nameAr || null, nameEn || null, status || null],
  );
  await audit(client, {
    entityType: 'haraj_room',
    entityId: roomId,
    eventType: 'haraj.room.updated',
    actorUserId,
    payload: { nameAr, nameEn, status: status || current.status },
  });
  return getRoom(client, rows[0].id);
}

async function assertAuctioneerFree(client, { auctioneerUserId, start, end, exceptRoomSessionId }) {
  const { rows } = await client.query(
    `SELECT rs.id, rs.haraj_session_id, s.scheduled_start_at, s.scheduled_end_at, s.status
     FROM haraj_room_sessions rs
     JOIN haraj_sessions s ON s.id = rs.haraj_session_id
     WHERE rs.auctioneer_user_id = $1
       AND s.status NOT IN ('cancelled', 'closed', 'archived')
       AND ($4::uuid IS NULL OR rs.id <> $4)
       AND s.scheduled_start_at < $3
       AND s.scheduled_end_at > $2`,
    [auctioneerUserId, start.toISOString(), end.toISOString(), exceptRoomSessionId || null],
  );
  if (rows[0]) {
    fail(
      409,
      'HARAJ_AUCTIONEER_CONFLICT',
      'Auctioneer already assigned to an overlapping session room',
    );
  }
}

async function attachRoom(client, {
  sessionId,
  roomId,
  category,
  code,
  nameAr,
  nameEn,
  auctioneerUserId,
  backupAuctioneerUserId,
  store,
  claimedAuctioneerId,
  expectedSessionStatus,
  idempotencyKey,
  actorUserId,
}) {
  const session = await lockSession(client, sessionId);
  if (expectedSessionStatus && String(expectedSessionStatus) !== String(session.status)) {
    fail(409, 'HARAJ_SESSION_CONFLICT', 'Session state changed; refresh and retry');
  }
  if (session.status === 'cancelled') {
    fail(409, 'HARAJ_SESSION_CANCELLED', 'Cannot attach rooms to a cancelled session');
  }
  if (!canEditSession(session.status)) {
    fail(409, 'HARAJ_SESSION_IMMUTABLE', 'Cannot attach rooms after session becomes operational');
  }

  if (idempotencyKey) {
    const prior = await findByIdempotency(client, 'haraj.room_session.created', idempotencyKey);
    if (prior) {
      const rooms = await listRoomSessions(client, sessionId);
      return { session: await getSession(client, sessionId), roomSession: rooms.find((r) => r.id === prior.entity_id) };
    }
  }

  const requestedCategory = category || session.category_code;
  if (requestedCategory && requestedCategory !== session.category_code) {
    fail(409, 'HARAJ_CATEGORY_MISMATCH', 'Room category must match session category');
  }

  let room;
  if (roomId) {
    room = await getRoom(client, roomId);
  } else {
    room = await createRoom(client, {
      category: requestedCategory,
      code,
      nameAr,
      nameEn,
      actorUserId,
    });
  }
  if (room.categoryCode !== session.category_code) {
    fail(409, 'HARAJ_CATEGORY_MISMATCH', 'Room category must match session category');
  }

  const auctioneer = assertAuctioneer(store, auctioneerUserId, claimedAuctioneerId);
  if (backupAuctioneerUserId) {
    assertAuctioneer(store, backupAuctioneerUserId);
    if (String(backupAuctioneerUserId) === auctioneer) {
      fail(400, 'HARAJ_AUCTIONEER_BACKUP_INVALID', 'Backup auctioneer must be a different person');
    }
  }

  const start = new Date(session.scheduled_start_at);
  const end = new Date(session.scheduled_end_at);
  await assertAuctioneerFree(client, { auctioneerUserId: auctioneer, start, end });

  const { rows } = await client.query(
    `INSERT INTO haraj_room_sessions (
        haraj_session_id, room_id, status, auctioneer_user_id, backup_auctioneer_user_id
     ) VALUES ($1, $2, 'idle', $3, $4)
     ON CONFLICT (haraj_session_id, room_id) DO NOTHING
     RETURNING *`,
    [sessionId, room.id, auctioneer, backupAuctioneerUserId || null],
  );
  let attached = rows[0];
  if (!attached) {
    const again = await client.query(
      `SELECT * FROM haraj_room_sessions WHERE haraj_session_id = $1 AND room_id = $2`,
      [sessionId, room.id],
    );
    attached = again.rows[0];
  } else {
    await audit(client, {
      entityType: 'haraj_room_session',
      entityId: attached.id,
      eventType: 'haraj.room_session.created',
      actorUserId,
      payload: {
        sessionId,
        roomId: room.id,
        auctioneerUserId: auctioneer,
        category: room.categoryCode,
        status: 'idle',
        liveActivated: false,
        queueAssigned: false,
        idempotencyKey: idempotencyKey || null,
      },
    });
  }
  return {
    session: await getSession(client, sessionId),
    roomSession: mapRoomSession(attached),
  };
}

async function assignAuctioneer(client, {
  roomSessionId,
  auctioneerUserId,
  backupAuctioneerUserId,
  store,
  claimedAuctioneerId,
  actorUserId,
}) {
  const { rows } = await client.query(
    `SELECT rs.*, s.status AS session_status, s.scheduled_start_at, s.scheduled_end_at
     FROM haraj_room_sessions rs
     JOIN haraj_sessions s ON s.id = rs.haraj_session_id
     WHERE rs.id = $1
     FOR UPDATE`,
    [roomSessionId],
  );
  if (!rows[0]) fail(404, 'HARAJ_ROOM_SESSION_NOT_FOUND', 'Room session not found');
  const current = rows[0];
  if (!canEditSession(current.session_status)) {
    fail(409, 'HARAJ_SESSION_IMMUTABLE', 'Cannot change auctioneer after session is operational');
  }
  const auctioneer = assertAuctioneer(store, auctioneerUserId, claimedAuctioneerId);
  await assertAuctioneerFree(client, {
    auctioneerUserId: auctioneer,
    start: new Date(current.scheduled_start_at),
    end: new Date(current.scheduled_end_at),
    exceptRoomSessionId: roomSessionId,
  });
  await client.query(
    `UPDATE haraj_room_sessions
     SET auctioneer_user_id = $2,
         backup_auctioneer_user_id = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [roomSessionId, auctioneer, backupAuctioneerUserId || null],
  );
  await audit(client, {
    entityType: 'haraj_room_session',
    entityId: roomSessionId,
    eventType: 'haraj.auctioneer.assigned',
    actorUserId,
    payload: {
      from: current.auctioneer_user_id,
      to: auctioneer,
      backupAuctioneerUserId: backupAuctioneerUserId || null,
    },
  });
  return getSession(client, current.haraj_session_id);
}

async function listEligibleLots(pool, { species, limit = 50 } = {}) {
  if (species) assertCategoryCode(species);
  return listQueue(pool, { bucket: 'accepted', species, limit });
}

async function assertLotFitsRoom(client, { auctionId, roomId }) {
  const room = await getRoom(client, roomId);
  const { rows } = await client.query(
    `SELECT id, species, status FROM auctions WHERE id = $1`,
    [auctionId],
  );
  if (!rows[0]) fail(404, 'AUCTION_NOT_FOUND', 'Lot not found');
  const lot = rows[0];
  const approved = await isAuctionApproved(client, auctionId);
  if (!approved || lot.status !== 'review') {
    fail(409, 'HARAJ_LOT_NOT_APPROVED', 'Only G4-approved lots are eligible for Haraj rooms');
  }
  if (lot.species !== room.categoryCode) {
    fail(409, 'HARAJ_CATEGORY_MISMATCH', 'Lot species is not compatible with this room');
  }
  return {
    eligible: true,
    auctionId: lot.id,
    species: lot.species,
    roomId: room.id,
    roomCategory: room.categoryCode,
    queueAssigned: false,
    activeLotAssigned: false,
  };
}

module.exports = {
  DEFAULT_TZ,
  CATEGORY_CODES,
  SESSION_EDITABLE,
  overlaps,
  canEditSession,
  assertTimezone,
  assertCategoryCode,
  assertTimeRange,
  parseTime,
  correlationId,
  ensureCategories,
  listCategories,
  listSessions,
  getSession,
  createSession,
  updateSession,
  cancelSession,
  listRooms,
  getRoom,
  createRoom,
  updateRoom,
  attachRoom,
  assignAuctioneer,
  listEligibleLots,
  assertLotFitsRoom,
  assertAuctioneerFree,
  audit,
  lockSession,
};
