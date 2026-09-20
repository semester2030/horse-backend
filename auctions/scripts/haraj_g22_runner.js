#!/usr/bin/env node
'use strict';

/**
 * G2.2 — Staging-only Haraj migration runner.
 * Never prints connection strings or passwords.
 *
 * Usage:
 *   APP_ENV=staging AUCTIONS_STAGING_DATABASE_URL=... node haraj_g22_runner.js <cmd>
 *
 * Commands: identity | inventory | apply-009 | apply-010 | rollback-010 | rollback-009
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  assertStagingMigrationAllowed,
  parseDatabaseIdentity,
  isProductionDatabaseUrl,
  isStagingDatabaseUrl,
} = require('../environment');

const STAGING_INSTANCE = 'dpg-dabp4j6k1f9s7391dseg-a';
const STAGING_DB = 'nomas_auctions_staging';
const PROD_INSTANCE = 'dpg-da5fc18jo6nc73cd4930-a';

const TABLES_009 = [
  'haraj_configuration',
  'haraj_categories',
  'haraj_rooms',
  'haraj_room_schedule_policies',
  'haraj_schedule_overrides',
  'haraj_sessions',
  'haraj_room_sessions',
  'haraj_queue_entries',
  'haraj_audit_events',
];
const TABLES_010 = [
  'haraj_provisional_awards',
  'haraj_inspections',
  'haraj_settlements',
  'haraj_after_listings',
];

function proposedPath(name) {
  return path.join(__dirname, '..', 'migrations', 'proposed', name);
}

function getUrl() {
  return String(process.env.AUCTIONS_STAGING_DATABASE_URL || '').trim();
}

function assertTarget() {
  const url = getUrl();
  if (!url) {
    throw Object.assign(new Error('AUCTIONS_STAGING_DATABASE_URL required'), {
      code: 'HARAJ_TARGET_UNPROVEN',
    });
  }
  assertStagingMigrationAllowed({ databaseUrl: url });
  const id = parseDatabaseIdentity(url);
  if (id.database !== STAGING_DB) {
    throw Object.assign(new Error(`Database name mismatch: ${id.database}`), {
      code: 'HARAJ_TARGET_UNPROVEN',
    });
  }
  if (!(id.hostname || '').includes(STAGING_INSTANCE)) {
    throw Object.assign(new Error('Hostname is not nomas-auctions-staging instance'), {
      code: 'HARAJ_TARGET_UNPROVEN',
    });
  }
  if ((id.hostname || '').includes(PROD_INSTANCE) || isProductionDatabaseUrl(url)) {
    throw Object.assign(new Error('Production database detected — ABORT'), {
      code: 'HARAJ_TARGET_UNPROVEN',
    });
  }
  if (!isStagingDatabaseUrl(url)) {
    throw Object.assign(new Error('Staging identity not proven'), {
      code: 'HARAJ_TARGET_UNPROVEN',
    });
  }
  return id;
}

function clientFromUrl(url) {
  const needsSsl = !/localhost|127\.0\.0\.1/.test(url);
  const clean = url.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
  return new Client({
    connectionString: clean,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000,
    keepAlive: true,
  });
}

async function withClient(fn) {
  const url = getUrl();
  let last;
  let client;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    client = clientFromUrl(url);
    try {
      await client.connect();
      last = null;
      break;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  if (last || !client) throw last;
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function liveIdentity(client) {
  const { rows } = await client.query(
    `SELECT current_database() AS db, current_user AS db_user, inet_server_addr()::text AS addr`,
  );
  return rows[0];
}

async function inventory(client) {
  const tables = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const columns = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  const fks = await client.query(`
    SELECT tc.table_name, tc.constraint_name, kcu.column_name,
           ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    ORDER BY tc.table_name, tc.constraint_name
  `);
  const indexes = await client.query(`
    SELECT tablename, indexname FROM pg_indexes
    WHERE schemaname = 'public' ORDER BY tablename, indexname
  `);
  const migrations = await client.query(
    `SELECT id, applied_at FROM auction_schema_migrations ORDER BY id`,
  );
  let auctionCount = 0;
  let bidCount = 0;
  let auctionIds = [];
  let bidIds = [];
  const hasAuctions = tables.rows.some((r) => r.table_name === 'auctions');
  const hasBids = tables.rows.some((r) => r.table_name === 'bids');
  if (hasAuctions) {
    const a = await client.query(`SELECT id FROM auctions ORDER BY created_at NULLS LAST, id`);
    auctionCount = a.rowCount;
    auctionIds = a.rows.map((r) => r.id);
  }
  if (hasBids) {
    const b = await client.query(`SELECT id FROM bids ORDER BY id`);
    bidCount = b.rowCount;
    bidIds = b.rows.map((r) => r.id);
  }
  const harajMode = columns.rows
    .filter((c) => c.table_name === 'auctions' && c.column_name === 'haraj_mode')
    .map((c) => ({ type: c.data_type, nullable: c.is_nullable, def: c.column_default }));
  return {
    tables: tables.rows.map((r) => r.table_name),
    columns: columns.rows,
    foreignKeys: fks.rows,
    indexes: indexes.rows,
    migrations: migrations.rows.map((r) => r.id),
    auctionCount,
    bidCount,
    auctionIds,
    bidIds,
    harajMode,
  };
}

function expectTables(inv, names, present) {
  const missing = names.filter((t) => inv.tables.includes(t) !== present);
  if (present && missing.length) {
    throw new Error(`Expected tables missing: ${missing.join(', ')}`);
  }
  if (!present && missing.length) {
    throw new Error(`Tables should be absent after rollback: ${missing.join(', ')}`);
  }
}

async function applied(client, id) {
  const { rows } = await client.query(
    `SELECT id FROM auction_schema_migrations WHERE id = $1`,
    [id],
  );
  return rows.length > 0;
}

async function applyFile(client, file, migrationId, extraValidate) {
  if (await applied(client, migrationId)) {
    throw new Error(`${migrationId} already applied — refusing unsafe duplicate`);
  }
  const sql = fs.readFileSync(proposedPath(file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(`INSERT INTO auction_schema_migrations (id) VALUES ($1)`, [migrationId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  const inv = await inventory(client);
  extraValidate(inv);
  return inv;
}

async function rollbackFile(client, file, migrationId) {
  if (!(await applied(client, migrationId))) {
    throw new Error(`${migrationId} is not applied — nothing to roll back`);
  }
  const sql = fs.readFileSync(proposedPath(file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return inventory(client);
}

function validate009(inv) {
  expectTables(inv, TABLES_009, true);
  if (!inv.migrations.includes('009_haraj_core_orchestration')) {
    throw new Error('009 not recorded in auction_schema_migrations');
  }
  if (!inv.harajMode.length) throw new Error('auctions.haraj_mode missing');
  const qFk = inv.foreignKeys.find(
    (f) => f.table_name === 'haraj_queue_entries' && f.column_name === 'auction_id',
  );
  if (!qFk || qFk.foreign_table !== 'auctions') {
    throw new Error('queue.auction_id must reference auctions.id (lot)');
  }
  const lotFk = inv.foreignKeys.find(
    (f) => f.table_name === 'haraj_room_sessions' && f.column_name === 'active_lot_id',
  );
  if (!lotFk || lotFk.foreign_table !== 'auctions') {
    throw new Error('active_lot_id must reference auctions.id');
  }
}

function validate010(inv) {
  validate009(inv);
  expectTables(inv, TABLES_010, true);
  if (!inv.migrations.includes('010_haraj_post_close')) {
    throw new Error('010 not recorded');
  }
  const awardFk = inv.foreignKeys.find(
    (f) => f.table_name === 'haraj_provisional_awards' && f.column_name === 'winning_bid_id',
  );
  if (!awardFk || awardFk.foreign_table !== 'bids') {
    throw new Error('provisional award must reference bids (existing bid SoT)');
  }
}

function validate008(inv) {
  expectTables(inv, TABLES_009.concat(TABLES_010), false);
  if (inv.migrations.includes('009_haraj_core_orchestration')) {
    throw new Error('009 still recorded after rollback');
  }
  if (inv.migrations.includes('010_haraj_post_close')) {
    throw new Error('010 still recorded after rollback');
  }
  if (inv.harajMode.length) throw new Error('haraj_mode still present after 009 rollback');
  if (!inv.migrations.includes('008_auction_media_independence')) {
    throw new Error('008 missing after rollback — core schema damaged');
  }
}

function redactInv(inv) {
  return {
    tables: inv.tables,
    migrations: inv.migrations,
    auctionCount: inv.auctionCount,
    bidCount: inv.bidCount,
    auctionIds: inv.auctionIds,
    bidIds: inv.bidIds,
    harajMode: inv.harajMode,
    tableCount: inv.tables.length,
    fkCount: inv.foreignKeys.length,
    indexCount: inv.indexes.length,
    harajTables: inv.tables.filter((t) => t.startsWith('haraj_')),
    auctionsColumns: inv.columns
      .filter((c) => c.table_name === 'auctions')
      .map((c) => c.column_name),
    disputeHarajColumns: inv.columns
      .filter(
        (c) =>
          c.table_name === 'auction_disputes' &&
          (c.column_name === 'provisional_award_id' || c.column_name === 'inspection_id'),
      )
      .map((c) => c.column_name),
  };
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error('Usage: haraj_g22_runner.js <command>');
    process.exit(2);
  }
  const parsed = assertTarget();
  console.log(
    JSON.stringify({
      ok: true,
      command: cmd,
      parsedIdentity: { hostname: parsed.hostname, database: parsed.database },
    }),
  );

  await withClient(async (client) => {
    const live = await liveIdentity(client);
    if (live.db !== STAGING_DB) {
      throw new Error(`Live current_database=${live.db} — ABORT`);
    }
    console.log(JSON.stringify({ liveIdentity: { db: live.db, db_user: live.db_user } }));

    if (cmd === 'identity') return;

    if (cmd === 'inventory') {
      const inv = await inventory(client);
      console.log(JSON.stringify({ inventory: redactInv(inv) }));
      return;
    }

    if (cmd === 'logical-backup') {
      const inv = await inventory(client);
      const outDir = process.argv[3];
      if (!outDir) throw new Error('logical-backup requires output directory');
      fs.mkdirSync(outDir, { recursive: true });
      const tables = {};
      for (const table of inv.tables) {
        if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
          throw new Error(`refusing unsafe table name ${table}`);
        }
        const { rows } = await client.query(`SELECT * FROM "${table}"`);
        tables[table] = rows;
      }
      const payload = {
        createdAt: new Date().toISOString(),
        liveDb: (await liveIdentity(client)).db,
        migrations: inv.migrations,
        tables,
      };
      const file = path.join(outDir, 'logical_backup.json');
      fs.writeFileSync(file, JSON.stringify(payload, null, 2));
      console.log(
        JSON.stringify({
          backup: {
            file,
            tableCount: inv.tables.length,
            migrations: inv.migrations,
            bytes: fs.statSync(file).size,
          },
        }),
      );
      return;
    }

    if (cmd === 'apply-009') {
      const inv = await applyFile(
        client,
        '009_haraj_core_orchestration.sql',
        '009_haraj_core_orchestration',
        validate009,
      );
      console.log(JSON.stringify({ applied: '009', inventory: redactInv(inv) }));
      return;
    }

    if (cmd === 'apply-010') {
      const inv = await applyFile(
        client,
        '010_haraj_post_close.sql',
        '010_haraj_post_close',
        validate010,
      );
      console.log(JSON.stringify({ applied: '010', inventory: redactInv(inv) }));
      return;
    }

    if (cmd === 'rollback-010') {
      const inv = await rollbackFile(
        client,
        '010_haraj_post_close.rollback.sql',
        '010_haraj_post_close',
      );
      expectTables(inv, TABLES_010, false);
      validate009(inv);
      console.log(JSON.stringify({ rolledBack: '010', inventory: redactInv(inv) }));
      return;
    }

    if (cmd === 'rollback-009') {
      const inv = await rollbackFile(
        client,
        '009_haraj_core_orchestration.rollback.sql',
        '009_haraj_core_orchestration',
      );
      validate008(inv);
      console.log(JSON.stringify({ rolledBack: '009', inventory: redactInv(inv) }));
      return;
    }

    if (cmd === 'validate-009') {
      const inv = await inventory(client);
      validate009(inv);
      console.log(JSON.stringify({ validated: '009', inventory: redactInv(inv) }));
      return;
    }

    if (cmd === 'validate-010') {
      const inv = await inventory(client);
      validate010(inv);
      console.log(JSON.stringify({ validated: '010', inventory: redactInv(inv) }));
      return;
    }

    if (cmd === 'validate-008') {
      const inv = await inventory(client);
      validate008(inv);
      console.log(JSON.stringify({ validated: '008', inventory: redactInv(inv) }));
      return;
    }

    throw new Error(`Unknown command: ${cmd}`);
  });
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: err.message,
      code: err.code || null,
    }),
  );
  process.exit(1);
});
