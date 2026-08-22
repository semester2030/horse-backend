'use strict';

const { effectiveEndAt } = require('../domain/states');
const {
  canTransitionAudioSession,
  isActiveAudioStatus,
  audienceAudioLabel,
} = require('../domain/audio');
const { appendEvent } = require('./auction_service');

const TOKEN_TTL_SECONDS = Number(process.env.AUCTION_AUDIO_TOKEN_TTL_SECONDS || 600);
const WINDOW_OPEN_MINUTES = Number(process.env.AUCTION_AUDIO_WINDOW_OPEN_MINUTES || 15);

function mapSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    auctionId: row.auction_id,
    hostId: row.host_id,
    hostBookingId: row.host_booking_id,
    hostUserId: row.host_user_id,
    provider: row.provider,
    roomName: row.room_name || row.provider_room_id,
    status: row.status,
    failureReason: row.failure_reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    pausedAt: row.paused_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicAudioState(session, { providerConfigured = false } = {}) {
  if (!session) {
    return {
      available: false,
      status: 'inactive',
      audienceLabel: 'الصوت لم يبدأ',
      providerConfigured,
      canListen: false,
      hostLive: false,
    };
  }
  return {
    available: session.status === 'live',
    status: session.status,
    audienceLabel: audienceAudioLabel(session.status),
    providerConfigured,
    canListen: ['ready', 'live', 'paused'].includes(session.status),
    hostLive: session.status === 'live',
    roomName: session.roomName,
    provider: session.provider,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
}

async function getLatestSession(client, auctionId) {
  const { rows } = await client.query(
    `SELECT * FROM audio_sessions
     WHERE auction_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [auctionId],
  );
  return mapSessionRow(rows[0]);
}

async function getActiveSession(client, auctionId) {
  const { rows } = await client.query(
    `SELECT * FROM audio_sessions
     WHERE auction_id = $1 AND status IN ('inactive', 'ready', 'live', 'paused')
     ORDER BY created_at DESC LIMIT 1`,
    [auctionId],
  );
  return mapSessionRow(rows[0]);
}

async function loadAudioContext(client, auctionId) {
  const { rows: auctionRows } = await client.query(
    `SELECT * FROM auctions WHERE id = $1`,
    [auctionId],
  );
  const auction = auctionRows[0];
  if (!auction) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  const { rows: bookingRows } = await client.query(
    `SELECT hb.*, ah.user_id AS host_user_id, ah.status AS host_status, ah.verified_at
     FROM host_bookings hb
     JOIN auction_hosts ah ON ah.id = hb.host_id
     WHERE hb.auction_id = $1 AND hb.status = 'scheduled'
     ORDER BY hb.created_at DESC LIMIT 1`,
    [auctionId],
  );
  const booking = bookingRows[0] || null;
  const session = await getActiveSession(client, auctionId);
  return { auction, booking, session };
}

function isWithinAudioWindow(auctionRow, now = new Date()) {
  const start = new Date(auctionRow.start_at);
  const openAt = new Date(start.getTime() - WINDOW_OPEN_MINUTES * 60 * 1000);
  const closeAt = effectiveEndAt(auctionRow, now);
  return now >= openAt && now <= closeAt;
}

function assertHostAuthorized(ctx, actorUserId) {
  const { booking } = ctx;
  if (!booking) {
    const err = new Error('Scheduled host booking required');
    err.code = 'AUDIO_BOOKING_REQUIRED';
    err.status = 409;
    throw err;
  }
  if (booking.host_status !== 'active' || !booking.verified_at) {
    const err = new Error('Host not active and verified');
    err.code = 'HOST_NOT_AUTHORIZED_FOR_AUDIO';
    err.status = 403;
    throw err;
  }
  if (String(booking.host_user_id) !== String(actorUserId)) {
    const err = new Error('Only assigned host may control audio');
    err.code = 'AUDIO_HOST_FORBIDDEN';
    err.status = 403;
    throw err;
  }
}

function assertAuctionLiveForPublish(ctx) {
  if (!['live', 'extended'].includes(ctx.auction.status)) {
    const err = new Error('Auction must be live or extended for host audio');
    err.code = 'AUCTION_NOT_LIVE_FOR_AUDIO';
    err.status = 409;
    throw err;
  }
}

function assertWithinWindow(ctx) {
  if (!isWithinAudioWindow(ctx.auction)) {
    const err = new Error('Outside allowed audio window');
    err.code = 'AUDIO_WINDOW_CLOSED';
    err.status = 409;
    throw err;
  }
}

function roomNameForAuction(auctionId) {
  return `nomas-auction-${auctionId}`;
}

async function prepareAudioSession(client, auctionId, actorUserId, provider) {
  const ctx = await loadAudioContext(client, auctionId);
  assertHostAuthorized(ctx, actorUserId);
  assertWithinWindow(ctx);

  if (ctx.session && isActiveAudioStatus(ctx.session.status)) {
    return ctx.session;
  }

  const roomName = roomNameForAuction(auctionId);
  const { rows } = await client.query(
    `INSERT INTO audio_sessions (
      auction_id, host_id, host_booking_id, host_user_id, provider, room_name, provider_room_id, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $6, 'ready')
    RETURNING *`,
    [
      auctionId,
      ctx.booking.host_id,
      ctx.booking.id,
      ctx.booking.host_user_id,
      provider.name,
      roomName,
    ],
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'audio.prepared',
    payload: { sessionId: rows[0].id, roomName },
    actorUserId,
  });

  return mapSessionRow(rows[0]);
}

async function startAudioSession(client, auctionId, actorUserId, provider) {
  const ctx = await loadAudioContext(client, auctionId);
  assertHostAuthorized(ctx, actorUserId);
  assertAuctionLiveForPublish(ctx);
  assertWithinWindow(ctx);

  let session = ctx.session;
  if (!session) {
    session = await prepareAudioSession(client, auctionId, actorUserId, provider);
  }

  if (session.status === 'live') {
    return session;
  }

  if (!canTransitionAudioSession(session.status, 'live')) {
    const err = new Error('Audio session cannot start from current state');
    err.code = 'AUDIO_SESSION_INVALID';
    err.status = 409;
    throw err;
  }

  const providerResult = await provider.createSession({
    auctionId,
    hostId: session.hostId,
    hostUserId: actorUserId,
    roomName: session.roomName,
  });

  if (!providerResult.ok) {
    const { rows } = await client.query(
      `UPDATE audio_sessions SET status = 'failed', failure_reason = $2, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [session.id, providerResult.error || 'provider_failed'],
    );
    await appendEvent(client, {
      auctionId,
      eventType: 'audio.failed',
      payload: { sessionId: session.id, reason: providerResult.error },
      actorUserId,
    });
    const err = new Error(providerResult.error || 'Audio provider unavailable');
    err.code = 'AUDIO_PROVIDER_FAILED';
    err.status = 503;
    err.biddingContinues = true;
    throw err;
  }

  const { rows } = await client.query(
    `UPDATE audio_sessions SET status = 'live', started_at = COALESCE(started_at, NOW()),
      paused_at = NULL, failure_reason = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [session.id],
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'audio.started',
    payload: { sessionId: session.id, roomName: session.roomName },
    actorUserId,
  });

  return mapSessionRow(rows[0]);
}

async function pauseAudioSession(client, auctionId, actorUserId) {
  const ctx = await loadAudioContext(client, auctionId);
  assertHostAuthorized(ctx, actorUserId);
  const session = ctx.session;
  if (!session || session.status !== 'live') {
    const err = new Error('No live audio session');
    err.code = 'AUDIO_NOT_LIVE';
    err.status = 409;
    throw err;
  }

  const { rows } = await client.query(
    `UPDATE audio_sessions SET status = 'paused', paused_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [session.id],
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'audio.paused',
    payload: { sessionId: session.id },
    actorUserId,
  });

  return mapSessionRow(rows[0]);
}

async function resumeAudioSession(client, auctionId, actorUserId) {
  const ctx = await loadAudioContext(client, auctionId);
  assertHostAuthorized(ctx, actorUserId);
  assertAuctionLiveForPublish(ctx);
  const session = ctx.session;
  if (!session || session.status !== 'paused') {
    const err = new Error('Audio session not paused');
    err.code = 'AUDIO_NOT_PAUSED';
    err.status = 409;
    throw err;
  }

  const { rows } = await client.query(
    `UPDATE audio_sessions SET status = 'live', paused_at = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [session.id],
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'audio.resumed',
    payload: { sessionId: session.id },
    actorUserId,
  });

  return mapSessionRow(rows[0]);
}

async function endAudioSession(client, auctionId, actorUserId, { forced = false, reason } = {}) {
  const ctx = await loadAudioContext(client, auctionId);
  if (!forced) {
    assertHostAuthorized(ctx, actorUserId);
  }
  const session = ctx.session;
  if (!session || !isActiveAudioStatus(session.status)) {
    return session || null;
  }

  const { rows } = await client.query(
    `UPDATE audio_sessions SET status = 'ended', ended_at = NOW(), updated_at = NOW(),
      failure_reason = COALESCE($2, failure_reason)
     WHERE id = $1 RETURNING *`,
    [session.id, reason || null],
  );

  await appendEvent(client, {
    auctionId,
    eventType: forced ? 'audio.force_ended' : 'audio.ended',
    payload: { sessionId: session.id, reason: reason || null },
    actorUserId,
  });

  return mapSessionRow(rows[0]);
}

async function mintAudioToken(client, auctionId, actorUserId, provider, { publish = false } = {}) {
  const ctx = await loadAudioContext(client, auctionId);
  const session = ctx.session || (publish
    ? null
    : await getLatestSession(client, auctionId));

  if (publish) {
    assertHostAuthorized(ctx, actorUserId);
    assertAuctionLiveForPublish(ctx);
    assertWithinWindow(ctx);
    if (!session || !['ready', 'live', 'paused'].includes(session.status)) {
      const err = new Error('Prepare audio session first');
      err.code = 'AUDIO_NOT_PREPARED';
      err.status = 409;
      throw err;
    }
  } else {
    if (!session || !['ready', 'live', 'paused'].includes(session.status)) {
      const err = new Error('Audio not available for listening');
      err.code = 'AUDIO_NOT_AVAILABLE';
      err.status = 409;
      throw err;
    }
    if (publish) {
      assertHostAuthorized(ctx, actorUserId);
    } else if (publish === false && ctx.booking &&
      String(ctx.booking.host_user_id) === String(actorUserId)) {
      // Host requesting listen token — still publish-capable check above handles publish=true
    }
  }

  if (typeof provider.mintToken !== 'function') {
    const err = new Error('Audio provider does not support tokens');
    err.code = 'AUDIO_PROVIDER_NO_TOKENS';
    err.status = 503;
    throw err;
  }

  const roomName = session.roomName || roomNameForAuction(auctionId);
  const tokenResult = await provider.mintToken({
    roomName,
    identity: String(actorUserId),
    auctionId,
    hostId: session.hostId,
    canPublish: publish,
    canSubscribe: true,
    ttlSeconds: TOKEN_TTL_SECONDS,
  });

  if (!tokenResult.ok) {
    const err = new Error(tokenResult.error || 'Token mint failed');
    err.code = 'AUDIO_TOKEN_FAILED';
    err.status = 503;
    err.biddingContinues = true;
    throw err;
  }

  return {
    token: tokenResult.token,
    url: tokenResult.url,
    roomName,
    expiresIn: tokenResult.expiresIn || TOKEN_TTL_SECONDS,
    canPublish: publish,
    canSubscribe: true,
  };
}

async function getAudioState(client, auctionId, provider) {
  const session = await getLatestSession(client, auctionId);
  return publicAudioState(session, { providerConfigured: provider.isConfigured });
}

module.exports = {
  TOKEN_TTL_SECONDS,
  mapSessionRow,
  publicAudioState,
  getLatestSession,
  getActiveSession,
  loadAudioContext,
  isWithinAudioWindow,
  prepareAudioSession,
  startAudioSession,
  pauseAudioSession,
  resumeAudioSession,
  endAudioSession,
  mintAudioToken,
  getAudioState,
  roomNameForAuction,
  audienceAudioLabel,
};
