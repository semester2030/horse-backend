'use strict';

const fs = require('fs');
const path = require('path');
const { getAuctionsDatabaseUrl } = require('./config');

let pool = null;
let pgModule = null;

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

async function runMigrations() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS auction_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = [];
  for (const file of files) {
    const migrationId = file.replace(/\.sql$/, '');
    const existing = await p.query(
      'SELECT id FROM auction_schema_migrations WHERE id = $1',
      [migrationId],
    );
    if (existing.rows.length) continue;
    const sqlPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await p.query('BEGIN');
    try {
      await p.query(sql);
      await p.query('INSERT INTO auction_schema_migrations (id) VALUES ($1)', [migrationId]);
      await p.query('COMMIT');
      applied.push(migrationId);
    } catch (err) {
      await p.query('ROLLBACK');
      throw err;
    }
  }
  return { applied: applied.length > 0, ids: applied };
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
}

module.exports = {
  isDbConfigured,
  getPool,
  runMigrations,
  withTransaction,
  closePool,
};
