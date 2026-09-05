'use strict';

/**
 * G7 — Lot Core Adaptation.
 * Auction.id remains the Lot. Queue entry IDs are operational only.
 * Does not activate/advance/skip live Lots (G8).
 */

const { isAuctionApproved } = require('./approval_flow');
const rooms = require('./haraj_session_room');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const QUEUE_MUTABLE = new Set(['queued', 'ready']);
const QUEUE_ACTIVE_MEMBER = new Set(['queued', 'ready', 'active']);

const SNAPSHOT = {
  ssotAuction: [
    'id',
    'status',
    'species',
    'owner_user_id',
    'starting_price',
    'current_price',
    'winner_user_id',
    'bid history',
    'media',
  ],
  operationalQueue: ['id', 'room_session_id', 'auction_id', 'position', 'status', 'planned_start_at'],
  neverCopied: ['current_price', 'winner_user_id', 'bid rows', 'settlement'],
  immutableOnceQueued: 'Auction financial/bid truth stays Auction Core. Queue only stores occurrence membership + order.',
};

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

function assertUuid(id, code = 'HARAJ_NOT_FOUND') {
  if (!UUID_RE.test(String(id || ''))) fail(404, code, 'Not found');
}

function mapEntry(row) {
  return {
    id: row.id,
    roomSessionId: row.room_session_id,
    sessionId: row.haraj_session_id || row.session_id || null,
    roomId: row.room_id || null,
    roomCode: row.room_code || null,
    categoryCode: row.category_code || null,
    auctionId: row.auction_id,
    lotId: row.auction_id,
    position: row.position,
    status: row.status,
    plannedStartAt: row.planned_start_at,
    activatedAt: row.activated_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    financialAuthority: false,
    bidAuthority: false,
    liveActivated: false,
    auction: row.auction_status
      ? {
          id: row.auction_id,
          status: row.auction_status,
          species: row.auction_species,
          title: row.lot_title || null,
        }
      : undefined,
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

async function lockRoomSession(client, roomSessionId) {
  assertUuid(roomSessionId, 'HARAJ_ROOM_SESSION_NOT_FOUND');
  const { rows } = await client.query(
    `SELECT rs.*, s.status AS session_status, s.id AS session_id,
            c.code AS category_code, r.code AS room_code, r.category_id
     FROM haraj_room_sessions rs
     JOIN haraj_sessions s ON s.id = rs.haraj_session_id
     JOIN haraj_categories c ON c.id = s.category_id
     JOIN haraj_rooms r ON r.id = rs.room_id
     WHERE rs.id = $1
     FOR UPDATE`,
    [roomSessionId],
  );
  if (!rows[0]) fail(404, 'HARAJ_ROOM_SESSION_NOT_FOUND', 'Room session not found');
  return rows[0];
}

function assertQueueEditable(rs) {
  if (!rooms.canEditSession(rs.session_status)) {
    fail(409, 'HARAJ_QUEUE_IMMUTABLE', 'Queue can be edited only before the session is operational');
  }
  if (String(rs.status) !== 'idle') {
    fail(409, 'HARAJ_QUEUE_IMMUTABLE', 'Live/pre-live room queues are G8, not G7');
  }
}

async function lockLot(client, auctionId) {
  assertUuid(auctionId, 'AUCTION_NOT_FOUND');
  const { rows } = await client.query(
    `SELECT a.*, l.title AS lot_title
     FROM auctions a
     JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1
     FOR UPDATE`,
    [auctionId],
  );
  if (!rows[0]) fail(404, 'AUCTION_NOT_FOUND', 'Lot not found');
  return rows[0];
}

function assertLotLifecycle(lot) {
  const status = String(lot.status || '');
  if (status === 'draft') fail(409, 'HARAJ_LOT_NOT_APPROVED', 'Draft lots cannot enter a Haraj queue');
  if (status === 'cancelled') fail(409, 'HARAJ_LOT_NOT_APPROVED', 'Rejected/cancelled lots cannot enter a Haraj queue');
  if (status !== 'review') {
    fail(409, 'HARAJ_LOT_NOT_APPROVED', 'Only G4-approved review lots may enter a Haraj queue');
  }
}

async function assertEligible(client, lot, categoryCode) {
  assertLotLifecycle(lot);
  const approved = await isAuctionApproved(client, lot.id);
  if (!approved) fail(409, 'HARAJ_LOT_NOT_APPROVED', 'Only G4-approved lots may enter a Haraj queue');
  const species = String(lot.species || '').toLowerCase();
  if (species !== String(categoryCode || '').toLowerCase()) {
    fail(409, 'HARAJ_CATEGORY_MISMATCH', 'Lot species is not compatible with this room');
  }
}

async function getEntry(client, entryId) {
  assertUuid(entryId, 'HARAJ_QUEUE_ENTRY_NOT_FOUND');
  const { rows } = await client.query(
    `SELECT qe.*, rs.haraj_session_id, rs.room_id, r.code AS room_code, c.code AS category_code,
            a.status AS auction_status, a.species AS auction_species, l.title AS lot_title
     FROM haraj_queue_entries qe
     JOIN haraj_room_sessions rs ON rs.id = qe.room_session_id
     JOIN haraj_rooms r ON r.id = rs.room_id
     JOIN haraj_sessions s ON s.id = rs.haraj_session_id
     JOIN haraj_categories c ON c.id = s.category_id
     JOIN auctions a ON a.id = qe.auction_id
     JOIN auction_lots l ON l.id = a.lot_id
     WHERE qe.id = $1`,
    [entryId],
  );
  if (!rows[0]) fail(404, 'HARAJ_QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found');
  return mapEntry(rows[0]);
}

async function listQueue(client, roomSessionId) {
  assertUuid(roomSessionId, 'HARAJ_ROOM_SESSION_NOT_FOUND');
  const exists = await client.query(`SELECT 1 FROM haraj_room_sessions WHERE id = $1`, [roomSessionId]);
  if (!exists.rows[0]) fail(404, 'HARAJ_ROOM_SESSION_NOT_FOUND', 'Room session not found');
  const { rows } = await client.query(
    `SELECT qe.*, rs.haraj_session_id, rs.room_id, r.code AS room_code, c.code AS category_code,
            a.status AS auction_status, a.species AS auction_species, l.title AS lot_title
     FROM haraj_queue_entries qe
     JOIN haraj_room_sessions rs ON rs.id = qe.room_session_id
     JOIN haraj_rooms r ON r.id = rs.room_id
     JOIN haraj_sessions s ON s.id = rs.haraj_session_id
     JOIN haraj_categories c ON c.id = s.category_id
     JOIN auctions a ON a.id = qe.auction_id
     JOIN auction_lots l ON l.id = a.lot_id
     WHERE qe.room_session_id = $1
     ORDER BY CASE WHEN qe.status IN ('queued','ready','active') THEN 0 ELSE 1 END,
              qe.position ASC`,
    [roomSessionId],
  );
  return rows.map(mapEntry);
}

async function nextPosition(client, roomSessionId) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(position), 0) + 1 AS n
     FROM haraj_queue_entries
     WHERE room_session_id = $1 AND status IN ('queued','ready','active')`,
    [roomSessionId],
  );
  return Number(rows[0].n);
}

async function findActiveMembership(client, auctionId) {
  const { rows } = await client.query(
    `SELECT * FROM haraj_queue_entries
     WHERE auction_id = $1 AND status IN ('queued','ready','active')
     LIMIT 1`,
    [auctionId],
  );
  return rows[0] || null;
}

async function setHarajMode(client, auctionId, mode) {
  await client.query(
    `UPDATE auctions SET haraj_mode = $2, updated_at = NOW() WHERE id = $1`,
    [auctionId, mode],
  );
}

async function assignLot(client, {
  roomSessionId,
  auctionId,
  actorUserId,
  clientCreatedBy,
  idempotencyKey,
}) {
  if (clientCreatedBy) fail(403, 'HARAJ_ACTOR_FORBIDDEN', 'Client-supplied createdBy is not authoritative');
  if (!auctionId) fail(400, 'AUCTION_ID_REQUIRED', 'auctionId is required');

  if (idempotencyKey) {
    const prior = await findByIdempotency(client, 'haraj.queue.assigned', idempotencyKey);
    if (prior) return getEntry(client, prior.entity_id);
  }

  const rs = await lockRoomSession(client, roomSessionId);
  assertQueueEditable(rs);
  const lot = await lockLot(client, auctionId);
  await assertEligible(client, lot, rs.category_code);

  const existingSame = await client.query(
    `SELECT * FROM haraj_queue_entries
     WHERE room_session_id = $1 AND auction_id = $2`,
    [roomSessionId, auctionId],
  );
  if (existingSame.rows[0] && QUEUE_ACTIVE_MEMBER.has(existingSame.rows[0].status)) {
    return getEntry(client, existingSame.rows[0].id);
  }
  if (existingSame.rows[0] && ['completed', 'skipped', 'active'].includes(existingSame.rows[0].status)) {
    fail(409, 'HARAJ_LOT_ALREADY_QUEUED', 'Lot already has a terminal or live queue entry on this occurrence');
  }

  const other = await findActiveMembership(client, auctionId);
  if (other && other.room_session_id !== roomSessionId) {
    fail(409, 'HARAJ_LOT_ALREADY_QUEUED', 'Lot already has an active queue membership');
  }

  if (existingSame.rows[0] && ['withdrawn', 'cancelled'].includes(existingSame.rows[0].status)) {
    const position = await nextPosition(client, roomSessionId);
    await client.query(
      `UPDATE haraj_queue_entries
       SET status = 'queued', position = $2, updated_at = NOW()
       WHERE id = $1`,
      [existingSame.rows[0].id, position],
    );
    await setHarajMode(client, auctionId, 'haraj_queued');
    await rooms.audit(client, {
      entityType: 'haraj_queue_entry',
      entityId: existingSame.rows[0].id,
      eventType: 'haraj.queue.assigned',
      actorUserId,
      payload: {
        auctionId,
        lotId: auctionId,
        roomSessionId,
        sessionId: rs.session_id,
        roomId: rs.room_id,
        position,
        fromPosition: existingSame.rows[0].position,
        toPosition: position,
        revived: true,
        idempotencyKey: idempotencyKey || null,
        auctionCoreUnchanged: true,
        liveActivated: false,
      },
    });
    return getEntry(client, existingSame.rows[0].id);
  }

  const position = await nextPosition(client, roomSessionId);
  let inserted;
  try {
    inserted = await client.query(
      `INSERT INTO haraj_queue_entries (room_session_id, auction_id, position, status)
       VALUES ($1, $2, $3, 'queued')
       RETURNING *`,
      [roomSessionId, auctionId, position],
    );
  } catch (err) {
    if (err.code === '23505') {
      const sameRoom = await client.query(
        `SELECT id FROM haraj_queue_entries
         WHERE room_session_id = $1 AND auction_id = $2`,
        [roomSessionId, auctionId],
      );
      if (sameRoom.rows[0]) return getEntry(client, sameRoom.rows[0].id);
      const otherRoom = await findActiveMembership(client, auctionId);
      if (otherRoom) fail(409, 'HARAJ_LOT_ALREADY_QUEUED', 'Lot already has an active queue membership');
      const retryPos = await nextPosition(client, roomSessionId);
      inserted = await client.query(
        `INSERT INTO haraj_queue_entries (room_session_id, auction_id, position, status)
         VALUES ($1, $2, $3, 'queued')
         RETURNING *`,
        [roomSessionId, auctionId, retryPos],
      );
    } else {
      throw err;
    }
  }

  await setHarajMode(client, auctionId, 'haraj_queued');
  await rooms.audit(client, {
    entityType: 'haraj_queue_entry',
    entityId: inserted.rows[0].id,
    eventType: 'haraj.queue.assigned',
    actorUserId,
    payload: {
      auctionId,
      lotId: auctionId,
      roomSessionId,
      sessionId: rs.session_id,
      roomId: rs.room_id,
      position: inserted.rows[0].position,
      fromPosition: null,
      toPosition: inserted.rows[0].position,
      idempotencyKey: idempotencyKey || null,
      auctionCoreUnchanged: true,
      liveActivated: false,
    },
  });
  return getEntry(client, inserted.rows[0].id);
}

async function withdrawEntry(client, { entryId, reason, actorUserId }) {
  assertUuid(entryId, 'HARAJ_QUEUE_ENTRY_NOT_FOUND');
  const { rows } = await client.query(
    `SELECT qe.*, rs.status AS room_status, s.status AS session_status
     FROM haraj_queue_entries qe
     JOIN haraj_room_sessions rs ON rs.id = qe.room_session_id
     JOIN haraj_sessions s ON s.id = rs.haraj_session_id
     WHERE qe.id = $1
     FOR UPDATE`,
    [entryId],
  );
  if (!rows[0]) fail(404, 'HARAJ_QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found');
  const row = rows[0];
  assertQueueEditable({ session_status: row.session_status, status: row.room_status });
  if (row.status === 'withdrawn') return getEntry(client, entryId);
  if (!QUEUE_MUTABLE.has(row.status)) {
    fail(409, 'HARAJ_QUEUE_ENTRY_IMMUTABLE', 'Only pre-live queued lots can be withdrawn in G7');
  }
  if (!String(reason || '').trim()) fail(400, 'HARAJ_REASON_REQUIRED', 'Withdraw reason is required');

  const fromPosition = row.position;
  await client.query(
    `UPDATE haraj_queue_entries
     SET status = 'withdrawn',
         position = 900000 + (abs(hashtext(id::text)) % 90000),
         updated_at = NOW()
     WHERE id = $1`,
    [entryId],
  );
  await compactQueued(client, row.room_session_id);
  const still = await findActiveMembership(client, row.auction_id);
  if (!still) await setHarajMode(client, row.auction_id, 'standalone');

  await rooms.audit(client, {
    entityType: 'haraj_queue_entry',
    entityId: entryId,
    eventType: 'haraj.queue.withdrawn',
    actorUserId,
    payload: {
      auctionId: row.auction_id,
      roomSessionId: row.room_session_id,
      reason: String(reason).slice(0, 500),
      fromPosition,
      toPosition: null,
      auctionDeleted: false,
      bidsDeleted: false,
    },
  });
  return getEntry(client, entryId);
}

async function compactQueued(client, roomSessionId) {
  const { rows } = await client.query(
    `SELECT id FROM haraj_queue_entries
     WHERE room_session_id = $1 AND status IN ('queued','ready','active')
     ORDER BY position ASC
     FOR UPDATE`,
    [roomSessionId],
  );
  if (!rows.length) return;
  await client.query(
    `UPDATE haraj_queue_entries
     SET position = position + 10000, updated_at = NOW()
     WHERE room_session_id = $1 AND status IN ('queued','ready','active')`,
    [roomSessionId],
  );
  for (let i = 0; i < rows.length; i += 1) {
    await client.query(
      `UPDATE haraj_queue_entries SET position = $2, updated_at = NOW() WHERE id = $1`,
      [rows[i].id, i + 1],
    );
  }
}

async function reorderQueue(client, { roomSessionId, entryIds, actorUserId }) {
  const rs = await lockRoomSession(client, roomSessionId);
  assertQueueEditable(rs);
  const ids = Array.isArray(entryIds) ? entryIds.map(String) : [];
  if (!ids.length) fail(400, 'HARAJ_QUEUE_ORDER_INVALID', 'entryIds is required');

  const current = await client.query(
    `SELECT id, position FROM haraj_queue_entries
     WHERE room_session_id = $1 AND status IN ('queued','ready')
     ORDER BY position ASC
     FOR UPDATE`,
    [roomSessionId],
  );
  const have = new Set(current.rows.map((r) => r.id));
  if (ids.length !== have.size || ids.some((id) => !have.has(id))) {
    fail(409, 'HARAJ_QUEUE_ORDER_INVALID', 'Reorder must include every pre-live queued entry exactly once');
  }

  await client.query(
    `UPDATE haraj_queue_entries
     SET position = position + 10000, updated_at = NOW()
     WHERE room_session_id = $1 AND status IN ('queued','ready')`,
    [roomSessionId],
  );
  const before = Object.fromEntries(current.rows.map((r) => [r.id, r.position]));
  for (let i = 0; i < ids.length; i += 1) {
    await client.query(
      `UPDATE haraj_queue_entries SET position = $2, updated_at = NOW() WHERE id = $1`,
      [ids[i], i + 1],
    );
  }
  await rooms.audit(client, {
    entityType: 'haraj_room_session',
    entityId: roomSessionId,
    eventType: 'haraj.queue.reordered',
    actorUserId,
    payload: {
      fromOrder: current.rows.map((r) => r.id),
      toOrder: ids,
      before,
      liveActivated: false,
    },
  });
  return listQueue(client, roomSessionId);
}

async function queueMembershipByAuction(client, auctionId) {
  const { rows } = await client.query(
    `SELECT id FROM haraj_queue_entries
     WHERE auction_id = $1 AND status IN ('queued','ready','active')
     LIMIT 1`,
    [auctionId],
  );
  return Boolean(rows[0]);
}

module.exports = {
  SNAPSHOT,
  QUEUE_MUTABLE,
  mapEntry,
  listQueue,
  getEntry,
  assignLot,
  withdrawEntry,
  reorderQueue,
  assertLotLifecycle,
  queueMembershipByAuction,
  lockRoomSession,
};
