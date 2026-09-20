#!/usr/bin/env node
'use strict';

/**
 * G3.1 live Staging closure — horse-backend-staging only.
 * Refuses Production host. Does not write Production.
 */

const STAGING_API = 'https://horse-backend-staging.onrender.com';
const PRODUCTION_API = 'https://horse-backend-i68h.onrender.com';
const STAGING_HOST_NEEDLE = 'horse-backend-staging';
const PRODUCTION_HOST_NEEDLE = 'horse-backend-i68h';

function assertStagingUrl(url) {
  const u = String(url);
  if (u.includes(PRODUCTION_HOST_NEEDLE)) {
    throw new Error(`Refusing Production API: ${url}`);
  }
  if (!u.includes(STAGING_HOST_NEEDLE)) {
    throw new Error(`STAGING ONLY: ${url}`);
  }
}

async function http(base, path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text };
}

function payload(overrides = {}) {
  const start = new Date(Date.now() + 7 * 86400000);
  return {
    channel: 'haraj',
    independent: true,
    species: 'horse',
    title: `G31 E2E ${Date.now()}`,
    startingPrice: 1200,
    minimumIncrement: 100,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 2 * 3600000).toISOString(),
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g31-e2e/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g31-e2e-placeholder',
    inspection: { available: true, windows: 'بعد العصر' },
    description: 'G3.1 staging seller lot — Auction=Lot — placeholder media (no CF delete)',
    ...overrides,
  };
}

function pickToken(json) {
  return (
    json?.idToken ||
    json?.token ||
    json?.accessToken ||
    json?.access_token ||
    json?.authToken ||
    json?.data?.token ||
    null
  );
}

async function registerOrLogin(base, email, password) {
  const reg = await http(base, '/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      name: 'G31 Seller',
      accountRole: 'heritage_advertiser',
    },
  });
  if (reg.status === 201 || reg.status === 200) {
    return { token: pickToken(reg.json), user: reg.json, created: true };
  }
  const login = await http(base, '/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (login.status !== 200) {
    throw new Error(`auth failed ${reg.status}/${login.status}: ${JSON.stringify(login.json)}`);
  }
  return { token: pickToken(login.json), user: login.json, created: false };
}

async function main() {
  const base = process.env.G31_STAGING_API || STAGING_API;
  assertStagingUrl(base);

  const results = [];
  const record = (name, pass, extra) => {
    results.push({ name, pass, ...extra });
    console.log(JSON.stringify({ step: name, pass, ...extra }));
  };

  const health = await http(base, '/health');
  record(
    'staging_identity',
    health.status === 200 && health.json?.storage?.inProduction === false,
    {
      status: health.status,
      inProduction: health.json?.storage?.inProduction,
      schemaVersion: health.json?.auctions?.schemaVersion,
    },
  );

  const prodHealth = await http(PRODUCTION_API, '/health');
  record('production_read_only_identity', prodHealth.status === 200, {
    status: prodHealth.status,
    inProduction: prodHealth.json?.storage?.inProduction,
    schemaVersion: prodHealth.json?.auctions?.schemaVersion,
    note: 'GET /health only — no Production writes',
  });

  const unauthCreate = await http(base, '/auctions', { method: 'POST', body: payload() });
  record('unauthenticated_create', unauthCreate.status === 401, { status: unauthCreate.status });

  const unauthMine = await http(base, '/auctions/mine');
  record('unauthenticated_mine', unauthMine.status === 401 || unauthMine.status === 403, {
    status: unauthMine.status,
    uuidMineError: String(unauthMine.text || '').includes('invalid input syntax for type uuid'),
  });

  const stamp = Date.now();
  const sellerA = await registerOrLogin(base, `g31.seller.a.${stamp}@nomas.staging`, 'G31-staging-pass!');
  const sellerB = await registerOrLogin(base, `g31.seller.b.${stamp}@nomas.staging`, 'G31-staging-pass!');
  record('auth_seller_a', Boolean(sellerA.token), {});
  record('auth_seller_b', Boolean(sellerB.token), {});

  const spoof = await http(base, '/auctions', {
    method: 'POST',
    token: sellerA.token,
    body: payload({ ownerUserId: 'spoof-other-user', sellerId: 'spoof-other-user' }),
  });
  record('client_owner_spoof_rejected', spoof.status === 403 && spoof.json?.code === 'AUCTION_OWNER_FORBIDDEN', {
    status: spoof.status,
    code: spoof.json?.code,
  });

  const created = await http(base, '/auctions', {
    method: 'POST',
    token: sellerA.token,
    body: payload(),
  });
  const auctionId = created.json?.auction?.id;
  record(
    'create_lot_auction_equals_lot',
    created.status === 201 && Boolean(auctionId) && created.json?.auction?.status === 'draft',
    {
      status: created.status,
      auctionId,
      statusLot: created.json?.auction?.status,
      ownerUserId: created.json?.auction?.ownerUserId,
    },
  );

  if (!auctionId) {
    writeSummary(results, { verdictHint: 'C', reason: 'create failed' });
    process.exit(1);
  }

  const idor = await http(base, `/auctions/${auctionId}/submit-review`, {
    method: 'POST',
    token: sellerB.token,
    body: { channel: 'haraj' },
  });
  record('seller_b_submit_seller_a', idor.status === 403, {
    status: idor.status,
    code: idor.json?.code,
    expected: 403,
  });

  const own = await http(base, `/auctions/${auctionId}/submit-review`, {
    method: 'POST',
    token: sellerA.token,
    body: { channel: 'haraj', inspection: { available: true } },
  });
  record(
    'seller_a_own_submit',
    own.status === 200 && own.json?.auction?.status === 'review' && own.json?.auction?.id === auctionId,
    {
      status: own.status,
      statusLot: own.json?.auction?.status,
      sameId: own.json?.auction?.id === auctionId,
    },
  );

  const dup = await http(base, `/auctions/${auctionId}/submit-review`, {
    method: 'POST',
    token: sellerA.token,
    body: { channel: 'haraj' },
  });
  record('duplicate_submit_same_lot', dup.status === 200 && dup.json?.auction?.id === auctionId, {
    status: dup.status,
    sameId: dup.json?.auction?.id === auctionId,
  });

  const mineA = await http(base, '/auctions/mine', { token: sellerA.token });
  const listA = Array.isArray(mineA.json?.auctions) ? mineA.json.auctions : [];
  const aHasOwn = listA.some((row) => row.id === auctionId || row.auctionId === auctionId);
  record('mine_seller_a', mineA.status === 200 && aHasOwn, {
    status: mineA.status,
    count: listA.length,
    hasOwnLot: aHasOwn,
    uuidMineError: String(mineA.text || '').includes('invalid input syntax for type uuid'),
  });

  const mineB = await http(base, '/auctions/mine', { token: sellerB.token });
  const listB = Array.isArray(mineB.json?.auctions) ? mineB.json.auctions : [];
  const bLeaked = listB.some((row) => row.id === auctionId || row.auctionId === auctionId);
  record('mine_seller_b_isolated', mineB.status === 200 && !bLeaked, {
    status: mineB.status,
    count: listB.length,
    leakedSellerA: bLeaked,
    uuidMineError: String(mineB.text || '').includes('invalid input syntax for type uuid'),
  });

  const bids = await http(base, `/auctions/${auctionId}/bids`);
  const bidCount = Array.isArray(bids.json?.bids) ? bids.json.bids.length : 0;
  record('no_second_bid_engine', bidCount === 0, { bidCount });

  writeSummary(results, {
    auctionId,
    staging: base,
    productionWrites: false,
  });
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

function writeSummary(results, extra) {
  const summary = {
    ok: results.every((r) => r.pass),
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    total: results.length,
    results,
    ...extra,
  };
  const fs = require('fs');
  const out = '/tmp/nomas_g31_staging_e2e.json';
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summary: true, file: out, ...summary }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
  process.exit(1);
});
