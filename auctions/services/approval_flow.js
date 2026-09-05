'use strict';

const { mapAuctionRow, appendEvent, transitionAuction } = require('./auction_service');

const APPROVAL_EVENT_TYPES = [
  'admin.review.approved',
  'auction.review_bypassed_developer',
  'haraj.auctioneer.accepted',
];

async function isAuctionApproved(client, auctionId) {
  const { rows } = await client.query(
    `SELECT 1 FROM auction_events
     WHERE auction_id = $1 AND event_type = ANY($2::text[])
     LIMIT 1`,
    [auctionId, APPROVAL_EVENT_TYPES],
  );
  return rows.length > 0;
}

async function getRequiresHost(client, auctionId) {
  const { rows } = await client.query(
    `SELECT payload FROM auction_events
     WHERE auction_id = $1 AND event_type = 'auction.created'
     ORDER BY created_at ASC LIMIT 1`,
    [auctionId],
  );
  const payload = rows[0]?.payload || {};
  return payload.requiresHost === true;
}

async function recordAuctionApproval(client, auctionId, actorUserId, { bypass = 'admin', reason } = {}) {
  const eventType =
    bypass === 'developer' ? 'auction.review_bypassed_developer' : 'admin.review.approved';
  await appendEvent(client, {
    auctionId,
    eventType,
    payload: {
      bypass,
      reason: reason || null,
      approvedAt: new Date().toISOString(),
    },
    actorUserId,
  });
}

async function hasScheduledHostBooking(client, auctionId) {
  const { rows } = await client.query(
    `SELECT 1 FROM host_bookings
     WHERE auction_id = $1 AND status = 'scheduled'
     LIMIT 1`,
    [auctionId],
  );
  return rows.length > 0;
}

async function getAuctionRow(client, auctionId) {
  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id
     FROM auctions a
     JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1`,
    [auctionId],
  );
  return rows[0] || null;
}

async function assertCanSchedule(client, auctionId) {
  const auction = await getAuctionRow(client, auctionId);
  if (!auction) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  if (auction.status !== 'review') {
    const err = new Error('Auction must be in review status to schedule');
    err.code = 'AUCTION_SCHEDULE_STATE_INVALID';
    err.status = 409;
    throw err;
  }

  if (!(await isAuctionApproved(client, auctionId))) {
    const err = new Error('Auction requires admin approval before scheduling');
    err.code = 'AUCTION_NOT_APPROVED';
    err.status = 403;
    throw err;
  }

  const requiresHost = await getRequiresHost(client, auctionId);
  if (requiresHost && !(await hasScheduledHostBooking(client, auctionId))) {
    const err = new Error('Host must accept booking before scheduling');
    err.code = 'AUCTION_HOST_NOT_SCHEDULED';
    err.status = 409;
    throw err;
  }

  return auction;
}

async function scheduleAuctionIfEligible(client, auctionId, actorUserId) {
  await assertCanSchedule(client, auctionId);
  return transitionAuction(client, auctionId, 'scheduled', { actorUserId });
}

async function approveAuctionReview(client, auctionId, actorUserId, opts = {}) {
  const auction = await getAuctionRow(client, auctionId);
  if (!auction) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (auction.status !== 'review') {
    const err = new Error('Auction not in review status');
    err.code = 'AUCTION_REVIEW_INVALID';
    err.status = 409;
    throw err;
  }

  if (!(await isAuctionApproved(client, auctionId))) {
    await recordAuctionApproval(client, auctionId, actorUserId, opts);
  }

  const requiresHost = await getRequiresHost(client, auctionId);
  if (!requiresHost) {
    return scheduleAuctionIfEligible(client, auctionId, actorUserId);
  }

  const fresh = await getAuctionRow(client, auctionId);
  return mapAuctionRow(fresh);
}

async function enrichAuctionWithApproval(client, auction) {
  if (!auction?.id) return auction;
  const approved = await isAuctionApproved(client, auction.id);
  return { ...auction, isApproved: approved };
}

module.exports = {
  APPROVAL_EVENT_TYPES,
  isAuctionApproved,
  getRequiresHost,
  recordAuctionApproval,
  hasScheduledHostBooking,
  assertCanSchedule,
  scheduleAuctionIfEligible,
  approveAuctionReview,
  getAuctionRow,
  enrichAuctionWithApproval,
};
