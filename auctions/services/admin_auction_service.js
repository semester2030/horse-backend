'use strict';

const { mapAuctionRow } = require('./auction_service');
const { mapDisputeRow } = require('./dispute_service');
const { mapRiskRow } = require('./risk_service');
const { effectiveEndAt } = require('../domain/states');
const { mapAdminLocation } = require('./location_snapshot');
const {
  loadAuctionMetrics,
  resolveLiveViewers,
  bumpPeakLiveViewers,
} = require('./metrics_service');
const {
  listBids,
  getHostBookingForAuction,
} = require('./auction_query_service');

const ADMIN_BIDS_PAGE = 50;
const ADMIN_TIMELINE_CAP = 100;
const ADMIN_RISK_CAP = 50;
const ADMIN_DISPUTE_CAP = 50;

async function listBidderAggregates(pool, auctionId) {
  const { rows } = await pool.query(
    `SELECT bidder_user_id,
            COUNT(*)::int AS accepted_bid_count,
            MIN(created_at) AS first_bid_at,
            MAX(created_at) AS last_bid_at,
            MAX(amount)::numeric AS highest_bid
     FROM bids
     WHERE auction_id = $1::uuid
     GROUP BY bidder_user_id
     ORDER BY highest_bid DESC, last_bid_at DESC
     LIMIT 100`,
    [auctionId],
  );
  return rows.map((r) => ({
    bidderUserId: r.bidder_user_id,
    label: `مزايد ${String(r.bidder_user_id).slice(-4)}`,
    acceptedBidCount: r.accepted_bid_count,
    firstBidAt: r.first_bid_at,
    lastBidAt: r.last_bid_at,
    highestBid: Number(r.highest_bid),
  }));
}

async function getAdminAuctionDetail(pool, auctionId, { wsHub } = {}) {
  const { rows } = await pool.query(
    `SELECT a.*, l.listing_id, l.video_id, l.title AS lot_title
     FROM auctions a JOIN auction_lots l ON l.id = a.lot_id WHERE a.id = $1`,
    [auctionId],
  );
  if (!rows[0]) return null;
  const now = new Date();
  const row = rows[0];
  const auction = mapAuctionRow(row);
  auction.lotTitle = row.lot_title;
  auction.serverTime = now.toISOString();
  auction.effectiveEndAt = effectiveEndAt(row, now).toISOString();
  auction.nextValidBid =
    Number(auction.currentPrice) + Number(auction.minimumIncrement);
  auction.nextMinimumBid = auction.nextValidBid;

  const metrics = await loadAuctionMetrics(pool, auctionId);
  const liveViewers = resolveLiveViewers(wsHub, auctionId);
  if (liveViewers > 0) {
    try {
      await bumpPeakLiveViewers(pool, auctionId, liveViewers);
    } catch (_) {
      /* peak is soft */
    }
  }

  const bidsPage = await listBids(pool, auctionId, {
    limit: ADMIN_BIDS_PAGE,
    includeBidderId: true,
  });
  const mappedBids = bidsPage.bids;

  const events = await pool.query(
    `SELECT * FROM auction_events
     WHERE auction_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [auctionId, ADMIN_TIMELINE_CAP],
  );
  const disputes = await pool.query(
    `SELECT * FROM auction_disputes
     WHERE auction_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [auctionId, ADMIN_DISPUTE_CAP],
  );
  const risks = await pool.query(
    `SELECT * FROM auction_risk_signals
     WHERE auction_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [auctionId, ADMIN_RISK_CAP],
  );

  const timeline = events.rows.map((e) => ({
    id: e.id,
    type: 'event',
    eventType: e.event_type,
    payload: e.payload,
    actorUserId: e.actor_user_id,
    createdAt: e.created_at,
  }));
  for (const d of disputes.rows) {
    timeline.push({
      id: d.id,
      type: 'dispute',
      eventType: `dispute.${d.status}`,
      payload: mapDisputeRow(d),
      actorUserId: d.reporter_user_id,
      createdAt: d.created_at,
    });
  }
  for (const r of risks.rows) {
    timeline.push({
      id: r.id,
      type: 'risk',
      eventType: 'risk.signal',
      payload: mapRiskRow(r),
      actorUserId: 'system',
      createdAt: r.created_at,
    });
  }
  timeline.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  auction.bids = mappedBids;
  auction.bidsNextCursor = bidsPage.nextCursor;
  auction.bidsHasMore = bidsPage.hasMore;
  auction.timeline = timeline.slice(0, ADMIN_TIMELINE_CAP);
  auction.timelineTruncated = timeline.length >= ADMIN_TIMELINE_CAP;
  auction.disputes = disputes.rows.map(mapDisputeRow);
  auction.riskSignals = risks.rows.map(mapRiskRow);

  const adminLocation = mapAdminLocation(row);
  const bidders = await listBidderAggregates(pool, auctionId);
  const winnerId = auction.winnerUserId || null;
  const biddersWithWinner = bidders.map((b) => ({
    ...b,
    isWinner: winnerId != null && String(b.bidderUserId) === String(winnerId),
  }));

  let hostSection = null;
  try {
    hostSection = await getHostBookingForAuction(pool, auctionId);
  } catch (_) {
    hostSection = null;
  }

  auction.sections = {
    overview: {
      id: auction.id,
      listingId: auction.listingId,
      videoId: auction.videoId,
      species: auction.species,
      lotTitle: auction.lotTitle,
      ownerUserId: auction.ownerUserId,
      hostId: hostSection?.hostId || null,
      hostDisplayName: hostSection?.hostDisplayName || null,
      status: auction.status,
      startingPrice: auction.startingPrice,
      currentPrice: auction.currentPrice,
      nextMinimumBid: auction.nextMinimumBid,
      minimumIncrement: auction.minimumIncrement,
      reservePrice: auction.reservePrice ?? null,
      startAt: auction.startAt,
      endAt: auction.endAt,
      effectiveEndAt: auction.effectiveEndAt,
      bidCount: metrics.bidCount,
      uniqueBidders: metrics.uniqueBidders,
      viewCount: metrics.viewCount,
      uniqueViewers: metrics.uniqueViewers,
      liveViewers,
      peakLiveViewers: auction.peakLiveViewers || 0,
      extensionsCount: metrics.extensionsCount,
      location: adminLocation,
      audioStatus: hostSection?.audioStatus || null,
      version: auction.version,
      createdAt: auction.createdAt,
      updatedAt: auction.updatedAt,
    },
    liveMetrics: {
      viewCount: metrics.viewCount,
      uniqueViewers: metrics.uniqueViewers,
      liveViewers,
      peakLiveViewers: auction.peakLiveViewers || 0,
      uniqueBidders: metrics.uniqueBidders,
      bidCount: metrics.bidCount,
      extensionsCount: metrics.extensionsCount,
      currentPrice: auction.currentPrice,
      nextMinimumBid: auction.nextMinimumBid,
      effectiveEndAt: auction.effectiveEndAt,
      hostPresenceLabel: hostSection?.hostPresenceLabel || null,
      audioStatus: hostSection?.audioStatus || null,
    },
    bids: mappedBids,
    bidsNextCursor: bidsPage.nextCursor,
    bidsHasMore: bidsPage.hasMore,
    bidders: biddersWithWinner,
    viewersAggregates: {
      viewCount: metrics.viewCount,
      uniqueViewers: metrics.uniqueViewers,
      liveViewers,
      peakLiveViewers: auction.peakLiveViewers || 0,
      note: 'Aggregates only — no per-user viewer surveillance list',
    },
    host: hostSection,
    location: adminLocation,
    media: {
      listingId: auction.listingId,
      videoId: auction.videoId,
      lotTitle: auction.lotTitle,
    },
    timeline: auction.timeline,
    timelineTruncated: auction.timelineTruncated,
    risk: auction.riskSignals,
    disputes: auction.disputes,
  };

  auction.viewCount = metrics.viewCount;
  auction.uniqueViewers = metrics.uniqueViewers;
  auction.liveViewers = liveViewers;
  auction.uniqueBidders = metrics.uniqueBidders;
  auction.bidCount = metrics.bidCount;
  auction.extensionsCount = metrics.extensionsCount;
  auction.location = adminLocation;
  if (hostSection) {
    auction.hostId = hostSection.hostId;
    auction.hostDisplayName = hostSection.hostDisplayName;
  }

  return auction;
}

async function listAdminAuctions(pool, filters = {}) {
  const clauses = ['1=1'];
  const params = [];
  let n = 1;

  if (filters.status) {
    if (filters.status === 'disputed') {
      clauses.push(
        `EXISTS (SELECT 1 FROM auction_disputes d WHERE d.auction_id = a.id AND d.status IN ('open','reviewing'))`,
      );
    } else {
      clauses.push(`a.status = $${n++}`);
      params.push(String(filters.status).toLowerCase());
    }
  }

  if (filters.species) {
    clauses.push(`a.species = $${n++}`);
    params.push(String(filters.species).toLowerCase());
  }
  if (filters.ownerUserId) {
    clauses.push(`a.owner_user_id = $${n++}`);
    params.push(String(filters.ownerUserId));
  }
  if (filters.hostId) {
    clauses.push(
      `EXISTS (SELECT 1 FROM host_bookings hb WHERE hb.auction_id = a.id AND hb.host_id = $${n++} AND hb.status IN ('requested','accepted','scheduled'))`,
    );
    params.push(filters.hostId);
  }
  if (filters.liveNow === 'true' || filters.liveNow === true) {
    clauses.push(`a.status IN ('live','extended')`);
  }
  if (filters.fromDate) {
    clauses.push(`a.start_at >= $${n++}`);
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    clauses.push(`a.start_at <= $${n++}`);
    params.push(filters.toDate);
  }
  if (filters.minPrice != null) {
    clauses.push(`a.current_price >= $${n++}`);
    params.push(Number(filters.minPrice));
  }
  if (filters.maxPrice != null) {
    clauses.push(`a.current_price <= $${n++}`);
    params.push(Number(filters.maxPrice));
  }
  if (filters.q) {
    clauses.push(
      `(l.listing_id ILIKE $${n} OR l.video_id ILIKE $${n} OR l.title ILIKE $${n} OR a.id::text ILIKE $${n})`,
    );
    params.push(`%${filters.q}%`);
    n++;
  }

  params.push(Math.min(Number(filters.limit) || 50, 100));

  const sql = `
    SELECT a.*, l.listing_id, l.video_id, l.title AS lot_title,
           hb.host_id, ah.display_name AS host_display_name,
           (SELECT COUNT(*)::int FROM auction_disputes d
            WHERE d.auction_id = a.id AND d.status IN ('open','reviewing')) AS open_disputes,
           (SELECT COUNT(*)::int FROM auction_risk_signals rs
            WHERE rs.auction_id = a.id AND rs.acknowledged = false) AS open_risk_signals
    FROM auctions a
    JOIN auction_lots l ON l.id = a.lot_id
    LEFT JOIN host_bookings hb ON hb.auction_id = a.id AND hb.status IN ('requested','accepted','scheduled')
    LEFT JOIN auction_hosts ah ON ah.id = hb.host_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY
      CASE a.status WHEN 'live' THEN 0 WHEN 'extended' THEN 1 WHEN 'frozen' THEN 2
                    WHEN 'review' THEN 3 WHEN 'scheduled' THEN 4 ELSE 5 END,
      a.updated_at DESC
    LIMIT $${n}`;

  const { rows } = await pool.query(sql, params);
  const now = new Date();
  return rows.map((row) => {
    const a = mapAuctionRow(row);
    a.lotTitle = row.lot_title;
    a.hostId = row.host_id;
    a.hostDisplayName = row.host_display_name;
    a.openDisputes = row.open_disputes;
    a.openRiskSignals = row.open_risk_signals;
    a.serverTime = now.toISOString();
    a.effectiveEndAt = effectiveEndAt(row, now).toISOString();
    return a;
  });
}

module.exports = {
  listAdminAuctions,
  getAdminAuctionDetail,
  listBidderAggregates,
  ADMIN_BIDS_PAGE,
  ADMIN_TIMELINE_CAP,
};
