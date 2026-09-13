'use strict';

const { mapAuctionRow } = require('./auction_service');
const { mapBidRow } = require('./bid_service');
const { effectiveEndAt } = require('../domain/states');
const { audienceAudioLabel } = require('./audio_service');
const { isAuctionApproved } = require('./approval_flow');
const {
  loadAuctionMetrics,
  bumpPeakLiveViewers,
  resolveLiveViewers,
} = require('./metrics_service');
const { mapPublicLocation } = require('./location_snapshot');

function enrichVideoFromStore(auction, store) {
  if (!auction) return auction;
  // Auction-owned media wins; never overwrite with store if already set.
  if (auction.videoUrl || auction.mediaVideoHlsUrl) {
    return {
      ...auction,
      videoUrl: auction.videoUrl || auction.mediaVideoHlsUrl || null,
      videoThumbnail:
        auction.videoThumbnail || auction.mediaVideoThumbnailUrl || null,
    };
  }
  if (!store?.videos) return auction;
  const vid = auction.videoId;
  if (!vid) return auction;
  const v = store.videos.get(String(vid));
  if (!v) return auction;
  return {
    ...auction,
    videoUrl: v.playbackUrl || v.hlsUrl || v.url || null,
    videoThumbnail: v.thumbnailUrl || v.thumbnail || null,
    videoTitle: v.title || v.caption || null,
  };
}

function bucketFilter(bucket) {
  const b = String(bucket || 'all').toLowerCase();
  if (b === 'upcoming') {
    return ["'scheduled'"];
  }
  if (b === 'live') {
    return ["'live'", "'extended'"];
  }
  if (b === 'ended') {
    return ["'ended'", "'sold'", "'unsold'"];
  }
  return null;
}

function encodeBidCursor(row) {
  return Buffer.from(String(row.id), 'utf8').toString('base64url');
}

function decodeBidCursor(cursor) {
  if (!cursor) return null;
  try {
    const id = Buffer.from(String(cursor), 'base64url').toString('utf8').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { id };
  } catch (_) {
    return null;
  }
}

function sanitizePublicBid(bid) {
  return {
    id: bid.id,
    auctionId: bid.auctionId,
    amount: bid.amount,
    auctionVersion: bid.auctionVersion,
    createdAt: bid.createdAt,
    bidderLabel: bid.bidderLabel,
  };
}

async function listSellerAuctions(pool, ownerUserId, { limit = 50 } = {}) {
  const owner = String(ownerUserId || '').trim();
  if (!owner) return [];
  const cap = Math.min(Number(limit) || 50, 100);
  const sql = `
    SELECT a.*, l.listing_id, l.video_id, l.title AS lot_title
    FROM auctions a
    JOIN auction_lots l ON l.id = a.lot_id
    WHERE a.owner_user_id = $1
    ORDER BY a.updated_at DESC NULLS LAST, a.created_at DESC
    LIMIT $2`;
  const { rows } = await pool.query(sql, [owner, cap]);
  const now = new Date();
  return rows.map((row) => {
    const a = mapAuctionRow(row);
    a.lotTitle = row.lot_title;
    a.serverTime = now.toISOString();
    a.effectiveEndAt = effectiveEndAt(row, now).toISOString();
    a.nextValidBid = Number(a.currentPrice) + Number(a.minimumIncrement);
    a.nextMinimumBid = a.nextValidBid;
    return a;
  });
}

async function listAuctions(pool, { bucket, species, videoId, limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  let n = 1;

  const statuses = bucketFilter(bucket);
  if (statuses) {
    clauses.push(`a.status IN (${statuses.join(', ')})`);
  } else {
    clauses.push(`a.status NOT IN ('draft', 'review', 'cancelled')`);
  }

  if (species) {
    clauses.push(`a.species = $${n++}`);
    params.push(String(species).toLowerCase());
  }
  if (videoId) {
    clauses.push(`l.video_id = $${n++}`);
    params.push(String(videoId));
  }

  params.push(Math.min(Number(limit) || 50, 100));

  const sql = `
    SELECT a.*, l.listing_id, l.video_id, l.title AS lot_title
    FROM auctions a
    JOIN auction_lots l ON l.id = a.lot_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY
      CASE a.status WHEN 'live' THEN 0 WHEN 'extended' THEN 1 WHEN 'scheduled' THEN 2 ELSE 3 END,
      a.start_at ASC
    LIMIT $${n}`;

  const { rows } = await pool.query(sql, params);
  const now = new Date();
  return rows.map((row) => {
    const a = mapAuctionRow(row);
    a.lotTitle = row.lot_title;
    a.serverTime = now.toISOString();
    a.effectiveEndAt = effectiveEndAt(row, now).toISOString();
    a.nextValidBid = Number(a.currentPrice) + Number(a.minimumIncrement);
    a.nextMinimumBid = a.nextValidBid;
    return a;
  });
}

async function enrichAuctionSummary(pool, auction, row, { wsHub } = {}) {
  const metrics = await loadAuctionMetrics(pool, auction.id);
  const liveViewers = resolveLiveViewers(wsHub, auction.id);
  if (liveViewers > 0) {
    try {
      await bumpPeakLiveViewers(pool, auction.id, liveViewers);
    } catch (_) {
      /* peak is soft — never fail GET */
    }
  }

  let hostAudio = null;
  try {
    const host = await getHostBookingForAuction(pool, auction.id);
    if (host) {
      hostAudio = {
        audioAvailable: host.audioAvailable,
        audioStatus: host.audioStatus,
        hostPresenceLabel: host.hostPresenceLabel,
        audienceAudioLabel: host.audienceAudioLabel,
      };
    }
  } catch (_) {
    hostAudio = null;
  }

  auction.location = mapPublicLocation(row);
  auction.viewCount = metrics.viewCount;
  auction.uniqueViewers = metrics.uniqueViewers;
  auction.liveViewers = liveViewers;
  auction.uniqueBidders = metrics.uniqueBidders;
  auction.bidCount = metrics.bidCount;
  auction.extensionsCount = metrics.extensionsCount;
  auction.nextMinimumBid = auction.nextValidBid;
  auction.hostAudio = hostAudio;
  return auction;
}

async function getAuctionById(pool, id, { wsHub } = {}) {
  const { rows } = await pool.query(
    `SELECT a.*, l.listing_id, l.video_id, l.title AS lot_title
     FROM auctions a JOIN auction_lots l ON l.id = a.lot_id WHERE a.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const now = new Date();
  const a = mapAuctionRow(rows[0]);
  a.lotTitle = rows[0].lot_title;
  a.serverTime = now.toISOString();
  a.effectiveEndAt = effectiveEndAt(rows[0], now).toISOString();
  a.nextValidBid = Number(a.currentPrice) + Number(a.minimumIncrement);
  a.isApproved = await isAuctionApproved(pool, id);
  await enrichAuctionSummary(pool, a, rows[0], { wsHub });
  return a;
}

/**
 * Paginated bid history — newest first.
 * Public responses must omit bidderUserId.
 */
async function listBids(
  pool,
  auctionId,
  { limit = 20, cursor, includeBidderId = false } = {},
) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const decoded = decodeBidCursor(cursor);
  const params = [auctionId];
  let where = 'auction_id = $1';
  if (decoded) {
    // Keyset from exact DB row — avoids timestamptz↔ISO precision loss.
    params.push(decoded.id);
    where += ` AND (created_at, id) < (
      SELECT b2.created_at, b2.id FROM bids b2 WHERE b2.id = $2::uuid
    )`;
  }
  params.push(lim + 1);

  const { rows } = await pool.query(
    `SELECT * FROM bids
     WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;
  const bids = page.map((r) => {
    const b = mapBidRow(r);
    b.bidderLabel = `مزايد ${String(b.bidderUserId).slice(-4)}`;
    if (includeBidderId) return b;
    return sanitizePublicBid(b);
  });
  const nextCursor =
    hasMore && page.length
      ? encodeBidCursor(page[page.length - 1])
      : null;
  return { bids, nextCursor, hasMore };
}

async function getHostBookingForAuction(pool, auctionId) {
  const { rows } = await pool.query(
    `SELECT hb.*, ah.display_name, ah.profile_image_url, ah.city, ah.experience,
            ah.status AS host_status, ah.verified_at, ah.user_id AS host_user_id,
            ah.specialties, a.status AS auction_status,
            aus.status AS audio_session_status, aus.started_at AS audio_started_at
     FROM host_bookings hb
     JOIN auction_hosts ah ON ah.id = hb.host_id
     JOIN auctions a ON a.id = hb.auction_id
     LEFT JOIN LATERAL (
       SELECT status, started_at FROM audio_sessions
       WHERE auction_id = hb.auction_id
       ORDER BY created_at DESC LIMIT 1
     ) aus ON TRUE
     WHERE hb.auction_id = $1 AND hb.status IN ('requested','accepted','scheduled')
     ORDER BY hb.created_at DESC LIMIT 1`,
    [auctionId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  const audioStatus = r.audio_session_status || 'inactive';
  const audioAvailable = audioStatus === 'live';
  let hostPresenceLabel = audienceAudioLabel(audioStatus);
  if (['live', 'extended'].includes(r.auction_status) && audioStatus === 'live') {
    hostPresenceLabel = 'المحرّج مباشر صوتيًا';
  } else if (['live', 'extended'].includes(r.auction_status)) {
    hostPresenceLabel = 'المحرّج متصل';
  }
  return {
    id: r.id,
    status: r.status,
    hostId: r.host_id,
    hostUserId: r.host_user_id,
    hostDisplayName: r.display_name,
    hostProfileImageUrl: r.profile_image_url,
    hostCity: r.city,
    hostExperience: r.experience,
    hostSpecialties: r.specialties || [],
    hostStatus: r.host_status,
    hostVerified: Boolean(r.verified_at),
    scheduledStartAt: r.scheduled_start_at,
    scheduledEndAt: r.scheduled_end_at,
    audioAvailable,
    audioStatus,
    audienceAudioLabel: audienceAudioLabel(audioStatus),
    hostPresenceLabel,
  };
}

module.exports = {
  listAuctions,
  listSellerAuctions,
  getAuctionById,
  listBids,
  getHostBookingForAuction,
  enrichVideoFromStore,
  encodeBidCursor,
  decodeBidCursor,
  sanitizePublicBid,
};
