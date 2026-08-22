'use strict';

const { canFreeze, isFrozen } = require('../domain/states');
const { acquireAuctionLock } = require('../domain/locking');
const { appendEvent, mapAuctionRow, transitionAuction } = require('./auction_service');

async function loadAuctionForUpdate(client, auctionId) {
  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id
     FROM auctions a JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1 FOR UPDATE`,
    [auctionId],
  );
  return rows[0] || null;
}

async function freezeAuction(client, auctionId, { adminId, reason } = {}) {
  await acquireAuctionLock(client, auctionId);
  const row = await loadAuctionForUpdate(client, auctionId);
  if (!row) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (isFrozen(row.status)) {
    const err = new Error('Auction already frozen');
    err.code = 'AUCTION_ALREADY_FROZEN';
    err.status = 409;
    throw err;
  }
  if (!canFreeze(row.status)) {
    const err = new Error(`Cannot freeze auction in status ${row.status}`);
    err.code = 'AUCTION_FREEZE_INVALID';
    err.status = 409;
    throw err;
  }

  const { rows } = await client.query(
    `UPDATE auctions SET status = 'frozen', pre_frozen_status = $1, frozen_reason = $2,
            frozen_at = NOW(), frozen_by_admin_id = $3, updated_at = NOW()
     WHERE id = $4
     RETURNING *, (SELECT listing_id FROM auction_lots WHERE id = lot_id) AS listing_id,
               (SELECT video_id FROM auction_lots WHERE id = lot_id) AS video_id`,
    [row.status, reason || 'admin_freeze', adminId || null, auctionId],
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'auction.frozen',
    payload: {
      from: row.status,
      reason: reason || 'admin_freeze',
      preFrozenStatus: row.status,
    },
    actorUserId: adminId,
  });

  return mapAuctionRow(rows[0]);
}

async function resumeAuction(client, auctionId, { adminId, reason } = {}) {
  await acquireAuctionLock(client, auctionId);
  const row = await loadAuctionForUpdate(client, auctionId);
  if (!row) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (!isFrozen(row.status)) {
    const err = new Error('Auction is not frozen');
    err.code = 'AUCTION_NOT_FROZEN';
    err.status = 409;
    throw err;
  }
  const restore = row.pre_frozen_status;
  if (!restore) {
    const err = new Error('Missing pre_frozen_status');
    err.code = 'AUCTION_RESUME_INVALID';
    err.status = 409;
    throw err;
  }

  const { rows } = await client.query(
    `UPDATE auctions SET status = $1, pre_frozen_status = NULL, frozen_reason = NULL,
            frozen_at = NULL, frozen_by_admin_id = NULL, updated_at = NOW()
     WHERE id = $2
     RETURNING *, (SELECT listing_id FROM auction_lots WHERE id = lot_id) AS listing_id,
               (SELECT video_id FROM auction_lots WHERE id = lot_id) AS video_id`,
    [restore, auctionId],
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'auction.resumed',
    payload: { to: restore, reason: reason || 'admin_resume' },
    actorUserId: adminId,
  });

  return mapAuctionRow(rows[0]);
}

async function adminCancelAuction(client, auctionId, { adminId, reason } = {}) {
  await acquireAuctionLock(client, auctionId);
  const row = await loadAuctionForUpdate(client, auctionId);
  if (!row) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  const from = row.status;
  const cancelReason = reason || 'admin_cancel';
  const auction = await transitionAuction(client, auctionId, 'cancelled', {
    actorUserId: adminId,
    reason: cancelReason,
  });
  await appendEvent(client, {
    auctionId,
    eventType: 'admin.auction.cancelled',
    payload: { from, reason: cancelReason },
    actorUserId: adminId,
  });
  return auction;
}

module.exports = {
  freezeAuction,
  resumeAuction,
  adminCancelAuction,
};
