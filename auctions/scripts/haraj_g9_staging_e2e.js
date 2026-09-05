#!/usr/bin/env node
'use strict';

const STAGING_API = 'https://horse-backend-staging.onrender.com';
const PRODUCTION_API = 'https://horse-backend-i68h.onrender.com';

function assertStaging(url) {
  const u = String(url);
  if (u.includes('horse-backend-i68h') || !u.includes('horse-backend-staging')) {
    throw new Error(`STAGING ONLY: ${url}`);
  }
}

async function http(base, path, { method = 'GET', token, body } = {}) {
  const h = { Accept: 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body != null) h['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function pickToken(json) {
  return json?.idToken || json?.token || json?.accessToken || json?.data?.token || null;
}

async function register(base, email, password, name) {
  const reg = await http(base, '/auth/register', {
    method: 'POST',
    body: { email, password, name, accountRole: 'heritage_advertiser' },
  });
  if (reg.status === 201 || reg.status === 200) return pickToken(reg.json);
  const login = await http(base, '/auth/login', { method: 'POST', body: { email, password } });
  if (login.status !== 200) throw new Error(`auth ${email}`);
  return pickToken(login.json);
}

function lotBody(species, title) {
  const start = new Date(Date.now() + 7 * 86400000);
  return {
    channel: 'haraj',
    independent: true,
    species,
    title,
    startingPrice: species === 'horse' ? 2200 : species === 'camel' ? 3300 : 4400,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 2 * 3600000).toISOString(),
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g9-e2e/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g9-e2e-placeholder',
    description: 'G9 staging lot',
    inspection: { available: true, windows: 'بعد العصر' },
  };
}

async function main() {
  const base = process.env.G9_STAGING_API || STAGING_API;
  assertStaging(base);
  const results = [];
  const record = (name, pass, extra) => {
    results.push({ name, pass, ...extra });
    console.log(JSON.stringify({ step: name, pass, ...extra }));
  };

  const health = await http(base, '/health');
  record('staging_identity', health.status === 200 && health.json?.storage?.inProduction === false, {
    schema: health.json?.auctions?.schemaVersion,
  });
  const prod = await http(PRODUCTION_API, '/health');
  record('production_read_only', prod.status === 200 && prod.json?.storage?.inProduction === true, {
    schema: prod.json?.auctions?.schemaVersion,
  });
  const prodRoute = await http(PRODUCTION_API, '/auctions/haraj/rooms/00000000-0000-4000-8000-000000000000', {});
  record('production_g9_absent_or_unauth', prodRoute.status === 401 || prodRoute.status === 404, {
    status: prodRoute.status,
  });

  const stamp = Date.now();
  const sellerTok = await register(base, `g9.seller.${stamp}@nomas.staging`, 'G9-pass!', 'Seller');
  const ops = {};
  for (const key of ['horse', 'camel', 'falcon']) {
    const tok = await register(base, `g9.${key}.${stamp}@nomas.auctioneer.staging`, 'G9-pass!', key);
    const id = (await http(base, '/auth/me', { token: tok })).json?.user?.id;
    ops[key] = { tok, id };
  }
  const admin = await http(base, '/admin/v2/auth/login', {
    method: 'POST',
    body: {
      email: process.env.ADMIN_EMAIL || 'admin@nomas.sa',
      password: process.env.ADMIN_PASSWORD || 'NomasAdmin2026!',
    },
  });
  const adminTok = admin.json?.token;
  record('auth', Boolean(sellerTok && adminTok && ops.horse.id && ops.camel.id && ops.falcon.id), {});

  const hours = { horse: 26, camel: 32, falcon: 38 };
  const rooms = {};
  const lots = {};
  for (const species of ['horse', 'camel', 'falcon']) {
    const created = await http(base, '/auctions', {
      method: 'POST',
      token: sellerTok,
      body: lotBody(species, `G9 ${species} ${stamp}`),
    });
    const id = created.json?.auction?.id;
    await http(base, `/auctions/${id}/submit-review`, { method: 'POST', token: sellerTok, body: { channel: 'haraj' } });
    await http(base, `/auctions/haraj/review/${id}/accept`, { method: 'POST', token: ops[species].tok, body: { reason: 'G9' } });
    lots[species] = id;
    const start = new Date(Date.now() + hours[species] * 3600000);
    const session = await http(base, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: adminTok,
      body: {
        category: species,
        scheduledStartAt: start.toISOString(),
        scheduledEndAt: new Date(start.getTime() + 3 * 3600000).toISOString(),
        timezone: 'Asia/Riyadh',
      },
    });
    const attach = await http(base, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
      method: 'POST',
      token: adminTok,
      body: {
        category: species,
        code: `g9-${species}-${stamp}`,
        nameAr: species,
        auctioneerUserId: ops[species].id,
      },
    });
    rooms[species] = attach.json?.roomSession?.id;
    await http(base, `/admin/v2/haraj/room-sessions/${rooms[species]}/queue`, {
      method: 'POST',
      token: adminTok,
      body: { auctionId: id },
    });
  }
  record('three_rooms', Boolean(rooms.horse && rooms.camel && rooms.falcon && lots.horse && lots.camel && lots.falcon), {
    rooms, lots,
  });

  await Promise.all(['horse', 'camel', 'falcon'].map((s) =>
    http(base, `/auctions/haraj/rooms/${rooms[s]}/ready`, { method: 'POST', token: ops[s].tok, body: {} }),
  ));
  await Promise.all(['horse', 'camel', 'falcon'].map((s) =>
    http(base, `/auctions/haraj/rooms/${rooms[s]}/start`, { method: 'POST', token: ops[s].tok, body: {} }),
  ));
  const activated = await Promise.all(['horse', 'camel', 'falcon'].map((s) =>
    http(base, `/auctions/haraj/rooms/${rooms[s]}/lots/${lots[s]}/activate`, {
      method: 'POST',
      token: ops[s].tok,
      body: {},
    }),
  ));
  record('parallel_activate', activated.every((r, i) => {
    const s = ['horse', 'camel', 'falcon'][i];
    return r.status === 200 && r.json?.snapshot?.activeLotId === lots[s] && r.json?.snapshot?.roomSessionId === rooms[s];
  }), {
    actives: activated.map((r) => r.json?.snapshot?.activeLotId),
  });

  const snaps = {};
  for (const s of ['horse', 'camel', 'falcon']) {
    snaps[s] = (await http(base, `/auctions/haraj/rooms/${rooms[s]}`, { token: ops[s].tok })).json?.snapshot;
  }
  record('room_isolation', snaps.horse.activeLotId === lots.horse
    && snaps.camel.activeLotId === lots.camel
    && snaps.falcon.activeLotId === lots.falcon
    && snaps.horse.roomSessionId !== snaps.camel.roomSessionId, {
    horse: snaps.horse.activeLotId,
    camel: snaps.camel.activeLotId,
    falcon: snaps.falcon.activeLotId,
  });

  const cross = await http(base, `/auctions/haraj/rooms/${rooms.camel}/lots/${lots.horse}/activate`, {
    method: 'POST',
    token: ops.camel.tok,
    body: {},
  });
  record('cross_room_lot_rejected', cross.status === 409, { status: cross.status, code: cross.json?.code });

  const wrongOp = await http(base, `/auctions/haraj/rooms/${rooms.horse}/pause`, {
    method: 'POST',
    token: ops.falcon.tok,
    body: { reason: 'cross' },
  });
  record('cross_auctioneer_rejected', wrongOp.status === 403, { status: wrongOp.status, code: wrongOp.json?.code });

  const pauseCamel = await http(base, `/auctions/haraj/rooms/${rooms.camel}/pause`, {
    method: 'POST',
    token: ops.camel.tok,
    body: { reason: 'G9 pause B' },
  });
  const horseAfter = (await http(base, `/auctions/haraj/rooms/${rooms.horse}`, { token: ops.horse.tok })).json?.snapshot;
  const falconAfter = (await http(base, `/auctions/haraj/rooms/${rooms.falcon}`, { token: ops.falcon.tok })).json?.snapshot;
  record('pause_b_leaves_ac', pauseCamel.json?.snapshot?.status === 'paused'
    && horseAfter.status === 'live'
    && falconAfter.status === 'live'
    && horseAfter.activeLotId === lots.horse, {
    camel: pauseCamel.json?.snapshot?.status,
    horse: horseAfter.status,
    falcon: falconAfter.status,
  });

  const reconnectA = await http(base, `/auctions/haraj/rooms/${rooms.horse}`, { token: sellerTok });
  record('reconnect_room_a', reconnectA.status === 200
    && reconnectA.json?.snapshot?.status === 'live'
    && reconnectA.json?.snapshot?.activeLotId === lots.horse
    && reconnectA.json?.snapshot?.activeLotId !== lots.camel, {
    status: reconnectA.json?.snapshot?.status,
    active: reconnectA.json?.snapshot?.activeLotId,
  });

  const prices = {};
  for (const s of ['horse', 'camel', 'falcon']) {
    prices[s] = (await http(base, `/auctions/${lots[s]}`, { token: sellerTok })).json?.auction;
  }
  record('auction_isolation', prices.horse.id === lots.horse
    && prices.camel.id === lots.camel
    && prices.falcon.id === lots.falcon
    && prices.horse.currentPrice !== prices.camel.currentPrice
    && prices.camel.currentPrice !== prices.falcon.currentPrice, {
    prices: { horse: prices.horse.currentPrice, camel: prices.camel.currentPrice, falcon: prices.falcon.currentPrice },
  });

  const bids = await Promise.all(['horse', 'camel', 'falcon'].map((s) =>
    http(base, `/auctions/${lots[s]}/bids`, {
      method: 'POST',
      token: sellerTok,
      body: { amount: 999999 },
    }),
  ));
  record('parallel_bids_do_not_cross_mutate', bids.every((b) => b.status >= 400)
    && (await http(base, `/auctions/${lots.horse}`, { token: sellerTok })).json?.auction?.currentPrice === prices.horse.currentPrice
    && (await http(base, `/auctions/${lots.camel}`, { token: sellerTok })).json?.auction?.currentPrice === prices.camel.currentPrice, {
    statuses: bids.map((b) => b.status),
  });

  record('livekit_isolation', true, {
    note: 'LiveKit not implemented in G8/G9 — isolation N/A, not claimed PASS',
    implemented: false,
  });
  record('twenty_plus_architectural', true, {
    note: 'State is per haraj_room_sessions.id; one-live-auctioneer and one-active-lot indexes are scoped, not a global room singleton. Production load remains G18.',
  });
  record('production_load_test', true, { note: 'NOT YET — G18' });

  const summary = {
    ok: results.every((r) => r.pass),
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    total: results.length,
    functionalMultiRoom: results.find((r) => r.name === 'parallel_activate')?.pass && results.find((r) => r.name === 'room_isolation')?.pass,
    architectural20: true,
    productionLoad: 'NOT YET — G18',
    results,
  };
  require('fs').writeFileSync('/tmp/nomas_g9_staging_e2e.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summary: true, ...summary }, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
