'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, 'services', 'haraj_observability.js'),
  'utf8',
);

describe('G17 observability domain', () => {
  let obs;

  beforeEach(() => {
    delete require.cache[require.resolve('./services/haraj_observability')];
    obs = require('./services/haraj_observability');
    obs.resetForTests();
  });

  it('is deterministic, forbids AI/vendor, and does not become business authority', () => {
    assert.equal(obs.AI_STATUS.implemented, false);
    assert.equal(obs.AI_STATUS.provider, false);
    assert.equal(obs.LIVEKIT.implemented, false);
    assert.equal(/openai|anthropic|datadog|sentry|opentelemetry|prometheus/i.test(SRC), false);
    assert.equal(/\b(INSERT INTO|CREATE TABLE)\b/i.test(SRC), false);
  });

  it('redacts secrets, sentinels, and newlines without leaking plaintext', () => {
    const out = obs.redact({
      authorization: 'Bearer G17_SECRET_SENTINEL_TOKEN',
      password: 'G17_PASSWORD_SENTINEL',
      evidence: 'G17_PRIVATE_EVIDENCE_SENTINEL',
      note: 'line1\nERROR fake-event',
      auctionId: 'a1',
    });
    assert.equal(out.authorization, '[REDACTED]');
    assert.equal(out.password, '[REDACTED]');
    assert.equal(out.evidence, '[REDACTED]');
    assert.equal(String(out.note).includes('\n'), false);
    assert.equal(out.auctionId, 'a1');
    const line = JSON.stringify(obs.logStructured('info', 'test.redact', {
      token: 'G17_SECRET_SENTINEL_TOKEN',
    }));
    assert.equal(line.includes('G17_SECRET_SENTINEL_TOKEN'), false);
  });

  it('classifies domain 4xx as business rejection, not 5xx', () => {
    assert.equal(obs.classify({ code: 'HARAJ_EXPOSURE_LIMIT', status: 409 }, 409), 'BUSINESS_REJECTION');
    assert.equal(obs.classify({ status: 401 }, 401), 'AUTHENTICATION');
    assert.equal(obs.classify({ status: 500 }, 500), 'INTERNAL_ERROR');
    const body = obs.safeErrorBody({ status: 500, message: 'boom /secret/path', stack: 'x' }, { correlationId: 'req-abc' });
    assert.equal(body.message, 'Internal error');
    assert.equal(body.requestId, 'req-abc');
    assert.equal(JSON.stringify(body).includes('/secret/path'), false);
  });

  it('accepts only safe correlation ids and never treats them as actors', () => {
    const req = {
      get: (h) => (h === 'x-request-id' ? 'client-corr-123456' : ''),
    };
    assert.equal(obs.resolveCorrelationId(req), 'client-corr-123456');
    const forged = { get: () => 'x\nERROR forged' };
    assert.match(obs.resolveCorrelationId(forged), /^req-/);
  });

  it('keeps structured logs parseable under circular objects and log injection', () => {
    const circular = { auctionId: 'lot-1' };
    circular.self = circular;
    assert.doesNotThrow(() => obs.logStructured('info', 'test.circular', circular));
    const rec = obs.redact({ note: 'ok\nERROR forged-event', auctionId: 'lot-1' });
    assert.equal(String(rec.note).includes('\n'), false);
    assert.equal(rec.auctionId, 'lot-1');
  });

  it('does not mark ready when the critical DB inject is active, and LiveKit does not block', () => {
    const prevApp = process.env.APP_ENV;
    process.env.APP_ENV = 'staging';
    delete require.cache[require.resolve('./services/haraj_observability')];
    obs = require('./services/haraj_observability');
    obs.resetForTests();
    obs.setRuntimeInject('db_unavailable');
    const down = obs.getReadiness({ auctionsReady: true, dbConfigured: true, migrationsReady: true, schemaVersion: '011_haraj_bidder_eligibility_security' });
    assert.equal(down.alive, true);
    assert.equal(down.ready, false);
    assert.equal(down.livekit.implemented, false);
    obs.setRuntimeInject(null);
    const mismatch = obs.getReadiness({ auctionsReady: true, dbConfigured: true, migrationsReady: false, schemaVersion: '008_auction_media_independence' });
    assert.equal(mismatch.ready, false);
    assert.ok(mismatch.reasons.includes('MIGRATIONS_NOT_READY'));
    process.env.APP_ENV = prevApp;
    delete require.cache[require.resolve('./services/haraj_observability')];
  });

  it('forbids production injection and leaves default inject inactive', () => {
    const prevApp = process.env.APP_ENV;
    const prevFlag = process.env.HARAJ_G17_INJECT_ENABLE;
    process.env.APP_ENV = 'production';
    process.env.HARAJ_G17_INJECT_ENABLE = 'true';
    delete require.cache[require.resolve('./services/haraj_observability')];
    const prod = require('./services/haraj_observability');
    assert.equal(prod.injectEnabled(), false);
    assert.throws(() => prod.assertProductionInjectForbidden(), (e) => e.code === 'G17_INJECT_FORBIDDEN_IN_PRODUCTION');
    process.env.APP_ENV = prevApp;
    if (prevFlag == null) delete process.env.HARAJ_G17_INJECT_ENABLE;
    else process.env.HARAJ_G17_INJECT_ENABLE = prevFlag;
    delete require.cache[require.resolve('./services/haraj_observability')];
  });
});
