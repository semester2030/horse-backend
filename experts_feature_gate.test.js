/**
 * Experts pause is fail-closed. Missing config must not open the service.
 * Isolated: no database, no booking, no payment.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { expertsFeatureEnabled, expertsAccessGuard } = require('./experts');

function withEnv(value, fn) {
  const prev = process.env.EXPERTS_ENABLED;
  if (value === undefined) delete process.env.EXPERTS_ENABLED;
  else process.env.EXPERTS_ENABLED = value;
  const done = (err) => {
    if (prev === undefined) delete process.env.EXPERTS_ENABLED;
    else process.env.EXPERTS_ENABLED = prev;
    if (err) throw err;
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then((v) => {
        done();
        return v;
      }, (err) => {
        done(err);
      });
    }
    done();
    return result;
  } catch (err) {
    done(err);
  }
}

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('missing EXPERTS_ENABLED keeps experts off', () => {
  withEnv(undefined, () => {
    assert.equal(expertsFeatureEnabled(), false);
    const res = mockRes();
    let called = false;
    expertsAccessGuard({}, res, () => {
      called = true;
    });
    assert.equal(called, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FEATURE_DISABLED');
  });
});

test('false, empty, and unrelated values stay off', () => {
  for (const value of ['', 'false', '0', 'yes', 'on', '1']) {
    withEnv(value, () => {
      assert.equal(expertsFeatureEnabled(), false, value);
    });
  }
});

test('only exact true opens the guard, then delivery returns to off', () => {
  withEnv('true', () => {
    assert.equal(expertsFeatureEnabled(), true);
    const res = mockRes();
    let called = false;
    expertsAccessGuard({}, res, () => {
      called = true;
    });
    assert.equal(called, true);
  });
  withEnv(undefined, () => {
    assert.equal(expertsFeatureEnabled(), false);
  });
});

test('direct GET /experts is rejected when the flag is unset', async () => {
  await withEnv(undefined, async () => {
    const app = express();
    app.use('/experts', expertsAccessGuard);
    app.get('/experts', (req, res) => res.json({ leaked: true }));
    app.post('/experts/requests', (req, res) => res.json({ created: true }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const list = await fetch(`http://127.0.0.1:${port}/experts`);
      const listBody = await list.json();
      assert.equal(list.status, 403);
      assert.equal(listBody.code, 'FEATURE_DISABLED');
      const create = await fetch(`http://127.0.0.1:${port}/experts/requests`, {
        method: 'POST',
      });
      const createBody = await create.json();
      assert.equal(create.status, 403);
      assert.equal(createBody.code, 'FEATURE_DISABLED');
      assert.equal(createBody.created, undefined);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
