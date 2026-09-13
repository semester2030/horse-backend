'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('G2.1 / G2.1A — environment guard', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    delete require.cache[require.resolve('./environment')];
  });

  function loadEnv() {
    delete require.cache[require.resolve('./environment')];
    return require('./environment');
  }

  it('rejects migration when APP_ENV is not staging', () => {
    process.env.APP_ENV = 'production';
    process.env.AUCTIONS_STAGING_DATABASE_URL =
      'postgresql://user:secret@dpg-dabp4j6k1f9s7391dseg-a.oregon-postgres.render.com/nomas_auctions_staging';
    const env = loadEnv();
    assert.throws(
      () => env.assertStagingMigrationAllowed(),
      (e) => e.code === 'HARAJ_MIGRATION_PREFLIGHT_FAILED',
    );
  });

  it('rejects production Render auctions DB instance', () => {
    process.env.APP_ENV = 'staging';
    process.env.AUCTIONS_STAGING_DATABASE_URL =
      'postgresql://user:secret@dpg-da5fc18jo6nc73cd4930-a.oregon-postgres.render.com/nomas_auctions';
    const env = loadEnv();
    assert.throws(
      () => env.assertStagingMigrationAllowed(),
      (e) => e.code === 'HARAJ_MIGRATION_PREFLIGHT_FAILED',
    );
  });

  it('passes cloud staging DB identity (G2.1A Render instance)', () => {
    process.env.APP_ENV = 'staging';
    process.env.AUCTIONS_STAGING_DATABASE_URL =
      'postgresql://nomas_auctions_staging_user:secret@dpg-dabp4j6k1f9s7391dseg-a.oregon-postgres.render.com/nomas_auctions_staging';
    const env = loadEnv();
    const ok = env.assertStagingMigrationAllowed();
    assert.equal(ok.ok, true);
    assert.equal(ok.dbIdentity.database, 'nomas_auctions_staging');
    assert.equal(env.isStagingDatabaseUrl(process.env.AUCTIONS_STAGING_DATABASE_URL), true);
    assert.equal(env.isProductionDatabaseUrl(process.env.AUCTIONS_STAGING_DATABASE_URL), false);
  });

  it('rejects unknown cloud DB (ambiguous identity)', () => {
    process.env.APP_ENV = 'staging';
    process.env.AUCTIONS_STAGING_DATABASE_URL =
      'postgresql://user:secret@dpg-unknown999-a.oregon-postgres.render.com/other_db';
    const env = loadEnv();
    assert.throws(
      () => env.assertStagingMigrationAllowed(),
      (e) => e.code === 'HARAJ_MIGRATION_PREFLIGHT_FAILED',
    );
  });

  it('rejects missing database URL', () => {
    process.env.APP_ENV = 'staging';
    delete process.env.AUCTIONS_STAGING_DATABASE_URL;
    delete process.env.AUCTIONS_DATABASE_URL;
    delete process.env.DATABASE_URL;
    const env = loadEnv();
    assert.throws(
      () => env.assertStagingMigrationAllowed(),
      (e) => e.code === 'HARAJ_MIGRATION_PREFLIGHT_FAILED',
    );
  });

  it('rejects Production AUCTIONS_DATABASE_URL fallback when staging URL is missing', () => {
    process.env.APP_ENV = 'staging';
    delete process.env.AUCTIONS_STAGING_DATABASE_URL;
    process.env.AUCTIONS_DATABASE_URL =
      'postgresql://user:secret@dpg-da5fc18jo6nc73cd4930-a.oregon-postgres.render.com/nomas_auctions';
    const env = loadEnv();
    assert.throws(
      () => env.assertStagingMigrationAllowed(),
      (e) => e.code === 'HARAJ_MIGRATION_PREFLIGHT_FAILED',
    );
  });

  it('passes localhost only with explicit allowLocalhost flag', () => {
    process.env.APP_ENV = 'staging';
    process.env.AUCTIONS_DATABASE_URL = 'postgresql://localhost:5432/nomas_auctions';
    const env = loadEnv();
    assert.throws(() => env.assertStagingMigrationAllowed());
    const ok = env.assertStagingMigrationAllowed({ allowLocalhost: true });
    assert.equal(ok.ok, true);
    assert.equal(ok.dbIdentity.database, 'nomas_auctions');
  });

  it('parseDatabaseIdentity never includes password', () => {
    process.env.AUCTIONS_DATABASE_URL =
      'postgresql://user:secretpass@localhost:5432/nomas_auctions';
    const env = loadEnv();
    const id = env.parseDatabaseIdentity(process.env.AUCTIONS_DATABASE_URL);
    assert.equal(id.hostname, 'localhost');
    assert.equal(id.database, 'nomas_auctions');
    assert.ok(!JSON.stringify(id).includes('secretpass'));
  });

  it('isProductionBackendUrl detects production host only (not staging)', () => {
    const env = loadEnv();
    assert.equal(
      env.isProductionBackendUrl('https://horse-backend-i68h.onrender.com'),
      true,
    );
    assert.equal(
      env.isProductionBackendUrl('https://horse-backend-staging.onrender.com'),
      false,
    );
    assert.equal(env.isProductionBackendUrl('http://127.0.0.1:4000'), false);
  });
});
