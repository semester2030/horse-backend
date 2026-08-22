'use strict';

const { mapAuctionRow } = require('./auction_service');
const { mapBidRow } = require('./bid_service');
const { effectiveEndAt } = require('../domain/states');
const { audienceAudioLabel } = require('./audio_service');

function enrichVideoFromStore(auction, store) {
  if (!auction || !store?.videos) return auction;
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
    return a;
  });
}

async function getAuctionById(pool, id) {
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
  return a;
}

async function listBids(pool, auctionId, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM bids WHERE auction_id = $1
     ORDER BY amount DESC, created_at ASC LIMIT $2`,
    [auctionId, Math.min(Number(limit) || 50, 100)],
  );
  return rows.map((r) => {
    const b = mapBidRow(r);
    b.bidderLabel = `مزايد ${String(b.bidderUserId).slice(-4)}`;
    return b;
  });
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
  getAuctionById,
  listBids,
  getHostBookingForAuction,
  enrichVideoFromStore,
};
