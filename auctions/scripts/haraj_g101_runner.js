#!/usr/bin/env node
'use strict';

/**
 * G10.1 — Staging-only migration 011 runner.
 * Never prints connection strings or passwords.
 *
 * Usage (local):
 *   APP_ENV=staging AUCTIONS_STAGING_DATABASE_URL=... node haraj_g101_runner.js <cmd>
 *
 * Usage (Render job on horse-backend-staging):
 *   sh -c 'export AUCTIONS_STAGING_DATABASE_URL="$DATABASE_URL"; export APP_ENV=staging; node auctions/scripts/haraj_g101_runner.js <cmd>'
 *
 * Commands:
 *   identity | inventory | apply-011 | validate-011 | rollback-011 | validate-010 | reapply-011 | cycle
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const STAGING_INSTANCE = 'dpg-dabp4j6k1f9s7391dseg-a';
const STAGING_DB = 'nomas_auctions_staging';
const PROD_INSTANCE = 'dpg-da5fc18jo6nc73cd4930-a';
const MIGRATION_ID = '011_haraj_bidder_eligibility_security';

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
const CORE_TABLES = ['auctions', 'auction_lots', 'bids', 'auction_events'];

function proposedPath(name) {
  return path.join(__dirname, '..', 'migrations', 'proposed', name);
}

function getUrl() {
  return String(process.env.AUCTIONS_STAGING_DATABASE_URL || '').trim();
}

function parseDatabaseIdentity(connectionString) {
  if (!connectionString || typeof connectionString !== 'string') {
    return { configured: false, hostname: null, database: null };
  }
  try {
    const u = new URL(connectionString.replace(/^postgres(ql)?:\/\//, 'http://'));
    const database = (u.pathname || '').replace(/^\//, '').split('?')[0] || null;
    return { configured: true, hostname: u.hostname || null, database: database || null };
  } catch {
    return { configured: false, hostname: null, database: null };
  }
}

function assertTarget() {
  const appEnv = String(process.env.APP_ENV || process.env.NOMAS_ENV || '').trim().toLowerCase();
  if (appEnv !== 'staging') {
    throw Object.assign(new Error(`APP_ENV must be staging (current: ${appEnv || 'unset'})`), {
      code: 'HARAJ_TARGET_UNPROVEN',
    });
  }
  const url = getUrl();
  if (!url) {
    throw Object.assign(new Error('AUCTIONS_STAGING_DATABASE_URL required'), {
      code: 'HARAJ_TARGET_UNPROVEN',
    });
  }
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
  if ((id.hostname || '').includes(PROD_INSTANCE) || id.database === 'nomas_auctions') {
    throw Object.assign(new Error('Production database detected — ABORT'), {
      code: 'HARAJ_TARGET_UNPROVEN',
    });
  }
  return { hostname: id.hostname, database: id.database };
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
  if (rows[0].db !== STAGING_DB) {
    throw new Error(`Live current_database=${rows[0].db} — ABORT`);
  }
  if (rows[0].db === 'nomas_auctions') {
    throw new Error('Production database name observed — ABORT');
  }
  return { db: rows[0].db, db_user: rows[0].db_user };
}

async function inventory(client) {
  const tables = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const columns = await client.query(`
    SELECT table_name, column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
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
  const checks = await client.query(`
    SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE contype = 'c' AND connamespace = 'public'::regnamespace
    ORDER BY 1, 2
  `);
  const indexes = await client.query(`
    SELECT tablename, indexname FROM pg_indexes
    WHERE schemaname = 'public' ORDER BY tablename, indexname
  `);
  const migrations = await client.query(
    `SELECT id, applied_at FROM auction_schema_migrations ORDER BY id`,
  );
  const counts = {};
  for (const table of CORE_TABLES.concat(TABLES_009, TABLES_010)) {
    if (tables.rows.some((r) => r.table_name === table)) {
      const c = await client.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
      counts[table] = c.rows[0].n;
    }
  }
  return {
    tables: tables.rows.map((r) => r.table_name),
    columns: columns.rows,
    foreignKeys: fks.rows,
    checks: checks.rows,
    indexes: indexes.rows,
    migrations: migrations.rows.map((r) => r.id),
    counts,
  };
}

function redactInv(inv) {
  return {
    migrations: inv.migrations,
    tableCount: inv.tables.length,
    tables: inv.tables,
    harajTables: inv.tables.filter((t) => t.startsWith('haraj_')),
    corePresent: CORE_TABLES.every((t) => inv.tables.includes(t)),
    g7g8g9Present: TABLES_009.every((t) => inv.tables.includes(t)),
    g10PostClosePresent: TABLES_010.every((t) => inv.tables.includes(t)),
    g10TablesPresent: TABLES_011.filter((t) => inv.tables.includes(t)),
    counts: inv.counts,
    fkCount: inv.foreignKeys.length,
    indexCount: inv.indexes.length,
    moneyColumns: inv.columns
      .filter((c) => TABLES_011.includes(c.table_name) && /limit|amount|exposure|price/.test(c.column_name))
      .map((c) => ({
        table: c.table_name,
        column: c.column_name,
        type: c.data_type,
        precision: c.numeric_precision,
        scale: c.numeric_scale,
      })),
  };
}

function expectTables(inv, names, present) {
  const missing = names.filter((t) => inv.tables.includes(t) !== present);
  if (present && missing.length) throw new Error(`Expected tables missing: ${missing.join(', ')}`);
  if (!present && missing.length) {
    throw new Error(`Tables should be absent: ${missing.join(', ')}`);
  }
}

function validate010(inv) {
  expectTables(inv, TABLES_009.concat(TABLES_010).concat(CORE_TABLES), true);
  if (!inv.migrations.includes('010_haraj_post_close')) throw new Error('010 not recorded');
  if (inv.migrations.includes(MIGRATION_ID)) throw new Error('011 still recorded — expected 010');
  expectTables(inv, TABLES_011, false);
}

function validate011(inv) {
  expectTables(inv, TABLES_009.concat(TABLES_010).concat(CORE_TABLES).concat(TABLES_011), true);
  if (!inv.migrations.includes('010_haraj_post_close')) throw new Error('010 missing after 011');
  if (!inv.migrations.includes(MIGRATION_ID)) throw new Error('011 not recorded');
  const money = inv.columns.filter(
    (c) => TABLES_011.includes(c.table_name) && ['bid_limit', 'authorized_limit', 'bid_amount', 'prior_exposure', 'resulting_exposure'].includes(c.column_name),
  );
  for (const col of money) {
    if (col.data_type !== 'numeric' || Number(col.numeric_precision) !== 14 || Number(col.numeric_scale) !== 2) {
      throw new Error(`Unsafe money type ${col.table_name}.${col.column_name}=${col.data_type}(${col.numeric_precision},${col.numeric_scale})`);
    }
  }
  const forbidden = inv.columns.filter(
    (c) => TABLES_011.includes(c.table_name) && ['real', 'double precision'].includes(c.data_type),
  );
  if (forbidden.length) throw new Error('FLOAT/REAL/DOUBLE present on 011 money tables');
  const secFk = inv.foreignKeys.find(
    (f) => f.table_name === 'haraj_bid_securities' && f.column_name === 'bidder_user_id',
  );
  if (!secFk || secFk.foreign_table !== 'haraj_bidder_profiles') {
    throw new Error('haraj_bid_securities.bidder_user_id must reference haraj_bidder_profiles');
  }
  const snapFk = inv.foreignKeys.find(
    (f) => f.table_name === 'haraj_bidder_exposure_snapshots' && f.column_name === 'auction_id',
  );
  if (!snapFk || snapFk.foreign_table !== 'auctions') {
    throw new Error('exposure snapshot must reference auctions');
  }
}

async function applied(client, id) {
  const { rows } = await client.query(`SELECT id FROM auction_schema_migrations WHERE id = $1`, [id]);
  return rows.length > 0;
}

async function apply011(client) {
  if (await applied(client, MIGRATION_ID)) {
    throw new Error('011 already applied — refusing unsafe duplicate');
  }
  const sql = fs.readFileSync(proposedPath('011_haraj_bidder_eligibility_security.sql'), 'utf8');
  const started = Date.now();
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(`INSERT INTO auction_schema_migrations (id) VALUES ($1)`, [MIGRATION_ID]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  const inv = await inventory(client);
  validate011(inv);
  return { durationMs: Date.now() - started, inventory: redactInv(inv) };
}

async function rollback011(client) {
  if (!(await applied(client, MIGRATION_ID))) {
    throw new Error('011 is not applied — nothing to roll back');
  }
  const sql = fs.readFileSync(proposedPath('011_haraj_bidder_eligibility_security_rollback.sql'), 'utf8');
  const started = Date.now();
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  const inv = await inventory(client);
  validate010(inv);
  return { durationMs: Date.now() - started, inventory: redactInv(inv) };
}

async function constraintProbes(client) {
  const probe = `g101-probe-${Date.now()}`;
  const results = [];
  const run = async (name, fn, expectFail) => {
    try {
      await fn();
      results.push({ name, pass: !expectFail, note: expectFail ? 'should have failed' : 'ok' });
    } catch (err) {
      results.push({ name, pass: Boolean(expectFail), code: err.code || null, message: expectFail ? 'rejected' : err.message });
    }
  };
  await run('valid_profile', async () => {
    await client.query(
      `INSERT INTO haraj_bidder_profiles (user_id, eligibility_status, bid_limit) VALUES ($1, 'verified', 100000)`,
      [probe],
    );
  }, false);
  await run('negative_limit', async () => {
    await client.query(
      `INSERT INTO haraj_bidder_profiles (user_id, eligibility_status, bid_limit) VALUES ($1, 'verified', -1)`,
      [`${probe}-neg`],
    );
  }, true);
  await run('security_without_profile', async () => {
    await client.query(
      `INSERT INTO haraj_bid_securities (bidder_user_id, status, scope_type, authorized_limit)
       VALUES ($1, 'active', 'global', 1000)`,
      [`${probe}-missing`],
    );
  }, true);
  await run('psp_production_forbidden', async () => {
    await client.query(
      `INSERT INTO haraj_bid_securities
        (bidder_user_id, status, scope_type, authorized_limit, provider_mode)
       VALUES ($1, 'active', 'global', 1000, 'psp_production')`,
      [probe],
    );
  }, true);
  await run('audit_update_forbidden', async () => {
    const ins = await client.query(
      `INSERT INTO haraj_bidder_audit_events (bidder_user_id, event_type) VALUES ($1, 'probe') RETURNING id`,
      [probe],
    );
    await client.query(`UPDATE haraj_bidder_audit_events SET event_type = 'mutated' WHERE id = $1`, [ins.rows[0].id]);
  }, true);
  await client.query(`DELETE FROM haraj_bidder_audit_events WHERE bidder_user_id LIKE $1`, [`${probe}%`]).catch(() => {});
  await client.query(`DELETE FROM haraj_bid_securities WHERE bidder_user_id LIKE $1`, [`${probe}%`]).catch(() => {});
  await client.query(`DELETE FROM haraj_bidder_profiles WHERE user_id LIKE $1`, [`${probe}%`]).catch(() => {});
  if (results.some((r) => !r.pass)) {
    throw new Error(`Constraint probes failed: ${results.filter((r) => !r.pass).map((r) => r.name).join(', ')}`);
  }
  return results;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error('Usage: haraj_g101_runner.js <command>');
    process.exit(2);
  }
  const parsed = assertTarget();
  console.log(JSON.stringify({
    ok: true,
    command: cmd,
    parsedIdentity: { hostnameMarker: STAGING_INSTANCE, database: parsed.database },
    productionHostnameRejected: !(parsed.hostname || '').includes(PROD_INSTANCE),
  }));

  await withClient(async (client) => {
    const live = await liveIdentity(client);
    console.log(JSON.stringify({ liveIdentity: live, notProductionDb: live.db !== 'nomas_auctions' }));

    if (cmd === 'identity') return;

    if (cmd === 'inventory') {
      console.log(JSON.stringify({ inventory: redactInv(await inventory(client)) }));
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
      const probes = await constraintProbes(client);
      console.log(JSON.stringify({ validated: '011', inventory: redactInv(inv), probes }));
      return;
    }

    if (cmd === 'apply-011') {
      const started = new Date().toISOString();
      const result = await apply011(client);
      console.log(JSON.stringify({ applied: '011', started, completed: new Date().toISOString(), ...result }));
      return;
    }

    if (cmd === 'rollback-011') {
      const result = await rollback011(client);
      console.log(JSON.stringify({ rolledBack: '011', restored: '010', ...result }));
      return;
    }

    if (cmd === 'reapply-011') {
      const result = await apply011(client);
      const probes = await constraintProbes(client);
      console.log(JSON.stringify({ reapplied: '011', ...result, probes }));
      return;
    }

    if (cmd === 'cycle') {
      const pre = redactInv(await inventory(client));
      if (pre.migrations.includes(MIGRATION_ID)) {
        throw new Error('cycle expects schema 010 (011 not applied)');
      }
      validate010(await inventory(client));
      const apply = await apply011(client);
      const probes1 = await constraintProbes(client);
      const rb = await rollback011(client);
      const re = await apply011(client);
      const probes2 = await constraintProbes(client);
      const finalInv = redactInv(await inventory(client));
      console.log(JSON.stringify({
        cycle: 'apply-rollback-reapply',
        preMigrations: pre.migrations,
        applyDurationMs: apply.durationMs,
        rollbackDurationMs: rb.durationMs,
        reapplyDurationMs: re.durationMs,
        probesApply: probes1,
        probesFinal: probes2,
        finalSchema: finalInv.migrations[finalInv.migrations.length - 1],
        inventory: finalInv,
      }));
      return;
    }

    throw new Error(`Unknown command: ${cmd}`);
  });
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: err.message,
    code: err.code || null,
  }));
  process.exit(1);
});
