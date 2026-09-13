'use strict';

const {
  ENABLE_AUCTIONS,
  AUCTIONS_DATABASE_URL,
} = require('./config');
const {
  isDbConfigured,
  runMigrations,
  closePool,
  areMigrationsReady,
  getSchemaVersion,
  getLastMigrationError,
  REQUIRED_MIGRATION_ID,
  markMigrationsNotReady,
} = require('./db');
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
let harajScheduler = null;
let bootState = {
  enabled: false,
  dbConfigured: false,
  migrationsReady: false,
  schemaVersion: null,
  ready: false,
  reason: null,
};

function syncBootFromDb(extra = {}) {
  bootState = {
    enabled: ENABLE_AUCTIONS,
    dbConfigured: isDbConfigured(),
    migrationsReady: areMigrationsReady(),
    schemaVersion: getSchemaVersion(),
    ready: ENABLE_AUCTIONS && isDbConfigured() && areMigrationsReady(),
    reason: getLastMigrationError(),
    requiredMigrationId: REQUIRED_MIGRATION_ID,
    ...extra,
  };
  return { ...bootState };
}

/**
 * Safe public health/status block — no secrets.
 */
function getAuctionsPublicStatus() {
  return {
    enabled: ENABLE_AUCTIONS,
    dbConfigured: isDbConfigured(),
    postgresConfigured: isDbConfigured(),
    migrationsReady: areMigrationsReady(),
    schemaVersion: getSchemaVersion(),
    requiredMigrationId: REQUIRED_MIGRATION_ID,
    ready: bootState.ready === true,
    storeReleaseImpact: ENABLE_AUCTIONS
      ? 'isolated module'
      : 'none — feature OFF',
  };
}

function areAuctionsReady() {
  return bootState.ready === true && areMigrationsReady();
}

async function initAuctionsModule() {
  if (!ENABLE_AUCTIONS) {
    console.log(
      '[auctions] DISABLED (ENABLE_AUCTIONS=false) — Store Release v1 unaffected',
    );
    bootState = {
      enabled: false,
      dbConfigured: false,
      migrationsReady: false,
      schemaVersion: null,
      ready: false,
      reason: 'AUCTIONS_DISABLED',
      requiredMigrationId: REQUIRED_MIGRATION_ID,
    };
    return { ...bootState };
  }
  if (!isDbConfigured()) {
    console.warn(
      '[auctions] ENABLED but AUCTIONS_DATABASE_URL missing — routes return 503 until configured',
    );
    markMigrationsNotReady('AUCTIONS_DATABASE_URL missing');
    bootState = {
      enabled: true,
      dbConfigured: false,
      migrationsReady: false,
      schemaVersion: null,
      ready: false,
      reason: 'AUCTIONS_DATABASE_URL missing',
      requiredMigrationId: REQUIRED_MIGRATION_ID,
    };
    return { ...bootState };
  }
  try {
    const migration = await runMigrations();
    const state = syncBootFromDb({
      migration,
      audioDecision,
      reason: null,
    });
    console.log(
      `[auctions] PostgreSQL ready schema=${migration.schemaVersion} applied=${migration.applied} migrationsReady=${migration.migrationsReady}`,
    );
    return state;
  } catch (err) {
    markMigrationsNotReady(err.message);
    bootState = {
      enabled: true,
      dbConfigured: true,
      migrationsReady: false,
      schemaVersion: getSchemaVersion(),
      ready: false,
      reason: err.message,
      requiredMigrationId: REQUIRED_MIGRATION_ID,
    };
    console.error('[auctions] migration/init failed — fail closed:', err.message);
    return { ...bootState };
  }
}

function startAuctionsLifecycle({ auctionRealtime, store } = {}) {
  if (!ENABLE_AUCTIONS || !areAuctionsReady()) return null;
  if (!lifecycleWorker) {
    lifecycleWorker = startAuctionLifecycleWorker({ auctionRealtime });
  }
  if (!harajScheduler) {
    const { startHarajScheduler } = require('./services/haraj_scheduling_engine');
    harajScheduler = startHarajScheduler({ store });
  }
  return lifecycleWorker;
}

function stopAuctionsLifecycle() {
  if (lifecycleWorker) {
    lifecycleWorker.stop();
    lifecycleWorker = null;
  }
  if (harajScheduler) {
    harajScheduler.stop();
    harajScheduler = null;
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
  areAuctionsReady,
  getAuctionsPublicStatus,
  REQUIRED_MIGRATION_ID,
};
