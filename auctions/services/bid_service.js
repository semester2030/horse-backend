'use strict';

const { randomUUID } = require('crypto');
const {
  isBiddableStatus,
  effectiveEndAt,
  serverNow,
} = require('../domain/states');
const { appendEvent, mapAuctionRow, money } = require('./auction_service');
const { acquireAuctionLock } = require('../domain/locking');
const { isFrozen } = require('../domain/states');

function mapBidRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    auctionId: row.auction_id,
    bidderUserId: row.bidder_user_id,
    amount: Number(row.amount),
    auctionVersion: row.auction_version,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

/**
 * Atomic bid acceptance — SELECT FOR UPDATE on auction row inside caller transaction.
 */
async function placeBid(client, {
  auctionId,
  bidderUserId,
  amount,
  idempotencyKey,
  expectedVersion,
  allowOwnerBid = false,
}) {
  const key = String(idempotencyKey || '').trim();
  if (!key) {
    const err = new Error('Idempotency-Key required');
    err.code = 'BID_IDEMPOTENCY_REQUIRED';
    err.status = 400;
    throw err;
  }

  await acquireAuctionLock(client, auctionId);

  const existing = await client.query(
    `SELECT * FROM bids WHERE auction_id = $1 AND idempotency_key = $2`,
    [auctionId, key],
  );
  if (existing.rows[0]) {
    return { bid: mapBidRow(existing.rows[0]), replay: true };
  }

  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id
     FROM auctions a JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1 FOR UPDATE`,
    [auctionId],
  );
  const auction = rows[0];
  if (!auction) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  if (isFrozen(auction.status)) {
    const err = new Error(`Bidding not allowed in status ${auction.status}`);
    err.code = 'BID_NOT_ALLOWED';
    err.status = 409;
    throw err;
  }

  if (!isBiddableStatus(auction.status)) {
    const err = new Error(`Bidding not allowed in status ${auction.status}`);
    err.code = 'BID_NOT_ALLOWED';
    err.status = 409;
    throw err;
  }

  const now = serverNow();
  const end = effectiveEndAt(auction, now);
  if (now >= end) {
    const err = new Error('Auction closed');
    err.code = 'AUCTION_CLOSED';
    err.status = 409;
    throw err;
  }

  if (expectedVersion != null && Number(expectedVersion) !== Number(auction.version)) {
    const err = new Error('Stale auction version');
    err.code = 'BID_STALE_VERSION';
    err.status = 409;
    throw err;
  }

  const bidAmount = money(amount);
  const minRequired = money(Number(auction.current_price) + Number(auction.minimum_increment));
  if (bidAmount < minRequired) {
    const err = new Error(`Bid must be >= ${minRequired}`);
    err.code = 'BID_INCREMENT_TOO_LOW';
    err.status = 400;
    err.details = { minRequired, currentPrice: Number(auction.current_price) };
    throw err;
  }

  if (
    !allowOwnerBid &&
    String(auction.owner_user_id) === String(bidderUserId)
  ) {
    const err = new Error('Owner cannot bid on own auction');
    err.code = 'BID_OWNER_FORBIDDEN';
    err.status = 403;
    throw err;
  }

  const { rows: bidRows } = await client.query(
    `INSERT INTO bids (auction_id, bidder_user_id, amount, auction_version, idempotency_key)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [auctionId, String(bidderUserId), bidAmount, auction.version, key],
  );

  let newStatus = auction.status;
  let extendedUntil = auction.extended_until;
  const secondsLeft = (end.getTime() - now.getTime()) / 1000;
  const antiSnipe = Number(auction.anti_sniping_seconds || 0);

  if (antiSnipe > 0 && secondsLeft <= antiSnipe) {
    extendedUntil = new Date(now.getTime() + antiSnipe * 1000).toISOString();
    newStatus = 'extended';
  }

  await client.query(
    `UPDATE auctions
     SET current_price = $1, version = version + 1, status = $2,
         extended_until = $3, updated_at = NOW()
     WHERE id = $4`,
    [bidAmount, newStatus, extendedUntil, auctionId],
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'bid.accepted',
    payload: {
      bidId: bidRows[0].id,
      amount: bidAmount,
      newVersion: Number(auction.version) + 1,
      extendedUntil,
      status: newStatus,
    },
    actorUserId: bidderUserId,
  });

  const { rows: freshRows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id
     FROM auctions a JOIN auction_lots l ON l.id = a.lot_id WHERE a.id = $1`,
    [auctionId],
  );

  return {
    bid: mapBidRow(bidRows[0]),
    replay: false,
    auction: mapAuctionRow(freshRows[0]),
    wasExtended: newStatus === 'extended' && auction.status !== 'extended',
  };
}

module.exports = {
  placeBid,
  mapBidRow,
};
