'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { canTransitionHost, canHostAcceptBookings } = require('./domain/host');
const { PRE_AUDIO_CONTRACT } = require('./audio/pre_audio_contract');

describe('Auction Phase 4 — host domain (unit)', () => {
  it('host lifecycle transitions', () => {
    assert.equal(canTransitionHost('pending', 'verified'), true);
    assert.equal(canTransitionHost('verified', 'active'), true);
    assert.equal(canTransitionHost('active', 'suspended'), true);
    assert.equal(canTransitionHost('pending', 'active'), false);
  });

  it('only active+verified hosts accept bookings', () => {
    assert.equal(canHostAcceptBookings({ status: 'active', verified_at: new Date() }), true);
    assert.equal(canHostAcceptBookings({ status: 'verified', verified_at: new Date() }), false);
    assert.equal(canHostAcceptBookings({ status: 'active', verified_at: null }), false);
    assert.equal(canHostAcceptBookings({ status: 'suspended', verified_at: new Date() }), false);
  });

  it('pre-audio contract is stub only', () => {
    assert.equal(PRE_AUDIO_CONTRACT.phase4Behavior.wired, false);
    assert.equal(PRE_AUDIO_CONTRACT.phase4Behavior.microphonePermission, false);
  });
});

describe('Auction Phase 4 — host E2E (PostgreSQL)', () => {
  const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;
  let pool;
  let db;
  let hostService;
  let auctionService;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    db = require('./db');
    pool = db.getPool();
    await db.runMigrations();
    hostService = require('./services/host_service');
    auctionService = require('./services/auction_service');
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

  it('registration creates pending host', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, {
        userId: 'host-reg-1',
        displayName: 'محرّج',
        city: 'الرياض',
        specialties: ['horse'],
      });
      assert.equal(host.status, 'pending');
      assert.equal(host.city, 'الرياض');
    });
  });

  it('unverified host cannot accept booking requests', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, {
        userId: 'host-pending',
        displayName: 'Pending',
      });
      const start = new Date(Date.now() + 86400000);
      const end = new Date(start.getTime() + 3600000);
      await hostService.addAvailability(client, {
        hostId: host.id,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-pend',
        videoId: 'V-pend',
        species: 'horse',
        ownerUserId: 'owner-pend',
        createdByUserId: 'owner-pend',
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        requiresHost: true,
      });
      await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'admin' });
      const { recordAuctionApproval } = require('./services/approval_flow');
      await recordAuctionApproval(client, auction.id, 'admin', { bypass: 'admin' });
      await assert.rejects(
        () =>
          hostService.requestHostBooking(client, {
            auctionId: auction.id,
            hostId: host.id,
            requestedByUserId: 'owner-pend',
            scheduledStartAt: start.toISOString(),
            scheduledEndAt: end.toISOString(),
          }),
        (e) => e.code === 'HOST_NOT_ACTIVE',
      );
    });
  });

  it('suspended host rejected for booking', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, {
        userId: 'host-susp',
        displayName: 'Susp',
      });
      await activateHost(client, host.id);
      await hostService.suspendHost(client, host.id, 'admin-1', 'test');
      const start = new Date(Date.now() + 86400000);
      const end = new Date(start.getTime() + 3600000);
      await hostService.addAvailability(client, {
        hostId: host.id,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-susp',
        videoId: 'V-susp',
        species: 'horse',
        ownerUserId: 'owner-susp',
        createdByUserId: 'owner-susp',
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        requiresHost: true,
      });
      await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'admin' });
      const { recordAuctionApproval } = require('./services/approval_flow');
      await recordAuctionApproval(client, auction.id, 'admin', { bypass: 'admin' });
      await assert.rejects(
        () =>
          hostService.requestHostBooking(client, {
            auctionId: auction.id,
            hostId: host.id,
            requestedByUserId: 'owner-susp',
            scheduledStartAt: start.toISOString(),
            scheduledEndAt: end.toISOString(),
          }),
        (e) => e.code === 'HOST_NOT_ACTIVE',
      );
    });
  });

  it('availability overlap rejected', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, { userId: 'host-av', displayName: 'AV' });
      const start = new Date(Date.now() + 86400000);
      const end = new Date(start.getTime() + 3600000);
      await hostService.addAvailability(client, {
        hostId: host.id,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      await assert.rejects(
        () =>
          hostService.addAvailability(client, {
            hostId: host.id,
            startAt: new Date(start.getTime() + 1800000).toISOString(),
            endAt: new Date(end.getTime() + 1800000).toISOString(),
          }),
        (e) => e.code === 'HOST_AVAILABILITY_CONFLICT',
      );
    });
  });

  it('Path A E2E — seller auction → host request → host accept → scheduled', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, {
        userId: 'host-path-a',
        displayName: 'Path A Host',
      });
      await activateHost(client, host.id);
      const start = new Date(Date.now() + 86400000);
      const end = new Date(start.getTime() + 3600000);
      await hostService.addAvailability(client, {
        hostId: host.id,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-path-a',
        videoId: 'V-path-a',
        species: 'horse',
        ownerUserId: 'seller-path-a',
        createdByUserId: 'seller-path-a',
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
        requestedByUserId: 'seller-path-a',
        scheduledStartAt: start.toISOString(),
        scheduledEndAt: end.toISOString(),
      });
      assert.equal(booking.status, 'requested');
      const accepted = await hostService.respondHostBooking(client, booking.id, true, {
        actorUserId: 'host-path-a',
      });
      assert.equal(accepted.status, 'scheduled');
      const { rows } = await client.query(`SELECT status FROM auctions WHERE id = $1`, [
        auction.id,
      ]);
      assert.equal(rows[0].status, 'scheduled');
    });
  });

  it('Path B — host proxy draft requires owner consent; admin schedules', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, {
        userId: 'host-path-b',
        displayName: 'Proxy Host',
      });
      await activateHost(client, host.id);
      const start = new Date(Date.now() + 86400000);
      const end = new Date(start.getTime() + 3600000);
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-path-b',
        videoId: 'V-path-b',
        species: 'camel',
        ownerUserId: 'owner-path-b',
        createdByUserId: 'host-path-b',
        createdByRole: 'host_proxy',
        ownerConsentRef: 'consent-token-123',
        startingPrice: 2000,
        minimumIncrement: 100,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      assert.equal(auction.createdByRole, 'host_proxy');
      assert.notEqual(auction.ownerUserId, auction.createdByUserId);
      await auctionService.transitionAuction(client, auction.id, 'review', {
        actorUserId: 'admin-1',
      });
      const { approveAuctionReview } = require('./services/approval_flow');
      const scheduled = await approveAuctionReview(client, auction.id, 'admin-1', {
        bypass: 'admin',
      });
      assert.equal(scheduled.status, 'scheduled');
    });
  });

  it('host cannot become asset owner on Path B', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-owner',
        videoId: 'V-owner',
        species: 'falcon',
        ownerUserId: 'real-owner',
        createdByUserId: 'host-proxy-user',
        createdByRole: 'host_proxy',
        ownerConsentRef: 'consent-xyz',
        startingPrice: 5000,
        minimumIncrement: 200,
        startAt: new Date(Date.now() + 86400000).toISOString(),
        endAt: new Date(Date.now() + 90000000).toISOString(),
      });
      assert.equal(auction.ownerUserId, 'real-owner');
      assert.equal(auction.createdByUserId, 'host-proxy-user');
    });
  });

  it('concurrent booking requests — one wins for same slot', async (t) => {
    if (!url) return t.skip('no DB');
    let hostId;
    let start;
    let end;
    let auctionIds = [];
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, { userId: 'host-conc', displayName: 'C' });
      await activateHost(client, host.id);
      hostId = host.id;
      start = new Date(Date.now() + 86400000);
      end = new Date(start.getTime() + 3600000);
      await hostService.addAvailability(client, {
        hostId,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      for (let i = 0; i < 2; i += 1) {
        const a = await auctionService.createAuctionDraft(client, {
          listingId: `L-conc-${i}`,
          videoId: `V-conc-${i}`,
          species: 'horse',
          ownerUserId: `owner-conc-${i}`,
          createdByUserId: `owner-conc-${i}`,
          startingPrice: 1000,
          minimumIncrement: 100,
          startAt: start.toISOString(),
          endAt: end.toISOString(),
        });
        await auctionService.transitionAuction(client, a.id, 'review', { actorUserId: 'admin' });
        const { recordAuctionApproval } = require('./services/approval_flow');
        await recordAuctionApproval(client, a.id, 'admin', { bypass: 'admin' });
        auctionIds.push(a.id);
      }
    });

    const results = await Promise.allSettled(
      auctionIds.map((auctionId, i) =>
        db.withTransaction((client) =>
          hostService.requestHostBooking(client, {
            auctionId,
            hostId,
            requestedByUserId: `owner-conc-${i}`,
            scheduledStartAt: start.toISOString(),
            scheduledEndAt: end.toISOString(),
          }),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const fail = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(fail.length, 1);
    assert.equal(fail[0].reason.code, 'HOST_SCHEDULE_CONFLICT');
  });

  it('auction cannot schedule before admin review on host accept', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, { userId: 'host-draft', displayName: 'D' });
      await activateHost(client, host.id);
      const start = new Date(Date.now() + 86400000);
      const end = new Date(start.getTime() + 3600000);
      await hostService.addAvailability(client, {
        hostId: host.id,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-draft',
        videoId: 'V-draft',
        species: 'horse',
        ownerUserId: 'owner-draft',
        createdByUserId: 'owner-draft',
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        requiresHost: true,
      });
      await auctionService.transitionAuction(client, auction.id, 'review', {
        actorUserId: 'owner-draft',
      });
      await assert.rejects(
        () =>
          hostService.requestHostBooking(client, {
            auctionId: auction.id,
            hostId: host.id,
            requestedByUserId: 'owner-draft',
            scheduledStartAt: start.toISOString(),
            scheduledEndAt: end.toISOString(),
          }),
        (e) => e.code === 'HOST_AUCTION_NOT_APPROVED',
      );
    });
  });

  it('audit timeline includes host booking events', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, { userId: 'host-audit', displayName: 'A' });
      await activateHost(client, host.id);
      const start = new Date(Date.now() + 86400000);
      const end = new Date(start.getTime() + 3600000);
      await hostService.addAvailability(client, {
        hostId: host.id,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-audit',
        videoId: 'V-audit',
        species: 'horse',
        ownerUserId: 'owner-audit',
        createdByUserId: 'owner-audit',
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        requiresHost: true,
      });
      await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'admin' });
      const { approveAuctionReview } = require('./services/approval_flow');
      await approveAuctionReview(client, auction.id, 'admin', { bypass: 'admin' });
      const booking = await hostService.requestHostBooking(client, {
        auctionId: auction.id,
        hostId: host.id,
        requestedByUserId: 'owner-audit',
        scheduledStartAt: start.toISOString(),
        scheduledEndAt: end.toISOString(),
      });
      await hostService.respondHostBooking(client, booking.id, true, { actorUserId: 'host-audit' });
      const { rows } = await client.query(
        `SELECT event_type FROM auction_events WHERE auction_id = $1 ORDER BY created_at ASC`,
        [auction.id],
      );
      const types = rows.map((r) => r.event_type);
      assert.ok(types.includes('host.booking_requested'));
      assert.ok(types.includes('host.booking_accepted'));
    });
  });
});
