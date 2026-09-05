'use strict';

/**
 * G15 — Admin Command Center (read model).
 * Admin UI is not authority. This service only aggregates existing backend truth.
 * No AI. No bid/winner edits. No money movement.
 */

const harajHistory = require('./haraj_history_analytics');

const AI_STATUS = Object.freeze({
  scope: 'DEFERRED — OWNER DECISION',
  implemented: false,
  summaries: false,
  recommendations: false,
});

const HIGH_RISK_ACTIONS = Object.freeze([
  { action: 'schedule.override', permission: 'auctions:ops', confirm: true, money: false, bidTruth: false },
  { action: 'auctioneer.assign', permission: 'auctions:ops', confirm: true, money: false, bidTruth: false },
  { action: 'bidder.suspend', permission: 'auctions:ops', confirm: true, money: false, bidTruth: false },
  { action: 'bidder.bid_limit.change', permission: 'auctions:ops', confirm: true, money: false, bidTruth: false },
  { action: 'inspection.resolve', permission: 'auctions:ops', confirm: true, money: false, bidTruth: false },
  { action: 'after_haraj.close', permission: 'auctions:ops', confirm: true, money: false, bidTruth: false },
]);

const FORBIDDEN = Object.freeze({
  editAcceptedBid: false,
  editHighestBidder: false,
  editBidHistory: false,
  editWinner: false,
  wallet: false,
  escrow: false,
  payout: false,
  manualBalanceEdit: false,
  realMoneyCapture: false,
});

async function getOverview(client) {
  const [sessions, rooms, queue, reviews, inspections, after, bidders, analytics] = await Promise.all([
    client.query(
      `SELECT id, category_code, status, timezone, scheduled_start_at, scheduled_end_at
       FROM haraj_sessions
       WHERE status IN ('planned','upcoming','live','paused')
       ORDER BY scheduled_start_at ASC
       LIMIT 20`,
    ),
    client.query(
      `SELECT rs.id, rs.status, rs.active_lot_id, rs.auctioneer_user_id, rs.haraj_session_id,
              r.code AS room_code, r.name_ar AS room_name, r.category_code
       FROM haraj_room_sessions rs
       JOIN haraj_rooms r ON r.id = rs.room_id
       WHERE rs.status IN ('pre_live','live','paused')
       ORDER BY rs.updated_at DESC
       LIMIT 20`,
    ),
    client.query(
      `SELECT status, COUNT(*)::int AS count
       FROM haraj_queue_entries
       GROUP BY status`,
    ),
    client.query(
      `SELECT COUNT(*)::int AS pending_reviews
       FROM auctions
       WHERE status = 'review'`,
    ),
    client.query(
      `SELECT p.status, COUNT(*)::int AS count
       FROM haraj_provisional_awards p
       WHERE p.status IN ('provisional','inspection_pending','disputed')
       GROUP BY p.status`,
    ),
    client.query(
      `SELECT mode, status, COUNT(*)::int AS count
       FROM haraj_after_listings
       WHERE status IN ('eligible','listed')
       GROUP BY mode, status`,
    ),
    client.query(
      `SELECT
         COUNT(*) FILTER (WHERE eligibility_status = 'suspended')::int AS suspended_bidders,
         COUNT(*) FILTER (WHERE eligibility_status IN ('pending','not_verified'))::int AS pending_bidders
       FROM haraj_bidder_profiles`,
    ).catch(() => ({ rows: [{ suspended_bidders: 0, pending_bidders: 0 }] })),
    harajHistory.getAnalytics(client, {}, { role: 'admin', actorUserId: 'command-center' }),
  ]);

  const warnings = [];
  if (Number(reviews.rows[0]?.pending_reviews || 0) > 0) {
    warnings.push({ code: 'PENDING_SELLER_REVIEWS', count: Number(reviews.rows[0].pending_reviews) });
  }
  const pendingInspections = inspections.rows.reduce((n, r) => n + Number(r.count), 0);
  if (pendingInspections > 0) {
    warnings.push({ code: 'PENDING_INSPECTIONS', count: pendingInspections });
  }
  if (Number(bidders.rows[0]?.suspended_bidders || 0) > 0) {
    warnings.push({ code: 'SUSPENDED_BIDDERS', count: Number(bidders.rows[0].suspended_bidders) });
  }

  return {
    timezone: 'Asia/Riyadh',
    readOnly: true,
    adminIsNotAuthority: true,
    ai: AI_STATUS,
    forbidden: FORBIDDEN,
    highRiskActions: HIGH_RISK_ACTIONS,
    sessions: sessions.rows.map((r) => ({
      sessionId: r.id,
      category: r.category_code,
      status: r.status,
      timezone: r.timezone,
      scheduledStartAt: r.scheduled_start_at,
      scheduledEndAt: r.scheduled_end_at,
    })),
    activeRooms: rooms.rows.map((r) => ({
      roomSessionId: r.id,
      sessionId: r.haraj_session_id,
      status: r.status,
      roomCode: r.room_code,
      roomName: r.room_name,
      category: r.category_code,
      activeLotId: r.active_lot_id,
      auctioneerUserId: r.auctioneer_user_id,
    })),
    queue: Object.fromEntries(queue.rows.map((r) => [r.status, Number(r.count)])),
    pendingSellerReviews: Number(reviews.rows[0]?.pending_reviews || 0),
    pendingInspections,
    inspectionBreakdown: Object.fromEntries(inspections.rows.map((r) => [r.status, Number(r.count)])),
    afterHaraj: after.rows.map((r) => ({ mode: r.mode, status: r.status, count: Number(r.count) })),
    bidderOps: {
      suspended: Number(bidders.rows[0]?.suspended_bidders || 0),
      pending: Number(bidders.rows[0]?.pending_bidders || 0),
    },
    analytics: analytics.metrics,
    analyticsLabels: analytics.labels,
    analyticsSource: 'haraj_history_analytics',
    warnings,
    riskPlaceholder: {
      available: false,
      gate: 'G16',
      note: 'Risk / disputes / fraud command surface is a G16 placeholder only.',
    },
    livekit: 'NOT IMPLEMENTED / NOT TESTED',
  };
}

module.exports = {
  AI_STATUS,
  HIGH_RISK_ACTIONS,
  FORBIDDEN,
  getOverview,
};
