'use strict';

/**
 * PostgreSQL advisory transaction locks — multi-instance safe auction mutation guard.
 * Bidding truth remains row-level FOR UPDATE; this serializes cross-instance ops on same auction.
 */
async function acquireAuctionLock(client, auctionId) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('nomas:auction:' || $1::text))`,
    [String(auctionId)],
  );
}

module.exports = {
  acquireAuctionLock,
};
