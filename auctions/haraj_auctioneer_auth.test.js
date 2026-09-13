'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isHarajAuctioneer,
  applyStagingAuctioneerBootstrap,
  grantAuctioneerCapability,
  CAPABILITY,
} = require('./services/haraj_auctioneer_auth');

describe('G4 auctioneer auth', () => {
  it('does not treat privileged-looking users as auctioneers without capability', () => {
    assert.equal(
      isHarajAuctioneer({ id: 'p1', isPrivileged: true, capabilities: ['browse'] }, 'p1'),
      false,
    );
  });

  it('accepts explicit capability', () => {
    const user = grantAuctioneerCapability({ id: 'a1', capabilities: ['browse'] });
    assert.equal(user.capabilities.includes(CAPABILITY), true);
    assert.equal(isHarajAuctioneer(user, 'a1'), true);
  });

  it('staging bootstrap only for auctioneer emails when APP_ENV=staging', () => {
    const prev = process.env.APP_ENV;
    const prevNode = process.env.NODE_ENV;
    const prevSvc = process.env.RENDER_SERVICE_NAME;
    process.env.APP_ENV = 'staging';
    delete process.env.NODE_ENV;
    delete process.env.RENDER_SERVICE_NAME;
    const granted = applyStagingAuctioneerBootstrap({
      email: 'op@nomas.auctioneer.staging',
      capabilities: [],
    });
    assert.equal(granted.capabilities.includes(CAPABILITY), true);
    const ignored = applyStagingAuctioneerBootstrap({
      email: 'seller@nomas.staging',
      capabilities: [],
    });
    assert.equal(ignored.capabilities.includes(CAPABILITY), false);
    process.env.APP_ENV = 'production';
    const prod = applyStagingAuctioneerBootstrap({
      email: 'op@nomas.auctioneer.staging',
      capabilities: [],
    });
    assert.equal(prod.capabilities.includes(CAPABILITY), false);
    process.env.APP_ENV = '';
    process.env.NODE_ENV = 'development';
    process.env.RENDER_SERVICE_NAME = 'horse-backend-staging';
    const viaRender = applyStagingAuctioneerBootstrap({
      email: 'op2@nomas.auctioneer.staging',
      capabilities: [],
    });
    assert.equal(viaRender.capabilities.includes(CAPABILITY), true);
    process.env.APP_ENV = prev;
    process.env.NODE_ENV = prevNode;
    process.env.RENDER_SERVICE_NAME = prevSvc;
  });

  it('allowlists user ids from env', () => {
    const prev = process.env.HARAJ_AUCTIONEER_USER_IDS;
    process.env.HARAJ_AUCTIONEER_USER_IDS = 'u-allow,u-other';
    assert.equal(isHarajAuctioneer({ capabilities: [] }, 'u-allow'), true);
    assert.equal(isHarajAuctioneer({ capabilities: [] }, 'u-nope'), false);
    process.env.HARAJ_AUCTIONEER_USER_IDS = prev;
  });
});
