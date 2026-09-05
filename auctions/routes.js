'use strict';

const express = require('express');
const { ENABLE_AUCTIONS, SETTLEMENT_NOTE } = require('./config');
const {
  withTransaction,
  isDbConfigured,
  areMigrationsReady,
  getSchemaVersion,
  REQUIRED_MIGRATION_ID,
} = require('./db');
const {
  createAuctionDraft,
  updateSellerDraft,
  transitionAuction,
  closeAuctionAtomic,
  mapAuctionRow,
  appendEvent,
} = require('./services/auction_service');
const harajG10 = require('./services/haraj_bidder_security');
const harajInspection = require('./services/haraj_inspection');
const harajAfterMarket = require('./services/haraj_after_market');
const harajHistory = require('./services/haraj_history_analytics');
const harajCommandCenter = require('./services/haraj_admin_command_center');
const harajRisk = require('./services/haraj_risk_disputes');
const opsNotify = require('../ops_notify');
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
const { isAuctionDeveloperUserId } = require('./dev_testing');
const {
  validateAuctionAssetOwnership,
  validateIndependentAuctionCreate,
} = require('./services/ownership_validation');
const {
  isHarajChannel,
  assertNoOwnershipSpoof,
  applyHarajCreateDefaults,
  validateHarajSellerPayload,
  normalizeInspection,
} = require('./services/haraj_seller_submission');
const {
  scheduleAuctionIfEligible,
  approveAuctionReview,
} = require('./services/approval_flow');
  const {
    assertOwnerForLifecycle,
    assertManualGoLiveTimeAllowed,
  } = require('./services/lifecycle_auth');
  const {
    requireHarajAuctioneer,
    isHarajAuctioneer,
  } = require('./services/haraj_auctioneer_auth');
  const harajReview = require('./services/haraj_auctioneer_review');
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
  if (!areMigrationsReady()) {
    return res.status(503).json({
      message: 'Auctions schema migrations not ready',
      code: 'AUCTIONS_MIGRATIONS_NOT_READY',
      requiredMigrationId: REQUIRED_MIGRATION_ID,
      schemaVersion: getSchemaVersion(),
    });
  }
  next();
}

function registerAuctionRoutes(app, ctx) {
  const router = express.Router();
  const { auth, requireSessionUser, auctionRealtime } = ctx;
  const audio = createAuctionAudioProvider();
  const realtimeMode = 'WS_PHASE3_REST_AUTHORITY';

  const harajObs = require('./services/haraj_observability');
  router.use(auctionsFeatureGate);

  router.get('/ready', (req, res) => {
    const readiness = harajObs.getReadiness({
      auctionsReady: ENABLE_AUCTIONS && isDbConfigured() && areMigrationsReady(),
      dbConfigured: isDbConfigured(),
      schemaVersion: getSchemaVersion(),
      migrationsReady: areMigrationsReady(),
    });
    res.status(readiness.ready ? 200 : 503).json({ ...readiness, requestId: req.correlationId });
  });

  router.get('/status', (req, res) => {
    res.json({
      enabled: ENABLE_AUCTIONS,
      dbConfigured: isDbConfigured(),
      migrationsReady: areMigrationsReady(),
      schemaVersion: getSchemaVersion(),
      requiredMigrationId: REQUIRED_MIGRATION_ID,
      ready: ENABLE_AUCTIONS && isDbConfigured() && areMigrationsReady(),
      audioProvider: audio.name,
      audioConfigured: audio.isConfigured,
      audioWired: audio.name !== 'noop' && audio.isConfigured,
      settlementNote: SETTLEMENT_NOTE,
      v1Species: ['horse', 'camel', 'falcon'],
      realtimeMode: realtimeMode,
      requestId: req.correlationId,
      version: harajObs.deployedVersion(),
    });
  });

  const queryService = require('./services/auction_query_service');
  const {
    requireListingLocationSnapshot,
    requireAuctionOwnerLocation,
  } = require('./services/location_snapshot');
  const { recordQualifiedView, getBidAggregates, getExtensionsCount } = require('./services/metrics_service');

  router.get('/mine', auth, requireSessionUser, async (req, res) => {
    try {
      const { getPool } = require('./db');
      const list = await queryService.listSellerAuctions(getPool(), req.authUserId, {
        limit: req.query.limit,
      });
      const pool = getPool();
      for (const item of list) {
        item.harajReview = await harajReview.sellerReviewSummary(pool, {
          id: item.id,
          status: item.status,
        });
        item.harajInspection = await harajInspection.publicSummary(pool, item.id);
        item.harajAfterMarket = await harajAfterMarket.publicSummary(pool, item.id);
      }
      res.json({
        auctions: list,
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ message: err.message, code: 'AUCTION_MINE_ERROR' });
    }
  });

  router.get('/haraj/review/summary', auth, requireSessionUser, requireHarajAuctioneer, async (req, res) => {
    try {
      const counts = await harajReview.summaryCounts(getPool());
      res.json({ counts, serverTime: new Date().toISOString() });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code || 'AUCTIONEER_SUMMARY_ERROR' });
    }
  });

  router.get('/haraj/review/queue', auth, requireSessionUser, requireHarajAuctioneer, async (req, res) => {
    try {
      const auctions = await harajReview.listQueue(getPool(), {
        bucket: req.query.bucket,
        species: req.query.species,
        ownerUserId: req.query.seller,
        city: req.query.city || req.query.location,
        limit: req.query.limit,
      });
      res.json({ auctions, serverTime: new Date().toISOString() });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code || 'AUCTIONEER_QUEUE_ERROR' });
    }
  });

  const harajLive = require('./services/haraj_live_room');

  async function runHarajLive(req, res, fn, eventType) {
    try {
      const snapshot = await withTransaction((client) =>
        fn(client, {
          roomSessionId: req.params.roomSessionId,
          auctionId: req.params.auctionId || req.body?.auctionId || req.body?.lotId,
          reason: req.body?.reason,
          actorUserId: req.authUserId,
          admin: false,
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        }),
      );
      if (auctionRealtime) harajLive.publishIfPossible(auctionRealtime, snapshot, eventType);
      res.json({ snapshot, livekit: snapshot.livekit });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  }

  function dispatchInspectionNotifications(items) {
    if (!items || !items.length || !ctx.store) return;
    if (harajInspection.isProductionNotifyForbidden()) return;
    const idFn = ctx.id || (() => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    for (const item of items) {
      opsNotify.notifyUser(
        { store: ctx.store, id: idFn },
        {
          userId: item.userId,
          title: item.title,
          body: item.body,
          meta: item.meta,
        },
      );
    }
    if (typeof ctx.saveStore === 'function') ctx.saveStore();
  }

  router.get('/haraj/inspections/mine', auth, requireSessionUser, async (req, res) => {
    try {
      const cases = await withTransaction((client) =>
        harajInspection.listCases(client, {
          actorUserId: req.authUserId,
          actorRole: 'buyer',
          limit: req.query.limit,
        }),
      );
      res.json({
        cases,
        serverTime: new Date().toISOString(),
        settlementImplemented: false,
        livekit: { implemented: false, classification: 'NOT IMPLEMENTED / NOT TESTED' },
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/haraj/inspections', auth, requireSessionUser, requireHarajAuctioneer, async (req, res) => {
    try {
      const cases = await withTransaction((client) =>
        harajInspection.listCases(client, {
          actorUserId: req.authUserId,
          actorRole: 'auctioneer',
          limit: req.query.limit,
        }),
      );
      res.json({ cases, serverTime: new Date().toISOString() });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/:id/inspection', auth, requireSessionUser, async (req, res) => {
    try {
      const inspection = await withTransaction((client) =>
        harajInspection.getInspectionCase(client, {
          auctionId: req.params.id,
          actorUserId: req.authUserId,
          actorRole: isHarajAuctioneer(req.authUser, req.authUserId) ? 'auctioneer' : undefined,
        }),
      );
      res.json({
        inspection,
        serverTime: new Date().toISOString(),
        settlementImplemented: false,
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/:id/inspection/ensure', auth, requireSessionUser, async (req, res) => {
    try {
      const result = await withTransaction((client) =>
        harajInspection.ensureInspectionCase(client, {
          auctionId: req.params.id,
          actorUserId: req.authUserId,
          actorRole: 'buyer',
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        }),
      );
      dispatchInspectionNotifications(result.notifications);
      res.status(result.replay ? 200 : 201).json({
        inspection: result.case,
        replay: result.replay,
        settlementImplemented: false,
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/:id/inspection/decision', auth, requireSessionUser, async (req, res) => {
    try {
      if (req.body?.winnerUserId || req.body?.winner_user_id || req.body?.userId || req.body?.auctionId) {
        return res.status(403).json({
          message: 'Client-supplied winner/user/auction identity is not authoritative',
          code: 'INSPECTION_CLIENT_AUTHORITY_FORBIDDEN',
        });
      }
      const result = await withTransaction(async (client) => {
        const out = await harajInspection.submitBuyerDecision(client, {
          auctionId: req.params.id,
          actorUserId: req.authUserId,
          outcome: req.body?.outcome,
          reasonCategory: req.body?.reasonCategory,
          statement: req.body?.statement,
          evidence: req.body?.evidence,
          expectedUpdatedAt: req.body?.expectedUpdatedAt,
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        });
        if (out.case?.awardStatus === 'withdrawn') {
          out.g16 = await harajRisk.escalateWithdrawal(client, {
            auctionId: req.params.id,
            actorUserId: req.authUserId,
            buyerUserId: out.case.winnerUserId,
            awardId: out.case.awardId,
          });
        }
        return out;
      });
      try {
        harajObs.applyInject(req, 'notify');
        dispatchInspectionNotifications(result.notifications);
      } catch (notifyErr) {
        harajObs.logStructured('error', 'notify.failed_after_commit', {
          requestId: req.correlationId,
          auctionId: req.params.id,
          taxonomy: 'DEPENDENCY_FAILURE',
          code: notifyErr.code || null,
          businessCommitted: true,
        });
      }
      res.json({
        inspection: result.case,
        replay: result.replay,
        settlementImplemented: false,
        g16: result.g16 || null,
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/:id/inspection/seller-response', auth, requireSessionUser, async (req, res) => {
    try {
      const result = await withTransaction((client) =>
        harajInspection.sellerRespond(client, {
          auctionId: req.params.id,
          actorUserId: req.authUserId,
          statement: req.body?.statement,
          expectedUpdatedAt: req.body?.expectedUpdatedAt,
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        }),
      );
      res.json({ inspection: result.case, replay: result.replay });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/:id/inspection/schedule', auth, requireSessionUser, requireHarajAuctioneer, async (req, res) => {
    try {
      if (req.body?.winnerUserId || req.body?.currentPrice || req.body?.bidAmount) {
        return res.status(403).json({
          message: 'Auctioneer cannot change winner, bids, or money',
          code: 'INSPECTION_AUCTIONEER_FORBIDDEN',
        });
      }
      const inspection = await withTransaction((client) =>
        harajInspection.scheduleInspection(client, {
          auctionId: req.params.id,
          actorUserId: req.authUserId,
          actorRole: 'auctioneer',
          scheduledAt: req.body?.scheduledAt,
          notes: req.body?.notes,
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        }),
      );
      res.json({ inspection });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  function dispatchAfterHarajNotifications(items) {
    if (!items || !items.length || !ctx.store) return;
    if (harajAfterMarket.isProductionNotifyForbidden()) return;
    const idFn = ctx.id || (() => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    for (const item of items) {
      opsNotify.notifyUser(
        { store: ctx.store, id: idFn },
        {
          userId: item.userId,
          title: item.title,
          body: item.body,
          meta: item.meta,
        },
      );
    }
    if (typeof ctx.saveStore === 'function') ctx.saveStore();
  }

  function afterHarajActorRole(req) {
    if (isHarajAuctioneer(req.authUser, req.authUserId)) return 'auctioneer';
    return 'user';
  }

  function historyActorRole(req) {
    if (isHarajAuctioneer(req.authUser, req.authUserId)) return 'auctioneer';
    return 'user';
  }

  router.get('/haraj/history', auth, requireSessionUser, async (req, res) => {
    try {
      const role = historyActorRole(req);
      const result = await withTransaction((client) =>
        harajHistory.loadHistoryList(client, {
          species: req.query.species,
          status: req.query.status,
          from: req.query.from,
          to: req.query.to,
          afterHarajMode: req.query.afterHarajMode,
          inspectionOutcome: req.query.inspectionOutcome,
          roomSessionId: req.query.roomSessionId,
          sessionId: req.query.sessionId,
          limit: req.query.limit,
        }, {
          role: role === 'auctioneer' ? 'auctioneer' : 'user',
          actorUserId: req.authUserId,
        }),
      );
      if (req.query.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        return res.send(harajHistory.toCsv(result.items));
      }
      res.json({ history: result, ai: harajHistory.AI_STATUS });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/haraj/analytics', auth, requireSessionUser, async (req, res) => {
    try {
      if (historyActorRole(req) === 'auctioneer') {
        return res.status(403).json({
          message: 'Auctioneer cannot read seller/admin analytics',
          code: 'ANALYTICS_FORBIDDEN',
        });
      }
      const analytics = await withTransaction((client) =>
        harajHistory.getAnalytics(client, {
          species: req.query.species,
          status: req.query.status,
          from: req.query.from,
          to: req.query.to,
          afterHarajMode: req.query.afterHarajMode,
          inspectionOutcome: req.query.inspectionOutcome,
          roomSessionId: req.query.roomSessionId,
          sessionId: req.query.sessionId,
        }, { role: 'seller', actorUserId: req.authUserId }),
      );
      res.json({ analytics, ai: harajHistory.AI_STATUS });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/haraj/cases/:id', auth, requireSessionUser, async (req, res) => {
    try {
      const detail = await withTransaction((client) => harajRisk.getCase(client, req.params.id));
      const reporter = detail.case?.reporterUserId;
      const isReporter = String(reporter) === String(req.authUserId);
      if (!isReporter) {
        return res.status(403).json({ message: 'Not authorized for this case', code: 'CASE_FORBIDDEN' });
      }
      res.json(harajRisk.publicCaseView(detail));
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/:id/haraj-history', auth, requireSessionUser, async (req, res) => {
    try {
      const record = await withTransaction((client) =>
        harajHistory.getRecord(client, {
          auctionId: req.params.id,
          actorUserId: req.authUserId,
          actorRole: historyActorRole(req),
        }),
      );
      res.json({ history: record, ai: harajHistory.AI_STATUS });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/haraj/after-market', async (req, res) => {
    try {
      const listings = await withTransaction((client) =>
        harajAfterMarket.listDiscovery(client, {
          species: req.query.species,
          limit: req.query.limit,
        }),
      );
      res.json({
        listings,
        settlementImplemented: false,
        ai: harajAfterMarket.AI_STATUS,
        livekit: { implemented: false, classification: 'NOT IMPLEMENTED / NOT TESTED' },
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/:id/after-haraj', auth, requireSessionUser, async (req, res) => {
    try {
      const afterHaraj = await withTransaction((client) =>
        harajAfterMarket.getAfterHaraj(client, {
          auctionId: req.params.id,
          actorUserId: req.authUserId,
          actorRole: afterHarajActorRole(req),
        }),
      );
      res.json({
        afterHaraj,
        settlementImplemented: false,
        ai: harajAfterMarket.AI_STATUS,
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/:id/after-haraj', auth, requireSessionUser, async (req, res) => {
    try {
      if (req.body?.buyerUserId || req.body?.sellerUserId) {
        return res.status(403).json({
          message: 'Client cannot spoof buyer or seller identity',
          code: 'AFTER_HARAJ_IDENTITY_SPOOF',
        });
      }
      const result = await withTransaction((client) =>
        harajAfterMarket.activateDisposition(client, {
          auctionId: req.params.id,
          actorUserId: req.authUserId,
          actorRole: afterHarajActorRole(req),
          mode: req.body?.mode,
          approvedPrice: req.body?.approvedPrice,
          startingPrice: req.body?.startingPrice,
          reservePrice: req.body?.reservePrice,
          minimumIncrement: req.body?.minimumIncrement,
          startAt: req.body?.startAt,
          endAt: req.body?.endAt,
          antiSnipingSeconds: req.body?.antiSnipingSeconds,
          currentPresentation: req.body?.currentPresentation,
          copyLastBid: req.body?.copyLastBid,
          useHighestBid: req.body?.useHighestBid,
          expectedUpdatedAt: req.body?.expectedUpdatedAt,
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        }),
      );
      dispatchAfterHarajNotifications(result.notifications);
      res.status(result.replay ? 200 : 201).json({
        afterHaraj: result.view,
        replay: result.replay,
        settlementImplemented: false,
        ai: harajAfterMarket.AI_STATUS,
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code, details: err.details });
    }
  });

  router.post('/:id/after-haraj/offers', auth, requireSessionUser, async (req, res) => {
    try {
      if (req.body?.buyerUserId || req.body?.sellerUserId) {
        return res.status(403).json({
          message: 'Client cannot spoof buyer or seller identity',
          code: 'AFTER_HARAJ_IDENTITY_SPOOF',
        });
      }
      const result = await withTransaction((client) =>
        harajAfterMarket.submitOffer(client, {
          auctionId: req.params.id,
          actorUserId: req.authUserId,
          amount: req.body?.amount,
          stagingExpiresInSeconds: req.body?.stagingExpiresInSeconds,
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        }),
      );
      dispatchAfterHarajNotifications(result.notifications);
      res.status(result.replay ? 200 : 201).json({
        afterHaraj: result.view,
        offerId: result.offerId,
        replay: result.replay,
        settlementImplemented: false,
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/:id/after-haraj/offers/:offerId/withdraw', auth, requireSessionUser, async (req, res) => {
    try {
      const result = await withTransaction((client) =>
        harajAfterMarket.withdrawOffer(client, {
          auctionId: req.params.id,
          offerId: req.params.offerId,
          actorUserId: req.authUserId,
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        }),
      );
      dispatchAfterHarajNotifications(result.notifications);
      res.json({ afterHaraj: result.view, replay: result.replay, settlementImplemented: false });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/:id/after-haraj/offers/:offerId/accept', auth, requireSessionUser, async (req, res) => {
    try {
      const result = await withTransaction((client) =>
        harajAfterMarket.decideOffer(client, {
          auctionId: req.params.id,
          offerId: req.params.offerId,
          decision: 'accept',
          actorUserId: req.authUserId,
          actorRole: afterHarajActorRole(req),
          expectedUpdatedAt: req.body?.expectedUpdatedAt,
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        }),
      );
      dispatchAfterHarajNotifications(result.notifications);
      res.json({ afterHaraj: result.view, replay: result.replay, settlementImplemented: false, requestId: req.correlationId });
    } catch (err) {
      if (err.code === 'AFTER_HARAJ_STALE_STATE' || err.status === 409) {
        try { harajObs.recordAfterHarajConflict(); } catch { /* obs */ }
      }
      res.status(err.status || 500).json(harajObs.safeErrorBody(err, req));
    }
  });

  router.post('/:id/after-haraj/offers/:offerId/reject', auth, requireSessionUser, async (req, res) => {
    try {
      const result = await withTransaction((client) =>
        harajAfterMarket.decideOffer(client, {
          auctionId: req.params.id,
          offerId: req.params.offerId,
          decision: 'reject',
          actorUserId: req.authUserId,
          actorRole: afterHarajActorRole(req),
          expectedUpdatedAt: req.body?.expectedUpdatedAt,
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        }),
      );
      dispatchAfterHarajNotifications(result.notifications);
      res.json({ afterHaraj: result.view, replay: result.replay, settlementImplemented: false });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.post('/:id/after-haraj/purchase-intent', auth, requireSessionUser, async (req, res) => {
    try {
      const result = await withTransaction((client) =>
        harajAfterMarket.createPurchaseIntent(client, {
          auctionId: req.params.id,
          actorUserId: req.authUserId,
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        }),
      );
      dispatchAfterHarajNotifications(result.notifications);
      res.status(result.replay ? 200 : 201).json({
        afterHaraj: result.view,
        replay: result.replay,
        settlementImplemented: false,
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/haraj/me/eligibility', auth, requireSessionUser, async (req, res) => {
    try {
      const dossier = await withTransaction((client) => harajG10.getSelfEligibility(client, req.authUserId));
      res.json({
        eligibility: dossier,
        livekit: { implemented: false, classification: 'NOT IMPLEMENTED / NOT TESTED' },
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });

  router.get('/haraj/rooms/:roomSessionId', auth, requireSessionUser, async (req, res) => {
    try {
      const snapshot = await withTransaction((client) => harajLive.getSnapshot(client, req.params.roomSessionId));
      res.json({ snapshot, reconnect: true, subscribe: `haraj-room:${req.params.roomSessionId}` });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  });
  router.post('/haraj/rooms/:roomSessionId/ready', auth, requireSessionUser, requireHarajAuctioneer, (req, res) =>
    runHarajLive(req, res, harajLive.readyRoom, 'room.ready'),
  );
  router.post('/haraj/rooms/:roomSessionId/start', auth, requireSessionUser, requireHarajAuctioneer, (req, res) =>
    runHarajLive(req, res, harajLive.startRoom, 'room.live'),
  );
  router.post('/haraj/rooms/:roomSessionId/pause', auth, requireSessionUser, requireHarajAuctioneer, (req, res) =>
    runHarajLive(req, res, harajLive.pauseRoom, 'room.paused'),
  );
  router.post('/haraj/rooms/:roomSessionId/resume', auth, requireSessionUser, requireHarajAuctioneer, (req, res) =>
    runHarajLive(req, res, harajLive.resumeRoom, 'room.resumed'),
  );
  router.post('/haraj/rooms/:roomSessionId/advance', auth, requireSessionUser, requireHarajAuctioneer, (req, res) =>
    runHarajLive(req, res, harajLive.advanceLot, 'lot.completed'),
  );
  router.post('/haraj/rooms/:roomSessionId/complete', auth, requireSessionUser, requireHarajAuctioneer, (req, res) =>
    runHarajLive(req, res, harajLive.completeRoom, 'room.completed'),
  );
  router.post(
    '/haraj/rooms/:roomSessionId/lots/:auctionId/activate',
    auth,
    requireSessionUser,
    requireHarajAuctioneer,
    (req, res) => runHarajLive(req, res, harajLive.activateLot, 'lot.activated'),
  );
  router.post(
    '/haraj/rooms/:roomSessionId/lots/:auctionId/skip',
    auth,
    requireSessionUser,
    requireHarajAuctioneer,
    (req, res) => runHarajLive(req, res, harajLive.skipLot, 'lot.skipped'),
  );

  router.get('/haraj/review/:id/history', auth, requireSessionUser, requireHarajAuctioneer, async (req, res) => {
    try {
      const history = await withTransaction(async (client) => {
        await harajReview.getReviewable(client, req.params.id, req.authUserId);
        return harajReview.listHistory(client, req.params.id, { includeInternal: true });
      });
      res.json({ history });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code || 'AUCTIONEER_HISTORY_ERROR' });
    }
  });

  router.get('/haraj/review/:id', auth, requireSessionUser, requireHarajAuctioneer, async (req, res) => {
    try {
      const auction = await withTransaction((client) =>
        harajReview.getReviewable(client, req.params.id, req.authUserId),
      );
      res.json({
        auction,
        dataClasses: {
          sellerProvided: ['title', 'description', 'species', 'breed', 'media', 'location', 'inspection', 'startingPrice', 'reservePrice'],
          systemVerified: ['id', 'status', 'createdAt', 'ownerUserId', 'minimumIncrement'],
          auctioneerNotes: ['harajReview.internalNote'],
        },
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code || 'AUCTIONEER_GET_ERROR' });
    }
  });

  function reviewAction(handler) {
    return async (req, res) => {
      try {
        const cid = harajReview.correlationId(req);
        const auction = await withTransaction((client) =>
          handler(client, {
            auctionId: req.params.id,
            actorUserId: req.authUserId,
            reason: req.body?.reason,
            sellerMessage: req.body?.sellerMessage,
            internalNote: req.body?.internalNote || req.body?.note,
            expectedStatus: req.body?.expectedStatus,
            expectedVersion: req.body?.expectedVersion,
            correlationId: cid,
          }),
        );
        res.json({ auction });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code || 'AUCTIONEER_ACTION_ERROR' });
      }
    };
  }

  router.post(
    '/haraj/review/:id/accept',
    auth,
    requireSessionUser,
    requireHarajAuctioneer,
    reviewAction((client, args) => harajReview.acceptLot(client, args)),
  );
  router.post(
    '/haraj/review/:id/request-changes',
    auth,
    requireSessionUser,
    requireHarajAuctioneer,
    reviewAction((client, args) => harajReview.requestChanges(client, args)),
  );
  router.post(
    '/haraj/review/:id/reject',
    auth,
    requireSessionUser,
    requireHarajAuctioneer,
    reviewAction((client, args) => harajReview.rejectLot(client, args)),
  );
  router.post(
    '/haraj/review/:id/notes',
    auth,
    requireSessionUser,
    requireHarajAuctioneer,
    reviewAction((client, args) =>
      harajReview.addInternalNote(client, { ...args, note: args.internalNote }),
    ),
  );

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
      let auction = await queryService.getAuctionById(pool, req.params.id, {
        wsHub: ctx.wsHub,
      });
      if (!auction) {
        return res.status(404).json({ message: 'Auction not found', code: 'AUCTION_NOT_FOUND' });
      }
      if (ctx.store) {
        auction = queryService.enrichVideoFromStore(auction, ctx.store);
      }
      const page = await queryService.listBids(pool, req.params.id, { limit: 20 });
      const host = await queryService.getHostBookingForAuction(pool, req.params.id);
      auction.harajReview = await harajReview.sellerReviewSummary(pool, {
        id: auction.id,
        status: auction.status,
      });
      auction.harajInspection = await harajInspection.publicSummary(pool, auction.id);
      auction.harajAfterMarket = await harajAfterMarket.publicSummary(pool, auction.id);
      res.json({
        auction,
        bids: page.bids,
        bidsNextCursor: page.nextCursor,
        host,
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ message: err.message, code: 'AUCTION_GET_ERROR' });
    }
  });

  router.get('/:id/bids', async (req, res) => {
    try {
      const { getPool } = require('./db');
      const page = await queryService.listBids(getPool(), req.params.id, {
        limit: req.query.limit,
        cursor: req.query.cursor,
        includeBidderId: false,
      });
      res.json({
        bids: page.bids,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/:id/views', auth, requireSessionUser, async (req, res) => {
    try {
      const { getPool } = require('./db');
      const pool = getPool();
      const auction = await queryService.getAuctionById(pool, req.params.id, {
        wsHub: ctx.wsHub,
      });
      if (!auction) {
        return res.status(404).json({ message: 'Auction not found', code: 'AUCTION_NOT_FOUND' });
      }
      const result = await recordQualifiedView(pool, {
        auctionId: req.params.id,
        viewerKey: String(req.authUserId),
      });
      const { loadAuctionMetrics } = require('./services/metrics_service');
      const fresh = await loadAuctionMetrics(pool, req.params.id);
      res.json({
        view: result,
        metrics: {
          viewCount: fresh.viewCount,
          uniqueViewers: fresh.uniqueViewers,
          liveViewers: auction.liveViewers,
          uniqueBidders: fresh.uniqueBidders,
          bidCount: fresh.bidCount,
          inserted: result.inserted,
        },
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message,
        code: err.code || 'AUCTION_VIEW_ERROR',
      });
    }
  });

  router.post('/', auth, requireSessionUser, async (req, res) => {
    try {
      harajObs.applyInject(req, 'media');
      const rawBody = req.body || {};
      const haraj = isHarajChannel(rawBody);
      const spoof = assertNoOwnershipSpoof(rawBody, req.authUserId, {
        allowHostProxyOwner:
          rawBody.createdByRole === 'host_proxy' && !haraj,
      });
      if (!spoof.ok) {
        return res.status(spoof.status).json({
          message: spoof.message,
          code: spoof.code,
        });
      }

      const body = haraj ? applyHarajCreateDefaults(rawBody) : rawBody;
      let harajMeta = null;
      if (haraj) {
        const hv = validateHarajSellerPayload(body);
        if (!hv.ok) {
          return res.status(hv.status).json({
            message: hv.message,
            code: hv.code,
          });
        }
        harajMeta = hv;
        body.title = hv.title;
        body.description = hv.description;
        body.species = hv.species;
      }

      const species = assertSpecies(body.species);
      const createdByRole =
        haraj
          ? 'seller'
          : body.createdByRole === 'host_proxy'
            ? 'host_proxy'
            : 'seller';
      const ownerUserId =
        createdByRole === 'host_proxy'
          ? String(body.ownerUserId || '')
          : req.authUserId;
      if (!ownerUserId) {
        return res.status(400).json({ message: 'ownerUserId required' });
      }

      if (createdByRole === 'seller' && String(ownerUserId) !== String(req.authUserId)) {
        return res.status(403).json({
          message: 'Seller auctions must be created for your own listings',
          code: 'AUCTION_OWNER_FORBIDDEN',
        });
      }

      if (createdByRole === 'host_proxy') {
        if (!body.ownerConsentRef) {
          return res.status(400).json({
            message: 'ownerConsentRef required for host_proxy',
            code: 'AUCTION_OWNER_CONSENT_REQUIRED',
          });
        }
        if (String(ownerUserId) === String(req.authUserId)) {
          return res.status(403).json({
            message: 'Host proxy cannot target own account as owner',
            code: 'HOST_PROXY_OWNER_MISMATCH',
          });
        }
      }

      const listingId = String(body.listingId || '').trim();
      const videoId = String(body.videoId || '').trim();
      const independentMode =
        haraj ||
        body.independent === true ||
        body.mode === 'independent' ||
        (!listingId && !videoId);

      let locResult;
      let media = null;

      if (independentMode) {
        const independent = validateIndependentAuctionCreate({
          ...body,
          ownerUserId,
          species,
        });
        if (!independent.ok) {
          return res.status(independent.status).json({
            message: independent.message,
            code: independent.code,
          });
        }
        media = independent.media;
        locResult = requireAuctionOwnerLocation(body);
        if (!locResult.ok) {
          return res.status(locResult.status).json({
            message: locResult.message,
            code: locResult.code,
          });
        }
      } else {
        const ownership = validateAuctionAssetOwnership(ctx.store, {
          listingId,
          videoId,
          species,
          ownerUserId,
        });
        if (!ownership.ok) {
          return res.status(ownership.status).json({
            message: ownership.message,
            code: ownership.code,
          });
        }

        // LEGACY: Authoritative location from listing — ignore client lat/lng.
        const listing = ctx.store.horses.get(listingId);
        locResult = requireListingLocationSnapshot(listing);
        if (!locResult.ok) {
          return res.status(locResult.status).json({
            message: locResult.message,
            code: locResult.code,
          });
        }
      }

      const requiresHost = haraj ? false : body.requiresHost === true;

      const auction = await withTransaction(async (client) => {
        if (createdByRole === 'host_proxy') {
          const host = await getHostByUserId(client, req.authUserId);
          if (!host || host.status !== 'active' || !host.verifiedAt) {
            const err = new Error('Host must be verified and active for Path B');
            err.code = 'HOST_NOT_ACTIVE';
            err.status = 403;
            throw err;
          }
        }

        const created = await createAuctionDraft(client, {
          listingId: independentMode ? null : listingId,
          videoId: independentMode ? null : videoId,
          species,
          title: body.title,
          description: body.description,
          breed: body.breed,
          gender: body.gender,
          color: body.color,
          ageLabel: body.ageLabel || body.age,
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
          requiresHost,
          locationSnapshot: locResult.snapshot,
          media,
        });
        if (haraj && harajMeta) {
          await appendEvent(client, {
            auctionId: created.id,
            eventType: 'haraj.seller.draft_created',
            payload: {
              channel: 'haraj',
              inspection: harajMeta.inspection,
              commercialAuthority: {
                startingPrice: 'SELLER',
                reservePrice: 'SELLER_OPTIONAL',
                minimumIncrement: 'SYSTEM',
                startAtEndAt: 'SYSTEM_PLACEHOLDER_NOT_ROOM',
                currentPrice: 'SYSTEM',
                roomQueue: 'NOT_SUPPORTED',
              },
            },
            actorUserId: req.authUserId,
          });
        }
        return created;
      });
      res.status(201).json({ auction });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message,
        code: err.code || 'AUCTION_ERROR',
      });
    }
  });

  router.patch('/:id', auth, requireSessionUser, async (req, res) => {
    try {
      const body = req.body || {};
      const spoof = assertNoOwnershipSpoof(body, req.authUserId);
      if (!spoof.ok) {
        return res.status(spoof.status).json({
          message: spoof.message,
          code: spoof.code,
        });
      }
      const forbidden = require('./services/haraj_seller_submission')
        .rejectForbiddenSellerControls(body);
      if (!forbidden.ok) {
        return res.status(forbidden.status).json({
          message: forbidden.message,
          code: forbidden.code,
        });
      }

      let locSnapshot;
      if (body.location) {
        const locResult = requireAuctionOwnerLocation(body);
        if (!locResult.ok) {
          return res.status(locResult.status).json({
            message: locResult.message,
            code: locResult.code,
          });
        }
        locSnapshot = locResult.snapshot;
      }

      let media;
      if (body.mediaVideoHlsUrl || body.mediaVideoCloudflareId) {
        const independent = validateIndependentAuctionCreate({
          ...body,
          ownerUserId: req.authUserId,
          species: body.species || 'horse',
        });
        if (!independent.ok) {
          return res.status(independent.status).json({
            message: independent.message,
            code: independent.code,
          });
        }
        media = independent.media;
      } else if (Array.isArray(body.mediaImages)) {
        media = { mediaImages: body.mediaImages };
      }

      let description = body.description;
      if (body.inspection) {
        const parsed = normalizeInspection(body.inspection);
        if (parsed.error) {
          return res.status(parsed.error.status).json({
            message: parsed.error.message,
            code: parsed.error.code,
          });
        }
        const {
          mergeDescriptionWithInspection,
        } = require('./services/haraj_seller_submission');
        description = mergeDescriptionWithInspection(
          body.description,
          parsed.value,
        );
      }

      const auction = await withTransaction(async (client) =>
        updateSellerDraft(client, {
          auctionId: req.params.id,
          actorUserId: req.authUserId,
          patch: {
            title: body.title,
            description,
            breed: body.breed,
            gender: body.gender,
            color: body.color,
            ageLabel: body.ageLabel || body.age,
            startingPrice: body.startingPrice,
            reservePrice: body.reservePrice,
            locationSnapshot: locSnapshot,
            media,
          },
        }),
      );
      res.json({ auction });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message,
        code: err.code || 'AUCTION_PATCH_ERROR',
      });
    }
  });

  router.post('/:id/submit-review', auth, requireSessionUser, async (req, res) => {
    try {
      const submitBody = req.body || {};
      let beforeStatus;
      const auction = await withTransaction(async (client) => {
        const row = await assertOwnerForLifecycle(
          client,
          req.params.id,
          req.authUserId,
        );
        beforeStatus = row.status;
        let result;
        if (row.status === 'draft') {
          result = await transitionAuction(client, req.params.id, 'review', {
            actorUserId: req.authUserId,
          });
        } else if (row.status === 'review') {
          const { rows: fresh } = await client.query(
            `SELECT a.*, l.listing_id, l.video_id
             FROM auctions a JOIN auction_lots l ON l.id = a.lot_id WHERE a.id = $1`,
            [req.params.id],
          );
          result = mapAuctionRow(fresh[0]);
        } else {
          const err = new Error('Auction not in draft or review status');
          err.code = 'AUCTION_REVIEW_INVALID';
          err.status = 409;
          throw err;
        }

        if (
          String(row.owner_user_id) === String(req.authUserId) &&
          isAuctionDeveloperUserId(row.owner_user_id)
        ) {
          result = await approveAuctionReview(client, req.params.id, req.authUserId, {
            bypass: 'developer',
            reason: 'owner_developer_exemption',
          });
        }

        if (isHarajChannel(submitBody) || submitBody.inspection) {
          let inspection = null;
          if (submitBody.inspection) {
            const parsed = normalizeInspection(submitBody.inspection);
            if (parsed.error) {
              const err = new Error(parsed.error.message);
              err.code = parsed.error.code;
              err.status = parsed.error.status;
              throw err;
            }
            inspection = parsed.value;
          }
          await appendEvent(client, {
            auctionId: req.params.id,
            eventType: 'haraj.seller.submitted',
            payload: {
              channel: 'haraj',
              fromStatus: beforeStatus,
              toStatus: result.status,
              inspection,
            },
            actorUserId: req.authUserId,
          });
        }

        return result;
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
        const row = await assertOwnerForLifecycle(
          client,
          req.params.id,
          req.authUserId,
        );
        beforeStatus = row.status;
        return scheduleAuctionIfEligible(client, req.params.id, req.authUserId);
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
        const row = await assertOwnerForLifecycle(
          client,
          req.params.id,
          req.authUserId,
        );
        beforeStatus = row.status;
        assertManualGoLiveTimeAllowed(row);
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
      harajObs.applyInject(req, 'handler');
      const idempotencyKey =
        req.headers['idempotency-key'] || req.body?.idempotencyKey;
      const result = await withTransaction((client) =>
        harajG10.placeBidGuarded(client, {
          auctionId: req.params.id,
          bidderUserId: req.authUserId,
          amount: req.body?.amount,
          idempotencyKey,
          expectedVersion: req.body?.expectedVersion,
          clientBody: req.body,
          correlationId: req.correlationId || idempotencyKey,
        }),
      );
      harajObs.observeBidOutcome({
        replay: result.replay,
        accepted: !result.replay,
        businessRejected: false,
        code: result.replay ? 'BID_IDEMPOTENT_REPLAY' : 'BID_ACCEPTED',
      });
      if (auctionRealtime && result.auction && !result.replay) {
        let metrics = {};
        try {
          const pool = getPool();
          const bids = await getBidAggregates(pool, result.auction.id);
          const extensionsCount = await getExtensionsCount(pool, result.auction.id);
          metrics = { ...bids, extensionsCount };
        } catch (pubErr) {
          harajObs.logStructured('error', 'auction.bid.metrics_degraded', {
            requestId: req.correlationId,
            auctionId: result.auction.id,
            taxonomy: 'DEPENDENCY_FAILURE',
            code: pubErr.code || null,
          });
        }
        auctionRealtime.publishBidAccepted(result.auction, result.bid, {
          wasExtended: result.wasExtended,
          metrics,
        });
      }
      res.status(result.replay ? 200 : 201).json({ ...result, requestId: req.correlationId });
    } catch (err) {
      const status = err.status || 500;
      const taxonomy = harajObs.classify(err, status);
      harajObs.observeBidOutcome({
        replay: false,
        accepted: false,
        businessRejected: taxonomy === 'BUSINESS_REJECTION' || taxonomy === 'CONFLICT' || taxonomy === 'AUTHORIZATION',
        code: err.code,
      });
      res.locals.errorCode = err.code;
      res.status(status).json(harajObs.safeErrorBody(err, req));
    }
  });

  router.post('/:id/close', auth, requireSessionUser, async (req, res) => {
    try {
      let closedPayload;
      const auction = await withTransaction(async (client) => {
        await assertOwnerForLifecycle(client, req.params.id, req.authUserId);
        const closed = await closeAuctionAtomic(client, req.params.id, {
          actorUserId: req.authUserId,
        });
        const ensured = await harajInspection.ensureAfterClose(client, {
          auction: closed,
          actorUserId: req.authUserId,
        });
        const { rows } = await client.query(
          `SELECT payload FROM auction_events
           WHERE auction_id = $1 AND event_type = 'auction.closed'
           ORDER BY created_at DESC LIMIT 1`,
          [req.params.id],
        );
        closedPayload = rows[0]?.payload || {};
        return { closed, notifications: ensured?.notifications || [] };
      });
      dispatchInspectionNotifications(auction.notifications);
      if (auctionRealtime) {
        auctionRealtime.publishClosed(auction.closed, closedPayload);
      }
      res.json({ auction: auction.closed, inspectionCreated: Boolean(auction.notifications?.length) });
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
  const harajOps = require('./services/haraj_session_room');

  function harajActor(req) {
    return req.adminUserId || req.adminUser?.id || null;
  }

  function rejectClientActor(req) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.createdBy || body.created_by || body.adminId || body.admin === true) {
      const err = new Error('Client-supplied actor identity is not authoritative');
      err.status = 403;
      err.code = 'HARAJ_ACTOR_FORBIDDEN';
      throw err;
    }
  }

  adminRouter.get(
    '/haraj/categories',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const categories = await withTransaction((client) => harajOps.listCategories(client));
        res.json({ categories });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/lots/eligible',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const auctions = await harajOps.listEligibleLots(getPool(), {
          species: req.query.species || req.query.category,
          limit: req.query.limit,
        });
        res.json({
          auctions,
          lotIdIsAuctionId: true,
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  const harajSchedule = require('./services/haraj_scheduling_engine');

  function requireSchedulerOrAdmin(req, res, next) {
    const expected = process.env.HARAJ_SCHEDULER_KEY;
    const provided = req.get('x-haraj-scheduler-key');
    if (expected && provided && provided === expected) {
      req.adminUserId = req.adminUserId || 'system-scheduler';
      req.adminUser = req.adminUser || { id: 'system-scheduler', role: 'scheduler' };
      return next();
    }
    return requireAdminAuth(req, res, () => requirePerm('auctions:ops')(req, res, next));
  }

  adminRouter.get(
    '/haraj/schedule/policies',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const policies = await withTransaction((client) =>
          harajSchedule.listPolicies(client, {
            roomId: req.query.roomId,
            status: req.query.status,
          }),
        );
        res.json({
          policies,
          horizonDays: harajSchedule.defaultHorizonDays(),
          schedulerAuthority: 'backend',
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/schedule/policies',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const policy = await withTransaction((client) =>
          harajSchedule.createPolicy(client, {
            body: req.body || {},
            actorUserId: harajActor(req),
            store: ctx.store,
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          actorName: req.adminUser?.name,
          action: 'haraj.policy.create',
          entityType: 'haraj_room_schedule_policy',
          entityId: policy.id,
        });
        res.status(201).json({ policy });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/schedule/policies/:id',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const policy = await withTransaction((client) => harajSchedule.getPolicy(client, req.params.id));
        res.json({ policy });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.patch(
    '/haraj/schedule/policies/:id',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const policy = await withTransaction((client) =>
          harajSchedule.updatePolicy(client, {
            policyId: req.params.id,
            body: req.body || {},
            actorUserId: harajActor(req),
            store: ctx.store,
          }),
        );
        res.json({ policy });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/schedule/policies/:id/enable',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const policy = await withTransaction((client) =>
          harajSchedule.setPolicyEnabled(client, {
            policyId: req.params.id,
            enabled: true,
            actorUserId: harajActor(req),
          }),
        );
        res.json({ policy });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/schedule/policies/:id/disable',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const policy = await withTransaction((client) =>
          harajSchedule.setPolicyEnabled(client, {
            policyId: req.params.id,
            enabled: false,
            actorUserId: harajActor(req),
          }),
        );
        res.json({ policy });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/schedule/preview',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const result = await withTransaction(async (client) => {
          if (req.body?.policyId) {
            const policy = await harajSchedule.getPolicy(client, req.body.policyId);
            return { policy, ...harajSchedule.previewPolicy(policy, { horizonDays: req.body?.horizonDays }) };
          }
          return harajSchedule.previewPolicy(req.body || {}, { horizonDays: req.body?.horizonDays });
        });
        res.json(result);
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/schedule/occurrences',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const occurrences = await withTransaction((client) =>
          harajSchedule.listUpcoming(client, {
            policyId: req.query.policyId,
            roomId: req.query.roomId,
            horizonDays: req.query.horizonDays,
          }),
        );
        res.json({
          occurrences,
          horizonDays: harajSchedule.defaultHorizonDays(),
          schedulerAuthority: 'backend',
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/schedule/overrides',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const overrides = await withTransaction((client) =>
          harajSchedule.listOverrides(client, {
            policyId: req.query.policyId,
            roomId: req.query.roomId,
          }),
        );
        res.json({ overrides });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/schedule/overrides',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const result = await withTransaction((client) =>
          harajSchedule.createOverride(client, {
            body: req.body || {},
            actorUserId: harajActor(req),
            store: ctx.store,
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          actorName: req.adminUser?.name,
          action: 'haraj.override.create',
          entityType: 'haraj_schedule_override',
          entityId: result.override?.id,
        });
        res.status(result.replayed ? 200 : 201).json(result);
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/schedule/run',
    requireSchedulerOrAdmin,
    async (req, res) => {
      try {
        rejectClientActor(req);
        const result = await withTransaction((client) =>
          harajSchedule.runScheduler(client, {
            store: ctx.store,
            actorUserId: harajActor(req) || 'system-scheduler',
            horizonDays: req.body?.horizonDays,
          }),
        );
        try { require('./services/haraj_observability').observeScheduler(result); } catch { /* obs */ }
        res.json({
          ...result,
          schedulerAuthority: 'backend',
          horizonDays: harajSchedule.defaultHorizonDays(),
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/sessions',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const sessions = await withTransaction((client) =>
          harajOps.listSessions(client, {
            status: req.query.status,
            category: req.query.category || req.query.species,
            limit: req.query.limit,
          }),
        );
        res.json({ sessions });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/sessions',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const idempotencyKey = req.get('idempotency-key') || req.body?.idempotencyKey;
        const session = await withTransaction((client) =>
          harajOps.createSession(client, {
            category: req.body?.category || req.body?.species,
            scheduledStartAt: req.body?.scheduledStartAt,
            scheduledEndAt: req.body?.scheduledEndAt,
            timezone: req.body?.timezone,
            idempotencyKey,
            actorUserId: harajActor(req),
            clientCreatedBy: req.body?.createdBy || req.body?.created_by,
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          actorName: req.adminUser?.name,
          action: 'haraj.session.create',
          entityType: 'haraj_session',
          entityId: session.id,
        });
        res.status(201).json({ session });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/sessions/:id/rooms',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const session = await withTransaction((client) => harajOps.getSession(client, req.params.id));
        res.json({ session, rooms: session.rooms });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/sessions/:id/rooms',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const result = await withTransaction((client) =>
          harajOps.attachRoom(client, {
            sessionId: req.params.id,
            roomId: req.body?.roomId,
            category: req.body?.category,
            code: req.body?.code,
            nameAr: req.body?.nameAr,
            nameEn: req.body?.nameEn,
            auctioneerUserId: req.body?.auctioneerUserId,
            backupAuctioneerUserId: req.body?.backupAuctioneerUserId,
            store: ctx.store,
            claimedAuctioneerId: req.body?.auctioneerId,
            expectedSessionStatus: req.body?.expectedStatus,
            idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
            actorUserId: harajActor(req),
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          actorName: req.adminUser?.name,
          action: 'haraj.room_session.create',
          entityType: 'haraj_room_session',
          entityId: result.roomSession?.id,
        });
        res.status(201).json(result);
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/sessions/:id',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const session = await withTransaction((client) => harajOps.getSession(client, req.params.id));
        res.json({ session });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.patch(
    '/haraj/sessions/:id',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const session = await withTransaction((client) =>
          harajOps.updateSession(client, {
            sessionId: req.params.id,
            scheduledStartAt: req.body?.scheduledStartAt,
            scheduledEndAt: req.body?.scheduledEndAt,
            timezone: req.body?.timezone,
            status: req.body?.status,
            expectedStatus: req.body?.expectedStatus,
            actorUserId: harajActor(req),
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          actorName: req.adminUser?.name,
          action: 'haraj.session.update',
          entityType: 'haraj_session',
          entityId: session.id,
        });
        res.json({ session });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/sessions/:id/cancel',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const session = await withTransaction((client) =>
          harajOps.cancelSession(client, {
            sessionId: req.params.id,
            reason: req.body?.reason,
            expectedStatus: req.body?.expectedStatus,
            actorUserId: harajActor(req),
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          actorName: req.adminUser?.name,
          action: 'haraj.session.cancel',
          entityType: 'haraj_session',
          entityId: session.id,
          note: req.body?.reason || '',
        });
        res.json({ session });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/rooms',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const rooms = await withTransaction((client) =>
          harajOps.listRooms(client, {
            category: req.query.category || req.query.species,
            limit: req.query.limit,
          }),
        );
        res.json({ rooms });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/rooms',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const room = await withTransaction((client) =>
          harajOps.createRoom(client, {
            category: req.body?.category,
            code: req.body?.code,
            nameAr: req.body?.nameAr,
            nameEn: req.body?.nameEn,
            idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
            actorUserId: harajActor(req),
          }),
        );
        res.status(201).json({ room });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/rooms/:id/lot-eligibility',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const check = await withTransaction((client) =>
          harajOps.assertLotFitsRoom(client, {
            roomId: req.params.id,
            auctionId: req.body?.auctionId,
          }),
        );
        res.json(check);
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/rooms/:id',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const room = await withTransaction((client) => harajOps.getRoom(client, req.params.id));
        res.json({ room });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.patch(
    '/haraj/rooms/:id',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const room = await withTransaction((client) =>
          harajOps.updateRoom(client, {
            roomId: req.params.id,
            nameAr: req.body?.nameAr,
            nameEn: req.body?.nameEn,
            status: req.body?.status,
            actorUserId: harajActor(req),
          }),
        );
        res.json({ room });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.patch(
    '/haraj/room-sessions/:id',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const session = await withTransaction((client) =>
          harajOps.assignAuctioneer(client, {
            roomSessionId: req.params.id,
            auctioneerUserId: req.body?.auctioneerUserId,
            backupAuctioneerUserId: req.body?.backupAuctioneerUserId,
            store: ctx.store,
            claimedAuctioneerId: req.body?.auctioneerId,
            actorUserId: harajActor(req),
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          actorName: req.adminUser?.name,
          action: 'haraj.auctioneer.assign',
          entityType: 'haraj_room_session',
          entityId: req.params.id,
        });
        res.json({ session });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  const harajQueue = require('./services/haraj_lot_queue');

  adminRouter.get(
    '/haraj/room-sessions/:id/queue',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const entries = await withTransaction((client) => harajQueue.listQueue(client, req.params.id));
        res.json({
          entries,
          lotIdIsAuctionId: true,
          liveActivated: false,
          financialAuthority: false,
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/room-sessions/:id/queue',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const entry = await withTransaction((client) =>
          harajQueue.assignLot(client, {
            roomSessionId: req.params.id,
            auctionId: req.body?.auctionId || req.body?.lotId,
            actorUserId: harajActor(req),
            clientCreatedBy: req.body?.createdBy || req.body?.created_by,
            idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          actorName: req.adminUser?.name,
          action: 'haraj.queue.assign',
          entityType: 'haraj_queue_entry',
          entityId: entry.id,
        });
        res.status(201).json({ entry, lotId: entry.auctionId });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/room-sessions/:id/queue/reorder',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const entries = await withTransaction((client) =>
          harajQueue.reorderQueue(client, {
            roomSessionId: req.params.id,
            entryIds: req.body?.entryIds || req.body?.orderedEntryIds,
            actorUserId: harajActor(req),
          }),
        );
        res.json({ entries });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/queue-entries/:id/withdraw',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const entry = await withTransaction((client) =>
          harajQueue.withdrawEntry(client, {
            entryId: req.params.id,
            reason: req.body?.reason,
            actorUserId: harajActor(req),
          }),
        );
        res.json({ entry });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  const harajLiveAdmin = require('./services/haraj_live_room');

  async function runAdminLive(req, res, fn, eventType) {
    try {
      rejectClientActor(req);
      const snapshot = await withTransaction((client) =>
        fn(client, {
          roomSessionId: req.params.id,
          auctionId: req.params.auctionId || req.body?.auctionId || req.body?.lotId,
          reason: req.body?.reason,
          actorUserId: harajActor(req),
          admin: true,
          idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
        }),
      );
      if (auctionRealtime) harajLiveAdmin.publishIfPossible(auctionRealtime, snapshot, eventType);
      res.json({ snapshot, livekit: snapshot.livekit });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message, code: err.code });
    }
  }

  adminRouter.get(
    '/haraj/room-sessions/:id/live',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const snapshot = await withTransaction((client) => harajLiveAdmin.getSnapshot(client, req.params.id));
        res.json({ snapshot, reconnect: true });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );
  adminRouter.post('/haraj/room-sessions/:id/ready', requireAdminAuth, requirePerm('auctions:ops'), (req, res) =>
    runAdminLive(req, res, harajLiveAdmin.readyRoom, 'room.ready'),
  );
  adminRouter.post('/haraj/room-sessions/:id/start', requireAdminAuth, requirePerm('auctions:ops'), (req, res) =>
    runAdminLive(req, res, harajLiveAdmin.startRoom, 'room.live'),
  );
  adminRouter.post('/haraj/room-sessions/:id/pause', requireAdminAuth, requirePerm('auctions:ops'), (req, res) =>
    runAdminLive(req, res, harajLiveAdmin.pauseRoom, 'room.paused'),
  );
  adminRouter.post('/haraj/room-sessions/:id/resume', requireAdminAuth, requirePerm('auctions:ops'), (req, res) =>
    runAdminLive(req, res, harajLiveAdmin.resumeRoom, 'room.resumed'),
  );
  adminRouter.post('/haraj/room-sessions/:id/advance', requireAdminAuth, requirePerm('auctions:ops'), (req, res) =>
    runAdminLive(req, res, harajLiveAdmin.advanceLot, 'lot.completed'),
  );
  adminRouter.post('/haraj/room-sessions/:id/complete', requireAdminAuth, requirePerm('auctions:ops'), (req, res) =>
    runAdminLive(req, res, harajLiveAdmin.completeRoom, 'room.completed'),
  );
  adminRouter.post(
    '/haraj/room-sessions/:id/lots/:auctionId/activate',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    (req, res) => runAdminLive(req, res, harajLiveAdmin.activateLot, 'lot.activated'),
  );
  adminRouter.post(
    '/haraj/room-sessions/:id/lots/:auctionId/skip',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    (req, res) => runAdminLive(req, res, harajLiveAdmin.skipLot, 'lot.skipped'),
  );

  adminRouter.get(
    '/haraj/bidders/:userId',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const dossier = await withTransaction((client) => harajG10.getBidderDossier(client, req.params.userId));
        res.json({
          dossier,
          lockOrder: harajG10.LOCK_ORDER,
          invariant: harajG10.EXPOSURE_INVARIANT,
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.put(
    '/haraj/bidders/:userId',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const profile = await withTransaction((client) =>
          harajG10.upsertBidderProfile(client, {
            userId: req.params.userId,
            eligibilityStatus: req.body?.eligibilityStatus,
            bidLimit: req.body?.bidLimit,
            adminId: harajActor(req),
            suspendedReason: req.body?.suspendedReason,
            revokedReason: req.body?.revokedReason,
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          action: 'haraj.bidder.upsert',
          entityType: 'haraj_bidder_profile',
          entityId: req.params.userId,
        });
        res.json({ profile });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code, details: err.details });
      }
    },
  );

  adminRouter.post(
    '/haraj/bidders/:userId/security',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const security = await withTransaction((client) =>
          harajG10.issueStagingTestSecurity(client, {
            userId: req.params.userId,
            authorizedLimit: req.body?.authorizedLimit,
            adminId: harajActor(req),
            expiresAt: req.body?.expiresAt,
            idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          action: 'haraj.bidder.security.issue',
          entityType: 'haraj_bid_security',
          entityId: security.id,
        });
        res.status(201).json({
          security,
          provider: harajG10.STAGING_TEST_PROVIDER,
          realMoney: false,
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/bidders/:userId/suspend',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const profile = await withTransaction((client) =>
          harajG10.upsertBidderProfile(client, {
            userId: req.params.userId,
            eligibilityStatus: 'suspended',
            adminId: harajActor(req),
            suspendedReason: req.body?.reason || 'admin_suspend',
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          action: 'haraj.bidder.suspend',
          entityType: 'haraj_bidder_profile',
          entityId: req.params.userId,
        });
        res.json({ profile });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code, details: err.details });
      }
    },
  );

  adminRouter.get(
    '/haraj/inspections',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const cases = await withTransaction((client) =>
          harajInspection.listCases(client, {
            actorUserId: harajActor(req),
            actorRole: 'admin',
            limit: req.query.limit,
          }),
        );
        res.json({ cases, settlementImplemented: false });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/inspections/:auctionId',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const inspection = await withTransaction((client) =>
          harajInspection.getInspectionCase(client, {
            auctionId: req.params.auctionId,
            actorUserId: harajActor(req),
            actorRole: 'admin',
          }),
        );
        res.json({ inspection, settlementImplemented: false });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/inspections/:auctionId/ensure',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const result = await withTransaction((client) =>
          harajInspection.ensureInspectionCase(client, {
            auctionId: req.params.auctionId,
            actorUserId: harajActor(req),
            actorRole: 'admin',
            windowHours: req.body?.windowHours,
            idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          action: 'haraj.inspection.ensure',
          entityType: 'haraj_inspection',
          entityId: req.params.auctionId,
        });
        res.status(result.replay ? 200 : 201).json({
          inspection: result.case,
          replay: result.replay,
          settlementImplemented: false,
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/inspections/:auctionId/resolve',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const result = await withTransaction(async (client) => {
          const out = await harajInspection.resolveMismatch(client, {
            auctionId: req.params.auctionId,
            actorUserId: harajActor(req),
            actorRole: 'admin',
            resolution: req.body?.resolution,
            note: req.body?.note,
            expectedUpdatedAt: req.body?.expectedUpdatedAt,
            idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
          });
          if (req.body?.resolution === 'confirm_mismatch') {
            out.g16 = await harajRisk.escalateMismatch(client, {
              auctionId: req.params.auctionId,
              actorUserId: harajActor(req),
              inspectionId: out.case?.inspectionId,
              awardId: out.case?.awardId,
            });
          }
          return out;
        });
        logAudit(ctx, {
          actorId: harajActor(req),
          action: `haraj.inspection.resolve.${req.body?.resolution || 'unknown'}`,
          entityType: 'haraj_inspection',
          entityId: req.params.auctionId,
        });
        res.json({
          inspection: result.case,
          replay: result.replay,
          settlementImplemented: false,
          g16: result.g16 || null,
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/inspections/:auctionId/expire',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        const inspection = await withTransaction((client) =>
          harajInspection.expireCheck(client, {
            auctionId: req.params.auctionId,
            actorUserId: harajActor(req),
            actorRole: 'admin',
            stagingForce: req.body?.stagingForce === true,
          }),
        );
        res.json({ inspection, settlementImplemented: false });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/inspections/:auctionId/expert-finding',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const inspection = await withTransaction((client) =>
          harajInspection.addExpertFinding(client, {
            auctionId: req.params.auctionId,
            actorUserId: harajActor(req),
            actorRole: 'admin',
            performed: req.body?.performed,
            observations: req.body?.observations,
            documents: req.body?.documents,
            idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          action: 'haraj.inspection.expert_finding',
          entityType: 'haraj_inspection',
          entityId: req.params.auctionId,
        });
        res.json({ inspection, settlementImplemented: false });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/cases',
    requireAdminAuth,
    requirePerm('auctions:disputes'),
    async (req, res) => {
      try {
        const cases = await withTransaction((client) =>
          harajRisk.listCases(client, {
            status: req.query.status,
            category: req.query.category,
            limit: req.query.limit,
          }),
        );
        res.json({ cases, ai: harajRisk.AI_STATUS, signalIsNotGuilt: true });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/cases/:id',
    requireAdminAuth,
    requirePerm('auctions:disputes'),
    async (req, res) => {
      try {
        const detail = await withTransaction((client) => harajRisk.getCase(client, req.params.id));
        res.json({ ...detail, adminIsNotAuthority: true });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/cases/:id/resolve',
    requireAdminAuth,
    requirePerm('auctions:disputes'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const result = await withTransaction((client) =>
          harajRisk.resolveCase(client, {
            caseId: req.params.id,
            adminId: harajActor(req),
            resolution: req.body?.resolution,
            note: req.body?.note || req.body?.reason,
            expectedUpdatedAt: req.body?.expectedUpdatedAt,
            subjectUserId: req.body?.subjectUserId,
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          action: `haraj.case.resolve.${req.body?.resolution || 'unknown'}`,
          entityType: 'auction_dispute',
          entityId: req.params.id,
        });
        res.json(result);
      } catch (err) {
        if (err.code === 'CASE_STALE_STATE' || err.status === 409) {
          try { require('./services/haraj_observability').recordCaseConflict(); } catch { /* obs */ }
        }
        const harajObs = require('./services/haraj_observability');
        res.status(err.status || 500).json(harajObs.safeErrorBody(err, req));
      }
    },
  );

  adminRouter.post(
    '/haraj/risk/evaluate/:auctionId',
    requireAdminAuth,
    requirePerm('auctions:disputes'),
    async (req, res) => {
      try {
        const result = await withTransaction((client) =>
          harajRisk.evaluateDeterministic(client, req.params.auctionId),
        );
        res.json(result);
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/command-center',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const overview = await withTransaction((client) => harajCommandCenter.getOverview(client));
        const harajObs = require('./services/haraj_observability');
        res.json({
          overview: {
            ...overview,
            opsHealth: {
              ...harajObs.getReadiness({
                auctionsReady: ENABLE_AUCTIONS && isDbConfigured() && areMigrationsReady(),
                dbConfigured: isDbConfigured(),
                schemaVersion: getSchemaVersion(),
                migrationsReady: areMigrationsReady(),
              }),
              metrics: harajObs.snapshot().metrics,
              status: harajObs.getReadiness({
                auctionsReady: ENABLE_AUCTIONS && isDbConfigured() && areMigrationsReady(),
                dbConfigured: isDbConfigured(),
                schemaVersion: getSchemaVersion(),
                migrationsReady: areMigrationsReady(),
              }).ready ? 'HEALTHY' : 'UNAVAILABLE',
            },
          },
          ai: harajCommandCenter.AI_STATUS,
          adminIsNotAuthority: true,
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/ops-health',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      const harajObs = require('./services/haraj_observability');
      const readiness = harajObs.getReadiness({
        auctionsReady: ENABLE_AUCTIONS && isDbConfigured() && areMigrationsReady(),
        dbConfigured: isDbConfigured(),
        schemaVersion: getSchemaVersion(),
        migrationsReady: areMigrationsReady(),
      });
      let invariants = null;
      try {
        invariants = await withTransaction((client) => harajObs.runInvariants(client));
      } catch (err) {
        harajObs.logStructured('error', 'ops.invariants_failed', {
          requestId: req.correlationId,
          code: err.code || null,
        });
      }
      res.json({
        readiness,
        snapshot: harajObs.snapshot(),
        invariants,
        requestId: req.correlationId,
        adminIsNotAuthority: true,
        secretsOmitted: true,
      });
    },
  );

  adminRouter.get(
    '/haraj/ops-logs',
    requireAdminAuth,
    requirePerm('auctions:read'),
    (req, res) => {
      const harajObs = require('./services/haraj_observability');
      res.json({ logs: harajObs.recentLogs(), requestId: req.correlationId });
    },
  );

  adminRouter.post(
    '/haraj/ops/inject',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    (req, res) => {
      try {
        rejectClientActor(req);
        const harajObs = require('./services/haraj_observability');
        const result = harajObs.setRuntimeInject(req.body?.mode || null, {
          roomId: req.body?.roomId,
          actor: 'admin',
        });
        res.json({ inject: result, requestId: req.correlationId });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code, requestId: req.correlationId });
      }
    },
  );

  adminRouter.post(
    '/haraj/ops/probe',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const harajObs = require('./services/haraj_observability');
        const auctionId = req.body?.auctionId;
        const readOnly = Boolean(req.body?.readOnly);
        let beforeUpdatedAt = null;
        const count = await withTransaction(async (client) => {
          if (auctionId) {
            const { rows } = await client.query('SELECT updated_at FROM auctions WHERE id = $1', [auctionId]);
            beforeUpdatedAt = rows[0]?.updated_at || null;
            if (rows[0] && !readOnly) {
              await client.query('UPDATE auctions SET updated_at = NOW() WHERE id = $1', [auctionId]);
            }
          }
          const { rows } = await client.query('SELECT COUNT(*)::int AS c FROM auctions');
          return rows[0].c;
        });
        harajObs.logStructured('info', 'g17.probe', {
          requestId: req.correlationId,
          auctionId: auctionId || null,
          phase: req.body?.phase || 'handler',
          note: req.body?.note || null,
        });
        try {
          harajObs.applyInject(req, req.body?.phase || 'handler');
        } catch (err) {
          return res.status(err.status || 500).json({
            ...harajObs.safeErrorBody(err, req),
            auctionsCount: count,
            beforeUpdatedAt,
            businessTruthUnchanged: true,
            phase: req.body?.phase || 'handler',
          });
        }
        res.json({
          ok: true,
          auctionsCount: count,
          beforeUpdatedAt,
          requestId: req.correlationId,
        });
      } catch (err) {
        const harajObs = require('./services/haraj_observability');
        res.status(err.status || 500).json({
          ...harajObs.safeErrorBody(err, req),
          businessTruthUnchanged: err.code === 'G17_INJECTED_ROLLBACK',
        });
      }
    },
  );

  adminRouter.get(
    '/haraj/history',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const result = await withTransaction((client) =>
          harajHistory.loadHistoryList(client, {
            species: req.query.species,
            status: req.query.status,
            from: req.query.from,
            to: req.query.to,
            afterHarajMode: req.query.afterHarajMode,
            inspectionOutcome: req.query.inspectionOutcome,
            ownerUserId: req.query.ownerUserId || req.query.seller,
            roomSessionId: req.query.roomSessionId,
            sessionId: req.query.sessionId,
            limit: req.query.limit,
          }, { role: 'admin', actorUserId: harajActor(req) }),
        );
        if (req.query.format === 'csv') {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', 'attachment; filename="haraj-history.csv"');
          return res.send(harajHistory.toCsv(result.items));
        }
        res.json({ history: result, ai: harajHistory.AI_STATUS });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/analytics',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const analytics = await withTransaction((client) =>
          harajHistory.getAnalytics(client, {
            species: req.query.species,
            status: req.query.status,
            from: req.query.from,
            to: req.query.to,
            afterHarajMode: req.query.afterHarajMode,
            inspectionOutcome: req.query.inspectionOutcome,
            ownerUserId: req.query.ownerUserId || req.query.seller,
            roomSessionId: req.query.roomSessionId,
            sessionId: req.query.sessionId,
          }, { role: 'admin', actorUserId: harajActor(req) }),
        );
        res.json({ analytics, ai: harajHistory.AI_STATUS });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/history/:id',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const record = await withTransaction((client) =>
          harajHistory.getRecord(client, {
            auctionId: req.params.id,
            actorUserId: harajActor(req),
            actorRole: 'admin',
          }),
        );
        res.json({ history: record, ai: harajHistory.AI_STATUS });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/after-market',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const listings = await withTransaction((client) =>
          harajAfterMarket.listOperatorCases(client, { limit: req.query.limit }),
        );
        res.json({
          listings,
          settlementImplemented: false,
          ai: harajAfterMarket.AI_STATUS,
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.get(
    '/haraj/after-market/:auctionId',
    requireAdminAuth,
    requirePerm('auctions:read'),
    async (req, res) => {
      try {
        const afterHaraj = await withTransaction((client) =>
          harajAfterMarket.getAfterHaraj(client, {
            auctionId: req.params.auctionId,
            actorUserId: harajActor(req),
            actorRole: 'admin',
          }),
        );
        res.json({ afterHaraj, settlementImplemented: false, ai: harajAfterMarket.AI_STATUS });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

  adminRouter.post(
    '/haraj/after-market/:auctionId/close',
    requireAdminAuth,
    requirePerm('auctions:ops'),
    async (req, res) => {
      try {
        rejectClientActor(req);
        const result = await withTransaction((client) =>
          harajAfterMarket.adminClose(client, {
            auctionId: req.params.auctionId,
            actorUserId: harajActor(req),
            reason: req.body?.reason,
            expectedUpdatedAt: req.body?.expectedUpdatedAt,
            idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey,
          }),
        );
        logAudit(ctx, {
          actorId: harajActor(req),
          action: 'haraj.after.close',
          entityType: 'haraj_after_listings',
          entityId: req.params.auctionId,
        });
        res.json({
          afterHaraj: result.view,
          replay: result.replay,
          settlementImplemented: false,
        });
      } catch (err) {
        res.status(err.status || 500).json({ message: err.message, code: err.code });
      }
    },
  );

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
        const auction = await getAdminAuctionDetail(getPool(), req.params.id, {
          wsHub: ctx.wsHub,
        });
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
        const auction = await getAdminAuctionDetail(getPool(), req.params.id, {
          wsHub: ctx.wsHub,
        });
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

          if (!req.body?.approve) {
            const result = await transitionAuction(client, req.params.id, 'cancelled', {
              actorUserId: adminActor(req),
              reason: req.body?.reason,
            });
            await require('./services/auction_service').appendEvent(client, {
              auctionId: req.params.id,
              eventType: 'admin.review.rejected',
              payload: { reason: req.body?.reason || null },
              actorUserId: adminActor(req),
            });
            return result;
          }

          return approveAuctionReview(client, req.params.id, adminActor(req), {
            bypass: 'admin',
            reason: req.body?.reason,
          });
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
