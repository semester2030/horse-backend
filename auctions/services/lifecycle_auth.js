'use strict';

const { serverNow } = require('../domain/states');

/**
 * Lifecycle route authorization — owner-only for seller auction control.
 * Admin lifecycle uses separate admin routes with RBAC.
 */
async function loadAuctionRow(client, auctionId) {
  const { rows } = await client.query(
    `SELECT id, status, owner_user_id, start_at, end_at, extended_until
     FROM auctions WHERE id = $1`,
    [auctionId],
  );
  if (!rows[0]) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  return rows[0];
}

function assertAuctionOwner(row, actorUserId) {
  if (String(row.owner_user_id) !== String(actorUserId)) {
    const err = new Error('Only the auction owner may perform this lifecycle action');
    err.code = 'AUCTION_LIFECYCLE_FORBIDDEN';
    err.status = 403;
    throw err;
  }
}

async function assertOwnerForLifecycle(client, auctionId, actorUserId) {
  const row = await loadAuctionRow(client, auctionId);
  assertAuctionOwner(row, actorUserId);
  return row;
}

function assertManualGoLiveTimeAllowed(row, now = serverNow()) {
  if (row.status !== 'scheduled') {
    const err = new Error(`Cannot go live from status ${row.status}`);
    err.code = 'AUCTION_GO_LIVE_INVALID';
    err.status = 409;
    throw err;
  }
  if (now < new Date(row.start_at)) {
    const err = new Error('Auction has not reached scheduled start time');
    err.code = 'AUCTION_NOT_STARTED';
    err.status = 409;
    throw err;
  }
}

module.exports = {
  loadAuctionRow,
  assertAuctionOwner,
  assertOwnerForLifecycle,
  assertManualGoLiveTimeAllowed,
};
