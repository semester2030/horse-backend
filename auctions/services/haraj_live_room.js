'use strict';

/**
 * G8 — Live Room Orchestration.
 * Room occurrence state machine only. Auction Core remains bid/winner authority.
 * LiveKit/broadcast is not claimed PASS.
 */

const rooms = require('./haraj_session_room');
const queue = require('./haraj_lot_queue');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TRANSITIONS = [
  { from: 'idle', action: 'ready', to: 'pre_live', role: 'assigned_auctioneer|admin', audit: 'haraj.room.ready' },
  { from: 'pre_live', action: 'start', to: 'live', role: 'assigned_auctioneer|admin', audit: 'haraj.room.live' },
  { from: 'live', action: 'pause', to: 'paused', role: 'assigned_auctioneer|admin', audit: 'haraj.room.paused' },
  { from: 'paused', action: 'resume', to: 'live', role: 'assigned_auctioneer|admin', audit: 'haraj.room.resumed' },
  { from: 'live', action: 'activate', to: 'live', role: 'assigned_auctioneer|admin', audit: 'haraj.lot.activated' },
  { from: 'live', action: 'advance', to: 'live', role: 'assigned_auctioneer|admin', audit: 'haraj.lot.completed' },
  { from: 'live', action: 'skip', to: 'live', role: 'assigned_auctioneer|admin', audit: 'haraj.lot.skipped' },
  { from: 'live', action: 'complete', to: 'closed', role: 'assigned_auctioneer|admin', audit: 'haraj.room.completed' },
  { from: 'paused', action: 'complete', to: 'closed', role: 'assigned_auctioneer|admin', audit: 'haraj.room.completed' },
  { from: 'pre_live', action: 'cancel', to: 'closed', role: 'assigned_auctioneer|admin', audit: 'haraj.room.cancelled' },
  { from: 'idle', action: 'cancel', to: 'closed', role: 'assigned_auctioneer|admin', audit: 'haraj.room.cancelled' },
];

const LIVEKIT = {
  implemented: false,
  tested: false,
  classification: 'NON-BROADCAST ORCHESTRATION — dedicated Staging LiveKit not proven; do not claim broadcast PASS',
  productionFallback: false,
};

function observe(action, snapshot, extra = {}) {
  try {
    const obs = require('./haraj_observability');
    if (action === 'ready' || action === 'start') obs.observeWs('join', {
      roomId: snapshot.roomId || extra.roomId || null,
      roomSessionId: snapshot.roomSessionId || extra.roomSessionId || null,
      sessionId: snapshot.sessionId || extra.sessionId || null,
      auctionId: snapshot.activeLotId || extra.auctionId || null,
    });
    obs.logStructured('info', 'haraj.room', {
      action,
      roomId: snapshot.roomId || extra.roomId || null,
      roomSessionId: snapshot.roomSessionId || extra.roomSessionId || null,
      sessionId: snapshot.sessionId || extra.sessionId || null,
      auctionId: snapshot.activeLotId || extra.auctionId || null,
      requestId: extra.correlationId || extra.requestId || null,
    });
  } catch {
    console.log(JSON.stringify({
      ev: 'haraj.g9',
      action,
      roomId: snapshot.roomId || extra.roomId || null,
      roomSessionId: snapshot.roomSessionId || extra.roomSessionId || null,
    }));
  }
}

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

function assertUuid(id, code = 'HARAJ_NOT_FOUND') {
  if (!UUID_RE.test(String(id || ''))) fail(404, code, 'Not found');
}

function versionOf(updatedAt) {
  const n = Date.parse(updatedAt);
  return Number.isFinite(n) ? n : 0;
}

function assertOperator(rs, { actorUserId, admin }) {
  if (admin) return;
  if (!actorUserId || String(rs.auctioneer_user_id) !== String(actorUserId)) {
    fail(403, 'HARAJ_AUCTIONEER_NOT_ASSIGNED', 'Auctioneer is not assigned to this room');
  }
}

function eventContract(type, rs, extra = {}) {
  return {
    type,
    roomSessionId: rs.id,
    sessionId: rs.session_id || rs.haraj_session_id,
    roomId: rs.room_id,
    auctionId: extra.auctionId || rs.active_lot_id || null,
    auctioneerId: rs.auctioneer_user_id,
    status: extra.status || rs.status,
    activeLotId: extra.activeLotId !== undefined ? extra.activeLotId : rs.active_lot_id,
    version: versionOf(extra.updatedAt || rs.updated_at),
    serverTimestamp: new Date().toISOString(),
    financialAuthority: false,
    bidAuthority: false,
    ...extra,
  };
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

async function getSnapshot(client, roomSessionId) {
  const rs = await queue.lockRoomSession(client, roomSessionId);
  const entries = await queue.listQueue(client, roomSessionId);
  const active = entries.find((e) => e.status === 'active') || null;
  return {
    roomSessionId: rs.id,
    sessionId: rs.session_id,
    roomId: rs.room_id,
    roomCode: rs.room_code,
    categoryCode: rs.category_code,
    status: rs.status,
    queueStatus: rs.queue_status,
    auctioneerUserId: rs.auctioneer_user_id,
    backupAuctioneerUserId: rs.backup_auctioneer_user_id,
    activeLotId: rs.active_lot_id,
    activeLot: active,
    entries,
    pausedAt: rs.paused_at,
    pausedReason: rs.paused_reason,
    updatedAt: rs.updated_at,
    version: versionOf(rs.updated_at),
    financialAuthority: false,
    bidAuthority: false,
    auctionCorePreserved: true,
    secondBidEngine: false,
    livekit: LIVEKIT,
    pauseSemantics: 'Room operational pause only. Auction Core timers are not frozen client-side or by this Gate.',
  };
}

async function setStatus(client, roomSessionId, status, extra = {}) {
  const { rows } = await client.query(
    `UPDATE haraj_room_sessions
     SET status = $2,
         queue_status = COALESCE($3, queue_status),
         paused_at = $4,
         paused_reason = $5,
         active_lot_id = COALESCE($6, active_lot_id),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      roomSessionId,
      status,
      extra.queueStatus || null,
      extra.pausedAt !== undefined ? extra.pausedAt : null,
      extra.pausedReason !== undefined ? extra.pausedReason : null,
      extra.activeLotId !== undefined ? extra.activeLotId : null,
    ],
  );
  return rows[0];
}

async function readyRoom(client, { roomSessionId, actorUserId, admin, idempotencyKey }) {
  if (idempotencyKey) {
    const prior = await findByIdempotency(client, 'haraj.room.ready', idempotencyKey);
    if (prior) return getSnapshot(client, roomSessionId);
  }
  const rs = await queue.lockRoomSession(client, roomSessionId);
  assertOperator(rs, { actorUserId, admin });
  if (rs.status === 'pre_live') return getSnapshot(client, roomSessionId);
  if (rs.status !== 'idle') fail(409, 'HARAJ_ROOM_TRANSITION_INVALID', 'Room can become ready only from idle');
  if (!rs.auctioneer_user_id) fail(409, 'HARAJ_AUCTIONEER_REQUIRED', 'A responsible human auctioneer is required');
  await client.query(
    `UPDATE haraj_room_sessions
     SET status = 'pre_live', queue_status = 'locked', updated_at = NOW()
     WHERE id = $1`,
    [roomSessionId],
  );
  await rooms.audit(client, {
    entityType: 'haraj_room_session',
    entityId: roomSessionId,
    eventType: 'haraj.room.ready',
    actorUserId,
    payload: { from: 'idle', to: 'pre_live', idempotencyKey: idempotencyKey || null },
  });
  return getSnapshot(client, roomSessionId);
}

async function startRoom(client, { roomSessionId, actorUserId, admin, idempotencyKey }) {
  if (idempotencyKey) {
    const prior = await findByIdempotency(client, 'haraj.room.live', idempotencyKey);
    if (prior) return getSnapshot(client, roomSessionId);
  }
  const rs = await queue.lockRoomSession(client, roomSessionId);
  assertOperator(rs, { actorUserId, admin });
  if (rs.status === 'live') return getSnapshot(client, roomSessionId);
  if (rs.status !== 'pre_live') fail(409, 'HARAJ_ROOM_TRANSITION_INVALID', 'Room can go live only from ready/pre_live');
  await client.query(
    `UPDATE haraj_room_sessions SET status = 'live', updated_at = NOW() WHERE id = $1`,
    [roomSessionId],
  );
  await rooms.audit(client, {
    entityType: 'haraj_room_session',
    entityId: roomSessionId,
    eventType: 'haraj.room.live',
    actorUserId,
    payload: { from: 'pre_live', to: 'live', idempotencyKey: idempotencyKey || null },
  });
  return getSnapshot(client, roomSessionId);
}

async function pauseRoom(client, { roomSessionId, reason, actorUserId, admin }) {
  const rs = await queue.lockRoomSession(client, roomSessionId);
  assertOperator(rs, { actorUserId, admin });
  if (rs.status === 'paused') return getSnapshot(client, roomSessionId);
  if (rs.status !== 'live') fail(409, 'HARAJ_ROOM_TRANSITION_INVALID', 'Only a live room can pause');
  await client.query(
    `UPDATE haraj_room_sessions
     SET status = 'paused', paused_at = NOW(), paused_reason = $2, updated_at = NOW()
     WHERE id = $1`,
    [roomSessionId, String(reason || 'paused').slice(0, 500)],
  );
  await rooms.audit(client, {
    entityType: 'haraj_room_session',
    entityId: roomSessionId,
    eventType: 'haraj.room.paused',
    actorUserId,
    payload: {
      from: 'live',
      to: 'paused',
      reason: String(reason || 'paused').slice(0, 500),
      auctionTimerFrozen: false,
    },
  });
  return getSnapshot(client, roomSessionId);
}

async function resumeRoom(client, { roomSessionId, actorUserId, admin }) {
  const rs = await queue.lockRoomSession(client, roomSessionId);
  assertOperator(rs, { actorUserId, admin });
  if (rs.status === 'live') return getSnapshot(client, roomSessionId);
  if (rs.status !== 'paused') fail(409, 'HARAJ_ROOM_TRANSITION_INVALID', 'Only a paused room can resume');
  await client.query(
    `UPDATE haraj_room_sessions
     SET status = 'live', paused_at = NULL, paused_reason = NULL, updated_at = NOW()
     WHERE id = $1`,
    [roomSessionId],
  );
  await rooms.audit(client, {
    entityType: 'haraj_room_session',
    entityId: roomSessionId,
    eventType: 'haraj.room.resumed',
    actorUserId,
    payload: { from: 'paused', to: 'live', auctionTimerChanged: false },
  });
  return getSnapshot(client, roomSessionId);
}

async function activateLot(client, { roomSessionId, auctionId, actorUserId, admin, idempotencyKey }) {
  if (!auctionId) fail(400, 'AUCTION_ID_REQUIRED', 'auctionId is required');
  if (idempotencyKey) {
    const prior = await findByIdempotency(client, 'haraj.lot.activated', idempotencyKey);
    if (prior) return getSnapshot(client, roomSessionId);
  }
  const rs = await queue.lockRoomSession(client, roomSessionId);
  assertOperator(rs, { actorUserId, admin });
  if (rs.status !== 'live') fail(409, 'HARAJ_ROOM_NOT_LIVE', 'Lot can be activated only while the room is live');
  if (rs.active_lot_id && rs.active_lot_id !== auctionId) {
    fail(409, 'HARAJ_ACTIVE_LOT_EXISTS', 'A Room may have at most one active Lot');
  }
  const lot = await queue.lockLot(client, auctionId);
  await queue.assertLotLifecycle(lot);
  const { isAuctionApproved } = require('./approval_flow');
  if (!(await isAuctionApproved(client, auctionId))) {
    fail(409, 'HARAJ_LOT_NOT_APPROVED', 'Only G4-approved lots may be activated');
  }
  if (String(lot.species).toLowerCase() !== String(rs.category_code).toLowerCase()) {
    fail(409, 'HARAJ_CATEGORY_MISMATCH', 'Lot species is not compatible with this room');
  }
  const { rows: membership } = await client.query(
    `SELECT * FROM haraj_queue_entries
     WHERE room_session_id = $1 AND auction_id = $2
     FOR UPDATE`,
    [roomSessionId, auctionId],
  );
  if (!membership[0]) fail(409, 'HARAJ_LOT_NOT_QUEUED', 'Lot does not belong to this room queue');
  if (['completed', 'skipped', 'withdrawn', 'cancelled'].includes(membership[0].status)) {
    fail(409, 'HARAJ_LOT_NOT_ACTIVATABLE', 'Lot is already completed or skipped');
  }
  const claimed = await client.query(
    `UPDATE haraj_room_sessions
     SET active_lot_id = $2, active_lot_set_at = NOW(), queue_status = 'in_progress', updated_at = NOW()
     WHERE id = $1 AND (active_lot_id IS NULL OR active_lot_id = $2)
     RETURNING id`,
    [roomSessionId, auctionId],
  );
  if (!claimed.rows[0]) fail(409, 'HARAJ_ACTIVE_LOT_EXISTS', 'A Room may have at most one active Lot');
  await client.query(
    `UPDATE haraj_queue_entries
     SET status = 'active', activated_at = COALESCE(activated_at, NOW()), updated_at = NOW()
     WHERE id = $1`,
    [membership[0].id],
  );
  await rooms.audit(client, {
    entityType: 'haraj_room_session',
    entityId: roomSessionId,
    eventType: 'haraj.lot.activated',
    actorUserId,
    payload: {
      auctionId,
      lotId: auctionId,
      newAuctionCreated: false,
      auctionCoreUnchanged: true,
      idempotencyKey: idempotencyKey || null,
    },
  });
  return getSnapshot(client, roomSessionId);
}

async function advanceLot(client, { roomSessionId, actorUserId, admin }) {
  const rs = await queue.lockRoomSession(client, roomSessionId);
  assertOperator(rs, { actorUserId, admin });
  if (rs.status !== 'live') fail(409, 'HARAJ_ROOM_NOT_LIVE', 'Advance requires a live room');
  if (!rs.active_lot_id) fail(409, 'HARAJ_NO_ACTIVE_LOT', 'No active Lot to advance');
  const auctionId = rs.active_lot_id;
  await client.query(
    `UPDATE haraj_queue_entries
     SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE room_session_id = $1 AND auction_id = $2 AND status = 'active'`,
    [roomSessionId, auctionId],
  );
  await client.query(
    `UPDATE haraj_room_sessions
     SET active_lot_id = NULL, active_lot_set_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [roomSessionId],
  );
  await rooms.audit(client, {
    entityType: 'haraj_room_session',
    entityId: roomSessionId,
    eventType: 'haraj.lot.completed',
    actorUserId,
    payload: {
      auctionId,
      lotId: auctionId,
      financialClosed: false,
      winnerDeclared: false,
      auctionCoreUnchanged: true,
    },
  });
  return getSnapshot(client, roomSessionId);
}

async function skipLot(client, { roomSessionId, auctionId, reason, actorUserId, admin }) {
  if (!String(reason || '').trim()) fail(400, 'HARAJ_REASON_REQUIRED', 'Skip reason is required');
  const rs = await queue.lockRoomSession(client, roomSessionId);
  assertOperator(rs, { actorUserId, admin });
  if (rs.status !== 'live' && rs.status !== 'paused') {
    fail(409, 'HARAJ_ROOM_NOT_LIVE', 'Skip requires a live or paused room');
  }
  const targetId = auctionId || rs.active_lot_id;
  if (!targetId) fail(400, 'AUCTION_ID_REQUIRED', 'auctionId is required');
  const { rows } = await client.query(
    `SELECT * FROM haraj_queue_entries
     WHERE room_session_id = $1 AND auction_id = $2
     FOR UPDATE`,
    [roomSessionId, targetId],
  );
  if (!rows[0]) fail(404, 'HARAJ_QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found');
  if (['completed', 'skipped', 'withdrawn'].includes(rows[0].status)) {
    return getSnapshot(client, roomSessionId);
  }
  await client.query(
    `UPDATE haraj_queue_entries
     SET status = 'skipped', completed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [rows[0].id],
  );
  if (rs.active_lot_id === targetId) {
    await client.query(
      `UPDATE haraj_room_sessions
       SET active_lot_id = NULL, active_lot_set_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [roomSessionId],
    );
  }
  await rooms.audit(client, {
    entityType: 'haraj_queue_entry',
    entityId: rows[0].id,
    eventType: 'haraj.lot.skipped',
    actorUserId,
    payload: {
      auctionId: targetId,
      reason: String(reason).slice(0, 500),
      auctionDeleted: false,
      bidsDeleted: false,
      winnerDeclared: false,
      requeueSameOccurrence: false,
    },
  });
  return getSnapshot(client, roomSessionId);
}

async function completeRoom(client, { roomSessionId, actorUserId, admin }) {
  const rs = await queue.lockRoomSession(client, roomSessionId);
  assertOperator(rs, { actorUserId, admin });
  if (rs.status === 'closed') return getSnapshot(client, roomSessionId);
  if (!['live', 'paused', 'pre_live'].includes(rs.status)) {
    fail(409, 'HARAJ_ROOM_TRANSITION_INVALID', 'Room cannot complete from this state');
  }
  if (rs.active_lot_id) fail(409, 'HARAJ_ACTIVE_LOT_EXISTS', 'Clear the active Lot before completing the room');
  await client.query(
    `UPDATE haraj_queue_entries
     SET status = 'carried_over', updated_at = NOW()
     WHERE room_session_id = $1 AND status IN ('queued','ready')`,
    [roomSessionId],
  );
  await client.query(
    `UPDATE haraj_room_sessions
     SET status = 'closed', queue_status = 'closed', updated_at = NOW()
     WHERE id = $1`,
    [roomSessionId],
  );
  await rooms.audit(client, {
    entityType: 'haraj_room_session',
    entityId: roomSessionId,
    eventType: 'haraj.room.completed',
    actorUserId,
    payload: { from: rs.status, to: 'closed', financialAuthority: false },
  });
  return getSnapshot(client, roomSessionId);
}

function publishIfPossible(auctionRealtime, snapshot, type) {
  observe(type, snapshot);
  if (!auctionRealtime || typeof auctionRealtime.publishHarajRoom !== 'function') return null;
  return auctionRealtime.publishHarajRoom(eventContract(type, {
    id: snapshot.roomSessionId,
    session_id: snapshot.sessionId,
    room_id: snapshot.roomId,
    auctioneer_user_id: snapshot.auctioneerUserId,
    status: snapshot.status,
    active_lot_id: snapshot.activeLotId,
    updated_at: snapshot.updatedAt,
  }));
}

module.exports = {
  TRANSITIONS,
  LIVEKIT,
  getSnapshot,
  readyRoom,
  startRoom,
  pauseRoom,
  resumeRoom,
  activateLot,
  advanceLot,
  skipLot,
  completeRoom,
  eventContract,
  publishIfPossible,
  versionOf,
};
