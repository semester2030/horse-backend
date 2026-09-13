'use strict';

/**
 * NOMAS Haraj — authoritative environment identity (G2.1 / G2.1A).
 * Never log connection strings or secrets from this module.
 */

const DEFAULT_PRODUCTION_BACKEND_HOSTS = [
  'horse-backend-i68h.onrender.com',
];

/** Render Postgres instance ID — nomas-auctions (production). */
const DEFAULT_PRODUCTION_AUCTIONS_DB_INSTANCE_IDS = [
  'dpg-da5fc18jo6nc73cd4930-a',
];

const DEFAULT_PRODUCTION_AUCTIONS_DB_NAMES = ['nomas_auctions'];

/** Render Postgres instance ID — nomas-auctions-staging (G2.1A). */
const DEFAULT_STAGING_AUCTIONS_DB_INSTANCE_IDS = [
  'dpg-dabp4j6k1f9s7391dseg-a',
];

const DEFAULT_STAGING_AUCTIONS_DB_NAMES = ['nomas_auctions_staging'];

function getAppEnv() {
  const explicit = String(process.env.APP_ENV || process.env.NOMAS_ENV || '')
    .trim()
    .toLowerCase();
  if (explicit === 'staging' || explicit === 'production' || explicit === 'development') {
    return explicit;
  }
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv === 'production') return 'production';
  if (nodeEnv === 'test') return 'development';
  return 'development';
}

function isProductionEnv() {
  return getAppEnv() === 'production';
}

function isStagingEnv() {
  return getAppEnv() === 'staging';
}

function splitCsvEnv(key, defaults) {
  const raw = String(process.env[key] || '').trim();
  if (!raw) return defaults;
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function getProductionBackendHosts() {
  return splitCsvEnv('NOMAS_PRODUCTION_HOST_MARKERS', DEFAULT_PRODUCTION_BACKEND_HOSTS);
}

function getProductionAuctionsDbInstanceIds() {
  return splitCsvEnv(
    'NOMAS_PRODUCTION_AUCTIONS_DB_INSTANCE_IDS',
    DEFAULT_PRODUCTION_AUCTIONS_DB_INSTANCE_IDS,
  );
}

function getStagingAuctionsDbInstanceIds() {
  return splitCsvEnv(
    'NOMAS_STAGING_AUCTIONS_DB_INSTANCE_IDS',
    DEFAULT_STAGING_AUCTIONS_DB_INSTANCE_IDS,
  );
}

function getProductionAuctionsDbNames() {
  return splitCsvEnv(
    'NOMAS_PRODUCTION_AUCTIONS_DB_NAMES',
    DEFAULT_PRODUCTION_AUCTIONS_DB_NAMES,
  );
}

function getStagingAuctionsDbNames() {
  return splitCsvEnv(
    'NOMAS_STAGING_AUCTIONS_DB_NAMES',
    DEFAULT_STAGING_AUCTIONS_DB_NAMES,
  );
}

function parseDatabaseIdentity(connectionString) {
  if (!connectionString || typeof connectionString !== 'string') {
    return { configured: false, hostname: null, database: null, port: null };
  }
  try {
    const u = new URL(connectionString.replace(/^postgres(ql)?:\/\//, 'http://'));
    const database = (u.pathname || '').replace(/^\//, '').split('?')[0] || null;
    return {
      configured: true,
      hostname: u.hostname || null,
      database: database || null,
      port: u.port || '5432',
    };
  } catch {
    return { configured: false, hostname: null, database: null, port: null };
  }
}

function hostnameIncludesAny(hostname, markers) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return markers.some((m) => h.includes(m));
}

function isProductionBackendUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase();
    return getProductionBackendHosts().some((m) => host === m || host.endsWith(`.${m}`));
  } catch {
    return false;
  }
}

function isStagingDatabaseUrl(connectionString) {
  const id = parseDatabaseIdentity(connectionString);
  if (!id.configured) return false;
  if (id.hostname === 'localhost' || id.hostname === '127.0.0.1') return false;
  const dbName = (id.database || '').toLowerCase();
  if (getStagingAuctionsDbNames().includes(dbName)) return true;
  return hostnameIncludesAny(id.hostname, getStagingAuctionsDbInstanceIds());
}

function isProductionDatabaseUrl(connectionString) {
  const id = parseDatabaseIdentity(connectionString);
  if (!id.configured) return false;
  if (id.hostname === 'localhost' || id.hostname === '127.0.0.1') return false;
  if (isStagingDatabaseUrl(connectionString)) return false;
  const dbName = (id.database || '').toLowerCase();
  if (getProductionAuctionsDbNames().includes(dbName)) return true;
  return hostnameIncludesAny(id.hostname, getProductionAuctionsDbInstanceIds());
}

function assertStagingMigrationAllowed(options = {}) {
  const allowLocalhost =
    options.allowLocalhost === true || options.allowLocalhost === 'true';
  let dbUrl = options.databaseUrl || process.env.AUCTIONS_STAGING_DATABASE_URL || '';
  if (!dbUrl && allowLocalhost) {
    dbUrl = process.env.AUCTIONS_DATABASE_URL || '';
  }

  const errors = [];

  if (!isStagingEnv()) {
    errors.push(
      `APP_ENV/NOMAS_ENV must be "staging" (current: ${getAppEnv() || 'unset'})`,
    );
  }

  const id = parseDatabaseIdentity(dbUrl);
  if (!id.configured) {
    errors.push('AUCTIONS_STAGING_DATABASE_URL is required for staging — no AUCTIONS_DATABASE_URL fallback');
  }

  if (isProductionDatabaseUrl(dbUrl)) {
    errors.push('Database target matches production auctions DB — ABORT');
  }

  if (id.configured && (id.hostname === 'localhost' || id.hostname === '127.0.0.1')) {
    if (options.allowLocalhost !== true && options.allowLocalhost !== 'true') {
      errors.push(
        'Localhost DB detected — set HARAJ_MIGRATION_ALLOW_LOCALHOST=true only for local dev review',
      );
    }
  } else if (id.configured && !isStagingDatabaseUrl(dbUrl)) {
    errors.push(
      'Database identity is ambiguous — must target nomas_auctions_staging or known staging instance',
    );
  }

  const explicitStaging = String(process.env.AUCTIONS_STAGING_DATABASE_URL || '').trim();
  if (
    isStagingEnv() &&
    !explicitStaging &&
    !options.allowLocalhost &&
    id.configured &&
    (id.hostname === 'localhost' || id.hostname === '127.0.0.1')
  ) {
    errors.push(
      'Cloud staging requires AUCTIONS_STAGING_DATABASE_URL — localhost is dev-only with HARAJ_MIGRATION_ALLOW_LOCALHOST=true',
    );
  }

  if (errors.length) {
    const err = new Error(`Haraj migration preflight FAILED:\n- ${errors.join('\n- ')}`);
    err.code = 'HARAJ_MIGRATION_PREFLIGHT_FAILED';
    err.details = { appEnv: getAppEnv(), dbIdentity: id };
    throw err;
  }

  return {
    ok: true,
    appEnv: getAppEnv(),
    dbIdentity: id,
  };
}

function getEnvironmentSummary() {
  const auctionsDb = isStagingEnv()
    ? String(process.env.AUCTIONS_STAGING_DATABASE_URL || '')
    : (
      process.env.AUCTIONS_STAGING_DATABASE_URL ||
      process.env.AUCTIONS_DATABASE_URL ||
      process.env.DATABASE_URL ||
      ''
    );
  return {
    appEnv: getAppEnv(),
    nodeEnv: process.env.NODE_ENV || null,
    auctionsDbIdentity: parseDatabaseIdentity(auctionsDb),
    productionBackendGuard: getProductionBackendHosts(),
    productionAuctionsDbInstances: getProductionAuctionsDbInstanceIds(),
    stagingAuctionsDbInstances: getStagingAuctionsDbInstanceIds(),
    isProductionDatabase: isProductionDatabaseUrl(auctionsDb),
    isStagingDatabase: isStagingDatabaseUrl(auctionsDb),
  };
}

module.exports = {
  getAppEnv,
  isProductionEnv,
  isStagingEnv,
  parseDatabaseIdentity,
  isProductionBackendUrl,
  isProductionDatabaseUrl,
  isStagingDatabaseUrl,
  assertStagingMigrationAllowed,
  getEnvironmentSummary,
  DEFAULT_PRODUCTION_BACKEND_HOSTS,
};
