'use strict';

const { randomUUID } = require('crypto');
const {
  canTransition,
  isBiddableStatus,
  isFrozen,
  effectiveEndAt,
  serverNow,
} = require('../domain/states');
const { acquireAuctionLock } = require('../domain/locking');
const { assertSpecies, assertListingRef } = require('../domain/species');
const {
  ANTI_SNIPE_SECONDS,
  SETTLEMENT_NOTE,
} = require('../config');

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

function mapAuctionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    lotId: row.lot_id,
    listingId: row.listing_id,
    videoId: row.video_id,
    ownerUserId: row.owner_user_id,
    createdByUserId: row.created_by_user_id,
    createdByRole: row.created_by_role,
    ownerConsentRef: row.owner_consent_ref,
    species: row.species,
    status: row.status,
    startingPrice: Number(row.starting_price),
    minimumIncrement: Number(row.minimum_increment),
    reservePrice: row.reserve_price != null ? Number(row.reserve_price) : null,
    currentPrice: Number(row.current_price),
    version: row.version,
    startAt: row.start_at,
    endAt: row.end_at,
    extendedUntil: row.extended_until,
    antiSnipingSeconds: row.anti_sniping_seconds,
    winnerUserId: row.winner_user_id,
    winningBidId: row.winning_bid_id,
    settlementNote: row.settlement_note,
    cancelledReason: row.cancelled_reason,
    preFrozenStatus: row.pre_frozen_status,
    frozenReason: row.frozen_reason,
    frozenAt: row.frozen_at,
    frozenByAdminId: row.frozen_by_admin_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function appendEvent(client, { auctionId, eventType, payload, actorUserId }) {
  await client.query(
    `INSERT INTO auction_events (auction_id, event_type, payload, actor_user_id)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [auctionId, eventType, JSON.stringify(payload || {}), actorUserId || null],
  );
}

async function getLotByRefs(client, listingId, videoId) {
  const { rows } = await client.query(
    `SELECT l.* FROM auction_lots l WHERE l.listing_id = $1 AND l.video_id = $2`,
    [listingId, videoId],
  );
  return rows[0] || null;
}

async function upsertLot(client, { listingId, videoId, species, title }) {
  const sp = assertSpecies(species);
  const refs = assertListingRef(listingId, videoId);
  const existing = await getLotByRefs(client, refs.listingId, refs.videoId);
  if (existing) return existing;
  const { rows } = await client.query(
    `INSERT INTO auction_lots (listing_id, video_id, species, title)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [refs.listingId, refs.videoId, sp, title || null],
  );
  return rows[0];
}

async function createAuctionDraft(client, input) {
  const sp = assertSpecies(input.species);
  const lot = await upsertLot(client, {
    listingId: input.listingId,
    videoId: input.videoId,
    species: sp,
    title: input.title,
  });

  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  if (!(startAt < endAt)) {
    const err = new Error('startAt must be before endAt');
    err.code = 'AUCTION_TIME_INVALID';
    err.status = 400;
    throw err;
  }

  const startingPrice = money(input.startingPrice);
  const minimumIncrement = money(input.minimumIncrement);
  if (minimumIncrement <= 0) {
    const err = new Error('minimumIncrement must be > 0');
    err.code = 'AUCTION_INCREMENT_INVALID';
    err.status = 400;
    throw err;
  }

  const createdByRole = input.createdByRole === 'host_proxy' ? 'host_proxy' : 'seller';
  if (createdByRole === 'host_proxy' && !input.ownerConsentRef) {
    const err = new Error('ownerConsentRef required for host_proxy creation');
    err.code = 'AUCTION_OWNER_CONSENT_REQUIRED';
    err.status = 400;
    throw err;
  }

  const { rows } = await client.query(
    `INSERT INTO auctions (
      lot_id, owner_user_id, created_by_user_id, created_by_role, owner_consent_ref,
      species, status, starting_price, minimum_increment, reserve_price, current_price,
      start_at, end_at, anti_sniping_seconds, settlement_note
    ) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$7,$10,$11,$12,$13)
    RETURNING *`,
    [
      lot.id,
      String(input.ownerUserId),
      String(input.createdByUserId),
      createdByRole,
      input.ownerConsentRef || null,
      sp,
      startingPrice,
      minimumIncrement,
      input.reservePrice != null ? money(input.reservePrice) : null,
      startAt.toISOString(),
      endAt.toISOString(),
      input.antiSnipingSeconds ?? ANTI_SNIPE_SECONDS,
      SETTLEMENT_NOTE,
    ],
  );

  const auctionRow = {
    ...rows[0],
    listing_id: lot.listing_id,
    video_id: lot.video_id,
  };
  await appendEvent(client, {
    auctionId: auctionRow.id,
    eventType: 'auction.created',
    payload: { status: 'draft', species: sp },
    actorUserId: input.createdByUserId,
  });
  return mapAuctionRow(auctionRow);
}

async function transitionAuction(client, auctionId, toStatus, { actorUserId, reason } = {}) {
  await acquireAuctionLock(client, auctionId);
  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id
     FROM auctions a
     JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1 FOR UPDATE`,
    [auctionId],
  );
  const row = rows[0];
  if (!row) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  const from = row.status;
  if (!canTransition(from, toStatus)) {
    const err = new Error(`Invalid transition ${from} → ${toStatus}`);
    err.code = 'AUCTION_TRANSITION_INVALID';
    err.status = 409;
    throw err;
  }

  const params = [toStatus, auctionId];
  let extra = '';
  if (toStatus === 'cancelled') {
    extra =
      ', cancelled_reason = $3, pre_frozen_status = NULL, frozen_reason = NULL, frozen_at = NULL, frozen_by_admin_id = NULL';
    params.push(reason || 'cancelled');
  }

  const updated = await client.query(
    `UPDATE auctions SET status = $1, updated_at = NOW()${extra} WHERE id = $2
     RETURNING *, (SELECT listing_id FROM auction_lots WHERE id = lot_id) AS listing_id,
               (SELECT video_id FROM auction_lots WHERE id = lot_id) AS video_id`,
    params,
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'auction.status_changed',
    payload: { from, to: toStatus, reason: reason || null },
    actorUserId,
  });

  return mapAuctionRow(updated.rows[0]);
}

async function goLiveIfDue(client, auctionId) {
  await acquireAuctionLock(client, auctionId);
  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id
     FROM auctions a JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1 FOR UPDATE`,
    [auctionId],
  );
  const row = rows[0];
  if (!row || row.status !== 'scheduled') return mapAuctionRow(row);
  const now = serverNow();
  if (now < new Date(row.start_at)) return mapAuctionRow(row);
  return transitionAuction(client, auctionId, 'live', { actorUserId: 'system' });
}

async function closeAuctionAtomic(client, auctionId, { actorUserId = 'system' } = {}) {
  await acquireAuctionLock(client, auctionId);
  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id
     FROM auctions a JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1 FOR UPDATE`,
    [auctionId],
  );
  const row = rows[0];
  if (!row) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  if (row.status === 'ended' || row.status === 'sold' || row.status === 'unsold') {
    return mapAuctionRow(row);
  }

  if (isFrozen(row.status)) {
    const err = new Error('Auction is frozen');
    err.code = 'AUCTION_FROZEN';
    err.status = 409;
    throw err;
  }

  if (!isBiddableStatus(row.status)) {
    const err = new Error(`Cannot close auction in status ${row.status}`);
    err.code = 'AUCTION_NOT_CLOSABLE';
    err.status = 409;
    throw err;
  }

  const now = serverNow();
  const end = effectiveEndAt(row, now);
  if (now < end) {
    const err = new Error('Auction has not reached end time');
    err.code = 'AUCTION_STILL_ACTIVE';
    err.status = 409;
    throw err;
  }

  await client.query(
    `UPDATE auctions SET status = 'ended', updated_at = NOW() WHERE id = $1`,
    [auctionId],
  );

  const { rows: topBids } = await client.query(
    `SELECT * FROM bids WHERE auction_id = $1 ORDER BY amount DESC, created_at ASC LIMIT 1`,
    [auctionId],
  );
  const top = topBids[0];
  let finalStatus = 'unsold';
  let winnerUserId = null;
  let winningBidId = null;

  if (top) {
    const meetsReserve =
      row.reserve_price == null || Number(top.amount) >= Number(row.reserve_price);
    if (meetsReserve) {
      finalStatus = 'sold';
      winnerUserId = top.bidder_user_id;
      winningBidId = top.id;
    }
  }

  const { rows: finalRows } = await client.query(
    `UPDATE auctions SET status = $1, winner_user_id = $2, winning_bid_id = $3, updated_at = NOW()
     WHERE id = $4
     RETURNING *, (SELECT listing_id FROM auction_lots WHERE id = lot_id) AS listing_id,
               (SELECT video_id FROM auction_lots WHERE id = lot_id) AS video_id`,
    [finalStatus, winnerUserId, winningBidId, auctionId],
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'auction.closed',
    payload: {
      finalStatus,
      winnerUserId,
      winningBidId,
      finalPrice: top ? Number(top.amount) : Number(row.current_price),
      settlementNote: SETTLEMENT_NOTE,
    },
    actorUserId,
  });

  return mapAuctionRow(finalRows[0]);
}

module.exports = {
  mapAuctionRow,
  appendEvent,
  upsertLot,
  createAuctionDraft,
  transitionAuction,
  goLiveIfDue,
  closeAuctionAtomic,
  money,
};
