'use strict';

const { randomUUID } = require('crypto');
const {
  canTransition,
  isBiddableStatus,
  isFrozen,
  effectiveEndAt,
  serverNow,
} = require('../domain/states');
const { acquireAuctionLock } = require('../domain/locking');
const { assertSpecies, assertListingRef, optionalListingRef } = require('../domain/species');
const {
  ANTI_SNIPE_SECONDS,
  SETTLEMENT_NOTE,
} = require('../config');

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

function mapAuctionRow(row) {
  if (!row) return null;
  const { mapPublicLocation } = require('./location_snapshot');
  let mediaImages = [];
  if (Array.isArray(row.media_images)) {
    mediaImages = row.media_images;
  } else if (typeof row.media_images === 'string') {
    try {
      const parsed = JSON.parse(row.media_images);
      if (Array.isArray(parsed)) mediaImages = parsed;
    } catch (_) {
      mediaImages = [];
    }
  }
  return {
    id: row.id,
    lotId: row.lot_id,
    listingId: row.listing_id || '',
    videoId: row.video_id || '',
    ownerUserId: row.owner_user_id,
    createdByUserId: row.created_by_user_id,
    createdByRole: row.created_by_role,
    ownerConsentRef: row.owner_consent_ref,
    species: row.species,
    status: row.status,
    startingPrice: Number(row.starting_price),
    minimumIncrement: Number(row.minimum_increment),
    reservePrice: row.reserve_price != null ? Number(row.reserve_price) : null,
    currentPrice: Number(row.current_price),
    version: row.version,
    startAt: row.start_at,
    endAt: row.end_at,
    extendedUntil: row.extended_until,
    antiSnipingSeconds: row.anti_sniping_seconds,
    winnerUserId: row.winner_user_id,
    winningBidId: row.winning_bid_id,
    settlementNote: row.settlement_note,
    cancelledReason: row.cancelled_reason,
    preFrozenStatus: row.pre_frozen_status,
    frozenReason: row.frozen_reason,
    frozenAt: row.frozen_at,
    frozenByAdminId: row.frozen_by_admin_id,
    peakLiveViewers:
      row.peak_live_viewers != null ? Number(row.peak_live_viewers) : 0,
    location: mapPublicLocation(row),
    description: row.description || null,
    breed: row.breed || null,
    gender: row.gender || null,
    color: row.color || null,
    ageLabel: row.age_label || null,
    mediaImages,
    mediaVideoCloudflareId: row.media_video_cloudflare_id || null,
    mediaVideoHlsUrl: row.media_video_hls_url || null,
    mediaVideoThumbnailUrl: row.media_video_thumbnail_url || null,
    // Prefer auction-owned media; legacy enrich may override if empty
    videoUrl: row.media_video_hls_url || null,
    videoThumbnail: row.media_video_thumbnail_url || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function appendEvent(client, { auctionId, eventType, payload, actorUserId }) {
  await client.query(
    `INSERT INTO auction_events (auction_id, event_type, payload, actor_user_id)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [auctionId, eventType, JSON.stringify(payload || {}), actorUserId || null],
  );
}

async function getLotByRefs(client, listingId, videoId) {
  const { rows } = await client.query(
    `SELECT l.* FROM auction_lots l WHERE l.listing_id = $1 AND l.video_id = $2`,
    [listingId, videoId],
  );
  return rows[0] || null;
}

async function upsertLot(client, { listingId, videoId, species, title }) {
  const sp = assertSpecies(species);
  const hasLegacy = String(listingId || '').trim() && String(videoId || '').trim();
  if (hasLegacy) {
    const refs = assertListingRef(listingId, videoId);
    const existing = await getLotByRefs(client, refs.listingId, refs.videoId);
    if (existing) return existing;
    const { rows } = await client.query(
      `INSERT INTO auction_lots (listing_id, video_id, species, title)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [refs.listingId, refs.videoId, sp, title || null],
    );
    return rows[0];
  }
  const refs = optionalListingRef(listingId, videoId);
  const { rows } = await client.query(
    `INSERT INTO auction_lots (listing_id, video_id, species, title)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [refs.listingId, refs.videoId, sp, title || null],
  );
  return rows[0];
}

async function createAuctionDraft(client, input) {
  const sp = assertSpecies(input.species);
  let lot;
  if (input.reuseLotId) {
    const existing = await client.query(
      `SELECT * FROM auction_lots WHERE id = $1`,
      [input.reuseLotId],
    );
    if (!existing.rows[0]) {
      const err = new Error('Lot not found for reuse');
      err.code = 'AUCTION_LOT_NOT_FOUND';
      err.status = 404;
      throw err;
    }
    lot = existing.rows[0];
  } else {
    lot = await upsertLot(client, {
      listingId: input.listingId,
      videoId: input.videoId,
      species: sp,
      title: input.title,
    });
  }

  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  if (!(startAt < endAt)) {
    const err = new Error('startAt must be before endAt');
    err.code = 'AUCTION_TIME_INVALID';
    err.status = 400;
    throw err;
  }

  const startingPrice = money(input.startingPrice);
  const minimumIncrement = money(input.minimumIncrement);
  if (minimumIncrement <= 0) {
    const err = new Error('minimumIncrement must be > 0');
    err.code = 'AUCTION_INCREMENT_INVALID';
    err.status = 400;
    throw err;
  }

  const createdByRole = input.createdByRole === 'host_proxy' ? 'host_proxy' : 'seller';
  if (createdByRole === 'host_proxy' && !input.ownerConsentRef) {
    const err = new Error('ownerConsentRef required for host_proxy creation');
    err.code = 'AUCTION_OWNER_CONSENT_REQUIRED';
    err.status = 400;
    throw err;
  }

  const loc = input.locationSnapshot || null;
  const media = input.media || {};
  const independentLot =
    !String(input.listingId || '').trim() && !String(input.videoId || '').trim();
  if (independentLot) {
    const { isPlayableAuctionHlsUrl } = require('./ownership_validation');
    if (!isPlayableAuctionHlsUrl(media.mediaVideoHlsUrl)) {
      const err = new Error(
        'Independent auction requires a usable HTTPS HLS/playback URL',
      );
      err.code = 'AUCTION_VIDEO_PLAYBACK_REQUIRED';
      err.status = 400;
      throw err;
    }
  }
  const mediaImagesJson = JSON.stringify(
    Array.isArray(media.mediaImages) ? media.mediaImages : [],
  );
  const { rows } = await client.query(
    `INSERT INTO auctions (
      lot_id, owner_user_id, created_by_user_id, created_by_role, owner_consent_ref,
      species, status, starting_price, minimum_increment, reserve_price, current_price,
      start_at, end_at, anti_sniping_seconds, settlement_note,
      location_city, location_district, location_address,
      location_lat, location_lng, location_source_listing_id, location_captured_at,
      media_video_cloudflare_id, media_video_hls_url, media_video_thumbnail_url, media_images,
      description, breed, gender, color, age_label
    ) VALUES (
      $1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$7,$10,$11,$12,$13,
      $14,$15,$16,$17,$18,$19,$20,
      $21,$22,$23,$24::jsonb,
      $25,$26,$27,$28,$29
    )
    RETURNING *`,
    [
      lot.id,
      String(input.ownerUserId),
      String(input.createdByUserId),
      createdByRole,
      input.ownerConsentRef || null,
      sp,
      startingPrice,
      minimumIncrement,
      input.reservePrice != null ? money(input.reservePrice) : null,
      startAt.toISOString(),
      endAt.toISOString(),
      input.antiSnipingSeconds ?? ANTI_SNIPE_SECONDS,
      SETTLEMENT_NOTE,
      loc?.city || null,
      loc?.district || null,
      loc?.address || null,
      loc?.lat != null ? Number(loc.lat) : null,
      loc?.lng != null ? Number(loc.lng) : null,
      loc?.sourceListingId || null,
      loc?.capturedAt || null,
      media.mediaVideoCloudflareId || null,
      media.mediaVideoHlsUrl || null,
      media.mediaVideoThumbnailUrl || null,
      mediaImagesJson,
      input.description || null,
      input.breed || null,
      input.gender || null,
      input.color || null,
      input.ageLabel || input.age || null,
    ],
  );

  const auctionRow = {
    ...rows[0],
    listing_id: lot.listing_id,
    video_id: lot.video_id,
  };
  const requiresHost = input.requiresHost === true;
  await appendEvent(client, {
    auctionId: auctionRow.id,
    eventType: 'auction.created',
    payload: { status: 'draft', species: sp, requiresHost },
    actorUserId: input.createdByUserId,
  });
  return mapAuctionRow(auctionRow);
}

async function transitionAuction(client, auctionId, toStatus, { actorUserId, reason } = {}) {
  await acquireAuctionLock(client, auctionId);
  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id
     FROM auctions a
     JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1 FOR UPDATE`,
    [auctionId],
  );
  const row = rows[0];
  if (!row) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  const from = row.status;
  if (!canTransition(from, toStatus)) {
    const err = new Error(`Invalid transition ${from} → ${toStatus}`);
    err.code = 'AUCTION_TRANSITION_INVALID';
    err.status = 409;
    throw err;
  }

  const params = [toStatus, auctionId];
  let extra = '';
  if (toStatus === 'cancelled') {
    extra =
      ', cancelled_reason = $3, pre_frozen_status = NULL, frozen_reason = NULL, frozen_at = NULL, frozen_by_admin_id = NULL';
    params.push(reason || 'cancelled');
  }

  const updated = await client.query(
    `UPDATE auctions SET status = $1, updated_at = NOW()${extra} WHERE id = $2
     RETURNING *, (SELECT listing_id FROM auction_lots WHERE id = lot_id) AS listing_id,
               (SELECT video_id FROM auction_lots WHERE id = lot_id) AS video_id`,
    params,
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'auction.status_changed',
    payload: { from, to: toStatus, reason: reason || null },
    actorUserId,
  });

  return mapAuctionRow(updated.rows[0]);
}

async function goLiveIfDue(client, auctionId) {
  await acquireAuctionLock(client, auctionId);
  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id
     FROM auctions a JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1 FOR UPDATE`,
    [auctionId],
  );
  const row = rows[0];
  if (!row || row.status !== 'scheduled') return mapAuctionRow(row);
  const now = serverNow();
  if (now < new Date(row.start_at)) return mapAuctionRow(row);
  return transitionAuction(client, auctionId, 'live', { actorUserId: 'system' });
}

async function closeAuctionAtomic(client, auctionId, { actorUserId = 'system' } = {}) {
  await acquireAuctionLock(client, auctionId);
  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id
     FROM auctions a JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1 FOR UPDATE`,
    [auctionId],
  );
  const row = rows[0];
  if (!row) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  if (row.status === 'ended' || row.status === 'sold' || row.status === 'unsold') {
    return mapAuctionRow(row);
  }

  if (isFrozen(row.status)) {
    const err = new Error('Auction is frozen');
    err.code = 'AUCTION_FROZEN';
    err.status = 409;
    throw err;
  }

  if (!isBiddableStatus(row.status)) {
    const err = new Error(`Cannot close auction in status ${row.status}`);
    err.code = 'AUCTION_NOT_CLOSABLE';
    err.status = 409;
    throw err;
  }

  const now = serverNow();
  const end = effectiveEndAt(row, now);
  if (now < end) {
    const err = new Error('Auction has not reached end time');
    err.code = 'AUCTION_STILL_ACTIVE';
    err.status = 409;
    throw err;
  }

  await client.query(
    `UPDATE auctions SET status = 'ended', updated_at = NOW() WHERE id = $1`,
    [auctionId],
  );

  const { rows: topBids } = await client.query(
    `SELECT * FROM bids WHERE auction_id = $1 ORDER BY amount DESC, created_at ASC LIMIT 1`,
    [auctionId],
  );
  const top = topBids[0];
  let finalStatus = 'unsold';
  let winnerUserId = null;
  let winningBidId = null;

  if (top) {
    const meetsReserve =
      row.reserve_price == null || Number(top.amount) >= Number(row.reserve_price);
    if (meetsReserve) {
      finalStatus = 'sold';
      winnerUserId = top.bidder_user_id;
      winningBidId = top.id;
    }
  }

  const { rows: finalRows } = await client.query(
    `UPDATE auctions SET status = $1, winner_user_id = $2, winning_bid_id = $3, updated_at = NOW()
     WHERE id = $4
     RETURNING *, (SELECT listing_id FROM auction_lots WHERE id = lot_id) AS listing_id,
               (SELECT video_id FROM auction_lots WHERE id = lot_id) AS video_id`,
    [finalStatus, winnerUserId, winningBidId, auctionId],
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'auction.closed',
    payload: {
      finalStatus,
      winnerUserId,
      winningBidId,
      finalPrice: top ? Number(top.amount) : Number(row.current_price),
      settlementNote: SETTLEMENT_NOTE,
    },
    actorUserId,
  });

  return mapAuctionRow(finalRows[0]);
}

async function updateSellerDraft(client, { auctionId, actorUserId, patch }) {
  const id = String(auctionId || '').trim();
  const actor = String(actorUserId || '').trim();
  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id, l.title AS lot_title
     FROM auctions a
     JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1
     FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (String(row.owner_user_id) !== actor) {
    const err = new Error('Only the lot owner may edit this draft');
    err.code = 'AUCTION_OWNER_FORBIDDEN';
    err.status = 403;
    throw err;
  }
  if (row.status !== 'draft') {
    const err = new Error('Material fields cannot be edited after submission');
    err.code = 'AUCTION_EDIT_LOCKED';
    err.status = 409;
    throw err;
  }

  const next = { ...patch };
  const starting =
    next.startingPrice != null ? money(next.startingPrice) : Number(row.starting_price);
  const reserve =
    next.reservePrice === null
      ? null
      : next.reservePrice != null
        ? money(next.reservePrice)
        : row.reserve_price != null
          ? Number(row.reserve_price)
          : null;
  if (next.startingPrice != null && starting <= 0) {
    const err = new Error('startingPrice must be > 0');
    err.code = 'AUCTION_STARTING_PRICE_INVALID';
    err.status = 400;
    throw err;
  }
  if (reserve != null && reserve < starting) {
    const err = new Error('reservePrice must be >= startingPrice');
    err.code = 'AUCTION_RESERVE_INVALID';
    err.status = 400;
    throw err;
  }

  const loc = next.locationSnapshot;
  const media = next.media;
  const mediaImagesJson =
    media && Array.isArray(media.mediaImages)
      ? JSON.stringify(media.mediaImages)
      : null;

  const { rows: updated } = await client.query(
    `UPDATE auctions SET
      starting_price = $2,
      current_price = $2,
      reserve_price = $3,
      description = COALESCE($4, description),
      breed = COALESCE($5, breed),
      gender = COALESCE($6, gender),
      color = COALESCE($7, color),
      age_label = COALESCE($8, age_label),
      location_city = COALESCE($9, location_city),
      location_district = COALESCE($10, location_district),
      location_address = COALESCE($11, location_address),
      location_lat = COALESCE($12, location_lat),
      location_lng = COALESCE($13, location_lng),
      media_video_cloudflare_id = COALESCE($14, media_video_cloudflare_id),
      media_video_hls_url = COALESCE($15, media_video_hls_url),
      media_video_thumbnail_url = COALESCE($16, media_video_thumbnail_url),
      media_images = COALESCE($17::jsonb, media_images),
      updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      starting,
      reserve,
      next.description !== undefined ? next.description : null,
      next.breed !== undefined ? next.breed : null,
      next.gender !== undefined ? next.gender : null,
      next.color !== undefined ? next.color : null,
      next.ageLabel !== undefined ? next.ageLabel : null,
      loc?.city || null,
      loc?.district || null,
      loc?.address || null,
      loc?.lat != null ? Number(loc.lat) : null,
      loc?.lng != null ? Number(loc.lng) : null,
      media?.mediaVideoCloudflareId || null,
      media?.mediaVideoHlsUrl || null,
      media?.mediaVideoThumbnailUrl || null,
      mediaImagesJson,
    ],
  );

  if (next.title) {
    await client.query(`UPDATE auction_lots SET title = $2 WHERE id = $1`, [
      row.lot_id,
      String(next.title).trim(),
    ]);
  }

  await appendEvent(client, {
    auctionId: id,
    eventType: 'haraj.seller.draft_updated',
    payload: { fields: Object.keys(patch || {}) },
    actorUserId: actor,
  });

  const mapped = mapAuctionRow({
    ...updated[0],
    listing_id: row.listing_id,
    video_id: row.video_id,
    lot_title: next.title || row.lot_title,
  });
  mapped.lotTitle = next.title || row.lot_title || mapped.lotTitle;
  return mapped;
}

module.exports = {
  mapAuctionRow,
  appendEvent,
  upsertLot,
  createAuctionDraft,
  updateSellerDraft,
  transitionAuction,
  goLiveIfDue,
  closeAuctionAtomic,
  money,
};
