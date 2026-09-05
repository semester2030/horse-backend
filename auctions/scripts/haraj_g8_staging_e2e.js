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

async function http(base, path, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
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
  return { status: res.status, json, text };
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
  if (login.status !== 200) throw new Error(`auth ${email} ${reg.status}/${login.status}`);
  return pickToken(login.json);
}

async function adminLogin(base) {
  const email = process.env.G8_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@nomas.sa';
  const password = process.env.G8_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'NomasAdmin2026!';
  return http(base, '/admin/v2/auth/login', { method: 'POST', body: { email, password } });
}

function lotBody(title) {
  const start = new Date(Date.now() + 7 * 86400000);
  return {
    channel: 'haraj',
    independent: true,
    species: 'horse',
    title,
    startingPrice: 2100,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 2 * 3600000).toISOString(),
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g8-e2e/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g8-e2e-placeholder',
  };
}

async function main() {
  const base = process.env.G8_STAGING_API || STAGING_API;
  assertStaging(base);
  const results = [];
  const record = (name, pass, extra) => {
    results.push({ name, pass, ...extra });
    console.log(JSON.stringify({ step: name, pass, ...extra }));
  };

  const health = await http(base, '/health');
  record('staging_identity', health.status === 200 && health.json?.storage?.inProduction === false, {
    schema: health.json?.auctions?.schemaVersion,
    inProduction: health.json?.storage?.inProduction,
  });
  const prod = await http(PRODUCTION_API, '/health');
  record('production_read_only', prod.status === 200 && prod.json?.storage?.inProduction === true, {
    schema: prod.json?.auctions?.schemaVersion,
  });
  const prodRoute = await http(PRODUCTION_API, '/auctions/haraj/rooms/00000000-0000-4000-8000-000000000000/start', {
    method: 'POST',
    body: {},
  });
  record('production_g8_absent_or_unauth', prodRoute.status === 401 || prodRoute.status === 404, {
    status: prodRoute.status,
  });

  const stamp = Date.now();
  const sellerTok = await register(base, `g8.seller.${stamp}@nomas.staging`, 'G8-pass!', 'Seller');
  const bidderTok = await register(base, `g8.bidder.${stamp}@nomas.staging`, 'G8-pass!', 'Bidder');
  const opTok = await register(base, `g8.op.${stamp}@nomas.auctioneer.staging`, 'G8-pass!', 'Auctioneer');
  const op2Tok = await register(base, `g8.op2.${stamp}@nomas.auctioneer.staging`, 'G8-pass!', 'Auctioneer2');
  const admin = await adminLogin(base);
  const adminTok = admin.json?.token;
  const opId = (await http(base, '/auth/me', { token: opTok })).json?.user?.id;
  record('auth', Boolean(sellerTok && bidderTok && opTok && op2Tok && adminTok && opId), { opId });

  async function approved(title) {
    const created = await http(base, '/auctions', { method: 'POST', token: sellerTok, body: lotBody(title) });
    const id = created.json?.auction?.id;
    await http(base, `/auctions/${id}/submit-review`, { method: 'POST', token: sellerTok, body: { channel: 'haraj' } });
    await http(base, `/auctions/haraj/review/${id}/accept`, { method: 'POST', token: opTok, body: { reason: 'G8' } });
    return id;
  }
  const lot1 = await approved(`G8 lot1 ${stamp}`);
  const lot2 = await approved(`G8 lot2 ${stamp}`);
  const lot3 = await approved(`G8 lot3 ${stamp}`);
  record('lots_approved', Boolean(lot1 && lot2 && lot3), { lot1, lot2, lot3 });

  const start = new Date(Date.now() + 30 * 3600000);
  const session = await http(base, '/admin/v2/haraj/sessions', {
    method: 'POST',
    token: adminTok,
    body: {
      category: 'horse',
      scheduledStartAt: start.toISOString(),
      scheduledEndAt: new Date(start.getTime() + 4 * 3600000).toISOString(),
      timezone: 'Asia/Riyadh',
    },
  });
  const attach = await http(base, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
    method: 'POST',
    token: adminTok,
    body: { category: 'horse', code: `g8-horse-${stamp}`, nameAr: 'خيل G8', auctioneerUserId: opId },
  });
  const rs = attach.json?.roomSession?.id;
  record('room_assigned', attach.status === 201 && Boolean(rs), { rs });

  for (const id of [lot1, lot2, lot3]) {
    await http(base, `/admin/v2/haraj/room-sessions/${rs}/queue`, {
      method: 'POST',
      token: adminTok,
      body: { auctionId: id },
    });
  }

  const unauth = await http(base, `/auctions/haraj/rooms/${rs}/start`, { method: 'POST', body: {} });
  record('unauth_start', unauth.status === 401, { status: unauth.status });
  const sellerStart = await http(base, `/auctions/haraj/rooms/${rs}/start`, { method: 'POST', token: sellerTok, body: {} });
  record('seller_start_denied', sellerStart.status === 401 || sellerStart.status === 403, { status: sellerStart.status });
  const bidderStart = await http(base, `/auctions/haraj/rooms/${rs}/start`, { method: 'POST', token: bidderTok, body: {} });
  record('bidder_start_denied', bidderStart.status === 401 || bidderStart.status === 403, { status: bidderStart.status });
  const wrong = await http(base, `/auctions/haraj/rooms/${rs}/ready`, { method: 'POST', token: op2Tok, body: {} });
  record('wrong_auctioneer_denied', wrong.status === 403, { status: wrong.status, code: wrong.json?.code });
  const spoof = await http(base, `/auctions/haraj/rooms/${rs}/ready`, {
    method: 'POST',
    token: opTok,
    body: { auctioneerId: 'not-me' },
  });
  record('spoofed_auctioneer_id', spoof.status === 403, { status: spoof.status, code: spoof.json?.code });

  const ready = await http(base, `/auctions/haraj/rooms/${rs}/ready`, { method: 'POST', token: opTok, body: {} });
  record('room_ready', ready.status === 200 && ready.json?.snapshot?.status === 'pre_live', {
    status: ready.status,
    room: ready.json?.snapshot?.status,
  });
  const live = await http(base, `/auctions/haraj/rooms/${rs}/start`, { method: 'POST', token: opTok, body: {} });
  record('room_live', live.status === 200 && live.json?.snapshot?.status === 'live', {
    status: live.status,
  });

  const act1 = await http(base, `/auctions/haraj/rooms/${rs}/lots/${lot1}/activate`, {
    method: 'POST',
    token: opTok,
    body: {},
  });
  record('activate_lot1', act1.status === 200 && act1.json?.snapshot?.activeLotId === lot1, {
    status: act1.status,
    active: act1.json?.snapshot?.activeLotId,
  });

  const [c1, c2] = await Promise.all([
    http(base, `/auctions/haraj/rooms/${rs}/lots/${lot2}/activate`, { method: 'POST', token: opTok, body: {} }),
    http(base, `/auctions/haraj/rooms/${rs}/lots/${lot2}/activate`, { method: 'POST', token: opTok, body: {} }),
  ]);
  record('second_active_rejected_or_same', (c1.status === 409 || c2.status === 409)
    && (act1.json?.snapshot?.activeLotId === lot1), {
    a: c1.status,
    b: c2.status,
    codes: [c1.json?.code, c2.json?.code],
  });

  const replayAct = await http(base, `/auctions/haraj/rooms/${rs}/lots/${lot1}/activate`, {
    method: 'POST',
    token: opTok,
    headers: { 'Idempotency-Key': `g8-act-${stamp}` },
    body: {},
  });
  record('activate_idempotent_same_lot', replayAct.status === 200 && replayAct.json?.snapshot?.activeLotId === lot1, {
    status: replayAct.status,
  });

  const advance = await http(base, `/auctions/haraj/rooms/${rs}/advance`, { method: 'POST', token: opTok, body: {} });
  const afterAdv = await http(base, `/auctions/${lot1}`, { token: sellerTok });
  record('advance_operational_only', advance.status === 200
    && !advance.json?.snapshot?.activeLotId
    && afterAdv.json?.auction?.id === lot1
    && afterAdv.json?.auction?.status === 'review', {
    status: advance.status,
    auctionStatus: afterAdv.json?.auction?.status,
  });

  const act2 = await http(base, `/auctions/haraj/rooms/${rs}/lots/${lot2}/activate`, {
    method: 'POST',
    token: opTok,
    body: {},
  });
  record('activate_lot2', act2.status === 200 && act2.json?.snapshot?.activeLotId === lot2, {
    active: act2.json?.snapshot?.activeLotId,
  });

  const paused = await http(base, `/auctions/haraj/rooms/${rs}/pause`, {
    method: 'POST',
    token: opTok,
    body: { reason: 'G8 pause' },
  });
  record('pause', paused.status === 200 && paused.json?.snapshot?.status === 'paused', {
    status: paused.json?.snapshot?.status,
    timerFrozen: false,
  });

  const reconnect = await http(base, `/auctions/haraj/rooms/${rs}`, { token: bidderTok });
  record('reconnect_snapshot', reconnect.status === 200
    && reconnect.json?.snapshot?.status === 'paused'
    && reconnect.json?.snapshot?.activeLotId === lot2
    && reconnect.json?.reconnect === true, {
    status: reconnect.json?.snapshot?.status,
    version: reconnect.json?.snapshot?.version,
  });

  const resumed = await http(base, `/auctions/haraj/rooms/${rs}/resume`, { method: 'POST', token: opTok, body: {} });
  record('resume', resumed.status === 200 && resumed.json?.snapshot?.status === 'live', {
    status: resumed.json?.snapshot?.status,
  });

  const skip = await http(base, `/auctions/haraj/rooms/${rs}/lots/${lot3}/skip`, {
    method: 'POST',
    token: opTok,
    body: { reason: 'G8 skip policy' },
  });
  const still3 = await http(base, `/auctions/${lot3}`, { token: sellerTok });
  record('skip_keeps_auction', skip.status === 200
    && still3.json?.auction?.id === lot3
    && (skip.json?.snapshot?.entries || []).some((e) => e.auctionId === lot3 && e.status === 'skipped'), {
    status: skip.status,
    auctionId: still3.json?.auction?.id,
  });

  const noComplete = await http(base, `/auctions/haraj/rooms/${rs}/complete`, { method: 'POST', token: opTok, body: {} });
  record('complete_blocked_while_active', noComplete.status === 409, { status: noComplete.status });

  await http(base, `/auctions/haraj/rooms/${rs}/advance`, { method: 'POST', token: opTok, body: {} });
  const done = await http(base, `/auctions/haraj/rooms/${rs}/complete`, { method: 'POST', token: opTok, body: {} });
  record('room_complete', done.status === 200 && done.json?.snapshot?.status === 'closed', {
    status: done.json?.snapshot?.status,
    livekit: done.json?.livekit?.implemented,
  });
  record('livekit_not_faked', done.json?.livekit?.implemented === false && done.json?.livekit?.tested === false, {
    classification: done.json?.livekit?.classification,
  });

  const summary = {
    ok: results.every((r) => r.pass),
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    total: results.length,
    schema: health.json?.auctions?.schemaVersion,
    results,
  };
  require('fs').writeFileSync('/tmp/nomas_g8_staging_e2e.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summary: true, ...summary }, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
