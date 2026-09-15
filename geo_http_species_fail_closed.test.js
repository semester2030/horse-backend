'use strict';

/**
 * HTTP geo discover/clusters — empty/invalid species fail-closed (not ALL).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { registerGeoDiscoveryRoutes } = require('./geo_discovery/routes');

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {
            json = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('geo_http_species_fail_closed', () => {
  let server;
  let port;

  before(async () => {
    const app = express();
    app.use(express.json());
    const store = {
      services: new Map(),
      servicePlaces: new Map(),
      catalogItems: new Map(),
    };
    registerGeoDiscoveryRoutes(app, {
      store,
      saveStore: () => {},
      id: () => 'x',
      auth: (_r, _s, n) => n(),
      requireSessionUser: (_r, _s, n) => n(),
    });
    ({ server, port } = await listen(app));
  });

  after(async () => {
    await new Promise((r) => server.close(r));
  });

  it('POST /geo/discover without species returns empty places', async () => {
    const res = await postJson(port, '/geo/discover', {
      zoom: 12,
      category: 'boarding',
      bbox: { sw: { lat: 24, lng: 46 }, ne: { lat: 25, lng: 47 } },
      filters: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-gde-species'], 'REQUIRED');
    assert.deepEqual(res.json.places || [], []);
    assert.equal(res.json.totalMatched ?? 0, 0);
  });

  it('POST /geo/discover with invalid species returns empty', async () => {
    const res = await postJson(port, '/geo/discover', {
      zoom: 12,
      category: 'veterinary',
      bbox: { sw: { lat: 24, lng: 46 }, ne: { lat: 25, lng: 47 } },
      filters: { species: ['sheep', 'Horsey'] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-gde-species'], 'REQUIRED');
    assert.deepEqual(res.json.places || [], []);
  });

  it('POST /geo/discover with falcon does not species-required empty-gate', async () => {
    const res = await postJson(port, '/geo/discover', {
      zoom: 12,
      category: 'veterinary',
      bbox: { sw: { lat: 24, lng: 46 }, ne: { lat: 25, lng: 47 } },
      filters: { species: ['falcon'] },
    });
    assert.equal(res.status, 200);
    assert.notEqual(res.headers['x-gde-species'], 'REQUIRED');
    assert.equal(res.json.meta?.reason, undefined);
    // Empty store → clusters/places empty, but not the species-required empty payload.
    assert.ok(res.json.mode === 'places' || res.json.mode === 'clusters');
  });
});
