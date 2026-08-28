'use strict';

const fs = require('fs');
const path = require('path');
const { getAuctionsDatabaseUrl } = require('./config');

/** Latest schema required before auction create/write paths may accept traffic. */
const REQUIRED_MIGRATION_ID = '008_auction_media_independence';

let pool = null;
let pgModule = null;
let migrationsReady = false;
let schemaVersion = null;
let lastMigrationError = null;

function loadPg() {
  if (pgModule) return pgModule;
  try {
    pgModule = require('pg');
    return pgModule;
  } catch (e) {
    return null;
  }
}

function isDbConfigured() {
  return Boolean(getAuctionsDatabaseUrl() && loadPg());
}

function getPool() {
  if (!isDbConfigured()) {
    throw new Error('AUCTIONS_DATABASE_URL not configured or pg module missing');
  }
  if (!pool) {
    const { Pool } = loadPg();
    pool = new Pool({
      connectionString: getAuctionsDatabaseUrl(),
      max: Number(process.env.AUCTIONS_PG_POOL_MAX || 10),
    });
  }
  return pool;
}

function listMigrationFiles() {
  const migrationsDir = path.join(__dirname, 'migrations');
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function readAppliedMigrationIds(clientOrPool) {
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS auction_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const { rows } = await clientOrPool.query(
    'SELECT id FROM auction_schema_migrations ORDER BY id ASC',
  );
  return rows.map((r) => r.id);
}

function computeSchemaVersion(appliedIds) {
  if (!appliedIds.length) return null;
  return appliedIds[appliedIds.length - 1];
}

function refreshReadyState(appliedIds) {
  schemaVersion = computeSchemaVersion(appliedIds);
  migrationsReady = appliedIds.includes(REQUIRED_MIGRATION_ID);
  if (migrationsReady) lastMigrationError = null;
  return {
    requiredMigrationId: REQUIRED_MIGRATION_ID,
    appliedIds,
    schemaVersion,
    migrationsReady,
  };
}

async function getMigrationsStatus() {
  if (!isDbConfigured()) {
    return {
      requiredMigrationId: REQUIRED_MIGRATION_ID,
      appliedIds: [],
      schemaVersion: null,
      migrationsReady: false,
      dbConfigured: false,
    };
  }
  const p = getPool();
  const appliedIds = await readAppliedMigrationIds(p);
  return {
    dbConfigured: true,
    ...refreshReadyState(appliedIds),
  };
}

function areMigrationsReady() {
  return migrationsReady === true;
}

function getSchemaVersion() {
  return schemaVersion;
}

function getLastMigrationError() {
  return lastMigrationError;
}

function markMigrationsNotReady(reason) {
  migrationsReady = false;
  lastMigrationError = reason ? String(reason) : lastMigrationError;
}

async function runMigrations() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS auction_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const files = listMigrationFiles();
  const applied = [];
  try {
    for (const file of files) {
      const migrationId = file.replace(/\.sql$/, '');
      const existing = await p.query(
        'SELECT id FROM auction_schema_migrations WHERE id = $1',
        [migrationId],
      );
      if (existing.rows.length) continue;
      const sqlPath = path.join(__dirname, 'migrations', file);
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await p.query('BEGIN');
      try {
        await p.query(sql);
        await p.query('INSERT INTO auction_schema_migrations (id) VALUES ($1)', [
          migrationId,
        ]);
        await p.query('COMMIT');
        applied.push(migrationId);
      } catch (err) {
        await p.query('ROLLBACK');
        throw err;
      }
    }
    const status = await getMigrationsStatus();
    if (!status.migrationsReady) {
      const msg = `Required auction migration missing: ${REQUIRED_MIGRATION_ID}`;
      markMigrationsNotReady(msg);
      const err = new Error(msg);
      err.code = 'AUCTIONS_MIGRATIONS_NOT_READY';
      throw err;
    }
    return {
      applied: applied.length > 0,
      ids: applied,
      id: status.schemaVersion,
      schemaVersion: status.schemaVersion,
      migrationsReady: true,
      requiredMigrationId: REQUIRED_MIGRATION_ID,
    };
  } catch (err) {
    markMigrationsNotReady(err.message);
    throw err;
  }
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  migrationsReady = false;
  schemaVersion = null;
}

module.exports = {
  REQUIRED_MIGRATION_ID,
  isDbConfigured,
  getPool,
  runMigrations,
  getMigrationsStatus,
  areMigrationsReady,
  getSchemaVersion,
  getLastMigrationError,
  markMigrationsNotReady,
  withTransaction,
  closePool,
};
