'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { canTransitionAudioSession, audienceAudioLabel } = require('./domain/audio');
const { createNoopAudioProvider } = require('./audio/noop_provider');
const { PRE_AUDIO_CONTRACT } = require('./audio/pre_audio_contract');
const { ENABLE_AUCTIONS } = require('./config');

describe('Auction Phase 5 — audio domain (unit)', () => {
  it('audio session state machine transitions', () => {
    assert.equal(canTransitionAudioSession('inactive', 'ready'), true);
    assert.equal(canTransitionAudioSession('ready', 'live'), true);
    assert.equal(canTransitionAudioSession('live', 'paused'), true);
    assert.equal(canTransitionAudioSession('paused', 'live'), true);
    assert.equal(canTransitionAudioSession('live', 'ended'), true);
    assert.equal(canTransitionAudioSession('ended', 'live'), false);
  });

  it('audience labels map session status', () => {
    assert.equal(audienceAudioLabel('live'), 'المحرّج مباشر صوتيًا');
    assert.equal(audienceAudioLabel('inactive'), 'الصوت لم يبدأ');
    assert.equal(audienceAudioLabel('failed'), 'الصوت غير متاح');
  });

  it('phase5 contract enables mic for host path only', () => {
    assert.equal(PRE_AUDIO_CONTRACT.phase5Behavior.microphonePermission, true);
    assert.equal(PRE_AUDIO_CONTRACT.phase5Behavior.audienceCanPublish, false);
  });

  it('noop provider mints publish and subscribe tokens', async () => {
    const p = createNoopAudioProvider();
    const pub = await p.mintToken({
      roomName: 'room-1',
      identity: 'host-1',
      canPublish: true,
    });
    const sub = await p.mintToken({
      roomName: 'room-1',
      identity: 'bidder-1',
      canPublish: false,
    });
    assert.match(pub.token, /pub/);
    assert.match(sub.token, /sub/);
    assert.equal(sub.token.includes('pub'), false);
  });

  it('feature flag defaults OFF', () => {
    assert.equal(ENABLE_AUCTIONS, false);
  });
});

describe('Auction Phase 5 — LiveKit tokens (unit)', () => {
  it('host publish token differs from audience subscribe token', async () => {
    process.env.LIVEKIT_API_KEY = 'test-api-key';
    process.env.LIVEKIT_API_SECRET = 'test-api-secret';
    process.env.LIVEKIT_URL = 'wss://test.example.livekit.cloud';
    delete require.cache[require.resolve('./audio/livekit_provider')];
    const { createLiveKitAudioProvider } = require('./audio/livekit_provider');
    const provider = createLiveKitAudioProvider();
    assert.equal(provider.isConfigured, true);

    const pub = await provider.mintToken({
      roomName: 'nomas-auction-a1',
      identity: 'host-user',
      canPublish: true,
      canSubscribe: true,
      ttlSeconds: 120,
    });
    const sub = await provider.mintToken({
      roomName: 'nomas-auction-a1',
      identity: 'bidder-user',
      canPublish: false,
      canSubscribe: true,
      ttlSeconds: 120,
    });
    assert.equal(pub.ok, true);
    assert.equal(sub.ok, true);
    assert.notEqual(pub.token, sub.token);
    assert.equal(pub.expiresIn, 120);
  });
});

describe('Auction Phase 5 — audio E2E (PostgreSQL)', () => {
  const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;
  let pool;
  let db;
  let hostService;
  let auctionService;
  let audioService;
  let bidService;
  let noop;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    process.env.AUCTION_AUDIO_PROVIDER = 'noop';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    db = require('./db');
    pool = db.getPool();
    await db.runMigrations();
    hostService = require('./services/host_service');
    auctionService = require('./services/auction_service');
    audioService = require('./services/audio_service');
    bidService = require('./services/bid_service');
    noop = createNoopAudioProvider();
  });

  after(async () => {
    if (db?.closePool) await db.closePool();
  });

  async function wipe(client) {
    await client.query('DELETE FROM auction_risk_signals');
    await client.query('DELETE FROM auction_disputes');
    await client.query('DELETE FROM audio_sessions');
    await client.query('UPDATE auctions SET host_booking_id = NULL');
    await client.query('DELETE FROM host_bookings');
    await client.query('DELETE FROM host_availability');
    await client.query('DELETE FROM auction_events');
    await client.query('DELETE FROM bids');
    await client.query('DELETE FROM auctions');
    await client.query('DELETE FROM auction_lots');
    await client.query('DELETE FROM auction_hosts');
  }

  async function activateHost(client, hostId) {
    await hostService.verifyHost(client, hostId, 'admin-1');
    return hostService.activateHost(client, hostId, 'admin-1');
  }

  async function setupLiveAuction(client, {
    hostUserId = 'host-audio-1',
    ownerUserId = 'owner-audio-1',
  } = {}) {
    const host = await hostService.registerHost(client, {
      userId: hostUserId,
      displayName: 'Audio Host',
    });
    await activateHost(client, host.id);
    const start = new Date(Date.now() - 120000);
    const end = new Date(Date.now() + 3600000);
    await hostService.addAvailability(client, {
      hostId: host.id,
      startAt: new Date(Date.now() - 900000).toISOString(),
      endAt: end.toISOString(),
    });
    const auction = await auctionService.createAuctionDraft(client, {
      listingId: `L-audio-${hostUserId}`,
      videoId: `V-audio-${hostUserId}`,
      species: 'horse',
      ownerUserId,
      createdByUserId: ownerUserId,
      startingPrice: 1000,
      minimumIncrement: 100,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      requiresHost: true,
    });
    await auctionService.transitionAuction(client, auction.id, 'review', {
      actorUserId: 'admin-1',
    });
    const { approveAuctionReview } = require('./services/approval_flow');
    await approveAuctionReview(client, auction.id, 'admin-1', { bypass: 'admin' });
    const booking = await hostService.requestHostBooking(client, {
      auctionId: auction.id,
      hostId: host.id,
      requestedByUserId: ownerUserId,
      scheduledStartAt: start.toISOString(),
      scheduledEndAt: end.toISOString(),
    });
    await hostService.respondHostBooking(client, booking.id, true, {
      actorUserId: hostUserId,
    });
    await auctionService.transitionAuction(client, auction.id, 'live', {
      actorUserId: 'admin-1',
    });
    return { host, auction, booking };
  }

  it('only assigned host can prepare and start audio', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const { host, auction } = await setupLiveAuction(client);
      await assert.rejects(
        () => audioService.prepareAudioSession(client, auction.id, 'wrong-user', noop),
        (e) => e.code === 'AUDIO_HOST_FORBIDDEN',
      );
      const prepared = await audioService.prepareAudioSession(
        client,
        auction.id,
        host.userId,
        noop,
      );
      assert.equal(prepared.status, 'ready');
      const live = await audioService.startAudioSession(
        client,
        auction.id,
        host.userId,
        noop,
      );
      assert.equal(live.status, 'live');
    });
  });

  it('audience receives subscribe-only token; host receives publish token', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const { host, auction } = await setupLiveAuction(client);
      await audioService.prepareAudioSession(client, auction.id, host.userId, noop);
      await audioService.startAudioSession(client, auction.id, host.userId, noop);
      const hostToken = await audioService.mintAudioToken(
        client,
        auction.id,
        host.userId,
        noop,
        { publish: true },
      );
      const audienceToken = await audioService.mintAudioToken(
        client,
        auction.id,
        'bidder-1',
        noop,
        { publish: false },
      );
      assert.equal(hostToken.canPublish, true);
      assert.equal(audienceToken.canPublish, false);
      assert.match(hostToken.token, /pub/);
      assert.match(audienceToken.token, /sub/);
    });
  });

  it('unverified host denied for audio prepare', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, {
        userId: 'host-unverified',
        displayName: 'Pending',
      });
      const start = new Date(Date.now() - 60000);
      const end = new Date(Date.now() + 3600000);
      await hostService.addAvailability(client, {
        hostId: host.id,
        startAt: new Date(Date.now() - 900000).toISOString(),
        endAt: end.toISOString(),
      });
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-unv',
        videoId: 'V-unv',
        species: 'horse',
        ownerUserId: 'owner-unv',
        createdByUserId: 'owner-unv',
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      await auctionService.transitionAuction(client, auction.id, 'review', {
        actorUserId: 'admin-1',
      });
      const { approveAuctionReview } = require('./services/approval_flow');
      await approveAuctionReview(client, auction.id, 'admin-1', { bypass: 'admin' });
      await auctionService.transitionAuction(client, auction.id, 'live', {
        actorUserId: 'admin-1',
      });
      await assert.rejects(
        () => audioService.prepareAudioSession(client, auction.id, 'host-unverified', noop),
        (e) => e.code === 'AUDIO_BOOKING_REQUIRED' || e.code === 'HOST_NOT_AUTHORIZED_FOR_AUDIO',
      );
    });
  });

  it('auction must be live for host audio start', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, {
        userId: 'host-not-live',
        displayName: 'Host',
      });
      await activateHost(client, host.id);
      const start = new Date(Date.now() - 120000);
      const end = new Date(Date.now() + 3600000);
      await hostService.addAvailability(client, {
        hostId: host.id,
        startAt: new Date(Date.now() - 900000).toISOString(),
        endAt: end.toISOString(),
      });
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-not-live',
        videoId: 'V-not-live',
        species: 'horse',
        ownerUserId: 'owner-not-live',
        createdByUserId: 'owner-not-live',
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        requiresHost: true,
      });
      await auctionService.transitionAuction(client, auction.id, 'review', {
        actorUserId: 'admin-1',
      });
      const { approveAuctionReview } = require('./services/approval_flow');
      await approveAuctionReview(client, auction.id, 'admin-1', { bypass: 'admin' });
      const booking = await hostService.requestHostBooking(client, {
        auctionId: auction.id,
        hostId: host.id,
        requestedByUserId: 'owner-not-live',
        scheduledStartAt: start.toISOString(),
        scheduledEndAt: end.toISOString(),
      });
      await hostService.respondHostBooking(client, booking.id, true, {
        actorUserId: 'host-not-live',
      });
      await audioService.prepareAudioSession(client, auction.id, host.userId, noop);
      await assert.rejects(
        () => audioService.startAudioSession(client, auction.id, host.userId, noop),
        (e) => e.code === 'AUCTION_NOT_LIVE_FOR_AUDIO',
      );
    });
  });

  it('double start is idempotent', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const { host, auction } = await setupLiveAuction(client);
      await audioService.prepareAudioSession(client, auction.id, host.userId, noop);
      const first = await audioService.startAudioSession(client, auction.id, host.userId, noop);
      const second = await audioService.startAudioSession(client, auction.id, host.userId, noop);
      assert.equal(first.id, second.id);
      assert.equal(second.status, 'live');
    });
  });

  it('admin force-end ends session and is audited', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const { host, auction } = await setupLiveAuction(client);
      await audioService.prepareAudioSession(client, auction.id, host.userId, noop);
      await audioService.startAudioSession(client, auction.id, host.userId, noop);
      const ended = await audioService.endAudioSession(client, auction.id, 'admin-1', {
        forced: true,
        reason: 'moderation',
      });
      assert.equal(ended.status, 'ended');
      const { rows } = await client.query(
        `SELECT event_type FROM auction_events WHERE auction_id = $1 AND event_type = 'audio.force_ended'`,
        [auction.id],
      );
      assert.equal(rows.length, 1);
    });
  });

  it('provider failure does not block bidding', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const { host, auction } = await setupLiveAuction(client);
      await audioService.prepareAudioSession(client, auction.id, host.userId, noop);
      const failingProvider = {
        name: 'mock-fail',
        isConfigured: true,
        async createSession() {
          return { ok: false, error: 'livekit_unavailable' };
        },
        async mintToken() {
          return { ok: false, error: 'livekit_unavailable' };
        },
      };
      await assert.rejects(
        () => audioService.startAudioSession(client, auction.id, host.userId, failingProvider),
        (e) => e.code === 'AUDIO_PROVIDER_FAILED',
      );
      const result = await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-x',
        amount: 1100,
        expectedVersion: 1,
        idempotencyKey: 'audio-fail-bid-1',
      });
      assert.equal(result.bid.amount, 1100);
      const { rows } = await client.query(`SELECT status FROM auctions WHERE id = $1`, [
        auction.id,
      ]);
      assert.equal(rows[0].status, 'live');
    });
  });

  it('pause and resume transitions', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const { host, auction } = await setupLiveAuction(client);
      await audioService.prepareAudioSession(client, auction.id, host.userId, noop);
      await audioService.startAudioSession(client, auction.id, host.userId, noop);
      const paused = await audioService.pauseAudioSession(client, auction.id, host.userId);
      assert.equal(paused.status, 'paused');
      const resumed = await audioService.resumeAudioSession(client, auction.id, host.userId);
      assert.equal(resumed.status, 'live');
    });
  });
});
