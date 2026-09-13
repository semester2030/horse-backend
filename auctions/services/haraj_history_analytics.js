'use strict';

/**
 * G13 — History & Analytics (read-only).
 * Reconstructs Haraj history from auctions, bids, auction_events, G11, G12.
 * Analytics are deterministic aggregates — never Auction Core truth.
 * No AI. No settlement/revenue labels. No writes to operational tables.
 */

const AI_SCOPE = 'DEFERRED — OWNER DECISION';
const AI_STATUS = Object.freeze({
  scope: AI_SCOPE,
  implemented: false,
  analytics: false,
  recommendations: false,
});

const PRESENTATION_TIMEZONE = 'Asia/Riyadh';
const RIYADH_OFFSET = '+03:00';

const MONEY_TERMS = Object.freeze({
  highestBidVolume: 'highest_bid_volume_sar — sum of historical highest bids, NOT revenue',
  acceptedOfferHandoff: 'accepted_offer_handoff_sar — commercial handoff amount, NOT settled cash',
  notRevenue: true,
  notGmvSettled: true,
  notCashReceived: true,
  notSellerPayout: true,
});

const EVENT_LABELS = Object.freeze({
  'auction.created': 'lot_submitted',
  'haraj.seller.draft_updated': 'draft_updated',
  'auction.status_changed': 'status_changed',
  'bid.accepted': 'bid',
  'haraj.review.accepted': 'approved',
  'haraj.review.rejected': 'review_rejected',
  'haraj.review.changes_requested': 'changes_requested',
  'haraj.disclosure.snapshot': 'inspection_disclosure_snapshot',
  'haraj.inspection.opened': 'inspection_opened',
  'haraj.inspection.buyer_accepted': 'inspection_accepted',
  'haraj.inspection.mismatch_claimed': 'inspection_mismatch',
  'haraj.inspection.buyer_withdrawn': 'inspection_withdrawn',
  'haraj.after.activated': 'after_haraj_activated',
  'haraj.after.mode_changed': 'after_haraj_mode_changed',
  'haraj.after.offer.submitted': 'after_haraj_offer',
  'haraj.after.offer.accepted': 'after_haraj_offer_accepted',
  'haraj.after.reauction': 'reauction_requested',
  'haraj.after.reauction.source': 'reauction_sourced',
  'haraj.after.closed': 'after_haraj_closed',
});

function fail(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (details) err.details = details;
  throw err;
}

function viewerRole({ actorUserId, actorRole, ownerUserId, bidderIds = [], offeredIds = [] }) {
  const role = String(actorRole || '');
  if (role === 'admin') return 'admin';
  const actor = String(actorUserId || '');
  if (!actor) return 'anon';
  if (actor === String(ownerUserId || '')) return 'seller';
  if (bidderIds.map(String).includes(actor) || offeredIds.map(String).includes(actor)) return 'buyer';
  if (role === 'auctioneer') return 'auctioneer';
  return 'none';
}

function parseRange(from, to) {
  const out = { from: null, to: null, timezone: PRESENTATION_TIMEZONE };
  if (from) {
    const s = String(from).trim();
    out.from = /^\d{4}-\d{2}-\d{2}$/.test(s)
      ? new Date(`${s}T00:00:00${RIYADH_OFFSET}`)
      : new Date(s);
    if (Number.isNaN(out.from.getTime())) fail(400, 'HISTORY_RANGE_INVALID', 'Invalid from');
  }
  if (to) {
    const s = String(to).trim();
    out.to = /^\d{4}-\d{2}-\d{2}$/.test(s)
      ? new Date(`${s}T23:59:59.999${RIYADH_OFFSET}`)
      : new Date(s);
    if (Number.isNaN(out.to.getTime())) fail(400, 'HISTORY_RANGE_INVALID', 'Invalid to');
  }
  if (out.from && out.to && out.from > out.to) {
    fail(400, 'HISTORY_RANGE_INVALID', 'from must be <= to');
  }
  return out;
}

function riyadhDayBounds(dateStr) {
  return parseRange(dateStr, dateStr);
}

function applyScope(clauses, params, filters, { forceOwnerId } = {}) {
  let n = params.length + 1;
  if (filters.species) {
    clauses.push(`a.species = $${n++}`);
    params.push(String(filters.species).toLowerCase());
  }
  if (filters.status) {
    clauses.push(`a.status = $${n++}`);
    params.push(String(filters.status).toLowerCase());
  }
  if (forceOwnerId) {
    clauses.push(`a.owner_user_id = $${n++}`);
    params.push(String(forceOwnerId));
  } else if (filters.ownerUserId) {
    clauses.push(`a.owner_user_id = $${n++}`);
    params.push(String(filters.ownerUserId));
  }
  if (filters.afterHarajMode) {
    clauses.push(`al.mode = $${n++}`);
    params.push(String(filters.afterHarajMode));
  }
  if (filters.inspectionOutcome) {
    clauses.push(`p.status = $${n++}`);
    params.push(String(filters.inspectionOutcome));
  }
  if (filters.roomSessionId) {
    clauses.push(`qe.room_session_id = $${n++}`);
    params.push(String(filters.roomSessionId));
  }
  if (filters.sessionId) {
    clauses.push(`rs.haraj_session_id = $${n++}`);
    params.push(String(filters.sessionId));
  }
  const range = parseRange(filters.from, filters.to);
  if (range.from) {
    clauses.push(`COALESCE(a.start_at, a.created_at) >= $${n++}`);
    params.push(range.from.toISOString());
  }
  if (range.to) {
    clauses.push(`COALESCE(a.start_at, a.created_at) <= $${n++}`);
    params.push(range.to.toISOString());
  }
  return range;
}

function scopedFrom() {
  return `
    FROM auctions a
    JOIN auction_lots l ON l.id = a.lot_id
    LEFT JOIN haraj_provisional_awards p ON p.auction_id = a.id
    LEFT JOIN haraj_after_listings al ON al.auction_id = a.id
    LEFT JOIN LATERAL (
      SELECT qe.room_session_id, qe.status AS queue_status
      FROM haraj_queue_entries qe
      WHERE qe.auction_id = a.id
      ORDER BY qe.created_at DESC
      LIMIT 1
    ) qe ON true
    LEFT JOIN haraj_room_sessions rs ON rs.id = qe.room_session_id
  `;
}

function stripPrivate(record, role) {
  const next = { ...record };
  delete next.bidLimit;
  delete next.activeExposure;
  delete next.authorizedLimit;
  delete next.psp;
  delete next.pspReference;
  delete next.inspectionEvidence;
  delete next.operatorNotes;
  delete next.riskFlags;
  delete next.privateBuyerContact;
  delete next.privateSellerContact;
  if (role !== 'admin') {
    delete next.sellerUserId;
    if (role !== 'seller') delete next.winnerUserId;
  }
  return next;
}

function mapHistoryRow(row, role) {
  const record = {
    auctionId: row.id,
    lotId: row.lot_id,
    lotTitle: row.lot_title || null,
    species: row.species,
    auctionStatus: row.status,
    sellerUserId: row.owner_user_id,
    startAt: row.start_at,
    endAt: row.end_at,
    highestBid: row.current_price != null ? Number(row.current_price) : null,
    highestBidIsNotRevenue: true,
    winnerUserId: row.winner_user_id || null,
    g11Outcome: row.award_status || null,
    afterHarajMode: row.after_mode || null,
    afterHarajStatus: row.after_status || null,
    roomSessionId: row.room_session_id || null,
    queueStatus: row.queue_status || null,
    bidCount: Number(row.bid_count || 0),
    uniqueBidders: Number(row.unique_bidders || 0),
    reauctionNewAuctionId: row.reauction_new_id || null,
    reauctionSourceAuctionId: row.reauction_source_id || null,
  };
  return stripPrivate(record, role);
}

async function loadHistoryList(client, filters, { role, actorUserId }) {
  if (role === 'anon' || role === 'none') {
    fail(401, 'HISTORY_AUTH_REQUIRED', 'Authentication required for Haraj history');
  }
  if (role === 'auctioneer' && !filters.auctionId) {
    /* auctioneer may list but not another seller's private analytics */
  }
  const clauses = ['1=1'];
  const params = [];
  const forceOwnerId = role === 'seller' ? actorUserId : null;
  if (role === 'buyer' || role === 'user') {
    const idx = params.length + 1;
    clauses.push(`(
      a.owner_user_id = $${idx}
      OR EXISTS (SELECT 1 FROM bids b WHERE b.auction_id = a.id AND b.bidder_user_id = $${idx})
      OR EXISTS (
        SELECT 1 FROM auction_events e
        WHERE e.auction_id = a.id
          AND e.event_type = 'haraj.after.offer.submitted'
          AND e.payload->>'buyerUserId' = $${idx}
      )
    )`);
    params.push(String(actorUserId));
  }
  if (role === 'auctioneer') {
    const idx = params.length + 1;
    clauses.push(`(
      rs.auctioneer_user_id = $${idx}
      OR EXISTS (
        SELECT 1 FROM auction_events e
        WHERE e.auction_id = a.id
          AND e.actor_user_id = $${idx}
          AND e.event_type LIKE 'haraj.review%'
      )
    )`);
    params.push(String(actorUserId));
  }
  const range = applyScope(clauses, params, filters, { forceOwnerId });
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  params.push(limit);
  const { rows } = await client.query(
    `SELECT a.id, a.lot_id, a.species, a.status, a.owner_user_id, a.start_at, a.end_at,
            a.current_price, a.winner_user_id, l.title AS lot_title,
            p.status AS award_status, al.mode AS after_mode, al.status AS after_status,
            qe.room_session_id, qe.queue_status,
            COALESCE((SELECT COUNT(*)::int FROM bids b WHERE b.auction_id = a.id), 0) AS bid_count,
            COALESCE((SELECT COUNT(DISTINCT bidder_user_id)::int FROM bids b WHERE b.auction_id = a.id), 0) AS unique_bidders,
            (SELECT payload->>'newAuctionId' FROM auction_events
              WHERE auction_id = a.id AND event_type = 'haraj.after.reauction'
              ORDER BY created_at DESC LIMIT 1) AS reauction_new_id,
            (SELECT payload->>'sourceAuctionId' FROM auction_events
              WHERE auction_id = a.id AND event_type = 'haraj.after.reauction.source'
              ORDER BY created_at DESC LIMIT 1) AS reauction_source_id
     ${scopedFrom()}
     WHERE ${clauses.join(' AND ')}
     ORDER BY COALESCE(a.start_at, a.created_at) DESC
     LIMIT $${params.length}`,
    params,
  );
  return {
    items: rows.map((r) => mapHistoryRow(r, role)),
    count: rows.length,
    timezone: PRESENTATION_TIMEZONE,
    range,
    moneyTerms: MONEY_TERMS,
    ai: AI_STATUS,
    readOnly: true,
  };
}

function timelineFromEvents(events) {
  return events.map((e) => {
    const payload = e.payload && typeof e.payload === 'object' ? e.payload : {};
    const label = EVENT_LABELS[e.event_type] || null;
    return {
      at: e.created_at,
      eventType: e.event_type,
      phase: label || 'recorded_event',
      available: true,
      fabricated: false,
      to: payload.to || payload.status || payload.mode || null,
    };
  });
}

async function getRecord(client, { auctionId, actorUserId, actorRole }) {
  const { rows } = await client.query(
    `SELECT a.*, l.title AS lot_title, l.id AS lot_row_id,
            p.status AS award_status, al.mode AS after_mode, al.status AS after_status
     FROM auctions a
     JOIN auction_lots l ON l.id = a.lot_id
     LEFT JOIN haraj_provisional_awards p ON p.auction_id = a.id
     LEFT JOIN haraj_after_listings al ON al.auction_id = a.id
     WHERE a.id = $1`,
    [auctionId],
  );
  if (!rows[0]) fail(404, 'AUCTION_NOT_FOUND', 'Auction not found');
  const row = rows[0];
  const bids = await client.query(
    `SELECT bidder_user_id, amount, created_at FROM bids WHERE auction_id = $1 ORDER BY amount DESC, created_at ASC`,
    [auctionId],
  );
  const offerActors = await client.query(
    `SELECT payload->>'buyerUserId' AS buyer
     FROM auction_events
     WHERE auction_id = $1 AND event_type = 'haraj.after.offer.submitted'`,
    [auctionId],
  );
  const role = viewerRole({
    actorUserId,
    actorRole,
    ownerUserId: row.owner_user_id,
    bidderIds: bids.rows.map((b) => b.bidder_user_id),
    offeredIds: offerActors.rows.map((r) => r.buyer).filter(Boolean),
  });
  if (role === 'anon') fail(401, 'HISTORY_AUTH_REQUIRED', 'Authentication required');
  if (role === 'none') fail(403, 'HISTORY_FORBIDDEN', 'Not authorized for this Haraj history');

  const events = await client.query(
    `SELECT event_type, payload, created_at, actor_user_id
     FROM auction_events WHERE auction_id = $1
     ORDER BY created_at ASC, id ASC`,
    [auctionId],
  );
  const reauction = events.rows.find((e) => e.event_type === 'haraj.after.reauction');
  const sourced = events.rows.find((e) => e.event_type === 'haraj.after.reauction.source');

  const bidHistory = role === 'admin' || role === 'seller'
    ? bids.rows.map((b) => ({
      amount: Number(b.amount),
      createdAt: b.created_at,
      bidderUserId: role === 'admin' ? b.bidder_user_id : undefined,
    }))
    : bids.rows
      .filter((b) => String(b.bidder_user_id) === String(actorUserId))
      .map((b) => ({ amount: Number(b.amount), createdAt: b.created_at, own: true }));

  const record = {
    auctionId: row.id,
    lotId: row.lot_id,
    lotTitle: row.lot_title,
    species: row.species,
    auctionStatus: row.status,
    sellerUserId: row.owner_user_id,
    startAt: row.start_at,
    endAt: row.end_at,
    highestBid: Number(row.current_price),
    highestBidIsNotRevenue: true,
    winnerUserId: row.winner_user_id,
    g11Outcome: row.award_status || null,
    afterHarajMode: row.after_mode || null,
    afterHarajStatus: row.after_status || null,
    timeline: timelineFromEvents(events.rows),
    timelineNote: 'Only recorded events. Missing steps are omitted, not invented.',
    bidHistory,
    bidHistoriesNotMergedAcrossReauction: true,
    reauction: {
      newAuctionId: reauction?.payload?.newAuctionId || null,
      sourceAuctionId: sourced?.payload?.sourceAuctionId || row.id,
      lastBidCopied: false,
    },
    media: {
      videoCloudflareId: row.media_video_cloudflare_id || null,
      reused: true,
    },
    moneyTerms: MONEY_TERMS,
    timezone: PRESENTATION_TIMEZONE,
    viewerRole: role,
    ai: AI_STATUS,
    readOnly: true,
    settlementImplemented: false,
  };
  return stripPrivate(record, role);
}

async function getAnalytics(client, filters, { role, actorUserId }) {
  if (role !== 'admin' && role !== 'seller') {
    fail(403, 'ANALYTICS_FORBIDDEN', 'Haraj analytics are not public');
  }
  const clauses = ['1=1'];
  const params = [];
  const forceOwnerId = role === 'seller' ? actorUserId : null;
  const range = applyScope(clauses, params, filters, { forceOwnerId });
  const where = clauses.join(' AND ');

  const [auctions, bids, offers, reauctions] = await Promise.all([
    client.query(
      `SELECT
         COUNT(*)::int AS auction_count,
         COUNT(*) FILTER (WHERE a.status IN ('sold','unsold'))::int AS completed_count,
         COUNT(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled_count,
         COUNT(*) FILTER (WHERE a.status = 'sold')::int AS sold_count,
         COUNT(*) FILTER (WHERE a.status = 'unsold')::int AS unsold_count,
         COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM bids b WHERE b.auction_id = a.id))::int AS with_bids_count,
         COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM bids b WHERE b.auction_id = a.id))::int AS without_bids_count,
         COALESCE(SUM(a.current_price) FILTER (
           WHERE EXISTS (SELECT 1 FROM bids b WHERE b.auction_id = a.id)
         ), 0)::numeric AS highest_bid_volume_sar,
         COUNT(DISTINCT a.owner_user_id)::int AS unique_sellers,
         COUNT(*) FILTER (WHERE a.species = 'horse')::int AS horse_count,
         COUNT(*) FILTER (WHERE a.species = 'camel')::int AS camel_count,
         COUNT(*) FILTER (WHERE a.species = 'falcon')::int AS falcon_count,
         COUNT(*) FILTER (WHERE p.status = 'accepted')::int AS inspection_accepted,
         COUNT(*) FILTER (WHERE p.status = 'disputed')::int AS inspection_disputed,
         COUNT(*) FILTER (WHERE p.status = 'withdrawn')::int AS inspection_withdrawn,
         COUNT(*) FILTER (WHERE p.status = 'cancelled')::int AS inspection_cancelled,
         COUNT(*) FILTER (WHERE al.mode = 'available_at_approved_price')::int AS after_fixed,
         COUNT(*) FILTER (WHERE al.mode = 'accept_offers')::int AS after_offers,
         COUNT(*) FILTER (WHERE al.mode = 're_auction')::int AS after_reauction,
         COUNT(*) FILTER (WHERE al.mode IN ('history_only','closed'))::int AS after_history_only,
         COUNT(DISTINCT qe.room_session_id)::int AS room_session_count,
         COUNT(DISTINCT rs.haraj_session_id)::int AS session_count
       ${scopedFrom()}
       WHERE ${where}`,
      params,
    ),
    client.query(
      `SELECT COUNT(*)::int AS total_bids,
              COUNT(DISTINCT b.bidder_user_id)::int AS unique_bidders
       FROM bids b
       JOIN auctions a ON a.id = b.auction_id
       JOIN auction_lots l ON l.id = a.lot_id
       LEFT JOIN haraj_provisional_awards p ON p.auction_id = a.id
       LEFT JOIN haraj_after_listings al ON al.auction_id = a.id
       LEFT JOIN LATERAL (
         SELECT qe.room_session_id FROM haraj_queue_entries qe
         WHERE qe.auction_id = a.id ORDER BY qe.created_at DESC LIMIT 1
       ) qe ON true
       LEFT JOIN haraj_room_sessions rs ON rs.id = qe.room_session_id
       WHERE ${where}`,
      params,
    ),
    client.query(
      `SELECT
         COUNT(*) FILTER (WHERE e.event_type = 'haraj.after.offer.submitted')::int AS offer_count,
         COALESCE(SUM((e.payload->>'amount')::numeric)
           FILTER (WHERE e.event_type = 'haraj.after.offer.accepted'), 0)::numeric AS accepted_offer_handoff_sar
       FROM auction_events e
       JOIN auctions a ON a.id = e.auction_id
       JOIN auction_lots l ON l.id = a.lot_id
       LEFT JOIN haraj_provisional_awards p ON p.auction_id = a.id
       LEFT JOIN haraj_after_listings al ON al.auction_id = a.id
       LEFT JOIN LATERAL (
         SELECT qe.room_session_id FROM haraj_queue_entries qe
         WHERE qe.auction_id = a.id ORDER BY qe.created_at DESC LIMIT 1
       ) qe ON true
       LEFT JOIN haraj_room_sessions rs ON rs.id = qe.room_session_id
       WHERE ${where}
         AND e.event_type IN ('haraj.after.offer.submitted','haraj.after.offer.accepted')`,
      params,
    ),
    client.query(
      `SELECT COUNT(*)::int AS reauction_count
       FROM auction_events e
       JOIN auctions a ON a.id = e.auction_id
       JOIN auction_lots l ON l.id = a.lot_id
       LEFT JOIN haraj_provisional_awards p ON p.auction_id = a.id
       LEFT JOIN haraj_after_listings al ON al.auction_id = a.id
       LEFT JOIN LATERAL (
         SELECT qe.room_session_id FROM haraj_queue_entries qe
         WHERE qe.auction_id = a.id ORDER BY qe.created_at DESC LIMIT 1
       ) qe ON true
       LEFT JOIN haraj_room_sessions rs ON rs.id = qe.room_session_id
       WHERE ${where} AND e.event_type = 'haraj.after.reauction'`,
      params,
    ),
  ]);

  const a = auctions.rows[0];
  const b = bids.rows[0];
  const completed = Number(a.completed_count);
  const totalBids = Number(b.total_bids);
  return {
    timezone: PRESENTATION_TIMEZONE,
    range,
    readOnly: true,
    authoritative: true,
    notAuctionTruth: true,
    ai: AI_STATUS,
    moneyTerms: MONEY_TERMS,
    metrics: {
      auctionCount: Number(a.auction_count),
      completedCount: completed,
      cancelledCount: Number(a.cancelled_count),
      soldCount: Number(a.sold_count),
      unsoldCount: Number(a.unsold_count),
      withBidsCount: Number(a.with_bids_count),
      withoutBidsCount: Number(a.without_bids_count),
      totalBids,
      uniqueBidders: Number(b.unique_bidders),
      uniqueSellers: Number(a.unique_sellers),
      averageBidsPerAuction: Number(a.auction_count) ? Math.round((totalBids / Number(a.auction_count)) * 100) / 100 : 0,
      speciesDistribution: {
        horse: Number(a.horse_count),
        camel: Number(a.camel_count),
        falcon: Number(a.falcon_count),
      },
      roomSessionCount: Number(a.room_session_count),
      sessionCount: Number(a.session_count),
      inspectionOutcomes: {
        accepted: Number(a.inspection_accepted),
        disputed: Number(a.inspection_disputed),
        withdrawn: Number(a.inspection_withdrawn),
        cancelled: Number(a.inspection_cancelled),
      },
      afterHarajModes: {
        available_at_approved_price: Number(a.after_fixed),
        accept_offers: Number(a.after_offers),
        re_auction: Number(a.after_reauction),
        history_only: Number(a.after_history_only),
      },
      offerCount: Number(offers.rows[0].offer_count),
      reauctionCount: Number(reauctions.rows[0].reauction_count),
      highestBidVolumeSar: Number(a.highest_bid_volume_sar),
      acceptedOfferHandoffSar: Number(offers.rows[0].accepted_offer_handoff_sar),
    },
    labels: {
      highestBidVolumeSar: 'Historical highest-bid volume — NOT revenue / NOT GMV settled',
      acceptedOfferHandoffSar: 'Accepted After-Haraj handoff amount — NOT cash received / NOT seller payout',
    },
  };
}

function toCsv(items) {
  const headers = [
    'auctionId',
    'lotTitle',
    'species',
    'auctionStatus',
    'highestBid',
    'g11Outcome',
    'afterHarajMode',
    'bidCount',
    'startAt',
    'endAt',
  ];
  const lines = [headers.join(',')];
  for (const item of items) {
    lines.push(headers.map((h) => {
      const v = item[h] == null ? '' : String(item[h]).replace(/"/g, '""');
      return /[",\n]/.test(v) ? `"${v}"` : v;
    }).join(','));
  }
  return lines.join('\n');
}

module.exports = {
  AI_SCOPE,
  AI_STATUS,
  PRESENTATION_TIMEZONE,
  MONEY_TERMS,
  EVENT_LABELS,
  viewerRole,
  parseRange,
  riyadhDayBounds,
  stripPrivate,
  timelineFromEvents,
  loadHistoryList,
  getRecord,
  getAnalytics,
  toCsv,
};
