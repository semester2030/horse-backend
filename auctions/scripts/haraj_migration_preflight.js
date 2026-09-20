#!/usr/bin/env node
'use strict';

/**
 * G2.1 — Haraj migration preflight (READINESS ONLY).
 * Does NOT execute 009/010. Verifies staging identity before any future migration run.
 *
 * Usage (staging cloud — when provisioned):
 *   APP_ENV=staging AUCTIONS_STAGING_DATABASE_URL=postgresql://... node backend/auctions/scripts/haraj_migration_preflight.js
 *
 * Usage (local dev review only):
 *   APP_ENV=staging AUCTIONS_DATABASE_URL=postgresql://localhost:5432/nomas_auctions \
 *     HARAJ_MIGRATION_ALLOW_LOCALHOST=true node backend/auctions/scripts/haraj_migration_preflight.js
 */

const path = require('path');
const {
  assertStagingMigrationAllowed,
  getEnvironmentSummary,
} = require('../environment');

async function main() {
  const allowLocalhost =
    process.env.HARAJ_MIGRATION_ALLOW_LOCALHOST === 'true' ||
    process.env.HARAJ_MIGRATION_ALLOW_LOCALHOST === '1';

  console.log('NOMAS Haraj — Migration Preflight (NOT EXECUTING 009/010)');
  console.log('Summary:', JSON.stringify(getEnvironmentSummary(), null, 2));

  try {
    const result = assertStagingMigrationAllowed({ allowLocalhost });
    console.log('PREFLIGHT: PASS');
    console.log('Target DB (non-secret):', result.dbIdentity);
    console.log('');
    console.log('Next approved step (NOT run by this script):');
    console.log('  1) Snapshot staging DB');
    console.log('  2) Apply migrations/proposed/009_haraj_core_orchestration.sql');
    console.log('  3) Validate schema');
    console.log('  4) Apply 010 or rollback 009 if needed');
    process.exit(0);
  } catch (err) {
    console.error('PREFLIGHT: FAIL');
    console.error(err.message);
    process.exit(1);
  }
}

main();
