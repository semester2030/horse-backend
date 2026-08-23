'use strict';

const {
  ENABLE_AUCTIONS,
  AUCTIONS_DATABASE_URL,
} = require('./config');
const { isDbConfigured, runMigrations, closePool } = require('./db');
const {
  registerAuctionRoutes,
  registerAuctionAdminRoutes,
} = require('./routes');
const { DECISION: audioDecision } = require('./audio/compare');
const {
  startAuctionLifecycleWorker,
  runLifecycleTick,
} = require('./services/lifecycle_worker');

let lifecycleWorker = null;

async function initAuctionsModule() {
  if (!ENABLE_AUCTIONS) {
    console.log('[auctions] DISABLED (ENABLE_AUCTIONS=false) — Store Release v1 unaffected');
    return { enabled: false, ready: false };
  }
  if (!isDbConfigured()) {
    console.warn(
      '[auctions] ENABLED but AUCTIONS_DATABASE_URL missing — routes return 503 until configured',
    );
    return { enabled: true, ready: false, reason: 'AUCTIONS_DATABASE_URL missing' };
  }
  const migration = await runMigrations();
  console.log(
    `[auctions] PostgreSQL ready migration=${migration.id} applied=${migration.applied}`,
  );
  return {
    enabled: true,
    ready: true,
    migration,
    audioDecision,
  };
}

function startAuctionsLifecycle({ auctionRealtime } = {}) {
  if (lifecycleWorker) return lifecycleWorker;
  if (!ENABLE_AUCTIONS || !isDbConfigured()) return null;
  lifecycleWorker = startAuctionLifecycleWorker({ auctionRealtime });
  return lifecycleWorker;
}

function stopAuctionsLifecycle() {
  if (lifecycleWorker) {
    lifecycleWorker.stop();
    lifecycleWorker = null;
  }
}

function registerAuctions(app, ctx) {
  registerAuctionRoutes(app, ctx);
}

function extendAdminForAuctions(adminRouter, adminCtx) {
  registerAuctionAdminRoutes(adminRouter, {
    ...adminCtx,
    requireAdminAuth: adminCtx.requireAdminAuth,
    requirePerm: adminCtx.requirePerm,
    logAudit: adminCtx.logAudit,
  });
}

module.exports = {
  initAuctionsModule,
  registerAuctions,
  extendAdminForAuctions,
  startAuctionsLifecycle,
  stopAuctionsLifecycle,
  runLifecycleTick,
  ENABLE_AUCTIONS,
  AUCTIONS_DATABASE_URL,
  isDbConfigured,
  closePool,
};
