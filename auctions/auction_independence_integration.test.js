'use strict';

/**
 * Auction independence — PostgreSQL integration gate (Migration 008+).
 * Requires: AUCTIONS_TEST_DATABASE_URL=postgresql://localhost:5432/nomas_auctions_test
 * No skipped critical Migration 008 proofs when DB URL is set.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  createAuctionRealtime,
} = require('./realtime/auction_realtime');

const url =
  process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;

if (!url) {
  throw new Error(
    'AUCTIONS_TEST_DATABASE_URL required for auction_independence_integration.test.js (no skip)',
  );
}

describe('Auction independence — Migration 008 + E2E (PostgreSQL)', { concurrency: 1 }, () => {
  let pool;
  let db;
  let auctionService;
  let bidService;
  let adminAuctionService;
  let queryService;
  let published;

  before(async () => {
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    delete require.cache[require.resolve('./services/auction_service')];
    delete require.cache[require.resolve('./services/bid_service')];
    delete require.cache[require.resolve('./services/admin_auction_service')];
    delete require.cache[require.resolve('./services/auction_query_service')];
    db = require('./db');
    auctionService = require('./services/auction_service');
    bidService = require('./services/bid_service');
    adminAuctionService = require('./services/admin_auction_service');
    queryService = require('./services/auction_query_service');
    await db.runMigrations();
    pool = db.getPool();
    assert.equal(db.areMigrationsReady(), true);
    assert.equal(db.REQUIRED_MIGRATION_ID, '008_auction_media_independence');
    assert.match(String(db.getSchemaVersion()), /008_auction_media_independence/);
  });

  after(async () => {
    if (db) await db.closePool();
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

  function saudiLocation() {
    return {
      city: 'الرياض',
      district: 'النرجس',
      address: null,
      lat: 24.7136,
      lng: 46.6753,
      sourceListingId: null,
      capturedAt: new Date().toISOString(),
    };
  }

  async function createIndependentLive(client, opts = {}) {
    const now = Date.now();
    const auction = await auctionService.createAuctionDraft(client, {
      listingId: null,
      videoId: null,
      species: opts.species || 'horse',
      ownerUserId: opts.ownerUserId || 'owner-ind',
      createdByUserId: opts.ownerUserId || 'owner-ind',
      createdByRole: 'seller',
      startingPrice: opts.startingPrice ?? 1000,
      minimumIncrement: opts.minimumIncrement ?? 50,
      reservePrice: opts.reservePrice ?? null,
      startAt: new Date(now - 60000).toISOString(),
      endAt: new Date(now + (opts.endMs || 120000)).toISOString(),
      antiSnipingSeconds: opts.antiSnipingSeconds ?? 30,
      title: opts.title || 'Independent lot',
      description: opts.description,
      breed: opts.breed,
      locationSnapshot: opts.locationSnapshot || saudiLocation(),
      media: {
        mediaVideoCloudflareId: opts.cfId || 'cf-ind-1',
        mediaVideoHlsUrl:
          opts.hls ||
          'https://videodelivery.net/cf-ind-1/manifest/video.m3u8',
        mediaVideoThumbnailUrl:
          opts.thumb || 'https://videodelivery.net/cf-ind-1/thumbnails/thumb.jpg',
        mediaImages: opts.images || [
          'https://imagedelivery.net/nomas/img1/public',
          'https://imagedelivery.net/nomas/img2/public',
        ],
      },
    });
    await auctionService.transitionAuction(client, auction.id, 'review', {
      actorUserId: 'admin',
    });
    const { approveAuctionReview } = require('./services/approval_flow');
    await approveAuctionReview(client, auction.id, 'admin', { bypass: 'admin' });
    await auctionService.transitionAuction(client, auction.id, 'live', {
      actorUserId: 'admin',
    });
    const { rows } = await client.query(
      `SELECT a.*, l.listing_id, l.video_id
       FROM auctions a JOIN auction_lots l ON l.id = a.lot_id
       WHERE a.id = $1`,
      [auction.id],
    );
    return auctionService.mapAuctionRow(rows[0]);
  }

  async function createLegacyLive(client, opts = {}) {
    const now = Date.now();
    const auction = await auctionService.createAuctionDraft(client, {
      listingId: opts.listingId || `L-leg-${now}`,
      videoId: opts.videoId || `V-leg-${now}`,
      species: 'horse',
      ownerUserId: opts.ownerUserId || 'owner-leg',
      createdByUserId: opts.ownerUserId || 'owner-leg',
      createdByRole: 'seller',
      startingPrice: 1000,
      minimumIncrement: 50,
      startAt: new Date(now - 60000).toISOString(),
      endAt: new Date(now + 120000).toISOString(),
      antiSnipingSeconds: 30,
      locationSnapshot: {
        city: 'جدة',
        lat: 21.4858,
        lng: 39.1925,
        sourceListingId: opts.listingId || `L-leg-${now}`,
        capturedAt: new Date().toISOString(),
      },
    });
    await auctionService.transitionAuction(client, auction.id, 'review', {
      actorUserId: 'admin',
    });
    const { approveAuctionReview } = require('./services/approval_flow');
    await approveAuctionReview(client, auction.id, 'admin', { bypass: 'admin' });
    await auctionService.transitionAuction(client, auction.id, 'live', {
      actorUserId: 'admin',
    });
    const { rows } = await client.query(
      `SELECT a.*, l.listing_id, l.video_id
       FROM auctions a JOIN auction_lots l ON l.id = a.lot_id
       WHERE a.id = $1`,
      [auction.id],
    );
    return auctionService.mapAuctionRow(rows[0]);
  }

  // ——— A. Migration 008 ———
  it('A1 Migration 008 applied; listing_id/video_id nullable', async () => {
    const { rows: cols } = await pool.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'auction_lots'
        AND column_name IN ('listing_id', 'video_id')
    `);
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
    assert.equal(byName.listing_id, 'YES');
    assert.equal(byName.video_id, 'YES');

    const { rows: mediaCols } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'auctions'
        AND column_name IN (
          'media_video_cloudflare_id', 'media_video_hls_url',
          'media_video_thumbnail_url', 'media_images'
        )
    `);
    assert.equal(mediaCols.length, 4);
  });

  it('A2 partial unique allows multiple (NULL,NULL); blocks duplicate legacy pairs', async () => {
    await db.withTransaction(async (client) => {
      await wipe(client);
      await client.query(
        `INSERT INTO auction_lots (listing_id, video_id, species, title)
         VALUES (NULL, NULL, 'horse', 'a'), (NULL, NULL, 'camel', 'b')`,
      );
      await client.query(
        `INSERT INTO auction_lots (listing_id, video_id, species, title)
         VALUES ('L1', 'V1', 'horse', 'legacy')`,
      );
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS c FROM auction_lots WHERE listing_id IS NULL`,
      );
      assert.equal(rows[0].c, 2);
    });
    await assert.rejects(
      () =>
        db.withTransaction((client) =>
          client.query(
            `INSERT INTO auction_lots (listing_id, video_id, species, title)
             VALUES ('L1', 'V1', 'horse', 'dup')`,
          ),
        ),
      (e) => e.code === '23505',
    );
  });

  it('A3 legacy linked rows remain valid after 008; no destructive loss', async () => {
    await db.withTransaction(async (client) => {
      await wipe(client);
      const legacy = await createLegacyLive(client);
      assert.ok(legacy.listingId);
      assert.ok(legacy.videoId);
      const { rows } = await client.query(
        `SELECT listing_id, video_id FROM auction_lots WHERE id = $1`,
        [legacy.lotId],
      );
      assert.equal(rows[0].listing_id, legacy.listingId);
      assert.equal(rows[0].video_id, legacy.videoId);
    });
  });

  // ——— B. Independent create ———
  it('B1 independent create without listingId/videoId stores owned media+location', async () => {
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await auctionService.createAuctionDraft(client, {
        listingId: null,
        videoId: null,
        species: 'falcon',
        ownerUserId: 'owner-b1',
        createdByUserId: 'owner-b1',
        startingPrice: 2000,
        minimumIncrement: 100,
        startAt: new Date(Date.now() + 3600000).toISOString(),
        endAt: new Date(Date.now() + 7200000).toISOString(),
        locationSnapshot: saudiLocation(),
        media: {
          mediaVideoCloudflareId: 'cf-b1',
          mediaVideoHlsUrl: 'https://videodelivery.net/cf-b1/manifest/video.m3u8',
          mediaImages: ['https://imagedelivery.net/x/public'],
        },
      });
      assert.equal(a.listingId, '');
      assert.equal(a.videoId, '');
      assert.match(a.videoUrl, /m3u8/);
      assert.equal(a.mediaImages.length, 1);
      assert.equal(a.location.city, 'الرياض');
      assert.equal(a.location.sourceListingId == null, true);
      assert.equal(a.ownerUserId, 'owner-b1');
    });
  });

  it('B2 rejects independent create without playable HLS', async () => {
    await db.withTransaction(async (client) => {
      await wipe(client);
      await assert.rejects(
        () =>
          auctionService.createAuctionDraft(client, {
            listingId: null,
            videoId: null,
            species: 'horse',
            ownerUserId: 'owner-b2',
            createdByUserId: 'owner-b2',
            startingPrice: 1000,
            minimumIncrement: 50,
            startAt: new Date(Date.now() + 3600000).toISOString(),
            endAt: new Date(Date.now() + 7200000).toISOString(),
            locationSnapshot: saudiLocation(),
            media: {
              mediaVideoCloudflareId: 'cf-only',
              mediaVideoHlsUrl: null,
              mediaImages: [],
            },
          }),
        (e) => e.code === 'AUCTION_VIDEO_PLAYBACK_REQUIRED',
      );
    });
  });

  it('B3 optional metadata omitted safely', async () => {
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await auctionService.createAuctionDraft(client, {
        listingId: null,
        videoId: null,
        species: 'camel',
        ownerUserId: 'owner-b3',
        createdByUserId: 'owner-b3',
        startingPrice: 500,
        minimumIncrement: 25,
        startAt: new Date(Date.now() + 3600000).toISOString(),
        endAt: new Date(Date.now() + 7200000).toISOString(),
        locationSnapshot: saudiLocation(),
        media: {
          mediaVideoHlsUrl: 'https://videodelivery.net/cf-b3/manifest/video.m3u8',
          mediaImages: [],
        },
      });
      assert.equal(a.description, null);
      assert.equal(a.breed, null);
      assert.deepEqual(a.mediaImages, []);
    });
  });

  // ——— C. Read ———
  it('C1 GET independent auction returns own media/location without feed store', async () => {
    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const live = await createIndependentLive(client, {
        breed: 'عربي',
        description: 'مستقل',
      });
      auctionId = live.id;
    });
    const detail = await queryService.getAuctionById(pool, auctionId);
    const enriched = queryService.enrichVideoFromStore(detail, {
      videos: new Map(),
      horses: new Map(),
    });
    assert.ok(enriched);
    assert.match(enriched.videoUrl, /m3u8/);
    assert.equal(enriched.mediaImages.length, 2);
    assert.equal(enriched.location.city, 'الرياض');
    assert.equal(enriched.breed, 'عربي');
    assert.equal(enriched.listingId, '');
    assert.equal(enriched.videoId, '');
  });

  // ——— D. Admin ———
  it('D1 Admin detail API returns independent media package without legacy refs', async () => {
    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const live = await createIndependentLive(client);
      auctionId = live.id;
    });
    const detail = await adminAuctionService.getAdminAuctionDetail(pool, auctionId);
    assert.equal(detail.sections.media.independent, true);
    assert.ok(detail.sections.media.videoUrl);
    assert.equal(detail.sections.media.images.length, 2);
    assert.equal(detail.sections.media.listingId, null);
    assert.equal(detail.sections.media.videoId, null);
    assert.ok(detail.sections.location);
    assert.equal(detail.sections.overview.ownerUserId, 'owner-ind');
  });

  // ——— E. Legacy ———
  it('E1 legacy auction still reads; enrich from store when no owned media', async () => {
    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      await createLegacyLive(client, {
        listingId: 'L-e1',
        videoId: 'V-e1',
      });
    });
    const { rows } = await pool.query(
      `SELECT a.id FROM auctions a JOIN auction_lots l ON l.id = a.lot_id
       WHERE l.listing_id = 'L-e1' AND l.video_id = 'V-e1' LIMIT 1`,
    );
    auctionId = rows[0].id;
    const store = {
      videos: new Map([
        [
          'V-e1',
          {
            id: 'V-e1',
            playbackUrl: 'https://videodelivery.net/legacy/manifest/video.m3u8',
            thumbnailUrl: 'https://videodelivery.net/legacy/thumb.jpg',
          },
        ],
      ]),
      horses: new Map(),
    };
    const detail = await queryService.getAuctionById(pool, auctionId);
    const enriched = queryService.enrichVideoFromStore(detail, store);
    assert.equal(enriched.listingId, 'L-e1');
    assert.equal(enriched.videoId, 'V-e1');
    assert.match(enriched.videoUrl, /legacy/);
  });

  // ——— F. Bidding regression on independent ———
  it('F1 owner cannot bid; quick + custom; stale version', async () => {
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await createIndependentLive(client);

      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: auction.id,
            bidderUserId: 'owner-ind',
            amount: 1050,
            idempotencyKey: 'own',
          }),
        (e) => e.code === 'BID_OWNER_FORBIDDEN',
      );

      const quick = await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-q',
        amount: 1050,
        idempotencyKey: 'q1',
      });
      assert.equal(quick.bid.amount, 1050);

      const custom = await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-c',
        amount: 1175,
        idempotencyKey: 'c1',
      });
      assert.equal(custom.bid.amount, 1175);

      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: auction.id,
            bidderUserId: 'bidder-stale',
            amount: 1300,
            idempotencyKey: 'stale',
            expectedVersion: 1,
          }),
        (e) => e.code === 'BID_STALE_VERSION',
      );
    });
  });

  it('F2 concurrent same-amount bids — exactly one wins', async () => {
    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await createIndependentLive(client, { antiSnipingSeconds: 0 });
      auctionId = auction.id;
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        db.withTransaction((client) =>
          bidService.placeBid(client, {
            auctionId,
            bidderUserId: `bidder-race-${i}`,
            amount: 1050,
            idempotencyKey: `ind-race-${i}`,
          }),
        ),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1);
  });

  it('F3 anti-sniping extends; close yields one winner', async () => {
    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const now = Date.now();
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: null,
        videoId: null,
        species: 'horse',
        ownerUserId: 'owner-snipe',
        createdByUserId: 'owner-snipe',
        startingPrice: 1000,
        minimumIncrement: 50,
        startAt: new Date(now - 60000).toISOString(),
        endAt: new Date(now + 15000).toISOString(),
        antiSnipingSeconds: 30,
        locationSnapshot: saudiLocation(),
        media: {
          mediaVideoHlsUrl: 'https://videodelivery.net/snipe/manifest/video.m3u8',
          mediaImages: [],
        },
      });
      await auctionService.transitionAuction(client, auction.id, 'review', {
        actorUserId: 'admin',
      });
      const { approveAuctionReview } = require('./services/approval_flow');
      await approveAuctionReview(client, auction.id, 'admin', { bypass: 'admin' });
      await auctionService.transitionAuction(client, auction.id, 'live', {
        actorUserId: 'admin',
      });
      auctionId = auction.id;

      const snipe = await bidService.placeBid(client, {
        auctionId,
        bidderUserId: 'bidder-snipe',
        amount: 1050,
        idempotencyKey: 'snipe-ind',
      });
      assert.equal(snipe.wasExtended, true);

      await bidService.placeBid(client, {
        auctionId,
        bidderUserId: 'bidder-win',
        amount: 1100,
        idempotencyKey: 'win-ind',
      });
      await client.query(
        `UPDATE auctions SET end_at = NOW() - INTERVAL '1 second', extended_until = NULL WHERE id = $1`,
        [auctionId],
      );
    });

    const closed = await db.withTransaction((c) =>
      auctionService.closeAuctionAtomic(c, auctionId),
    );
    assert.equal(closed.status, 'sold');
    assert.equal(closed.winnerUserId, 'bidder-win');
    assert.ok(closed.winningBidId);

    const again = await db.withTransaction((c) =>
      auctionService.closeAuctionAtomic(c, auctionId),
    );
    assert.equal(again.winnerUserId, 'bidder-win');
    assert.equal(again.winningBidId, closed.winningBidId);
  });

  // ——— G. Realtime ———
  it('G1 committed bid publishes WS; independent auctionId room works', async () => {
    published = [];
    const rt = createAuctionRealtime({
      wsHub: {
        publishAuction(ev) {
          published.push(ev);
          return { ...ev, seq: published.length };
        },
      },
      getPool: () => pool,
    });

    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await createIndependentLive(client);
      auctionId = auction.id;
      const result = await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-ws',
        amount: 1100,
        idempotencyKey: 'ws-ind-1',
      });
      rt.publishBidAccepted(result.auction, result.bid, {
        wasExtended: result.wasExtended,
      });
    });

    assert.equal(published.length >= 1, true);
    assert.equal(published[0].type, 'bid.accepted');
    assert.equal(published[0].auctionId, auctionId);
    assert.ok(!published[0].bidderUserId);
    assert.equal(await rt.canSubscribe('bidder-ws', auctionId), true);
  });

  it('startup gate: migrationsReady after runMigrations', async () => {
    const status = await db.getMigrationsStatus();
    assert.equal(status.migrationsReady, true);
    assert.equal(status.requiredMigrationId, '008_auction_media_independence');
    assert.ok(status.schemaVersion);
  });
});
