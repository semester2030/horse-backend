'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('G2.1B — staging DB URL fail-closed', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    delete require.cache[require.resolve('./config')];
  });

  function loadConfig() {
    delete require.cache[require.resolve('./config')];
    return require('./config');
  }

  it('staging ignores AUCTIONS_DATABASE_URL and DATABASE_URL', () => {
    process.env.APP_ENV = 'staging';
    delete process.env.AUCTIONS_STAGING_DATABASE_URL;
    process.env.AUCTIONS_DATABASE_URL =
      'postgresql://user:secret@dpg-da5fc18jo6nc73cd4930-a.oregon-postgres.render.com/nomas_auctions';
    process.env.DATABASE_URL = 'postgresql://user:secret@prod.example/nomas_auctions';
    const cfg = loadConfig();
    assert.equal(cfg.getAuctionsDatabaseUrl(), '');
  });

  it('staging uses only AUCTIONS_STAGING_DATABASE_URL', () => {
    process.env.APP_ENV = 'staging';
    process.env.AUCTIONS_STAGING_DATABASE_URL =
      'postgresql://nomas_auctions_staging_user:x@dpg-dabp4j6k1f9s7391dseg-a.oregon-postgres.render.com/nomas_auctions_staging';
    process.env.AUCTIONS_DATABASE_URL =
      'postgresql://user:secret@dpg-da5fc18jo6nc73cd4930-a.oregon-postgres.render.com/nomas_auctions';
    const cfg = loadConfig();
    assert.match(cfg.getAuctionsDatabaseUrl(), /nomas_auctions_staging/);
    assert.ok(!cfg.getAuctionsDatabaseUrl().includes('nomas_auctions_user'));
  });
});
