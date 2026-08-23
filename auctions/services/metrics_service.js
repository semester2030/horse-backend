'use strict';

/**
 * Thin auction metrics — not an analytics platform.
 *
 * Definitions:
 * - viewCount / uniqueViewers: COUNT(*) of auction_view_sessions (1 row per viewer)
 * - liveViewers: ephemeral WS room unique userIds (never PG SoT)
 * - uniqueBidders: COUNT(DISTINCT bidder_user_id) from bids
 * - bidCount: COUNT(*) from bids
 * - peakLiveViewers: soft gauge on auctions row (best-effort)
 */

async function recordQualifiedView(poolOrClient, { auctionId, viewerKey }) {
  const key = String(viewerKey || '').trim();
  const aid = String(auctionId || '').trim();
  if (!aid || !key) {
    const err = new Error('auctionId and viewerKey required');
    err.code = 'AUCTION_VIEW_INVALID';
    err.status = 400;
    throw err;
  }

  const { rows } = await poolOrClient.query(
    `INSERT INTO auction_view_sessions (auction_id, viewer_key)
     VALUES ($1::uuid, $2)
     ON CONFLICT (auction_id, viewer_key)
     DO UPDATE SET last_seen_at = NOW()
     RETURNING (xmax = 0) AS inserted, first_seen_at, last_seen_at`,
    [aid, key],
  );
  const row = rows[0];
  return {
    inserted: Boolean(row?.inserted),
    firstSeenAt: row?.first_seen_at,
    lastSeenAt: row?.last_seen_at,
  };
}

async function getViewAggregates(poolOrClient, auctionId) {
  const { rows } = await poolOrClient.query(
    `SELECT COUNT(*)::int AS view_count
     FROM auction_view_sessions WHERE auction_id = $1::uuid`,
    [auctionId],
  );
  const viewCount = rows[0]?.view_count || 0;
  // One session row per viewer ⇒ uniqueViewers === viewCount under current policy.
  return { viewCount, uniqueViewers: viewCount };
}

async function getBidAggregates(poolOrClient, auctionId) {
  const { rows } = await poolOrClient.query(
    `SELECT COUNT(*)::int AS bid_count,
            COUNT(DISTINCT bidder_user_id)::int AS unique_bidders
     FROM bids WHERE auction_id = $1::uuid`,
    [auctionId],
  );
  return {
    bidCount: rows[0]?.bid_count || 0,
    uniqueBidders: rows[0]?.unique_bidders || 0,
  };
}

async function getExtensionsCount(poolOrClient, auctionId) {
  // Anti-snipe ticks: bid.accepted events that left auction in extended state.
  const { rows } = await poolOrClient.query(
    `SELECT COUNT(*)::int AS n
     FROM auction_events
     WHERE auction_id = $1::uuid
       AND event_type = 'bid.accepted'
       AND COALESCE(payload->>'status', '') = 'extended'`,
    [auctionId],
  );
  return rows[0]?.n || 0;
}

async function loadAuctionMetrics(poolOrClient, auctionId) {
  // Sequential — safe when poolOrClient is a single pg Client inside a transaction.
  const views = await getViewAggregates(poolOrClient, auctionId);
  const bids = await getBidAggregates(poolOrClient, auctionId);
  const extensionsCount = await getExtensionsCount(poolOrClient, auctionId);
  return {
    viewCount: views.viewCount,
    uniqueViewers: views.uniqueViewers,
    uniqueBidders: bids.uniqueBidders,
    bidCount: bids.bidCount,
    extensionsCount,
  };
}

async function bumpPeakLiveViewers(poolOrClient, auctionId, liveViewers) {
  const n = Math.max(0, Number(liveViewers) || 0);
  if (n <= 0) return;
  await poolOrClient.query(
    `UPDATE auctions
     SET peak_live_viewers = GREATEST(peak_live_viewers, $2),
         updated_at = updated_at
     WHERE id = $1::uuid AND peak_live_viewers < $2`,
    [auctionId, n],
  );
}

/**
 * Count unique authenticated users in an auction WS room.
 * Multiple devices for same userId count as 1.
 * Uses room map only — do not recurse into hub.auctionLiveViewers.
 */
function countLiveViewersFromHub(wsHub, auctionId) {
  if (!wsHub || !auctionId) return 0;
  const room = `auction:${auctionId}`;
  const set = wsHub._rooms?.get?.(room);
  if (!set || set.size === 0) return 0;
  const ids = new Set();
  for (const c of set) {
    if (c?.userId) ids.add(String(c.userId));
  }
  return ids.size;
}

function resolveLiveViewers(wsHub, auctionId) {
  if (!wsHub || !auctionId) return 0;
  if (typeof wsHub.auctionLiveViewers === 'function') {
    return Number(wsHub.auctionLiveViewers(auctionId)) || 0;
  }
  return countLiveViewersFromHub(wsHub, auctionId);
}

module.exports = {
  recordQualifiedView,
  getViewAggregates,
  getBidAggregates,
  getExtensionsCount,
  loadAuctionMetrics,
  bumpPeakLiveViewers,
  countLiveViewersFromHub,
  resolveLiveViewers,
};
