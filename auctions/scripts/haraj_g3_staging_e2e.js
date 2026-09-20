#!/usr/bin/env node
'use strict';

/**
 * G3 Staging E2E — hits horse-backend-staging only.
 * Uses existing POST /auctions + submit-review (Auction = Lot).
 * Refuses Production host.
 */

const STAGING_API = 'https://horse-backend-staging.onrender.com';
const PRODUCTION_API = 'https://horse-backend-i68h.onrender.com';
const STAGING_HOST_NEEDLE = 'horse-backend-staging';
const PRODUCTION_HOST_NEEDLE = 'horse-backend-i68h';

function assertStagingUrl(url) {
  const u = String(url);
  if (u.includes(PRODUCTION_HOST_NEEDLE) || u.includes('onrender.com') && !u.includes(STAGING_HOST_NEEDLE)) {
    if (!u.includes(STAGING_HOST_NEEDLE)) {
      throw new Error(`Refusing non-staging API: ${url}`);
    }
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
    title: `G3 E2E ${Date.now()}`,
    startingPrice: 1200,
    minimumIncrement: 100,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 2 * 3600000).toISOString(),
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g3-e2e/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g3-e2e',
    inspection: { available: true, windows: 'بعد العصر' },
    description: 'G3 staging seller lot — Auction=Lot',
    ...overrides,
  };
}

async function registerOrLogin(base, email, password) {
  const reg = await http(base, '/auth/register', {
    method: 'POST',
        body: {
          email,
          password,
          name: 'G3 Seller',
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

async function main() {
  const base = process.env.G3_STAGING_API || STAGING_API;
  assertStagingUrl(base);

  const results = [];
  const record = (name, pass, extra) => {
    results.push({ name, pass, ...extra });
    console.log(JSON.stringify({ step: name, pass, ...extra }));
  };

  const health = await http(base, '/health');
  record('staging_health', health.status === 200, {
    status: health.status,
    host: base,
  });

  const aucStatus = await http(base, '/auctions/status');
  record('auctions_status', aucStatus.status === 200 && aucStatus.json?.enabled !== false, {
    status: aucStatus.status,
    body: aucStatus.json,
  });

  const noAuth = await http(base, '/auctions', {
    method: 'POST',
    body: payload(),
  });
  record('unauthenticated_create_denied', noAuth.status === 401 || noAuth.status === 403, {
    status: noAuth.status,
    code: noAuth.json?.code,
  });

  const stamp = Date.now();
  const sellerA = await registerOrLogin(
    base,
    `g3.seller.a.${stamp}@nomas.staging`,
    'G3-staging-pass!',
  );
  const sellerB = await registerOrLogin(
    base,
    `g3.seller.b.${stamp}@nomas.staging`,
    'G3-staging-pass!',
  );
  record('auth_seller_a', Boolean(sellerA.token), { created: sellerA.created });
  record('auth_seller_b', Boolean(sellerB.token), { created: sellerB.created });

  const sheep = await http(base, '/auctions', {
    method: 'POST',
    token: sellerA.token,
    body: payload({ species: 'sheep' }),
  });
  record('invalid_species_sheep', sheep.status >= 400, {
    status: sheep.status,
    code: sheep.json?.code,
  });

  const created = await http(base, '/auctions', {
    method: 'POST',
    token: sellerA.token,
    body: payload({ ownerUserId: 'spoof-other-user' }),
  });
  const ownerOk =
    created.status === 201 &&
    created.json?.auction?.id &&
    (!created.json.auction.ownerUserId ||
      created.json.auction.ownerUserId !== 'spoof-other-user');
  record('create_lot_auction_equals_lot', ownerOk, {
    status: created.status,
    auctionId: created.json?.auction?.id,
    ownerUserId: created.json?.auction?.ownerUserId,
    statusLot: created.json?.auction?.status,
    code: created.json?.code,
    message: created.json?.message,
  });

  const auctionId = created.json?.auction?.id;
  if (!auctionId) {
    record('abort_no_auction', false, { created });
    writeSummary(results, { verdictHint: 'C' });
    process.exit(1);
  }

  const bidBefore = await http(base, `/auctions/${auctionId}/bids`);
  const bidCountBefore = Array.isArray(bidBefore.json?.bids)
    ? bidBefore.json.bids.length
    : 0;

  const idorSubmit = await http(base, `/auctions/${auctionId}/submit-review`, {
    method: 'POST',
    token: sellerB.token,
    body: { channel: 'haraj' },
  });
  record('idor_submit_denied', idorSubmit.status === 403, {
    status: idorSubmit.status,
    code: idorSubmit.json?.code,
  });

  const submitted = await http(base, `/auctions/${auctionId}/submit-review`, {
    method: 'POST',
    token: sellerA.token,
    body: { channel: 'haraj', inspection: { available: true } },
  });
  record('submit_review', submitted.status === 200 && submitted.json?.auction?.status === 'review', {
    status: submitted.status,
    lotStatus: submitted.json?.auction?.status,
    sameId: submitted.json?.auction?.id === auctionId,
  });

  const dup = await http(base, `/auctions/${auctionId}/submit-review`, {
    method: 'POST',
    token: sellerA.token,
    body: { channel: 'haraj' },
  });
  record('duplicate_submit_idempotent', dup.status === 200 && dup.json?.auction?.id === auctionId, {
    status: dup.status,
    lotStatus: dup.json?.auction?.status,
  });

  const invalidLife = await http(base, `/auctions/${auctionId}/go-live`, {
    method: 'POST',
    token: sellerA.token,
  });
  record('invalid_lifecycle_rejected', invalidLife.status >= 400, {
    status: invalidLife.status,
    code: invalidLife.json?.code,
  });

  const mine = await http(base, '/auctions/mine', { token: sellerA.token });
  record('get_mine_probe', mine.status === 200 || mine.status === 404, {
    status: mine.status,
    liveImageHasMine: mine.status === 200,
    count: Array.isArray(mine.json?.auctions) ? mine.json.auctions.length : null,
  });

  const bidAfter = await http(base, `/auctions/${auctionId}/bids`);
  const bidCountAfter = Array.isArray(bidAfter.json?.bids)
    ? bidAfter.json.bids.length
    : 0;
  record('bid_history_untouched', bidCountBefore === bidCountAfter, {
    bidCountBefore,
    bidCountAfter,
  });

  const got = await http(base, `/auctions/${auctionId}`);
  record('lot_persisted', got.status === 200 && got.json?.auction?.id === auctionId, {
    status: got.status,
    lotStatus: got.json?.auction?.status,
  });

  let prodHealth;
  try {
    prodHealth = await http(PRODUCTION_API, '/health');
  } catch (e) {
    prodHealth = { status: 0, json: { error: e.message } };
  }
  record('production_health_read_only', prodHealth.status === 200 || prodHealth.status === 0, {
    status: prodHealth.status,
    note: 'No production writes attempted',
  });

  writeSummary(results, { auctionId, staging: base });
  const failed = results.filter((r) => !r.pass);
  process.exit(failed.length ? 1 : 0);
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
  const out = '/tmp/nomas_g3_staging_e2e.json';
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summary: true, file: out, ...summary }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
  process.exit(1);
});
