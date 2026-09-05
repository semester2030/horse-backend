'use strict';

/**
 * G6 Scheduling Engine — policy → occurrences → G5 HarajSession/RoomSession.
 * Backend is authoritative. Does not implement G7 Lot Core or G8 live rooms.
 */

const { createClock, systemClock } = require('./haraj_clock');
const calc = require('./haraj_schedule_calc');
const rooms = require('./haraj_session_room');
const { isHarajAuctioneer, applyStagingAuctioneerBootstrap } = require('./haraj_auctioneer_auth');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OVERRIDE_TYPES = {
  CANCEL: 'cancel_session',
  CHANGE_TIME: 'change_time',
  EXTRA_SESSION: 'extra_session',
  CLOSE_ROOM: 'close_room_day',
  EXTEND: 'extend_session',
  REASSIGN_AUCTIONEER: 'reassign_auctioneer',
  EMERGENCY_HOLD: 'emergency_hold',
};

const OVERRIDE_ALIASES = {
  cancel: OVERRIDE_TYPES.CANCEL,
  cancel_session: OVERRIDE_TYPES.CANCEL,
  change_time: OVERRIDE_TYPES.CHANGE_TIME,
  extra_session: OVERRIDE_TYPES.EXTRA_SESSION,
  close_room: OVERRIDE_TYPES.CLOSE_ROOM,
  close_room_day: OVERRIDE_TYPES.CLOSE_ROOM,
  extend: OVERRIDE_TYPES.EXTEND,
  extend_session: OVERRIDE_TYPES.EXTEND,
  reassign_auctioneer: OVERRIDE_TYPES.REASSIGN_AUCTIONEER,
  emergency_hold: OVERRIDE_TYPES.EMERGENCY_HOLD,
};

const SKIP_MATERIALIZE = new Set([
  OVERRIDE_TYPES.CANCEL,
  OVERRIDE_TYPES.CLOSE_ROOM,
  OVERRIDE_TYPES.EMERGENCY_HOLD,
]);

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

function assertPolicyId(policyId) {
  if (!UUID_RE.test(String(policyId || ''))) {
    fail(404, 'HARAJ_POLICY_NOT_FOUND', 'Policy not found');
  }
}

function defaultHorizonDays() {
  const n = Number(process.env.HARAJ_SCHEDULE_HORIZON_DAYS || 14);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 30) : 14;
}

function schedulerIntervalMs() {
  const n = Number(process.env.HARAJ_SCHEDULE_INTERVAL_MS || 300000);
  return Number.isFinite(n) && n >= 10000 ? n : 300000;
}

function asDateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function asTime(value) {
  if (value == null || value === '') return null;
  const raw = String(value);
  if (/^\d{2}:\d{2}:\d{2}/.test(raw)) return raw.slice(0, 8);
  if (/^\d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
  return raw;
}

function sameInstant(a, b) {
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

function mapPolicy(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    roomCode: row.room_code || null,
    categoryId: row.category_id || null,
    categoryCode: row.category_code || null,
    version: row.version,
    recurrence: row.recurrence,
    recurrenceInterval: row.recurrence_interval,
    daysOfWeek: row.days_of_week,
    startTimeLocal: asTime(row.start_time_local),
    endTimeLocal: asTime(row.end_time_local),
    timezone: row.timezone,
    oneTimeDate: asDateOnly(row.one_time_date),
    customRrule: row.custom_rrule,
    effectiveFrom: asDateOnly(row.effective_from),
    effectiveUntil: asDateOnly(row.effective_until),
    enabled: row.enabled,
    capacityLots: row.capacity_lots,
    auctioneerAssignmentRule: row.auctioneer_assignment_rule,
    defaultAuctioneerUserId: row.default_auctioneer_user_id,
    status: row.status,
    createdByAdminId: row.created_by_admin_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOverride(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    policyId: row.policy_id,
    overrideType: row.override_type,
    targetSessionId: row.target_session_id,
    originalStartAt: row.original_start_at,
    originalEndAt: row.original_end_at,
    overrideStartAt: row.override_start_at,
    overrideEndAt: row.override_end_at,
    newAuctioneerUserId: row.new_auctioneer_user_id,
    reason: row.reason,
    payload: row.payload || {},
    createdByAdminId: row.created_by_admin_id,
    createdAt: row.created_at,
  };
}

function policyCalcInput(row) {
  return {
    recurrence: row.recurrence,
    recurrenceInterval: row.recurrence_interval ?? row.recurrenceInterval,
    daysOfWeek: row.days_of_week ?? row.daysOfWeek,
    startTime: asTime(row.start_time_local || row.startTimeLocal),
    endTime: asTime(row.end_time_local || row.endTimeLocal),
    timezone: row.timezone,
    effectiveFrom: asDateOnly(row.effective_from || row.effectiveFrom),
    effectiveUntil: asDateOnly(row.effective_until || row.effectiveUntil),
    oneTimeDate: asDateOnly(row.one_time_date || row.oneTimeDate),
    customRrule: row.custom_rrule || row.customRrule,
  };
}

function rowToBody(row) {
  return {
    roomId: row.room_id,
    recurrence: row.recurrence,
    recurrenceInterval: row.recurrence_interval,
    daysOfWeek: row.days_of_week,
    startTimeLocal: asTime(row.start_time_local),
    endTimeLocal: asTime(row.end_time_local),
    timezone: row.timezone,
    oneTimeDate: asDateOnly(row.one_time_date),
    customRrule: row.custom_rrule,
    effectiveFrom: asDateOnly(row.effective_from),
    effectiveUntil: asDateOnly(row.effective_until),
    enabled: row.enabled,
    capacityLots: row.capacity_lots,
    auctioneerAssignmentRule: row.auctioneer_assignment_rule,
    defaultAuctioneerUserId: row.default_auctioneer_user_id,
  };
}

function assertAuctioneer(store, userId) {
  const id = String(userId || '').trim();
  if (!id) fail(400, 'HARAJ_AUCTIONEER_REQUIRED', 'Auctioneer is required to materialize a room occurrence');
  const raw = store?.users?.get?.(id) || { id, capabilities: [] };
  const user = applyStagingAuctioneerBootstrap({ ...raw, id });
  if (!isHarajAuctioneer(user, id)) {
    fail(400, 'HARAJ_AUCTIONEER_INVALID', 'Assigned user is not an authorized auctioneer');
  }
  return id;
}

function buildPolicyRow(body, actorUserId) {
  if (body.createdBy || body.created_by) {
    fail(403, 'HARAJ_ACTOR_FORBIDDEN', 'Client-supplied createdBy is not authoritative');
  }
  const roomId = String(body.roomId || body.room_id || '').trim();
  if (!roomId) fail(400, 'HARAJ_ROOM_REQUIRED', 'roomId is required');
  const requested = String(body.recurrence || '').trim().toLowerCase();
  const normalized = calc.normalizePolicy({
    recurrence: body.recurrence,
    recurrenceInterval: body.recurrenceInterval ?? body.recurrence_interval,
    daysOfWeek: body.daysOfWeek ?? body.days_of_week,
    startTime: body.startTimeLocal || body.startTime || body.start_time_local,
    endTime: body.endTimeLocal || body.endTime || body.end_time_local,
    timezone: body.timezone,
    effectiveFrom: body.effectiveFrom || body.effective_from,
    effectiveUntil: body.effectiveUntil || body.effective_until,
    oneTimeDate: body.oneTimeDate || body.one_time_date,
    customRrule: body.customRrule || body.custom_rrule,
  });
  const rule = String(body.auctioneerAssignmentRule || body.auctioneer_assignment_rule || 'admin_manual_per_session');
  if (!['fixed_user', 'pool_round_robin', 'admin_manual_per_session'].includes(rule)) {
    fail(400, 'HARAJ_ASSIGNMENT_RULE_INVALID', 'Invalid auctioneer assignment rule');
  }
  return {
    roomId,
    recurrence: requested === 'custom_rrule' ? 'custom_rrule' : normalized.recurrence,
    recurrenceInterval: normalized.recurrenceInterval,
    daysOfWeek: normalized.daysOfWeek,
    startTimeLocal: normalized.startTimeLocal,
    endTimeLocal: normalized.endTimeLocal,
    timezone: normalized.timezone,
    oneTimeDate: normalized.oneTimeDate,
    customRrule: body.customRrule || body.custom_rrule || null,
    effectiveFrom: normalized.effectiveFrom,
    effectiveUntil: normalized.effectiveUntil,
    enabled: body.enabled !== false,
    capacityLots: body.capacityLots || body.capacity_lots || null,
    auctioneerAssignmentRule: rule,
    defaultAuctioneerUserId: body.defaultAuctioneerUserId || body.default_auctioneer_user_id || null,
    createdBy: actorUserId || 'admin',
  };
}

const POLICY_SELECT = `
  SELECT p.*, r.code AS room_code, r.category_id, c.code AS category_code
  FROM haraj_room_schedule_policies p
  JOIN haraj_rooms r ON r.id = p.room_id
  JOIN haraj_categories c ON c.id = r.category_id
`;

async function lockPolicy(client, policyId) {
  assertPolicyId(policyId);
  const { rows } = await client.query(`${POLICY_SELECT} WHERE p.id = $1 FOR UPDATE`, [policyId]);
  if (!rows[0]) fail(404, 'HARAJ_POLICY_NOT_FOUND', 'Policy not found');
  return rows[0];
}

async function getPolicy(client, policyId) {
  assertPolicyId(policyId);
  const { rows } = await client.query(`${POLICY_SELECT} WHERE p.id = $1`, [policyId]);
  if (!rows[0]) fail(404, 'HARAJ_POLICY_NOT_FOUND', 'Policy not found');
  return mapPolicy(rows[0]);
}

async function listPolicies(client, { roomId, status } = {}) {
  const params = [];
  const clauses = [];
  let n = 1;
  if (roomId) {
    clauses.push(`p.room_id = $${n++}`);
    params.push(roomId);
  }
  if (status) {
    clauses.push(`p.status = $${n++}`);
    params.push(status);
  }
  const { rows } = await client.query(
    `${POLICY_SELECT}
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY c.sort_order ASC, r.sort_order ASC, p.created_at DESC`,
    params,
  );
  return rows.map(mapPolicy);
}

async function createPolicy(client, { body, actorUserId, store }) {
  const row = buildPolicyRow(body, actorUserId);
  const room = await rooms.getRoom(client, row.roomId);
  if (row.defaultAuctioneerUserId) assertAuctioneer(store, row.defaultAuctioneerUserId);
  if (row.auctioneerAssignmentRule === 'fixed_user' && !row.defaultAuctioneerUserId) {
    fail(400, 'HARAJ_AUCTIONEER_REQUIRED', 'fixed_user policies require defaultAuctioneerUserId');
  }

  const existing = await client.query(
    `SELECT id FROM haraj_room_schedule_policies WHERE room_id = $1 AND status = 'active' FOR UPDATE`,
    [row.roomId],
  );
  if (existing.rows[0] && row.enabled) {
    await client.query(
      `UPDATE haraj_room_schedule_policies
       SET status = 'superseded', enabled = false, updated_at = NOW()
       WHERE id = $1`,
      [existing.rows[0].id],
    );
  }

  const inserted = await client.query(
    `INSERT INTO haraj_room_schedule_policies (
        room_id, recurrence, recurrence_interval, days_of_week,
        start_time_local, end_time_local, timezone, one_time_date, custom_rrule,
        effective_from, effective_until, enabled, capacity_lots,
        auctioneer_assignment_rule, default_auctioneer_user_id,
        status, created_by_admin_id
     ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
     ) RETURNING id`,
    [
      row.roomId,
      row.recurrence,
      row.recurrenceInterval,
      row.daysOfWeek,
      row.startTimeLocal,
      row.endTimeLocal,
      row.timezone,
      row.oneTimeDate,
      row.customRrule,
      row.effectiveFrom,
      row.effectiveUntil,
      row.enabled,
      row.capacityLots,
      row.auctioneerAssignmentRule,
      row.defaultAuctioneerUserId,
      row.enabled ? 'active' : 'disabled',
      row.createdBy,
    ],
  );

  if (existing.rows[0] && row.enabled) {
    await client.query(
      `UPDATE haraj_room_schedule_policies
       SET superseded_by_policy_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [existing.rows[0].id, inserted.rows[0].id],
    );
    await rooms.audit(client, {
      entityType: 'haraj_room_schedule_policy',
      entityId: existing.rows[0].id,
      eventType: 'haraj.policy.superseded',
      actorUserId,
      payload: { roomId: row.roomId, supersededBy: inserted.rows[0].id, historicalSessionsMutated: false },
    });
  }

  await rooms.audit(client, {
    entityType: 'haraj_room_schedule_policy',
    entityId: inserted.rows[0].id,
    eventType: 'haraj.policy.created',
    actorUserId,
    payload: {
      roomId: row.roomId,
      recurrence: row.recurrence,
      timezone: row.timezone,
      category: room.categoryCode,
    },
  });
  return getPolicy(client, inserted.rows[0].id);
}

async function updatePolicy(client, { policyId, body, actorUserId, store }) {
  const current = await lockPolicy(client, policyId);
  if (current.status === 'superseded') {
    fail(409, 'HARAJ_POLICY_IMMUTABLE', 'Superseded policies cannot be edited');
  }
  const row = buildPolicyRow({ ...rowToBody(current), ...body, roomId: current.room_id }, actorUserId);
  if (row.roomId !== current.room_id) fail(400, 'HARAJ_POLICY_ROOM_IMMUTABLE', 'Cannot move a policy to another room');
  if (row.defaultAuctioneerUserId) assertAuctioneer(store, row.defaultAuctioneerUserId);
  await client.query(
    `UPDATE haraj_room_schedule_policies SET
        recurrence = $2, recurrence_interval = $3, days_of_week = $4,
        start_time_local = $5, end_time_local = $6, timezone = $7,
        one_time_date = $8, custom_rrule = $9, effective_from = $10, effective_until = $11,
        capacity_lots = $12, auctioneer_assignment_rule = $13,
        default_auctioneer_user_id = $14, version = version + 1, updated_at = NOW()
     WHERE id = $1`,
    [
      policyId,
      row.recurrence,
      row.recurrenceInterval,
      row.daysOfWeek,
      row.startTimeLocal,
      row.endTimeLocal,
      row.timezone,
      row.oneTimeDate,
      row.customRrule,
      row.effectiveFrom,
      row.effectiveUntil,
      row.capacityLots,
      row.auctioneerAssignmentRule,
      row.defaultAuctioneerUserId,
    ],
  );
  await rooms.audit(client, {
    entityType: 'haraj_room_schedule_policy',
    entityId: policyId,
    eventType: 'haraj.policy.updated',
    actorUserId,
    payload: {
      fromRecurrence: current.recurrence,
      toRecurrence: row.recurrence,
      historicalSessionsMutated: false,
      materializedFutureRewritten: false,
    },
  });
  return getPolicy(client, policyId);
}

async function setPolicyEnabled(client, { policyId, enabled, actorUserId }) {
  const current = await lockPolicy(client, policyId);
  if (enabled) {
    const other = await client.query(
      `SELECT id FROM haraj_room_schedule_policies
       WHERE room_id = $1 AND status = 'active' AND id <> $2`,
      [current.room_id, policyId],
    );
    if (other.rows[0]) fail(409, 'HARAJ_POLICY_ACTIVE_EXISTS', 'Room already has an active policy');
  }
  await client.query(
    `UPDATE haraj_room_schedule_policies
     SET enabled = $2, status = $3, updated_at = NOW()
     WHERE id = $1`,
    [policyId, enabled, enabled ? 'active' : 'disabled'],
  );
  await rooms.audit(client, {
    entityType: 'haraj_room_schedule_policy',
    entityId: policyId,
    eventType: enabled ? 'haraj.policy.enabled' : 'haraj.policy.disabled',
    actorUserId,
    payload: { futureSessionsDeleted: false, historicalSessionsDeleted: false },
  });
  return getPolicy(client, policyId);
}

function serializeOccurrences(list) {
  return list.map((o) => ({
    localDate: o.localDate,
    startAt: o.startAt.toISOString(),
    endAt: o.endAt.toISOString(),
    timezone: o.timezone,
    occurrenceKey: o.occurrenceKey,
  }));
}

function previewPolicy(row, { clock = systemClock, horizonDays } = {}) {
  const days = horizonDays || defaultHorizonDays();
  const tz = row.timezone || calc.DEFAULT_TZ;
  const range = calc.horizonRange(clock, days, tz);
  const occurrences = calc.calculateOccurrences(policyCalcInput(row), range.start, range.end);
  return {
    preview: true,
    authoritative: true,
    horizonDays: range.horizonDays,
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    timezone: tz,
    occurrences: serializeOccurrences(occurrences),
  };
}

async function listOverrides(client, { policyId, roomId } = {}) {
  const params = [];
  const clauses = [];
  let n = 1;
  if (policyId) {
    clauses.push(`policy_id = $${n++}`);
    params.push(policyId);
  }
  if (roomId) {
    clauses.push(`room_id = $${n++}`);
    params.push(roomId);
  }
  const { rows } = await client.query(
    `SELECT * FROM haraj_schedule_overrides
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY created_at DESC
     LIMIT 200`,
    params,
  );
  return rows.map(mapOverride);
}

function matchingOverrides(overrides, startAt) {
  return overrides.filter((o) => sameInstant(o.original_start_at || o.originalStartAt, startAt));
}

async function findSessionByOccurrence(client, policyId, originalStartAt) {
  const iso = new Date(originalStartAt).toISOString();
  const direct = await client.query(
    `SELECT s.*, c.code AS category_code
     FROM haraj_sessions s
     JOIN haraj_categories c ON c.id = s.category_id
     WHERE s.policy_id = $1 AND s.scheduled_start_at = $2
     LIMIT 1`,
    [policyId, iso],
  );
  if (direct.rows[0]) return direct.rows[0];

  const viaTarget = await client.query(
    `SELECT s.*, c.code AS category_code
     FROM haraj_schedule_overrides o
     JOIN haraj_sessions s ON s.id = o.target_session_id
     JOIN haraj_categories c ON c.id = s.category_id
     WHERE o.policy_id = $1 AND o.original_start_at = $2
     LIMIT 1`,
    [policyId, iso],
  );
  if (viaTarget.rows[0]) return viaTarget.rows[0];

  const viaOverrideTime = await client.query(
    `SELECT s.*, c.code AS category_code
     FROM haraj_schedule_overrides o
     JOIN haraj_sessions s
       ON s.policy_id = o.policy_id
      AND s.scheduled_start_at = o.override_start_at
     JOIN haraj_categories c ON c.id = s.category_id
     WHERE o.policy_id = $1 AND o.original_start_at = $2
     LIMIT 1`,
    [policyId, iso],
  );
  return viaOverrideTime.rows[0] || null;
}

async function linkOverrideSession(client, overrideId, sessionId) {
  if (!overrideId || !sessionId) return;
  await client.query(
    `UPDATE haraj_schedule_overrides SET target_session_id = $2 WHERE id = $1 AND target_session_id IS DISTINCT FROM $2`,
    [overrideId, sessionId],
  );
}

async function roomWindowTaken(client, { roomId, start, end, exceptSessionId }) {
  const { rows } = await client.query(
    `SELECT s.id
     FROM haraj_sessions s
     JOIN haraj_room_sessions rs ON rs.haraj_session_id = s.id
     WHERE rs.room_id = $1
       AND s.status NOT IN ('cancelled', 'closed', 'archived')
       AND s.scheduled_start_at < $3
       AND s.scheduled_end_at > $2
       AND ($4::uuid IS NULL OR s.id <> $4)
     LIMIT 1`,
    [roomId, new Date(start).toISOString(), new Date(end).toISOString(), exceptSessionId || null],
  );
  return rows[0] || null;
}

async function upsertOccurrence(client, {
  policy,
  originalStartAt,
  startAt,
  endAt,
  store,
  actorUserId,
  generationSource = 'scheduler',
  overrideId = null,
}) {
  const roomId = policy.room_id || policy.roomId;
  const lookupStart = originalStartAt || startAt;
  let session = await findSessionByOccurrence(client, policy.id, lookupStart);
  const auctioneer = assertAuctioneer(store, policy.default_auctioneer_user_id || policy.defaultAuctioneerUserId);

  const existingRoom = session
    ? await client.query(
      `SELECT id FROM haraj_room_sessions WHERE haraj_session_id = $1 AND room_id = $2`,
      [session.id, roomId],
    )
    : { rows: [] };

  if (!session) {
    const taken = await roomWindowTaken(client, { roomId, start: startAt, end: endAt });
    if (taken) {
      fail(409, 'HARAJ_ROOM_OCCURRENCE_EXISTS', 'Room already has a non-cancelled session in this window');
    }
    await rooms.assertAuctioneerFree(client, {
      auctioneerUserId: auctioneer,
      start: new Date(startAt),
      end: new Date(endAt),
    });
    const created = await client.query(
      `INSERT INTO haraj_sessions (
          category_id, policy_id, override_id, scheduled_start_at, scheduled_end_at,
          timezone, status, generation_source
       ) VALUES ($1,$2,$3,$4,$5,$6,'planned',$7)
       RETURNING *`,
      [
        policy.category_id,
        policy.id,
        overrideId,
        new Date(startAt).toISOString(),
        new Date(endAt).toISOString(),
        policy.timezone,
        generationSource,
      ],
    );
    session = created.rows[0];
    await rooms.audit(client, {
      entityType: 'haraj_session',
      entityId: session.id,
      eventType: 'haraj.session.materialized',
      actorUserId,
      payload: {
        policyId: policy.id,
        roomId,
        generationSource,
        recurrenceEngine: true,
        originalStartAt: new Date(lookupStart).toISOString(),
      },
    });
  } else if (
    rooms.canEditSession(session.status) &&
    (!sameInstant(session.scheduled_start_at, startAt) || !sameInstant(session.scheduled_end_at, endAt))
  ) {
    await rooms.assertAuctioneerFree(client, {
      auctioneerUserId: auctioneer,
      start: new Date(startAt),
      end: new Date(endAt),
      exceptRoomSessionId: existingRoom.rows[0]?.id || null,
    });
    await rooms.updateSession(client, {
      sessionId: session.id,
      scheduledStartAt: startAt,
      scheduledEndAt: endAt,
      actorUserId,
    });
    session = await (await client.query(
      `SELECT s.*, c.code AS category_code
       FROM haraj_sessions s JOIN haraj_categories c ON c.id = s.category_id
       WHERE s.id = $1`,
      [session.id],
    )).rows[0];
  }

  const roomRow = existingRoom.rows[0]
    ? existingRoom
    : await client.query(
      `SELECT id FROM haraj_room_sessions WHERE haraj_session_id = $1 AND room_id = $2`,
      [session.id, roomId],
    );
  if (!roomRow.rows[0]) {
    await rooms.attachRoom(client, {
      sessionId: session.id,
      roomId,
      auctioneerUserId: auctioneer,
      store,
      actorUserId,
    });
  }
  await linkOverrideSession(client, overrideId, session.id);
  return rooms.getSession(client, session.id);
}

async function applyReassign(client, { session, roomId, auctioneerUserId, store, actorUserId }) {
  if (!session || !auctioneerUserId) return;
  const rs = await client.query(
    `SELECT id FROM haraj_room_sessions WHERE haraj_session_id = $1 AND room_id = $2`,
    [session.id, roomId],
  );
  if (!rs.rows[0]) return;
  await rooms.assignAuctioneer(client, {
    roomSessionId: rs.rows[0].id,
    auctioneerUserId,
    store,
    actorUserId,
  });
}

async function materializePolicy(client, {
  policyId,
  store,
  actorUserId,
  clock = systemClock,
  horizonDays,
}) {
  const policy = await lockPolicy(client, policyId);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`haraj:g6:policy:${policy.id}`]);
  if (!policy.enabled || policy.status !== 'active') {
    return { policyId: policy.id, skipped: 'disabled', created: 0, existing: 0, cancelled: 0, errors: [] };
  }
  if (!policy.default_auctioneer_user_id) {
    return {
      policyId: policy.id,
      skipped: 'HARAJ_AUCTIONEER_REQUIRED',
      created: 0,
      existing: 0,
      cancelled: 0,
      errors: ['HARAJ_AUCTIONEER_REQUIRED'],
    };
  }

  const range = calc.horizonRange(clock, horizonDays || defaultHorizonDays(), policy.timezone);
  const candidates = calc.calculateOccurrences(policyCalcInput(policy), range.start, range.end);
  const overrideRows = await client.query(
    `SELECT * FROM haraj_schedule_overrides WHERE policy_id = $1 OR room_id = $2`,
    [policy.id, policy.room_id],
  );
  const ovs = overrideRows.rows;
  const now = clock.now();
  let created = 0;
  let existing = 0;
  let cancelled = 0;
  const errors = [];
  const sessions = [];

  for (const occ of candidates) {
    if (occ.endAt <= now) continue;
    const key = `haraj:g6:${policy.id}:${occ.occurrenceKey}`;
    try {
      await client.query('SAVEPOINT occ');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
      const matched = matchingOverrides(ovs, occ.startAt);
      const skip = matched.find((o) => SKIP_MATERIALIZE.has(o.override_type));
      const change = matched.find((o) => o.override_type === OVERRIDE_TYPES.CHANGE_TIME);
      const extend = matched.find((o) => o.override_type === OVERRIDE_TYPES.EXTEND);
      const reassign = matched.find((o) => o.override_type === OVERRIDE_TYPES.REASSIGN_AUCTIONEER);
      if (skip) {
        const found = await findSessionByOccurrence(client, policy.id, occ.startAt);
        if (found && found.status !== 'cancelled') {
          await rooms.cancelSession(client, {
            sessionId: found.id,
            reason: skip.reason || skip.override_type,
            actorUserId,
          });
          cancelled += 1;
        }
        await client.query('RELEASE SAVEPOINT occ');
        continue;
      }
      let startAt = occ.startAt;
      let endAt = occ.endAt;
      if (change) {
        startAt = new Date(change.override_start_at);
        endAt = new Date(change.override_end_at);
      }
      if (extend) {
        endAt = new Date(extend.override_end_at);
      }
      const before = await findSessionByOccurrence(client, policy.id, occ.startAt);
      const session = await upsertOccurrence(client, {
        policy,
        originalStartAt: occ.startAt,
        startAt,
        endAt,
        store,
        actorUserId,
        overrideId: change?.id || extend?.id || null,
      });
      if (reassign?.new_auctioneer_user_id) {
        await applyReassign(client, {
          session,
          roomId: policy.room_id,
          auctioneerUserId: reassign.new_auctioneer_user_id,
          store,
          actorUserId,
        });
      }
      if (before) existing += 1;
      else created += 1;
      sessions.push(session);
      await client.query('RELEASE SAVEPOINT occ');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT occ');
      errors.push({ occurrenceKey: occ.occurrenceKey, code: err.code || 'ERROR', message: err.message });
    }
  }

  for (const extra of ovs.filter((o) => o.override_type === OVERRIDE_TYPES.EXTRA_SESSION && o.policy_id === policy.id)) {
    try {
      await client.query('SAVEPOINT extra');
      const session = await upsertOccurrence(client, {
        policy,
        originalStartAt: extra.override_start_at,
        startAt: extra.override_start_at,
        endAt: extra.override_end_at,
        store,
        actorUserId,
        generationSource: 'override_extra',
        overrideId: extra.id,
      });
      sessions.push(session);
      await client.query('RELEASE SAVEPOINT extra');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT extra');
      errors.push({ occurrenceKey: `extra:${extra.id}`, code: err.code || 'ERROR', message: err.message });
    }
  }

  return {
    policyId: policy.id,
    roomId: policy.room_id,
    created,
    existing,
    cancelled,
    errors,
    occurrenceCount: sessions.length,
    sessions: sessions.map((s) => ({
      id: s.id,
      start: s.scheduledStartAt,
      status: s.status,
      rooms: s.rooms?.length || 0,
      policyId: s.policyId,
    })),
  };
}

async function runScheduler(client, { store, actorUserId = 'system-scheduler', clock = systemClock, horizonDays } = {}) {
  const { rows: lock } = await client.query(
    `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`,
    ['haraj:g6:scheduler'],
  );
  if (!lock[0]?.ok) return { skipped: true, reason: 'lock_held', results: [] };

  const policies = await client.query(
    `${POLICY_SELECT}
     WHERE p.enabled = true AND p.status = 'active'
     ORDER BY r.sort_order ASC`,
  );
  const results = [];
  for (const policy of policies.rows) {
    results.push(await materializePolicy(client, {
      policyId: policy.id,
      store,
      actorUserId,
      clock,
      horizonDays,
    }));
  }
  if (policies.rows[0]) {
    await rooms.audit(client, {
      entityType: 'haraj_room_schedule_policy',
      entityId: policies.rows[0].id,
      eventType: 'haraj.scheduler.run',
      actorUserId,
      actorRole: 'scheduler',
      payload: {
        policies: results.length,
        created: results.reduce((n, r) => n + (r.created || 0), 0),
        existing: results.reduce((n, r) => n + (r.existing || 0), 0),
        horizonDays: horizonDays || defaultHorizonDays(),
      },
    });
  }
  return { skipped: false, results };
}

async function createOverride(client, { body, actorUserId, store }) {
  if (body.createdBy || body.created_by) {
    fail(403, 'HARAJ_ACTOR_FORBIDDEN', 'Client-supplied createdBy is not authoritative');
  }
  const type = OVERRIDE_ALIASES[String(body.overrideType || body.type || '').toLowerCase()];
  if (!type) fail(400, 'HARAJ_OVERRIDE_TYPE_INVALID', 'Unsupported override type');
  const reason = String(body.reason || '').trim();
  if (!reason) fail(400, 'HARAJ_REASON_REQUIRED', 'Override reason is required');
  const policy = body.policyId ? await lockPolicy(client, body.policyId) : null;
  const roomId = body.roomId || policy?.room_id;
  if (!roomId) fail(400, 'HARAJ_ROOM_REQUIRED', 'roomId or policyId is required');
  if (policy && body.roomId && String(body.roomId) !== String(policy.room_id)) {
    fail(409, 'HARAJ_OVERRIDE_CROSS_ROOM', 'Override room does not match policy room');
  }

  let originalStart = body.originalStartAt || body.occurrenceStartAt || null;
  let originalEnd = body.originalEndAt || null;
  let session = null;
  if (body.sessionId) {
    session = await rooms.lockSession(client, body.sessionId);
    originalStart = originalStart || session.scheduled_start_at;
    originalEnd = originalEnd || session.scheduled_end_at;
    if (session.policy_id && policy && session.policy_id !== policy.id) {
      fail(409, 'HARAJ_OVERRIDE_CROSS_POLICY', 'Session does not belong to this policy');
    }
  }

  const replayKey = originalStart || body.overrideStartAt || null;
  const existing = await client.query(
    `SELECT * FROM haraj_schedule_overrides
     WHERE room_id = $1 AND override_type = $2
       AND COALESCE(policy_id::text,'') = COALESCE($3::text,'')
       AND COALESCE(original_start_at, override_start_at) IS NOT DISTINCT FROM $4::timestamptz
     ORDER BY created_at DESC LIMIT 1`,
    [roomId, type, policy?.id || null, replayKey],
  );
  if (existing.rows[0] && type !== OVERRIDE_TYPES.EXTRA_SESSION) {
    return { override: mapOverride(existing.rows[0]), replayed: true };
  }
  if (existing.rows[0] && type === OVERRIDE_TYPES.EXTRA_SESSION) {
    return { override: mapOverride(existing.rows[0]), replayed: true };
  }

  let overrideStart = body.overrideStartAt || null;
  let overrideEnd = body.overrideEndAt || null;
  let newAuctioneer = body.auctioneerUserId || body.newAuctioneerUserId || null;

  if (type === OVERRIDE_TYPES.CHANGE_TIME) {
    if (!overrideStart || !overrideEnd) fail(400, 'HARAJ_TIME_INVALID', 'CHANGE_TIME requires overrideStartAt and overrideEndAt');
    if (!(new Date(overrideEnd) > new Date(overrideStart))) {
      fail(400, 'HARAJ_TIME_RANGE_INVALID', 'overrideEndAt must be after overrideStartAt');
    }
  }
  if (type === OVERRIDE_TYPES.EXTEND) {
    const start = originalStart || session?.scheduled_start_at;
    overrideEnd = overrideEnd || body.scheduledEndAt;
    if (!start || !overrideEnd) fail(400, 'HARAJ_TIME_INVALID', 'EXTEND requires a new end time');
    if (!(new Date(overrideEnd) > new Date(start))) {
      fail(400, 'HARAJ_TIME_RANGE_INVALID', 'Extended end must be after start');
    }
    overrideStart = start;
  }
  if (type === OVERRIDE_TYPES.EXTRA_SESSION) {
    if (!overrideStart || !overrideEnd) fail(400, 'HARAJ_TIME_INVALID', 'EXTRA_SESSION requires start and end');
    if (!(new Date(overrideEnd) > new Date(overrideStart))) {
      fail(400, 'HARAJ_TIME_RANGE_INVALID', 'Extra session end must be after start');
    }
  }
  if (type === OVERRIDE_TYPES.REASSIGN_AUCTIONEER) {
    newAuctioneer = assertAuctioneer(store, newAuctioneer);
  }

  const inserted = await client.query(
    `INSERT INTO haraj_schedule_overrides (
        room_id, policy_id, override_type, target_session_id,
        original_start_at, original_end_at, override_start_at, override_end_at,
        new_auctioneer_user_id, reason, payload, created_by_admin_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
     RETURNING *`,
    [
      roomId,
      policy?.id || session?.policy_id || null,
      type,
      session?.id || null,
      originalStart,
      originalEnd,
      overrideStart,
      overrideEnd,
      newAuctioneer,
      reason,
      JSON.stringify({
        occurrenceKey: body.occurrenceKey || null,
        policyUnchanged: true,
      }),
      actorUserId || 'admin',
    ],
  );
  const override = inserted.rows[0];

  if (session && SKIP_MATERIALIZE.has(type)) {
    if (session.status !== 'cancelled') {
      await rooms.cancelSession(client, { sessionId: session.id, reason, actorUserId });
    }
  } else if (session && type === OVERRIDE_TYPES.CHANGE_TIME) {
    await rooms.updateSession(client, {
      sessionId: session.id,
      scheduledStartAt: overrideStart,
      scheduledEndAt: overrideEnd,
      actorUserId,
    });
  } else if (session && type === OVERRIDE_TYPES.EXTEND) {
    await rooms.updateSession(client, {
      sessionId: session.id,
      scheduledEndAt: overrideEnd,
      actorUserId,
    });
  } else if (session && type === OVERRIDE_TYPES.REASSIGN_AUCTIONEER) {
    await applyReassign(client, {
      session: { id: session.id },
      roomId,
      auctioneerUserId: newAuctioneer,
      store,
      actorUserId,
    });
  } else if (type === OVERRIDE_TYPES.EXTRA_SESSION && policy) {
    const created = await upsertOccurrence(client, {
      policy,
      originalStartAt: overrideStart,
      startAt: overrideStart,
      endAt: overrideEnd,
      store,
      actorUserId,
      generationSource: 'override_extra',
      overrideId: override.id,
    });
    await linkOverrideSession(client, override.id, created.id);
  } else if (SKIP_MATERIALIZE.has(type) && policy && originalStart) {
    const found = await findSessionByOccurrence(client, policy.id, originalStart);
    if (found && found.status !== 'cancelled') {
      await rooms.cancelSession(client, { sessionId: found.id, reason, actorUserId });
      await linkOverrideSession(client, override.id, found.id);
    }
  }

  await rooms.audit(client, {
    entityType: 'haraj_schedule_override',
    entityId: override.id,
    eventType: `haraj.override.${type}`,
    actorUserId,
    payload: {
      type,
      roomId,
      policyId: policy?.id || null,
      sessionId: session?.id || null,
      reason,
      toAuctioneer: newAuctioneer,
      policyUnchanged: true,
    },
  });
  const fresh = await client.query(`SELECT * FROM haraj_schedule_overrides WHERE id = $1`, [override.id]);
  return { override: mapOverride(fresh.rows[0]), replayed: false };
}

async function listUpcomingSafe(client, opts) {
  const policies = opts.policyId
    ? [await (async () => {
      assertPolicyId(opts.policyId);
      const { rows } = await client.query(`${POLICY_SELECT} WHERE p.id = $1`, [opts.policyId]);
      if (!rows[0]) fail(404, 'HARAJ_POLICY_NOT_FOUND', 'Policy not found');
      return rows[0];
    })()]
    : (await client.query(
      `${POLICY_SELECT} WHERE p.enabled = true AND p.status = 'active'
       ${opts.roomId ? 'AND p.room_id = $1' : ''}
       ORDER BY r.sort_order ASC`,
      opts.roomId ? [opts.roomId] : [],
    )).rows;

  const out = [];
  for (const policy of policies) {
    const preview = previewPolicy(policy, { clock: opts.clock, horizonDays: opts.horizonDays });
    const overrides = await listOverrides(client, { policyId: policy.id });
    for (const occ of preview.occurrences) {
      const sessionRow = await findSessionByOccurrence(client, policy.id, occ.startAt);
      const matched = overrides.filter((o) => sameInstant(o.originalStartAt, occ.startAt));
      out.push({
        policyId: policy.id,
        roomId: policy.room_id,
        roomCode: policy.room_code,
        categoryCode: policy.category_code,
        recurrence: policy.recurrence,
        timezone: policy.timezone,
        ...occ,
        sessionId: sessionRow?.id || null,
        sessionStatus: sessionRow?.status || null,
        overrides: matched.map((o) => o.overrideType),
      });
    }
  }
  return out;
}

function startHarajScheduler({ store, clock = systemClock } = {}) {
  const { withTransaction } = require('../db');
  const intervalMs = schedulerIntervalMs();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    withTransaction((client) => runScheduler(client, { store, clock, actorUserId: 'system-scheduler' })).catch((err) => {
      console.error('[haraj:scheduler] tick failed:', err.message);
    });
  };
  const delay = setTimeout(tick, 15000);
  const timer = setInterval(tick, intervalMs);
  if (typeof delay.unref === 'function') delay.unref();
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[haraj:scheduler] worker started intervalMs=${intervalMs} horizonDays=${defaultHorizonDays()}`);
  return {
    intervalMs,
    stop() {
      stopped = true;
      clearTimeout(delay);
      clearInterval(timer);
    },
    runOnce: () => withTransaction((client) => runScheduler(client, { store, clock, actorUserId: 'system-scheduler' })),
  };
}

module.exports = {
  OVERRIDE_TYPES,
  defaultHorizonDays,
  schedulerIntervalMs,
  mapPolicy,
  getPolicy,
  listPolicies,
  createPolicy,
  updatePolicy,
  setPolicyEnabled,
  previewPolicy,
  listOverrides,
  createOverride,
  materializePolicy,
  runScheduler,
  listUpcoming: listUpcomingSafe,
  startHarajScheduler,
  createClock,
  asDateOnly,
  asTime,
};
