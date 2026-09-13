#!/usr/bin/env node
'use strict';

/**
 * NOMAS Haraj — Production-only migration runner (009 → 010 → 011).
 * Hard-gated to Production Postgres identity. Never prints connection strings.
 *
 * Usage:
 *   APP_ENV=production AUCTIONS_DATABASE_URL=... \
 *     HARAJ_PROD_MIGRATE_CONFIRM=YES_PRODUCTION_NOMAS_AUCTIONS \
 *     node auctions/scripts/haraj_prod_migrate.js <cmd>
 *
 * Commands:
 *   identity | inventory | backup-logical <dir>
 *   apply-009 | apply-010 | apply-011
 *   validate-009 | validate-010 | validate-011
 *   integrity-ro
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const {
  parseDatabaseIdentity,
  isProductionDatabaseUrl,
  isStagingDatabaseUrl,
  isProductionEnv,
} = require('../environment');

const PROD_INSTANCE = 'dpg-da5fc18jo6nc73cd4930-a';
const PROD_DB = 'nomas_auctions';
const CONFIRM = 'YES_PRODUCTION_NOMAS_AUCTIONS';

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
const TABLES_011 = [
  'haraj_bidder_profiles',
  'haraj_bid_securities',
  'haraj_bidder_exposure_snapshots',
  'haraj_bidder_audit_events',
];

function proposedPath(name) {
  return path.join(__dirname, '..', 'migrations', 'proposed', name);
}

function getUrl() {
  return String(process.env.AUCTIONS_DATABASE_URL || '').trim();
}

function assertProductionTarget() {
  if (String(process.env.HARAJ_PROD_MIGRATE_CONFIRM || '').trim() !== CONFIRM) {
    throw Object.assign(
      new Error(`Set HARAJ_PROD_MIGRATE_CONFIRM=${CONFIRM}`),
      { code: 'HARAJ_PROD_CONFIRM_REQUIRED' },
    );
  }
  if (!isProductionEnv()) {
    throw Object.assign(new Error(`APP_ENV must be production (got ${process.env.APP_ENV || 'unset'})`), {
      code: 'HARAJ_TARGET_UNPROVEN',
    });
  }
  const url = getUrl();
  if (!url) {
    throw Object.assign(new Error('AUCTIONS_DATABASE_URL required'), { code: 'HARAJ_TARGET_UNPROVEN' });
  }
  if (isStagingDatabaseUrl(url)) {
    throw Object.assign(new Error('Staging database detected — ABORT'), { code: 'HARAJ_TARGET_UNPROVEN' });
  }
  if (!isProductionDatabaseUrl(url)) {
    throw Object.assign(new Error('Production database identity not proven'), { code: 'HARAJ_TARGET_UNPROVEN' });
  }
  const id = parseDatabaseIdentity(url);
  if (id.database !== PROD_DB) {
    throw Object.assign(new Error(`Database name mismatch: ${id.database}`), { code: 'HARAJ_TARGET_UNPROVEN' });
  }
  if (!(id.hostname || '').includes(PROD_INSTANCE)) {
    throw Object.assign(new Error('Hostname is not nomas-auctions Production instance'), {
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
    connectionTimeoutMillis: 30000,
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
  const migrations = await client.query(
    `SELECT id, applied_at FROM auction_schema_migrations ORDER BY id`,
  );
  const harajMode = columns.rows
    .filter((c) => c.table_name === 'auctions' && c.column_name === 'haraj_mode')
    .map((c) => ({ type: c.data_type, nullable: c.is_nullable, def: c.column_default }));
  return {
    tables: tables.rows.map((r) => r.table_name),
    columns: columns.rows,
    foreignKeys: fks.rows,
    migrations: migrations.rows.map((r) => r.id),
    harajMode,
  };
}

function expectTables(inv, names, present) {
  const missing = names.filter((t) => inv.tables.includes(t) !== present);
  if (present && missing.length) {
    throw new Error(`Expected tables missing: ${missing.join(', ')}`);
  }
  if (!present && missing.length) {
    throw new Error(`Tables should be absent: ${missing.join(', ')}`);
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

function validate009(inv) {
  expectTables(inv, TABLES_009, true);
  if (!inv.migrations.includes('009_haraj_core_orchestration')) {
    throw new Error('009 not recorded in auction_schema_migrations');
  }
  if (!inv.harajMode.length) throw new Error('auctions.haraj_mode missing');
}

function validate010(inv) {
  validate009(inv);
  expectTables(inv, TABLES_010, true);
  if (!inv.migrations.includes('010_haraj_post_close')) {
    throw new Error('010 not recorded');
  }
}

function validate011(inv) {
  validate010(inv);
  expectTables(inv, TABLES_011, true);
  if (!inv.migrations.includes('011_haraj_bidder_eligibility_security')) {
    throw new Error('011 not recorded');
  }
}

function redactInv(inv) {
  return {
    migrations: inv.migrations,
    tableCount: inv.tables.length,
    harajTables: inv.tables.filter((t) => t.startsWith('haraj_')),
    harajMode: inv.harajMode,
  };
}

async function backupLogical(client, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const inv = await inventory(client);
  const tables = {};
  for (const table of inv.tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
      throw new Error(`refusing unsafe table name ${table}`);
    }
    const { rows } = await client.query(`SELECT * FROM "${table}"`);
    tables[table] = rows;
  }
  const live = await liveIdentity(client);
  const payload = {
    createdAt: new Date().toISOString(),
    liveDb: live.db,
    postgresId: PROD_INSTANCE,
    migrations: inv.migrations,
    tableCount: inv.tables.length,
    tables,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `logical_backup_prod_${stamp}.json`);
  const raw = JSON.stringify(payload);
  fs.writeFileSync(file, raw);
  const proof = {
    type: 'logical-json',
    file,
    bytes: Buffer.byteLength(raw),
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    migrations: payload.migrations,
    tableCount: payload.tableCount,
    databaseName: live.db,
    postgresId: PROD_INSTANCE,
    createdAt: payload.createdAt,
  };
  fs.writeFileSync(path.join(outDir, `LOGICAL_BACKUP_PROOF_${stamp}.json`), JSON.stringify(proof, null, 2));
  return proof;
}

async function integrityRo(client) {
  const checks = [];
  async function check(name, sql, okFn) {
    try {
      const { rows } = await client.query(sql);
      const ok = okFn(rows);
      checks.push({ name, ok, detail: rows[0] || null });
    } catch (err) {
      // Table may not exist pre-migration — record skip vs fail carefully
      const missing = /does not exist/i.test(err.message);
      checks.push({ name, ok: missing, skipped: missing, error: missing ? null : err.message });
    }
  }

  await check(
    'no_duplicate_sessions',
    `SELECT COUNT(*)::int AS dupes FROM (
       SELECT id FROM haraj_sessions GROUP BY id HAVING COUNT(*) > 1
     ) t`,
    (rows) => Number(rows[0]?.dupes || 0) === 0,
  );
  await check(
    'no_impossible_active_lot',
    `SELECT COUNT(*)::int AS bad FROM haraj_room_sessions rs
     WHERE rs.active_lot_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.id = rs.active_lot_id)`,
    (rows) => Number(rows[0]?.bad || 0) === 0,
  );
  await check(
    'bid_history_integrity',
    `SELECT COUNT(*)::int AS orphan_bids FROM bids b
     WHERE NOT EXISTS (SELECT 1 FROM auctions a WHERE a.id = b.auction_id)`,
    (rows) => Number(rows[0]?.orphan_bids || 0) === 0,
  );
  await check(
    'winner_integrity',
    `SELECT COUNT(*)::int AS bad FROM auctions a
     WHERE a.winner_bid_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.id = a.winner_bid_id AND b.auction_id = a.id)`,
    (rows) => Number(rows[0]?.bad || 0) === 0,
  );
  await check(
    'no_double_accepted_after_offer',
    `SELECT listing_id, COUNT(*)::int AS accepted
     FROM haraj_after_listings
     WHERE status = 'accepted'
     GROUP BY listing_id
     HAVING COUNT(*) > 1`,
    (rows) => rows.length === 0,
  );
  await check(
    'no_contradictory_dispute',
    `SELECT COUNT(*)::int AS bad FROM auction_disputes
     WHERE status = 'open' AND resolved_at IS NOT NULL`,
    (rows) => Number(rows[0]?.bad || 0) === 0,
  );

  const failed = checks.filter((c) => c.ok === false && !c.skipped);
  return {
    checks,
    unexplainedCorruption: failed.length,
    ok: failed.length === 0,
  };
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error('Usage: haraj_prod_migrate.js <command>');
    process.exit(2);
  }
  const parsed = assertProductionTarget();
  console.log(
    JSON.stringify({
      ok: true,
      command: cmd,
      parsedIdentity: { hostname: parsed.hostname, database: parsed.database },
    }),
  );

  await withClient(async (client) => {
    const live = await liveIdentity(client);
    if (live.db !== PROD_DB) {
      throw new Error(`Live current_database=${live.db} — ABORT`);
    }
    console.log(JSON.stringify({ liveIdentity: { db: live.db, db_user: live.db_user } }));

    if (cmd === 'identity') return;

    if (cmd === 'inventory') {
      console.log(JSON.stringify({ inventory: redactInv(await inventory(client)) }));
      return;
    }

    if (cmd === 'backup-logical') {
      const outDir = process.argv[3];
      if (!outDir) throw new Error('backup-logical requires output directory');
      const proof = await backupLogical(client, outDir);
      console.log(JSON.stringify({ backup: proof }));
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
      if (!(await applied(client, '009_haraj_core_orchestration'))) {
        throw new Error('009 must be applied before 010');
      }
      const inv = await applyFile(
        client,
        '010_haraj_post_close.sql',
        '010_haraj_post_close',
        validate010,
      );
      console.log(JSON.stringify({ applied: '010', inventory: redactInv(inv) }));
      return;
    }

    if (cmd === 'apply-011') {
      if (!(await applied(client, '010_haraj_post_close'))) {
        throw new Error('010 must be applied before 011');
      }
      const inv = await applyFile(
        client,
        '011_haraj_bidder_eligibility_security.sql',
        '011_haraj_bidder_eligibility_security',
        validate011,
      );
      console.log(JSON.stringify({ applied: '011', inventory: redactInv(inv) }));
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

    if (cmd === 'validate-011') {
      const inv = await inventory(client);
      validate011(inv);
      console.log(JSON.stringify({ validated: '011', inventory: redactInv(inv) }));
      return;
    }

    if (cmd === 'integrity-ro') {
      const result = await integrityRo(client);
      console.log(JSON.stringify({ integrity: result }));
      if (!result.ok) process.exit(1);
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
