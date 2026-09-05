#!/usr/bin/env node
'use strict';

const fs = require('fs');
const STAGING_API = 'https://horse-backend-staging.onrender.com';
const PRODUCTION_API = 'https://horse-backend-i68h.onrender.com';
const RACE_ITERATIONS = Number(process.env.G10_RACE_ITERATIONS || 50);

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
  const email = process.env.G10_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@nomas.sa';
  const password = process.env.G10_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'NomasAdmin2026!';
  return http(base, '/admin/v2/auth/login', { method: 'POST', body: { email, password } });
}

function lotBody(species, title, { startOffsetMs = -120000, durationMs = 2 * 3600000 } = {}) {
  const start = new Date(Date.now() + startOffsetMs);
  return {
    channel: 'haraj',
    independent: true,
    species,
    title,
    startingPrice: 1000,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + durationMs).toISOString(),
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g10-e2e/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g10-e2e-placeholder',
    description: 'G10 staging lot',
    inspection: { available: true, windows: 'بعد العصر' },
  };
}

async function main() {
  const base = process.env.G10_STAGING_API || STAGING_API;
  assertStaging(base);
  const results = [];
  const record = (name, pass, extra) => {
    results.push({ name, pass: Boolean(pass), ...extra });
    console.log(JSON.stringify({ step: name, pass: Boolean(pass), ...extra }));
  };

  const health = await http(base, '/health');
  record('staging_identity', health.status === 200 && health.json?.storage?.inProduction === false, {
    schema: health.json?.auctions?.schemaVersion,
    inProduction: health.json?.storage?.inProduction,
  });
  const prod = await http(PRODUCTION_API, '/health');
  record('production_read_only', prod.status === 200 && prod.json?.storage?.inProduction === true, {
    schema: prod.json?.auctions?.schemaVersion,
    commitHint: prod.json?.gitSha || prod.json?.commit || null,
  });
  record('production_schema_unchanged_008', prod.json?.auctions?.schemaVersion === '008_auction_media_independence', {
    schema: prod.json?.auctions?.schemaVersion,
  });

  const stamp = Date.now();
  const sellerTok = await register(base, `g10.seller.${stamp}@nomas.staging`, 'G10-pass!', 'Seller');
  const xTok = await register(base, `g10.x.${stamp}@nomas.staging`, 'G10-pass!', 'BidderX');
  const yTok = await register(base, `g10.y.${stamp}@nomas.staging`, 'G10-pass!', 'BidderY');
  const pTok = await register(base, `g10.p.${stamp}@nomas.staging`, 'G10-pass!', 'BidderP');
  const ineligTok = await register(base, `g10.inelig.${stamp}@nomas.staging`, 'G10-pass!', 'Ineligible');
  const opHorseTok = await register(base, `g10.op.h.${stamp}@nomas.auctioneer.staging`, 'G10-pass!', 'OpH');
  const opCamelTok = await register(base, `g10.op.c.${stamp}@nomas.auctioneer.staging`, 'G10-pass!', 'OpC');
  const opFalconTok = await register(base, `g10.op.f.${stamp}@nomas.auctioneer.staging`, 'G10-pass!', 'OpF');
  const admin = await adminLogin(base);
  const adminTok = admin.json?.token;
  const sellerId = (await http(base, '/auth/me', { token: sellerTok })).json?.user?.id;
  const xId = (await http(base, '/auth/me', { token: xTok })).json?.user?.id;
  const yId = (await http(base, '/auth/me', { token: yTok })).json?.user?.id;
  const pId = (await http(base, '/auth/me', { token: pTok })).json?.user?.id;
  const ops = {
    horse: { tok: opHorseTok, id: (await http(base, '/auth/me', { token: opHorseTok })).json?.user?.id },
    camel: { tok: opCamelTok, id: (await http(base, '/auth/me', { token: opCamelTok })).json?.user?.id },
    falcon: { tok: opFalconTok, id: (await http(base, '/auth/me', { token: opFalconTok })).json?.user?.id },
  };
  record('auth', Boolean(sellerTok && xTok && yTok && pTok && adminTok && sellerId && xId && yId && pId
    && ops.horse.id && ops.camel.id && ops.falcon.id), {
    sellerId, xId, yId, pId, ops: { horse: ops.horse.id, camel: ops.camel.id, falcon: ops.falcon.id },
  });
  if (!adminTok) {
    writeSummary(results, { blocked: 'ADMIN_LOGIN' });
    process.exit(1);
  }

  async function authorize(userId, bidLimit, expiresAt, key) {
    const profile = await http(base, `/admin/v2/haraj/bidders/${userId}`, {
      method: 'PUT',
      token: adminTok,
      body: { eligibilityStatus: 'verified', bidLimit },
    });
    const security = await http(base, `/admin/v2/haraj/bidders/${userId}/security`, {
      method: 'POST',
      token: adminTok,
      headers: { 'Idempotency-Key': key || `g10-sec-${userId}-${bidLimit}` },
      body: { authorizedLimit: bidLimit, expiresAt, idempotencyKey: key || `g10-sec-${userId}-${bidLimit}` },
    });
    return { profile, security };
  }

  const ax = await authorize(xId, 100000);
  const ay = await authorize(yId, 200000);
  const ap = await authorize(pId, 200000);
  record('admin_authorize_bidders', ax.profile.status === 200 && ax.security.status === 201
    && ay.security.status === 201 && ap.security.status === 201, {
    x: ax.profile.status,
    securityLabel: ax.security.json?.provider?.label,
    realMoney: ax.security.json?.realMoney,
  });

  const start = new Date(Date.now() + 20 * 3600000);
  async function makeRoom(category, code, nameAr) {
    const session = await http(base, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: adminTok,
      body: {
        category,
        scheduledStartAt: start.toISOString(),
        scheduledEndAt: new Date(start.getTime() + 4 * 3600000).toISOString(),
        timezone: 'Asia/Riyadh',
      },
    });
    const attach = await http(base, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
      method: 'POST',
      token: adminTok,
      body: { category, code, nameAr, auctioneerUserId: ops[category].id },
    });
    return attach.json?.roomSession?.id;
  }
  const rooms = {
    horse: await makeRoom('horse', `g10-horse-${stamp}`, 'خيل G10'),
    camel: await makeRoom('camel', `g10-camel-${stamp}`, 'إبل G10'),
    falcon: await makeRoom('falcon', `g10-falcon-${stamp}`, 'صقور G10'),
  };
  record('rooms', Boolean(rooms.horse && rooms.camel && rooms.falcon), rooms);

  async function liveLot(species, title, opts) {
    const created = await http(base, '/auctions', {
      method: 'POST',
      token: sellerTok,
      body: lotBody(species, title, opts),
    });
    const id = created.json?.auction?.id;
    if (!id) return { id: null, created };
    await http(base, `/auctions/${id}/submit-review`, {
      method: 'POST',
      token: sellerTok,
      body: { channel: 'haraj' },
    });
    const accept = await http(base, `/auctions/haraj/review/${id}/accept`, {
      method: 'POST',
      token: ops[species].tok,
      body: { reason: 'G10' },
    });
    const assign = await http(base, `/admin/v2/haraj/room-sessions/${rooms[species]}/queue`, {
      method: 'POST',
      token: adminTok,
      body: { auctionId: id },
    });
    const scheduled = await http(base, `/auctions/${id}/schedule`, { method: 'POST', token: sellerTok, body: {} });
    const live = await http(base, `/auctions/${id}/go-live`, { method: 'POST', token: sellerTok, body: {} });
    return { id, created, accept, assign, scheduled, live };
  }

  async function bid(token, auctionId, amount, key) {
    return http(base, `/auctions/${auctionId}/bids`, {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': key },
      body: { amount, idempotencyKey: key },
    });
  }

  async function exposure(token) {
    const me = await http(base, '/auctions/haraj/me/eligibility', { token });
    return me.json?.eligibility?.activeExposure;
  }

  async function cancelLot(id) {
    return http(base, `/admin/v2/auctions/${id}/cancel`, {
      method: 'POST',
      token: adminTok,
      body: { reason: 'g10-e2e-cleanup' },
    });
  }

  const horseLive = await liveLot('horse', `G10 horse ${stamp}`);
  const camelLive = await liveLot('camel', `G10 camel ${stamp}`);
  const falconLive = await liveLot('falcon', `G10 falcon ${stamp}`);
  record('lots_live', horseLive.live?.status === 200 && camelLive.live?.status === 200 && falconLive.live?.status === 200
    && horseLive.live.json?.auction?.status === 'live', {
    horse: horseLive.live?.status,
    camel: camelLive.live?.status,
    falcon: falconLive.live?.status,
    horseStatus: horseLive.live?.json?.auction?.status,
    schedule: horseLive.scheduled?.status,
    assign: horseLive.assign?.status,
  });
  if (horseLive.live?.status !== 200) {
    writeSummary(results, { blocked: 'GO_LIVE', detail: horseLive.live?.json || horseLive.scheduled?.json });
    process.exit(1);
  }

  for (const species of ['horse', 'camel', 'falcon']) {
    await http(base, `/auctions/haraj/rooms/${rooms[species]}/ready`, { method: 'POST', token: ops[species].tok, body: {} });
    await http(base, `/auctions/haraj/rooms/${rooms[species]}/start`, { method: 'POST', token: ops[species].tok, body: {} });
  }
  const actH = await http(base, `/auctions/haraj/rooms/${rooms.horse}/lots/${horseLive.id}/activate`, {
    method: 'POST', token: ops.horse.tok, body: {},
  });
  const actC = await http(base, `/auctions/haraj/rooms/${rooms.camel}/lots/${camelLive.id}/activate`, {
    method: 'POST', token: ops.camel.tok, body: {},
  });
  const actF = await http(base, `/auctions/haraj/rooms/${rooms.falcon}/lots/${falconLive.id}/activate`, {
    method: 'POST', token: ops.falcon.tok, body: {},
  });
  record('rooms_activated', actH.status === 200 && actC.status === 200 && actF.status === 200, {
    horse: actH.status, camel: actC.status, falcon: actF.status,
  });

  const inelig = await bid(ineligTok, horseLive.id, 50000, `inelig-${stamp}`);
  record('ineligible_rejected', inelig.status === 403 && inelig.json?.code === 'HARAJ_BIDDER_NOT_VERIFIED', {
    status: inelig.status, code: inelig.json?.code,
  });

  const pending = await http(base, `/admin/v2/haraj/bidders/${xId}`, {
    method: 'PUT', token: adminTok, body: { eligibilityStatus: 'pending', bidLimit: 100000 },
  });
  const pendingBid = await bid(xTok, horseLive.id, 50000, `pending-${stamp}`);
  await http(base, `/admin/v2/haraj/bidders/${xId}`, {
    method: 'PUT', token: adminTok, body: { eligibilityStatus: 'verified', bidLimit: 100000 },
  });
  record('pending_rejected', pending.status === 200 && pendingBid.status === 403 && pendingBid.json?.code === 'HARAJ_BIDDER_PENDING', {
    status: pendingBid.status, code: pendingBid.json?.code,
  });

  const spoof = await http(base, `/auctions/${horseLive.id}/bids`, {
    method: 'POST',
    token: xTok,
    headers: { 'Idempotency-Key': `spoof-${stamp}` },
    body: { amount: 50000, bidLimit: 999999, bidderUserId: sellerId },
  });
  record('client_authority_forbidden', spoof.status === 403 && spoof.json?.code === 'HARAJ_CLIENT_AUTHORITY_FORBIDDEN', {
    status: spoof.status, code: spoof.json?.code,
  });

  await authorize(sellerId, 200000, null, `seller-sec-${stamp}`);
  const selfBid = await bid(sellerTok, horseLive.id, 50000, `self-${stamp}`);
  record('seller_self_bid', selfBid.status === 403 && selfBid.json?.code === 'BID_OWNER_FORBIDDEN', {
    status: selfBid.status, code: selfBid.json?.code,
  });

  const overflow = await bid(xTok, horseLive.id, 120000, `overflow-${stamp}`);
  record('limit_overflow', overflow.status === 409 && overflow.json?.code === 'HARAJ_EXPOSURE_LIMIT', {
    status: overflow.status, code: overflow.json?.code,
  });

  let bypasses = 0;
  let bothSucceeded = 0;
  let oneSucceeded = 0;
  let neither = 0;
  for (let i = 0; i < RACE_ITERATIONS; i += 1) {
    const a = await liveLot('horse', `G10 race H ${stamp}-${i}`);
    const b = await liveLot('camel', `G10 race C ${stamp}-${i}`);
    if (a.live?.status !== 200 || b.live?.status !== 200) {
      record(`race_setup_${i}`, false, { a: a.live?.status, b: b.live?.status, aErr: a.live?.json, bErr: b.live?.json });
      break;
    }
    const [ra, rb] = await Promise.all([
      bid(xTok, a.id, 70000, `race-a-${stamp}-${i}`),
      bid(xTok, b.id, 70000, `race-b-${stamp}-${i}`),
    ]);
    const okA = ra.status === 201;
    const okB = rb.status === 201;
    if (okA && okB) {
      bothSucceeded += 1;
      bypasses += 1;
    } else if (okA || okB) oneSucceeded += 1;
    else neither += 1;
    const exp = await exposure(xTok);
    if (Number(exp) > 100000) bypasses += 1;
    await cancelLot(a.id);
    await cancelLot(b.id);
    if (i === 0) {
      record('race_first_iteration', !(okA && okB) && Number(exp) <= 100000, {
        statusA: ra.status, statusB: rb.status, codes: [ra.json?.code, rb.json?.code], exposure: exp,
      });
    }
  }
  record('financial_race', bypasses === 0 && bothSucceeded === 0 && oneSucceeded > 0, {
    iterations: RACE_ITERATIONS,
    bothSucceeded,
    oneSucceeded,
    neither,
    bypasses,
  });

  const [pHorse, pCamel] = await Promise.all([
    bid(pTok, horseLive.id, 50000, `par-h-${stamp}`),
    bid(pTok, camelLive.id, 60000, `par-c-${stamp}`),
  ]);
  const horseAfter = await http(base, `/auctions/${horseLive.id}`, { token: sellerTok });
  const camelAfter = await http(base, `/auctions/${camelLive.id}`, { token: sellerTok });
  const pExp = await exposure(pTok);
  record('positive_parallel', pHorse.status === 201 && pCamel.status === 201
    && horseAfter.json?.auction?.currentPrice === 50000
    && camelAfter.json?.auction?.currentPrice === 60000
    && Number(pExp) === 110000, {
    horse: pHorse.status,
    camel: pCamel.status,
    horsePrice: horseAfter.json?.auction?.currentPrice,
    camelPrice: camelAfter.json?.auction?.currentPrice,
    aggregate: pExp,
  });

  const falconBid = await bid(yTok, falconLive.id, 15000, `falcon-${stamp}`);
  const falconAfter = await http(base, `/auctions/${falconLive.id}`, { token: sellerTok });
  record('falcon_isolation', falconBid.status === 201
    && falconAfter.json?.auction?.currentPrice === 15000
    && horseAfter.json?.auction?.currentPrice === 50000, {
    falcon: falconBid.status,
    falconPrice: falconAfter.json?.auction?.currentPrice,
  });

  const outbidLot = await liveLot('horse', `G10 outbid ${stamp}`);
  const aHigh = await bid(xTok, outbidLot.id, 20000, `out-a-${stamp}`);
  const expA1 = await exposure(xTok);
  const bHigh = await bid(yTok, outbidLot.id, 25000, `out-b-${stamp}`);
  const expA2 = await exposure(xTok);
  const expB2 = await exposure(yTok);
  record('outbid_exposure', aHigh.status === 201 && bHigh.status === 201
    && Number(expA1) >= 20000 && Number(expA2) === 0 && Number(expB2) === 25000, {
    a: aHigh.status, b: bHigh.status, expA1, expA2, expB2,
  });

  const raise = await bid(yTok, outbidLot.id, 40000, `raise-${stamp}`);
  const expB3 = await exposure(yTok);
  record('same_auction_increase', raise.status === 201 && Number(expB3) === 40000, {
    status: raise.status, exposure: expB3,
  });

  const replayKey = `idem-${stamp}`;
  const first = await bid(yTok, falconLive.id, 20000, replayKey);
  const replay2 = await Promise.all([bid(yTok, falconLive.id, 20000, replayKey), bid(yTok, falconLive.id, 20000, replayKey)]);
  const replay10 = [];
  for (let i = 0; i < 10; i += 1) replay10.push(bid(yTok, falconLive.id, 20000, replayKey));
  const replay10r = await Promise.all(replay10);
  const bidIds = [first, ...replay2, ...replay10r]
    .map((r) => r.json?.bid?.id)
    .filter(Boolean);
  const uniqueBidIds = new Set(bidIds);
  record('idempotency', (first.status === 201 || first.status === 200)
    && replay2.every((r) => r.status === 200 || r.status === 201)
    && replay10r.every((r) => r.status === 200 || r.status === 201)
    && uniqueBidIds.size === 1, {
    first: first.status,
    uniqueBidIds: uniqueBidIds.size,
    replay2: replay2.map((r) => r.status),
  });

  const low = await bid(pTok, horseLive.id, 1001, `atomic-${stamp}`);
  const pExp2 = await exposure(pTok);
  record('atomicity_rejected_increment', low.status >= 400 && Number(pExp2) === Number(pExp), {
    status: low.status, code: low.json?.code, exposure: pExp2,
  });

  const expireAt = new Date(Date.now() + 2500).toISOString();
  const expUser = await register(base, `g10.exp.${stamp}@nomas.staging`, 'G10-pass!', 'Expire');
  const expId = (await http(base, '/auth/me', { token: expUser })).json?.user?.id;
  await authorize(expId, 100000, expireAt, `exp-sec-${stamp}`);
  await new Promise((r) => setTimeout(r, 3000));
  const expiredBid = await bid(expUser, horseLive.id, 20000, `expired-${stamp}`);
  record('security_expiration', expiredBid.status === 403 && expiredBid.json?.code === 'HARAJ_BID_SECURITY_EXPIRED', {
    status: expiredBid.status, code: expiredBid.json?.code,
  });

  const holdLot = await liveLot('camel', `G10 hold ${stamp}`);
  const holdBid = await bid(xTok, holdLot.id, 80000, `hold-${stamp}`);
  const holdExp = await exposure(xTok);
  const reduce = await http(base, `/admin/v2/haraj/bidders/${xId}`, {
    method: 'PUT', token: adminTok, body: { eligibilityStatus: 'verified', bidLimit: 50000 },
  });
  record('limit_reduction_blocked', holdBid.status === 201 && Number(holdExp) === 80000
    && reduce.status === 409 && reduce.json?.code === 'HARAJ_BID_LIMIT_BELOW_EXPOSURE', {
    hold: holdBid.status, exposure: holdExp, reduce: reduce.status, code: reduce.json?.code,
  });

  const susp = await http(base, `/admin/v2/haraj/bidders/${xId}/suspend`, {
    method: 'POST', token: adminTok, body: { reason: 'g10-e2e' },
  });
  const suspBid = await bid(xTok, camelLive.id, 20000, `susp-${stamp}`);
  const suspExp = await exposure(xTok);
  const hist = await http(base, `/auctions/${holdLot.id}`, { token: sellerTok });
  record('suspension', susp.status === 200 && suspBid.status === 403 && suspBid.json?.code === 'HARAJ_BIDDER_SUSPENDED'
    && Number(suspExp) === 80000 && hist.json?.auction?.currentPrice === 80000, {
    newBid: suspBid.status, code: suspBid.json?.code, exposure: suspExp, historyPrice: hist.json?.auction?.currentPrice,
  });

  const cancelTarget = await liveLot('falcon', `G10 cancel ${stamp}`);
  await http(base, `/admin/v2/haraj/bidders/${yId}`, {
    method: 'PUT', token: adminTok, body: { eligibilityStatus: 'verified', bidLimit: 200000 },
  });
  const cBid = await bid(yTok, cancelTarget.id, 18000, `cancel-bid-${stamp}`);
  const beforeCancel = await exposure(yTok);
  const cancelled = await cancelLot(cancelTarget.id);
  const afterCancel = await exposure(yTok);
  const cancelHist = await http(base, `/auctions/${cancelTarget.id}`, { token: sellerTok });
  record('cancellation_exposure', cBid.status === 201 && cancelled.status === 200
    && Number(beforeCancel) >= 18000 && Number(afterCancel) === Number(beforeCancel) - 18000
    && cancelHist.json?.auction?.status === 'cancelled', {
    before: beforeCancel, after: afterCancel, status: cancelHist.json?.auction?.status,
  });

  const closeLot = await liveLot('horse', `G10 close ${stamp}`, { startOffsetMs: -2000, durationMs: 40000 });
  const closeBid = await bid(yTok, closeLot.id, 22000, `close-${stamp}`);
  await new Promise((r) => setTimeout(r, 45000));
  const closed = await http(base, `/auctions/${closeLot.id}/close`, { method: 'POST', token: sellerTok, body: {} });
  const closeExp = await exposure(yTok);
  record('close_provisional_exposure', closeBid.status === 201 && (closed.status === 200 || closed.status === 409)
    && Number(closeExp) >= 22000, {
    closeStatus: closed.status,
    closeCode: closed.json?.code,
    exposure: closeExp,
    auctionStatus: closed.json?.auction?.status,
    activeAfterClose: 'YES',
    why: 'ended/sold winner obligation remains until G11/G19 release',
  });

  const snapH = await http(base, `/auctions/haraj/rooms/${rooms.horse}`, { token: xTok });
  const pubH = await http(base, `/auctions/${horseLive.id}`, { token: ineligTok });
  const leaked = JSON.stringify({ snap: snapH.json, pub: pubH.json });
  record('privacy', !/bidLimit|authorizedLimit|provider_ref|providerRef|TEST-SANDBOX-ONLY|activeExposure/.test(leaked), {
    snapStatus: snapH.status, pubStatus: pubH.status,
  });

  const bidderAdmin = await http(base, `/admin/v2/haraj/bidders/${xId}`, { token: xTok });
  record('admin_authorization', bidderAdmin.status === 401 || bidderAdmin.status === 403, {
    status: bidderAdmin.status,
  });
  const dossier = await http(base, `/admin/v2/haraj/bidders/${pId}`, { token: adminTok });
  record('admin_dossier', dossier.status === 200
    && dossier.json?.dossier?.profile?.bidLimit === 200000
    && Array.isArray(dossier.json?.dossier?.audit), {
    status: dossier.status,
    exposure: dossier.json?.dossier?.activeExposure,
  });

  const meP = await http(base, '/auctions/haraj/me/eligibility', { token: pTok });
  record('self_eligibility_no_provider_ref', meP.status === 200
    && meP.json?.eligibility?.security?.providerRef == null
    && !JSON.stringify(meP.json).includes('TEST-SANDBOX-ONLY'), {
    status: meP.status,
  });

  writeSummary(results, {
    raceIterations: RACE_ITERATIONS,
    raceBypasses: bypasses,
    livekit: 'NOT IMPLEMENTED / NOT TESTED',
  });
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

function writeSummary(results, extra) {
  const summary = {
    ok: results.every((r) => r.pass),
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => r.fail === true || r.pass === false).length,
    total: results.length,
    results,
    ...extra,
  };
  summary.fail = results.filter((r) => !r.pass).length;
  fs.writeFileSync('/tmp/nomas_g10_staging_e2e.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summary: true, ...summary }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
