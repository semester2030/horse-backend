'use strict';

const express = require('express');
const { ENABLE_AUCTIONS, SETTLEMENT_NOTE } = require('./config');
const { withTransaction, isDbConfigured } = require('./db');
const {
  createAuctionDraft,
  transitionAuction,
  closeAuctionAtomic,
  mapAuctionRow,
} = require('./services/auction_service');
const { placeBid } = require('./services/bid_service');
const {
  registerHost,
  updateHostProfile,
  verifyHost,
  activateHost,
  rejectHost,
  suspendHost,
  reactivateHost,
  getHostById,
  getHostByUserId,
  listHosts,
  addAvailability,
  listAvailability,
  getHostCalendar,
  requestHostBooking,
  respondHostBooking,
  listBookingsForHost,
  listBookingsForUser,
} = require('./services/host_service');
const { discoverHosts } = require('./services/host_query_service');
const {
  prepareAudioSession,
  startAudioSession,
  pauseAudioSession,
  resumeAudioSession,
  endAudioSession,
  mintAudioToken,
  getAudioState,
  publicAudioState,
} = require('./services/audio_service');
const { PRE_AUDIO_CONTRACT } = require('./audio/pre_audio_contract');
const { createAuctionAudioProvider } = require('./audio');
const { assertSpecies } = require('./domain/species');
const { getPool } = require('./db');
const { freezeAuction, resumeAuction, adminCancelAuction } = require('./services/ops_service');
const {
  createDispute,
  assignDispute,
  resolveDispute,
  rejectDispute,
  listDisputes,
} = require('./services/dispute_service');
const {
  evaluateRiskSignals,
  listRiskSignals,
  acknowledgeRiskSignal,
} = require('./services/risk_service');
const {
  listAdminAuctions,
  getAdminAuctionDetail,
} = require('./services/admin_auction_service');

function adminActor(req) {
  return req.adminUserId || req.adminUser?.id || 'admin';
}

function auctionsFeatureGate(req, res, next) {
  if (!ENABLE_AUCTIONS) {
    return res.status(404).json({
      message: 'Auctions feature disabled',
      code: 'AUCTIONS_DISABLED',
    });
  }
  if (!isDbConfigured()) {
    return res.status(503).json({
      message: 'Auctions PostgreSQL not configured (AUCTIONS_DATABASE_URL)',
      code: 'AUCTIONS_DB_MISSING',
    });
  }
  next();
}

function registerAuctionRoutes(app, ctx) {
  const router = express.Router();
  const { auth, requireSessionUser, auctionRealtime } = ctx;
  const audio = createAuctionAudioProvider();
  const realtimeMode = 'WS_PHASE3_REST_AUTHORITY';

  router.use(auctionsFeatureGate);

  router.get('/status', (req, res) => {
    res.json({
      enabled: ENABLE_AUCTIONS,
      dbConfigured: isDbConfigured(),
      audioProvider: audio.name,
      audioConfigured: audio.isConfigured,
      audioWired: audio.name !== 'noop' && audio.isConfigured,
      settlementNote: SETTLEMENT_NOTE,
      v1Species: ['horse', 'camel', 'falcon'],
      realtimeMode: realtimeMode,
    });
  });

  const queryService = require('./services/auction_query_service');

  router.get('/', async (req, res) => {
    try {
      const { getPool } = require('./db');
      const pool = getPool();
      let list = await queryService.listAuctions(pool, {
        bucket: req.query.bucket,
        species: req.query.species,
        videoId: req.query.videoId,
        limit: req.query.limit,
      });
      const store = ctx.store;
      if (store) {
        list = list.map((a) => queryService.enrichVideoFromStore(a, store));
      }
      res.json({
        auctions: list,
        serverTime: new Date().toISOString(),
        realtimeMode,
      });
    } catch (err) {
      res.status(500).json({ message: err.message, code: 'AUCTION_LIST_ERROR' });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const { getPool } = require('./db');
      const pool = getPool();
      let auction = await queryService.getAuctionById(pool, req.params.id);
      if (!auction) {
        return res.status(404).json({ message: 'Auction not found', code: 'AUCTION_NOT_FOUND' });
      }
      if (ctx.store) {
        auction = queryService.enrichVideoFromStore(auction, ctx.store);
      }
      const bids = await queryService.listBids(pool, req.params.id, { limit: 20 });
      const host = await queryService.getHostBookingForAuction(pool, req.params.id);
      res.json({ auction, bids, host, serverTime: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ message: err.message, code: 'AUCTION_GET_ERROR' });
    }
  });

  router.get('/:id/bids', async (req, res) => {
    try {
      const { getPool } = require('./db');
      const bids = await queryService.listBids(getPool(), req.params.id, {
        limit: req.query.limit,
      });
      res.json({ bids });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/', auth, requireSessionUser, async (req, res) => {
    try {
      const body = req.body || {};
      const species = assertSpecies(body.species);
      const createdByRole =
        body.createdByRole === 'host_proxy' ? 'host_proxy' : 'seller';
      const ownerUserId =
        createdByRole === 'host_proxy'
          ? String(body.ownerUserId || '')
          : req.authUserId;
      if (!ownerUserId) {
        return res.status(400).json({ message: 'ownerUserId required' });
      }

      const auction = await withTransaction((client) =>
        createAuctionDraft(client, {
          listingId: body.listingId,
          videoId: body.videoId,
          species,
          title: body.title,
          ownerUserId,
          createdByUserId: req.authUserId,
          createdByRole,
          ownerConsentRef: body.ownerConsentRef,
          startingPrice: body.startingPrice,
          minimumIncrement: body.minimumIncrement,
          reservePrice: body.reservePrice,
          startAt: body.startAt,
          endAt: body.endAt,
          antiSnipingSeconds: body.antiSnipingSeconds,
        }),
      );
      res.status(201).json({ auction });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message,
        code: err.code || 'AUCTION_ERROR',
      });
    }
  });

  router.post('/:id/submit-review', auth, requireSessionUser, async (req, res) => {
    try {
      let beforeStatus;
      const auction = await withTransaction(async (client) => {
        const { rows } = await client.query('SELECT status FROM auctions WHERE id = $1', [
          req.params.id,
        ]);
        beforeStatus = rows[0]?.status;
        return transitionAuction(client, req.params.id, 'review', {
          actorUserId: req.authUserId,
        });
      });
      if (auctionRealtime) {
        auctionRealtime.publishTransition(beforeStatus, auction);
      }
      res.json({ auction });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/:id/schedule', auth, requireSessionUser, async (req, res) => {
    try {
      let beforeStatus;
      const auction = await withTransaction(async (client) => {
        const { rows } = await client.query('SELECT status FROM auctions WHERE id = $1', [
          req.params.id,
        ]);
        beforeStatus = rows[0]?.status;
        return transitionAuction(client, req.params.id, 'scheduled', {
          actorUserId: req.authUserId,
        });
      });
      if (auctionRealtime) {
        auctionRealtime.publishTransition(beforeStatus, auction);
      }
      res.json({ auction });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/:id/go-live', auth, requireSessionUser, async (req, res) => {
    try {
      let beforeStatus;
      const auction = await withTransaction(async (client) => {
        const { rows } = await client.query('SELECT status FROM auctions WHERE id = $1', [
          req.params.id,
        ]);
        beforeStatus = rows[0]?.status;
        await transitionAuction(client, req.params.id, 'live', {
          actorUserId: req.authUserId,
        });
        const { rows: fresh } = await client.query(
          `SELECT a.*, l.listing_id, l.video_id FROM auctions a
           JOIN auction_lots l ON l.id = a.lot_id WHERE a.id = $1`,
          [req.params.id],
        );
        return mapAuctionRow(fresh[0]);
      });
      if (auctionRealtime) {
        auctionRealtime.publishTransition(beforeStatus, auction);
      }
      res.json({ auction });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/:id/bids', auth, requireSessionUser, async (req, res) => {
    try {
      const idempotencyKey =
        req.headers['idempotency-key'] || req.body?.idempotencyKey;
      const result = await withTransaction((client) =>
        placeBid(client, {
          auctionId: req.params.id,
          bidderUserId: req.authUserId,
          amount: req.body?.amount,
          idempotencyKey,
          expectedVersion: req.body?.expectedVersion,
        }),
      );
      if (auctionRealtime && result.auction && !result.replay) {
        auctionRealtime.publishBidAccepted(result.auction, result.bid, {
          wasExtended: result.wasExtended,
        });
      }
      res.status(result.replay ? 200 : 201).json(result);
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message,
        code: err.code,
        details: err.details,
      });
    }
  });

  router.post('/:id/close', auth, requireSessionUser, async (req, res) => {
    try {
      let closedPayload;
      const auction = await withTransaction(async (client) => {
        const closed = await closeAuctionAtomic(client, req.params.id, {
          actorUserId: req.authUserId,
        });
        const { rows } = await client.query(
          `SELECT payload FROM auction_events
           WHERE auction_id = $1 AND event_type = 'auction.closed'
           ORDER BY created_at DESC LIMIT 1`,
          [req.params.id],
        );
        closedPayload = rows[0]?.payload || {};
        return closed;
      });
      if (auctionRealtime) {
        auctionRealtime.publishClosed(auction, closedPayload);
      }
      res.json({ auction });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/:id/events', auth, requireSessionUser, async (req, res) => {
    try {
      const { getPool } = require('./db');
      const { rows } = await getPool().query(
        `SELECT id, event_type, payload, actor_user_id, created_at
         FROM auction_events WHERE auction_id = $1 ORDER BY created_at ASC`,
        [req.params.id],
      );
      res.json({ events: rows });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ——— Host / Phase 4 ———
  router.get('/hosts/discover', auth, requireSessionUser, async (req, res) => {
    try {
      const { getPool } = require('./db');
      const hosts = await discoverHosts(getPool(), {
        species: req.query.species,
        city: req.query.city,
        windowStart: req.query.windowStart,
        windowEnd: req.query.windowEnd,
        limit: req.query.limit,
      });
      res.json({ hosts });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.get('/hosts/me', auth, requireSessionUser, async (req, res) => {
    try {
      const host = await withTransaction((client) =>
        getHostByUserId(client, req.authUserId),
      );
      res.json({ host });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/hosts/register', auth, requireSessionUser, async (req, res) => {
    try {
      const body = req.body || {};
      const host = await withTransaction((client) =>
        registerHost(client, {
          userId: req.authUserId,
          displayName: body.displayName,
          profileImageUrl: body.profileImageUrl,
          city: body.city,
          bio: body.bio,
          experience: body.experience,
          specialties: body.specialties,
        }),
      );
      res.status(201).json({ host });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.patch('/hosts/:hostId/profile', auth, requireSessionUser, async (req, res) => {
    try {
      const host = await withTransaction((client) =>
        updateHostProfile(client, req.params.hostId, req.authUserId, req.body || {}),
      );
      res.json({ host });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/hosts/:hostId', auth, requireSessionUser, async (req, res) => {
    try {
      const host = await withTransaction((client) => getHostById(client, req.params.hostId));
      if (!host) return res.status(404).json({ message: 'Host not found' });
      res.json({ host });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.get('/hosts/:hostId/availability', auth, requireSessionUser, async (req, res) => {
    try {
      const slots = await withTransaction((client) =>
        listAvailability(client, req.params.hostId),
      );
      res.json({ availability: slots });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/hosts/:hostId/availability', auth, requireSessionUser, async (req, res) => {
    try {
      const host = await withTransaction((client) => getHostById(client, req.params.hostId));
      if (!host || String(host.userId) !== String(req.authUserId)) {
        return res.status(403).json({ message: 'Forbidden', code: 'HOST_FORBIDDEN' });
      }
      const slot = await withTransaction((client) =>
        addAvailability(client, {
          hostId: req.params.hostId,
          startAt: req.body?.startAt,
          endAt: req.body?.endAt,
          slotType: req.body?.slotType,
        }),
      );
      res.status(201).json({ slot });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/hosts/:hostId/calendar', auth, requireSessionUser, async (req, res) => {
    try {
      const calendar = await withTransaction((client) =>
        getHostCalendar(client, req.params.hostId),
      );
      res.json({ calendar });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.get('/hosts/me/bookings', auth, requireSessionUser, async (req, res) => {
    try {
      const bookings = await withTransaction((client) =>
        listBookingsForHost(client, req.authUserId, { status: req.query.status }),
      );
      res.json({ bookings });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.get('/host-bookings/mine', auth, requireSessionUser, async (req, res) => {
    try {
      const bookings = await withTransaction((client) =>
        listBookingsForUser(client, req.authUserId),
      );
      res.json({ bookings });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.get('/audio/pre-audio-contract', (req, res) => {
    res.json({ contract: PRE_AUDIO_CONTRACT });
  });

  function audioError(res, err) {
    return res.status(err.status || 500).json({
      message: err.message,
      code: err.code || 'AUDIO_ERROR',
      biddingContinues: err.biddingContinues !== false,
    });
  }

  router.get('/:id/audio', auth, requireSessionUser, async (req, res) => {
    try {
      const state = await withTransaction((client) =>
        getAudioState(client, req.params.id, audio),
      );
      res.json({ audio: state, biddingContinues: true });
    } catch (err) {
      audioError(res, err);
    }
  });

  router.post('/:id/audio/prepare', auth, requireSessionUser, async (req, res) => {
    try {
      const session = await withTransaction((client) =>
        prepareAudioSession(client, req.params.id, req.authUserId, audio),
      );
      res.status(201).json({
        session,
        audio: publicAudioState(session, { providerConfigured: audio.isConfigured }),
        biddingContinues: true,
      });
    } catch (err) {
      audioError(res, err);
    }
  });

  router.post('/:id/audio/start', auth, requireSessionUser, async (req, res) => {
    try {
      const session = await withTransaction((client) =>
        startAudioSession(client, req.params.id, req.authUserId, audio),
      );
      res.json({
        session,
        audio: publicAudioState(session, { providerConfigured: audio.isConfigured }),
        biddingContinues: true,
      });
    } catch (err) {
      audioError(res, err);
    }
  });

  router.post('/:id/audio/pause', auth, requireSessionUser, async (req, res) => {
    try {
      const session = await withTransaction((client) =>
        pauseAudioSession(client, req.params.id, req.authUserId),
      );
      res.json({
        session,
        audio: publicAudioState(session, { providerConfigured: audio.isConfigured }),
        biddingContinues: true,
      });
    } catch (err) {
      audioError(res, err);
    }
  });

  router.post('/:id/audio/resume', auth, requireSessionUser, async (req, res) => {
    try {
      const session = await withTransaction((client) =>
        resumeAudioSession(client, req.params.id, req.authUserId),
      );
      res.json({
        session,
        audio: publicAudioState(session, { providerConfigured: audio.isConfigured }),
        biddingContinues: true,
      });
    } catch (err) {
      audioError(res, err);
    }
  });

  router.post('/:id/audio/end', auth, requireSessionUser, async (req, res) => {
    try {
      const session = await withTransaction((client) =>
        endAudioSession(client, req.params.id, req.authUserId, {
          reason: req.body?.reason,
        }),
      );
      res.json({
        session,
        audio: publicAudioState(session, { providerConfigured: audio.isConfigured }),
        biddingContinues: true,
      });
    } catch (err) {
      audioError(res, err);
    }
  });

  router.post('/:id/audio/token', auth, requireSessionUser, async (req, res) => {
    try {
      const publish = req.body?.publish === true;
      const token = await withTransaction((client) =>
        mintAudioToken(client, req.params.id, req.authUserId, audio, { publish }),
      );
      res.json({ token, biddingContinues: true });
    } catch (err) {
      audioError(res, err);
    }
  });

  router.post('/:auctionId/host-bookings', auth, requireSessionUser, async (req, res) => {
    try {
      const booking = await withTransaction((client) =>
        requestHostBooking(client, {
          auctionId: req.params.auctionId,
          hostId: req.body?.hostId,
          requestedByUserId: req.authUserId,
          scheduledStartAt: req.body?.scheduledStartAt,
          scheduledEndAt: req.body?.scheduledEndAt,
          ownerConsentRef: req.body?.ownerConsentRef,
        }),
      );
      res.status(201).json({ booking });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/host-bookings/:id/respond', auth, requireSessionUser, async (req, res) => {
    try {
      const booking = await withTransaction((client) =>
        respondHostBooking(client, req.params.id, req.body?.accept === true, {
          actorUserId: req.authUserId,
          rejectReason: req.body?.reason,
        }),
      );
      res.json({ booking });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  app.use('/auctions', router);
  return router;
}

function registerAuctionAdminRoutes(adminRouter, ctx) {
  const { requireAdminAuth, requirePerm, logAudit, auctionRealtime } = ctx;

  adminRouter.get(
    '/auctions',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      if (!ENABLE_AUCTIONS || !isDbConfigured()) {
        return res.status(503).json({ message: 'Auctions not enabled/configured' });
      }
      try {
        const auctions = await listAdminAuctions(getPool(), {
          status: req.query.status,
          species: req.query.species,
          ownerUserId: req.query.ownerUserId || req.query.owner,
          hostId: req.query.hostId || req.query.host,
          liveNow: req.query.liveNow,
          fromDate: req.query.from,
          toDate: req.query.to,
          minPrice: req.query.minPrice,
          maxPrice: req.query.maxPrice,
          q: req.query.q,
          limit: req.query.limit,
        });
        res.json({ auctions });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    },
  );

  adminRouter.get(
    '/auctions/disputes',
    requireAdminAuth,
    requirePerm('auctions:disputes'),
    async (req, res) => {
      try {
        const disputes = await listDisputes(getPool(), {
          status: req.query.status,
          auctionId: req.query.auctionId,
          limit: req.query.limit,
        });
        res.json({ disputes });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    },
  );

  adminRouter.get(
    '/auctions/hosts',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const hosts = await withTransaction((client) =>
          listHosts(client, { status: req.query.status, limit: req.query.limit }),
        );
        res.json({ hosts });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    },
  );

  adminRouter.get(
    '/auctions/:id',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const auction = await getAdminAuctionDetail(getPool(), req.params.id);
        if (!auction) return res.status(404).json({ message: 'Not found' });
        res.json({ auction });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    },
  );

  adminRouter.get(
    '/auctions/:id/timeline',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const auction = await getAdminAuctionDetail(getPool(), req.params.id);
        if (!auction) return res.status(404).json({ message: 'Not found' });
        res.json({ timeline: auction.timeline });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    },
  );

  adminRouter.post(
    '/auctions/:id/freeze',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        const auction = await withTransaction((client) =>
          freezeAuction(client, req.params.id, {
            adminId: adminActor(req),
            reason: req.body?.reason,
          }),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.freeze',
          entityType: 'auction',
          entityId: auction.id,
        });
        if (auctionRealtime) auctionRealtime.publishTransition(null, auction, { frozen: true });
        res.json({ auction });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/:id/resume',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        const auction = await withTransaction((client) =>
          resumeAuction(client, req.params.id, {
            adminId: adminActor(req),
            reason: req.body?.reason,
          }),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.resume',
          entityType: 'auction',
          entityId: auction.id,
        });
        if (auctionRealtime) auctionRealtime.publishTransition('frozen', auction);
        res.json({ auction });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/:id/cancel',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        const auction = await withTransaction((client) =>
          adminCancelAuction(client, req.params.id, {
            adminId: adminActor(req),
            reason: req.body?.reason,
          }),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.cancel',
          entityType: 'auction',
          entityId: auction.id,
        });
        if (auctionRealtime) {
          auctionRealtime.publishTransition(null, auction, { reason: req.body?.reason });
        }
        res.json({ auction });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/auctions/:id/risk-signals',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const signals = await listRiskSignals(getPool(), {
          auctionId: req.params.id,
          acknowledged: req.query.acknowledged,
        });
        res.json({ signals });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    },
  );

  adminRouter.post(
    '/auctions/:id/risk-signals/evaluate',
    requireAdminAuth,
    requirePerm('auctions:moderate'),
    async (req, res) => {
      try {
        const signals = await withTransaction((client) =>
          evaluateRiskSignals(client, req.params.id),
        );
        res.json({ signals });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/risk-signals/:signalId/acknowledge',
    requireAdminAuth,
    requirePerm('auctions:moderate'),
    async (req, res) => {
      try {
        const signal = await withTransaction((client) =>
          acknowledgeRiskSignal(client, req.params.signalId, {
            adminId: adminActor(req),
          }),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.risk.acknowledge',
          entityType: 'auction_risk_signal',
          entityId: signal.id,
        });
        res.json({ signal });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/disputes',
    requireAdminAuth,
    requirePerm('auctions:disputes'),
    async (req, res) => {
      try {
        const dispute = await withTransaction((client) =>
          createDispute(client, {
            auctionId: req.body?.auctionId,
            bidId: req.body?.bidId,
            reporterUserId: req.body?.reporterUserId || adminActor(req),
            category: req.body?.category,
            description: req.body?.description,
            evidenceRefs: req.body?.evidenceRefs,
          }),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.dispute.create',
          entityType: 'auction_dispute',
          entityId: dispute.id,
        });
        res.status(201).json({ dispute });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/disputes/:id/assign',
    requireAdminAuth,
    requirePerm('auctions:disputes'),
    async (req, res) => {
      try {
        const dispute = await withTransaction((client) =>
          assignDispute(client, req.params.id, { adminId: adminActor(req) }),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.dispute.assign',
          entityType: 'auction_dispute',
          entityId: dispute.id,
        });
        res.json({ dispute });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/disputes/:id/resolve',
    requireAdminAuth,
    requirePerm('auctions:disputes'),
    async (req, res) => {
      try {
        const dispute = await withTransaction((client) =>
          resolveDispute(client, req.params.id, {
            adminId: adminActor(req),
            resolution: req.body?.resolution,
            note: req.body?.note,
          }),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.dispute.resolve',
          entityType: 'auction_dispute',
          entityId: dispute.id,
        });
        res.json({ dispute });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/disputes/:id/reject',
    requireAdminAuth,
    requirePerm('auctions:disputes'),
    async (req, res) => {
      try {
        const dispute = await withTransaction((client) =>
          rejectDispute(client, req.params.id, {
            adminId: adminActor(req),
            note: req.body?.note,
          }),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.dispute.reject',
          entityType: 'auction_dispute',
          entityId: dispute.id,
        });
        res.json({ dispute });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/hosts/:hostId/verify',
    requireAdminAuth,
    requirePerm('auctions:moderate'),
    async (req, res) => {
      if (!ENABLE_AUCTIONS || !isDbConfigured()) {
        return res.status(503).json({ message: 'Auctions not enabled/configured' });
      }
      try {
        const host = await withTransaction(async (client) => {
          const verified = await verifyHost(client, req.params.hostId, adminActor(req));
          return activateHost(client, verified.id, adminActor(req));
        });
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.host.verify',
          entityType: 'auction_host',
          entityId: host.id,
        });
        res.json({ host });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/hosts/:hostId/reject',
    requireAdminAuth,
    requirePerm('auctions:moderate'),
    async (req, res) => {
      try {
        const host = await withTransaction((client) =>
          rejectHost(client, req.params.hostId, adminActor(req), req.body?.reason),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.host.reject',
          entityType: 'auction_host',
          entityId: host.id,
        });
        res.json({ host });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/hosts/:hostId/suspend',
    requireAdminAuth,
    requirePerm('auctions:moderate'),
    async (req, res) => {
      try {
        const host = await withTransaction((client) =>
          suspendHost(client, req.params.hostId, adminActor(req), req.body?.reason),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.host.suspend',
          entityType: 'auction_host',
          entityId: host.id,
        });
        res.json({ host });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/hosts/:hostId/reactivate',
    requireAdminAuth,
    requirePerm('auctions:moderate'),
    async (req, res) => {
      try {
        const host = await withTransaction((client) =>
          reactivateHost(client, req.params.hostId, adminActor(req)),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.host.reactivate',
          entityType: 'auction_host',
          entityId: host.id,
        });
        res.json({ host });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/:id/audio/force-end',
    requireAdminAuth,
    requirePerm('auctions:moderate'),
    async (req, res) => {
      if (!ENABLE_AUCTIONS || !isDbConfigured()) {
        return res.status(503).json({ message: 'Auctions not enabled/configured' });
      }
      try {
        const session = await withTransaction((client) =>
          endAudioSession(client, req.params.id, adminActor(req), {
            forced: true,
            reason: req.body?.reason || 'admin_force_end',
          }),
        );
        logAudit(ctx, {
          actorId: adminActor(req),
          action: 'auctions.audio.force_end',
          entityType: 'audio_session',
          entityId: session?.id || req.params.id,
        });
        res.json({ session, biddingContinues: true });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/auctions/:id/review',
    requireAdminAuth,
    requirePerm('auctions:moderate'),
    async (req, res) => {
      try {
        const to = req.body?.approve ? 'scheduled' : 'cancelled';
        let beforeStatus;
        const auction = await withTransaction(async (client) => {
          const { rows } = await client.query('SELECT status FROM auctions WHERE id = $1', [
            req.params.id,
          ]);
          beforeStatus = rows[0]?.status;
          if (beforeStatus !== 'review') {
            const err = new Error('Auction not in review status');
            err.code = 'AUCTION_REVIEW_INVALID';
            err.status = 409;
            throw err;
          }
          const result = await transitionAuction(client, req.params.id, to, {
            actorUserId: adminActor(req),
            reason: req.body?.reason,
          });
          await require('./services/auction_service').appendEvent(client, {
            auctionId: req.params.id,
            eventType: req.body?.approve ? 'admin.review.approved' : 'admin.review.rejected',
            payload: { reason: req.body?.reason || null },
            actorUserId: adminActor(req),
          });
          return result;
        });
        if (auctionRealtime) {
          auctionRealtime.publishTransition(beforeStatus, auction, {
            reason: req.body?.reason,
          });
        }
        logAudit(ctx, {
          actorId: adminActor(req),
          action: `auctions.review.${to}`,
          entityType: 'auction',
          entityId: auction.id,
        });
        res.json({ auction });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );
}

module.exports = {
  registerAuctionRoutes,
  registerAuctionAdminRoutes,
  auctionsFeatureGate,
};
