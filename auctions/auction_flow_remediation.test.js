'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAuctionAssetOwnership,
  videoLinkedToListing,
} = require('./services/ownership_validation');
const { isAuctionDeveloperUserId, getAuctionDeveloperUserId } = require('./dev_testing');
const {
  recordAuctionApproval,
  approveAuctionReview,
  isAuctionApproved,
} = require('./services/approval_flow');

function mockStore(listings = [], videos = []) {
  const horses = new Map();
  const videosMap = new Map();
  for (const h of listings) horses.set(h.id, h);
  for (const v of videos) videosMap.set(v.id, v);
  return { horses, videos: videosMap };
}

describe('Auction flow remediation — ownership (no PostgreSQL)', () => {
  it('rejects listing owned by another user', () => {
    const store = mockStore(
      [{ id: 'l1', sellerId: 'owner-a', species: 'horse' }],
      [{ id: 'v1', userId: 'owner-a', type: 'horse', horseId: 'l1' }],
    );
    const result = validateAuctionAssetOwnership(store, {
      listingId: 'l1',
      videoId: 'v1',
      species: 'horse',
      ownerUserId: 'owner-b',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AUCTION_LISTING_OWNER_MISMATCH');
  });

  it('rejects unlinked video', () => {
    const store = mockStore(
      [{ id: 'l1', sellerId: 'owner-a', species: 'camel' }],
      [{ id: 'v1', userId: 'owner-a', type: 'camel', horseId: 'other-listing' }],
    );
    const result = validateAuctionAssetOwnership(store, {
      listingId: 'l1',
      videoId: 'v1',
      species: 'camel',
      ownerUserId: 'owner-a',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AUCTION_VIDEO_NOT_LINKED');
  });

  it('rejects species mismatch', () => {
    const store = mockStore(
      [{ id: 'l1', sellerId: 'owner-a', species: 'falcon' }],
      [{ id: 'v1', userId: 'owner-a', type: 'horse', horseId: 'l1' }],
    );
    const result = validateAuctionAssetOwnership(store, {
      listingId: 'l1',
      videoId: 'v1',
      species: 'falcon',
      ownerUserId: 'owner-a',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AUCTION_SPECIES_MISMATCH');
  });

  it('accepts valid horse listing + linked video', () => {
    const listing = { id: 'l1', sellerId: 'owner-a', species: 'horse' };
    const video = { id: 'v1', userId: 'owner-a', type: 'horse', horseId: 'l1' };
    const store = mockStore([listing], [video]);
    assert.equal(videoLinkedToListing(video, 'l1', listing), true);
    const result = validateAuctionAssetOwnership(store, {
      listingId: 'l1',
      videoId: 'v1',
      species: 'horse',
      ownerUserId: 'owner-a',
    });
    assert.equal(result.ok, true);
  });
});

describe('Auction flow remediation — developer exemption env', () => {
  const prev = process.env.AUCTION_DEVELOPER_USER_ID;

  after(() => {
    if (prev == null) delete process.env.AUCTION_DEVELOPER_USER_ID;
    else process.env.AUCTION_DEVELOPER_USER_ID = prev;
  });

  it('no env → no bypass identity', () => {
    delete process.env.AUCTION_DEVELOPER_USER_ID;
    assert.equal(getAuctionDeveloperUserId(), '');
    assert.equal(isAuctionDeveloperUserId('any-user'), false);
  });

  it('only configured user id matches', () => {
    process.env.AUCTION_DEVELOPER_USER_ID = 'dev-user-99';
    assert.equal(isAuctionDeveloperUserId('dev-user-99'), true);
    assert.equal(isAuctionDeveloperUserId('other-user'), false);
  });
});

describe('Auction flow remediation — PostgreSQL integration', () => {
  const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;
  let pool;
  let db;
  let auctionService;
  let hostService;
  let bidService;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    db = require('./db');
    auctionService = require('./services/auction_service');
    hostService = require('./services/host_service');
    bidService = require('./services/bid_service');
    await db.runMigrations();
    pool = db.getPool();
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

  async function seedApprovedNoHost(client, ownerUserId = 'owner-regular') {
    const now = Date.now();
    const auction = await auctionService.createAuctionDraft(client, {
      listingId: `L-${now}`,
      videoId: `V-${now}`,
      species: 'horse',
      ownerUserId,
      createdByUserId: ownerUserId,
      startingPrice: 1000,
      minimumIncrement: 100,
      startAt: new Date(now + 3600000).toISOString(),
      endAt: new Date(now + 7200000).toISOString(),
      requiresHost: false,
    });
    await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: ownerUserId });
    const approved = await approveAuctionReview(client, auction.id, 'admin-test', { bypass: 'admin' });
    return approved;
  }

  it('regular user cannot schedule without admin approval', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const now = Date.now();
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: `L-nap-${now}`,
        videoId: `V-nap-${now}`,
        species: 'horse',
        ownerUserId: 'owner-nap',
        createdByUserId: 'owner-nap',
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: new Date(now + 3600000).toISOString(),
        endAt: new Date(now + 7200000).toISOString(),
        requiresHost: false,
      });
      await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'owner-nap' });
      const { scheduleAuctionIfEligible } = require('./services/approval_flow');
      await assert.rejects(
        () => scheduleAuctionIfEligible(client, auction.id, 'owner-nap'),
        (e) => e.code === 'AUCTION_NOT_APPROVED',
      );
    });
  });

  it('developer owner bypass is audited and schedules without host', async (t) => {
    if (!url) return t.skip('no DB');
    const prev = process.env.AUCTION_DEVELOPER_USER_ID;
    process.env.AUCTION_DEVELOPER_USER_ID = 'dev-owner-1';
    try {
      await db.withTransaction(async (client) => {
        await wipe(client);
        const now = Date.now();
        const auction = await auctionService.createAuctionDraft(client, {
          listingId: `L-dev-${now}`,
          videoId: `V-dev-${now}`,
          species: 'horse',
          ownerUserId: 'dev-owner-1',
          createdByUserId: 'dev-owner-1',
          startingPrice: 1000,
          minimumIncrement: 100,
          startAt: new Date(now + 3600000).toISOString(),
          endAt: new Date(now + 7200000).toISOString(),
          requiresHost: false,
        });
        await auctionService.transitionAuction(client, auction.id, 'review', {
          actorUserId: 'dev-owner-1',
        });
        const approved = await approveAuctionReview(client, auction.id, 'dev-owner-1', {
          bypass: 'developer',
          reason: 'owner_developer_exemption',
        });
        assert.equal(approved.status, 'scheduled');
        assert.equal(await isAuctionApproved(client, approved.id), true);
        const { rows: events } = await client.query(
          `SELECT event_type FROM auction_events WHERE auction_id = $1`,
          [approved.id],
        );
        assert.ok(events.some((e) => e.event_type === 'auction.review_bypassed_developer'));
      });
    } finally {
      if (prev == null) delete process.env.AUCTION_DEVELOPER_USER_ID;
      else process.env.AUCTION_DEVELOPER_USER_ID = prev;
    }
  });

  it('without approval events schedule is rejected', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const now = Date.now();
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: `L-noap-${now}`,
        videoId: `V-noap-${now}`,
        species: 'camel',
        ownerUserId: 'owner-noap',
        createdByUserId: 'owner-noap',
        startingPrice: 500,
        minimumIncrement: 50,
        startAt: new Date(now + 3600000).toISOString(),
        endAt: new Date(now + 7200000).toISOString(),
        requiresHost: false,
      });
      await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'owner-noap' });
      const { scheduleAuctionIfEligible } = require('./services/approval_flow');
      await assert.rejects(
        () => scheduleAuctionIfEligible(client, auction.id, 'owner-noap'),
        (e) => e.code === 'AUCTION_NOT_APPROVED',
      );
    });
  });

  it('owner still cannot bid after remediation', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const approved = await seedApprovedNoHost(client, 'owner-bid');
      await auctionService.transitionAuction(client, approved.id, 'live', { actorUserId: 'admin' });
      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: approved.id,
            bidderUserId: 'owner-bid',
            amount: 1100,
            idempotencyKey: 'owner-bid-k',
          }),
        (e) => e.code === 'BID_OWNER_FORBIDDEN',
      );
    });
  });

  it('with host — no schedule until host accepts after approval', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, { userId: 'host-h1', displayName: 'H' });
      await client.query(
        `UPDATE auction_hosts SET status = 'active', verified_at = NOW() WHERE id = $1`,
        [host.id],
      );
      const start = new Date(Date.now() + 86400000);
      const end = new Date(start.getTime() + 3600000);
      await hostService.addAvailability(client, {
        hostId: host.id,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-host',
        videoId: 'V-host',
        species: 'horse',
        ownerUserId: 'owner-host',
        createdByUserId: 'owner-host',
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        requiresHost: true,
      });
      await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'owner-host' });
      await recordAuctionApproval(client, auction.id, 'admin', { bypass: 'admin' });
      const { rows: st } = await client.query('SELECT status FROM auctions WHERE id = $1', [auction.id]);
      assert.equal(st[0].status, 'review');
      const booking = await hostService.requestHostBooking(client, {
        auctionId: auction.id,
        hostId: host.id,
        requestedByUserId: 'owner-host',
        scheduledStartAt: start.toISOString(),
        scheduledEndAt: end.toISOString(),
      });
      const accepted = await hostService.respondHostBooking(client, booking.id, true, {
        actorUserId: 'host-h1',
      });
      assert.equal(accepted.status, 'scheduled');
      const { rows: ast } = await client.query('SELECT status FROM auctions WHERE id = $1', [auction.id]);
      assert.equal(ast[0].status, 'scheduled');
    });
  });

  it('Path B preserves owner; host is not owner', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, { userId: 'host-b', displayName: 'Proxy' });
      await client.query(
        `UPDATE auction_hosts SET status = 'active', verified_at = NOW() WHERE id = $1`,
        [host.id],
      );
      const start = new Date(Date.now() + 86400000);
      const end = new Date(start.getTime() + 3600000);
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-path-b-rem',
        videoId: 'V-path-b-rem',
        species: 'falcon',
        ownerUserId: 'real-owner-b',
        createdByUserId: 'host-b',
        createdByRole: 'host_proxy',
        ownerConsentRef: 'consent-abc',
        startingPrice: 2000,
        minimumIncrement: 100,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        requiresHost: false,
      });
      assert.equal(auction.ownerUserId, 'real-owner-b');
      assert.equal(auction.createdByUserId, 'host-b');
      await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'host-b' });
      const approved = await approveAuctionReview(client, auction.id, 'admin', { bypass: 'admin' });
      assert.equal(approved.status, 'scheduled');
      assert.equal(approved.ownerUserId, 'real-owner-b');
    });
  });

  async function simulateSubmitReview(client, auctionId, actorUserId) {
    const { rows } = await client.query(
      'SELECT status, owner_user_id FROM auctions WHERE id = $1',
      [auctionId],
    );
    const row = rows[0];
    let result;
    if (row.status === 'draft') {
      result = await auctionService.transitionAuction(client, auctionId, 'review', {
        actorUserId,
      });
    } else if (row.status === 'review') {
      const { rows: fresh } = await client.query(
        `SELECT a.*, l.listing_id, l.video_id
         FROM auctions a JOIN auction_lots l ON l.id = a.lot_id WHERE a.id = $1`,
        [auctionId],
      );
      result = auctionService.mapAuctionRow(fresh[0]);
    } else {
      const err = new Error('invalid state');
      err.code = 'AUCTION_REVIEW_INVALID';
      throw err;
    }
    if (isAuctionDeveloperUserId(row.owner_user_id)) {
      result = await approveAuctionReview(client, auctionId, actorUserId, {
        bypass: 'developer',
        reason: 'owner_developer_exemption',
      });
    }
    return result;
  }

  it('unset AUCTION_DEVELOPER_USER_ID → no developer bypass on submit-review', async (t) => {
    if (!url) return t.skip('no DB');
    const prev = process.env.AUCTION_DEVELOPER_USER_ID;
    delete process.env.AUCTION_DEVELOPER_USER_ID;
    try {
      await db.withTransaction(async (client) => {
        await wipe(client);
        const now = Date.now();
        const auction = await auctionService.createAuctionDraft(client, {
          listingId: `L-unset-${now}`,
          videoId: `V-unset-${now}`,
          species: 'horse',
          ownerUserId: 'would-be-dev',
          createdByUserId: 'would-be-dev',
          startingPrice: 1000,
          minimumIncrement: 100,
          startAt: new Date(now + 3600000).toISOString(),
          endAt: new Date(now + 7200000).toISOString(),
          requiresHost: false,
        });
        const result = await simulateSubmitReview(client, auction.id, 'would-be-dev');
        assert.equal(result.status, 'review');
        assert.equal(await isAuctionApproved(client, auction.id), false);
        const { rows: events } = await client.query(
          `SELECT event_type FROM auction_events WHERE auction_id = $1`,
          [auction.id],
        );
        assert.equal(
          events.some((e) => e.event_type === 'auction.review_bypassed_developer'),
          false,
        );
      });
    } finally {
      if (prev == null) delete process.env.AUCTION_DEVELOPER_USER_ID;
      else process.env.AUCTION_DEVELOPER_USER_ID = prev;
    }
  });

  it('non-developer owner cannot get developer bypass when env points elsewhere', async (t) => {
    if (!url) return t.skip('no DB');
    const prev = process.env.AUCTION_DEVELOPER_USER_ID;
    process.env.AUCTION_DEVELOPER_USER_ID = 'real-dev-only';
    try {
      await db.withTransaction(async (client) => {
        await wipe(client);
        const now = Date.now();
        const auction = await auctionService.createAuctionDraft(client, {
          listingId: `L-imp-${now}`,
          videoId: `V-imp-${now}`,
          species: 'camel',
          ownerUserId: 'regular-owner',
          createdByUserId: 'regular-owner',
          startingPrice: 800,
          minimumIncrement: 50,
          startAt: new Date(now + 3600000).toISOString(),
          endAt: new Date(now + 7200000).toISOString(),
          requiresHost: false,
        });
        await simulateSubmitReview(client, auction.id, 'regular-owner');
        assert.equal(await isAuctionApproved(client, auction.id), false);
        const { scheduleAuctionIfEligible } = require('./services/approval_flow');
        await assert.rejects(
          () => scheduleAuctionIfEligible(client, auction.id, 'regular-owner'),
          (e) => e.code === 'AUCTION_NOT_APPROVED',
        );
      });
    } finally {
      if (prev == null) delete process.env.AUCTION_DEVELOPER_USER_ID;
      else process.env.AUCTION_DEVELOPER_USER_ID = prev;
    }
  });

  it('no-host: admin approval → scheduled', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const approved = await seedApprovedNoHost(client, 'owner-nohost');
      assert.equal(approved.status, 'scheduled');
      assert.equal(await isAuctionApproved(client, approved.id), true);
    });
  });

  it('concurrent schedule after approval — exactly one scheduled transition', async (t) => {
    if (!url) return t.skip('no DB');
    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const now = Date.now();
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: `L-conc-${now}`,
        videoId: `V-conc-${now}`,
        species: 'horse',
        ownerUserId: 'owner-conc',
        createdByUserId: 'owner-conc',
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: new Date(now + 3600000).toISOString(),
        endAt: new Date(now + 7200000).toISOString(),
        requiresHost: false,
      });
      await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'admin' });
      await recordAuctionApproval(client, auction.id, 'admin', { bypass: 'admin' });
      auctionId = auction.id;
    });
    const { scheduleAuctionIfEligible } = require('./services/approval_flow');
    const results = await Promise.allSettled([
      db.withTransaction((c) => scheduleAuctionIfEligible(c, auctionId, 'admin-a')),
      db.withTransaction((c) => scheduleAuctionIfEligible(c, auctionId, 'admin-b')),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const fail = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(fail.length, 1);
    const { rows } = await pool.query('SELECT status FROM auctions WHERE id = $1', [auctionId]);
    assert.equal(rows[0].status, 'scheduled');
  });
});
