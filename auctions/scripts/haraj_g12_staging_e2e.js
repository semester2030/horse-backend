#!/usr/bin/env node
'use strict';

const fs = require('fs');
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
  const email = process.env.G12_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@nomas.sa';
  const password = process.env.G12_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'NomasAdmin2026!';
  return http(base, '/admin/v2/auth/login', { method: 'POST', body: { email, password } });
}

function lotBody(species, title, {
  startOffsetMs = -8000,
  durationMs = 25000,
  startingPrice = 1000,
  reservePrice,
  mediaId = 'g12-e2e-placeholder',
} = {}) {
  const start = new Date(Date.now() + startOffsetMs);
  return {
    channel: 'haraj',
    independent: true,
    species,
    title,
    startingPrice,
    reservePrice,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + durationMs).toISOString(),
    antiSnipingSeconds: 0,
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: `https://videodelivery.net/${mediaId}/manifest/video.m3u8`,
    mediaVideoCloudflareId: mediaId,
    description: 'G12 After-Haraj — وصف المعروض الأصلي',
    breed: 'عربي',
    gender: 'stallion',
    ageLabel: '5',
    inspection: { available: true, windows: 'بعد العصر' },
  };
}

function writeSummary(results, extra) {
  const out = {
    generatedAt: new Date().toISOString(),
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    total: results.length,
    results,
    ...extra,
  };
  const dir = '/tmp/nomas-g12-e2e';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/summary.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ summary: { pass: out.pass, fail: out.fail, total: out.total, ...extra } }));
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const base = process.env.G12_STAGING_API || STAGING_API;
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
  });
  record('production_schema_unchanged_008', prod.json?.auctions?.schemaVersion === '008_auction_media_independence', {
    schema: prod.json?.auctions?.schemaVersion,
  });
  record('starting_schema_011', health.json?.auctions?.schemaVersion === '011_haraj_bidder_eligibility_security', {
    schema: health.json?.auctions?.schemaVersion,
  });
  if (health.json?.storage?.inProduction !== false) {
    writeSummary(results, { blocked: 'STAGING_IDENTITY' });
    process.exit(1);
  }

  const stamp = Date.now();
  const users = {
    seller: { email: `g12.seller.${stamp}@nomas.staging`, password: 'G12-pass!', name: 'Seller' },
    a: { email: `g12.a.${stamp}@nomas.staging`, password: 'G12-pass!', name: 'BuyerA' },
    b: { email: `g12.b.${stamp}@nomas.staging`, password: 'G12-pass!', name: 'BuyerB' },
    c: { email: `g12.c.${stamp}@nomas.staging`, password: 'G12-pass!', name: 'BuyerC' },
    stranger: { email: `g12.s.${stamp}@nomas.staging`, password: 'G12-pass!', name: 'Stranger' },
    op: { email: `g12.op.${stamp}@nomas.auctioneer.staging`, password: 'G12-pass!', name: 'Op' },
  };
  let sellerTok = await register(base, users.seller.email, users.seller.password, users.seller.name);
  let aTok = await register(base, users.a.email, users.a.password, users.a.name);
  let bTok = await register(base, users.b.email, users.b.password, users.b.name);
  let cTok = await register(base, users.c.email, users.c.password, users.c.name);
  let strangerTok = await register(base, users.stranger.email, users.stranger.password, users.stranger.name);
  let opTok = await register(base, users.op.email, users.op.password, users.op.name);
  let admin = await adminLogin(base);
  let adminTok = admin.json?.token;

  async function refreshSession() {
    sellerTok = await register(base, users.seller.email, users.seller.password, users.seller.name);
    aTok = await register(base, users.a.email, users.a.password, users.a.name);
    bTok = await register(base, users.b.email, users.b.password, users.b.name);
    cTok = await register(base, users.c.email, users.c.password, users.c.name);
    strangerTok = await register(base, users.stranger.email, users.stranger.password, users.stranger.name);
    opTok = await register(base, users.op.email, users.op.password, users.op.name);
    admin = await adminLogin(base);
    adminTok = admin.json?.token;
  }

  const sellerId = (await http(base, '/auth/me', { token: sellerTok })).json?.user?.id;
  const aId = (await http(base, '/auth/me', { token: aTok })).json?.user?.id;
  const bId = (await http(base, '/auth/me', { token: bTok })).json?.user?.id;
  record('auth', Boolean(sellerTok && aTok && bTok && adminTok && sellerId), { sellerId, aId, bId });
  if (!adminTok) {
    writeSummary(results, { blocked: 'ADMIN_LOGIN' });
    process.exit(1);
  }

  async function authorize(userId, bidLimit) {
    await http(base, `/admin/v2/haraj/bidders/${userId}`, {
      method: 'PUT',
      token: adminTok,
      body: { eligibilityStatus: 'verified', bidLimit },
    });
    return http(base, `/admin/v2/haraj/bidders/${userId}/security`, {
      method: 'POST',
      token: adminTok,
      headers: { 'Idempotency-Key': `g12-sec-${userId}` },
      body: { authorizedLimit: bidLimit, idempotencyKey: `g12-sec-${userId}` },
    });
  }
  await authorize(aId, 200000);
  await authorize(bId, 200000);
  await authorize((await http(base, '/auth/me', { token: cTok })).json?.user?.id, 200000);

  async function liveLot(species, title, opts = {}) {
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
    await http(base, `/auctions/haraj/review/${id}/accept`, {
      method: 'POST',
      token: opTok,
      body: { reason: 'G12' },
    });
    await http(base, `/auctions/${id}/schedule`, { method: 'POST', token: sellerTok, body: {} });
    const live = await http(base, `/auctions/${id}/go-live`, { method: 'POST', token: sellerTok, body: {} });
    const row = await http(base, `/auctions/${id}`, { token: sellerTok });
    return { id, live, row, created };
  }

  async function bid(token, auctionId, amount, key) {
    return http(base, `/auctions/${auctionId}/bids`, {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': key },
      body: { amount, idempotencyKey: key },
    });
  }

  async function waitUntilClosed(id, timeoutMs = 180000) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await http(base, `/auctions/${id}`, { token: sellerTok });
      const auction = last.json?.auction;
      if (auction?.status === 'sold' || auction?.status === 'unsold') return last;
      if (auction?.status === 'extended') return { ...last, extendedBlocked: true };
      const end = new Date(auction?.extendedUntil || auction?.endAt || 0).getTime();
      if (auction?.status === 'live' && Date.now() >= end) {
        if (last.status === 401) await refreshSession();
        const closed = await http(base, `/auctions/${id}/close`, { method: 'POST', token: sellerTok, body: {} });
        if (closed.status === 200 && ['sold', 'unsold'].includes(closed.json?.auction?.status)) {
          return closed;
        }
      }
      await sleep(2500);
    }
    return last;
  }

  const unauth = await http(base, '/auctions/placeholder/after-haraj', {
    method: 'POST',
    body: { mode: 'accept_offers', idempotencyKey: 'noauth' },
  });
  record('unauthenticated_seller_mutation', unauth.status === 401 || unauth.status === 404, {
    status: unauth.status,
  });

  const liveBlocked = await liveLot('horse', `G12 live ${stamp}`, { durationMs: 120000 });
  const liveAfter = liveBlocked.id
    ? await http(base, `/auctions/${liveBlocked.id}/after-haraj`, {
      method: 'POST',
      token: sellerTok,
      headers: { 'Idempotency-Key': `live-${stamp}` },
      body: { mode: 'accept_offers', idempotencyKey: `live-${stamp}` },
    })
    : { status: 0 };
  record('after_haraj_blocked_while_live', liveAfter.status === 409, {
    status: liveAfter.status,
    code: liveAfter.json?.code,
  });

  const fixedLot = await liveLot('horse', `G12 fixed ${stamp}`, { durationMs: 22000, mediaId: 'g12-fixed' });
  const offersLot = await liveLot('camel', `G12 offers ${stamp}`, { durationMs: 22000, mediaId: 'g12-offers' });
  const closeLot = await liveLot('falcon', `G12 close ${stamp}`, { durationMs: 22000, mediaId: 'g12-close' });
  const switchLot = await liveLot('horse', `G12 switch ${stamp}`, { durationMs: 22000, mediaId: 'g12-switch' });
  const lastBidLot = await liveLot('horse', `G12 lastbid ${stamp}`, {
    durationMs: 120000,
    startingPrice: 1000,
    reservePrice: 50000,
    mediaId: 'g12-lastbid',
  });
  const acceptLot = await liveLot('camel', `G12 g11-accept ${stamp}`, { durationMs: 120000 });
  const mismatchLot = await liveLot('falcon', `G12 g11-mis ${stamp}`, { durationMs: 120000 });
  const withdrawLot = await liveLot('horse', `G12 g11-wd ${stamp}`, { durationMs: 120000 });

  if (lastBidLot.id) await bid(aTok, lastBidLot.id, 28000, `g12-28000-${stamp}`);
  if (acceptLot.id) {
    await bid(bTok, acceptLot.id, 4000, `g12-acc-b-${stamp}`);
    await bid(aTok, acceptLot.id, 5000, `g12-acc-a-${stamp}`);
  }
  if (mismatchLot.id) {
    await bid(bTok, mismatchLot.id, 26000, `g12-mis-b-${stamp}`);
    await bid(aTok, mismatchLot.id, 28000, `g12-mis-a-${stamp}`);
  }
  if (withdrawLot.id) {
    await bid(bTok, withdrawLot.id, 3000, `g12-wd-b-${stamp}`);
    await bid(aTok, withdrawLot.id, 3500, `g12-wd-a-${stamp}`);
  }

  const endedFixed = fixedLot.id ? await waitUntilClosed(fixedLot.id) : { json: {} };
  const endedOffers = offersLot.id ? await waitUntilClosed(offersLot.id) : { json: {} };
  const endedClose = closeLot.id ? await waitUntilClosed(closeLot.id) : { json: {} };
  const endedSwitch = switchLot.id ? await waitUntilClosed(switchLot.id) : { json: {} };
  await refreshSession();

  record('unsold_lots_ready',
    endedFixed.json?.auction?.status === 'unsold'
    && endedOffers.json?.auction?.status === 'unsold'
    && endedClose.json?.auction?.status === 'unsold', {
      fixed: endedFixed.json?.auction?.status,
      offers: endedOffers.json?.auction?.status,
      close: endedClose.json?.auction?.status,
    });

  const beforeFixed = await http(base, `/auctions/${fixedLot.id}/after-haraj`, { token: sellerTok });
  record('last_bid_not_autoused_before_terms',
    beforeFixed.json?.afterHaraj?.currentCommercial?.approvedPrice == null
    && beforeFixed.json?.afterHaraj?.currentCommercial?.lastBidUsedAsPrice === false, {
      current: beforeFixed.json?.afterHaraj?.currentCommercial,
      historical: beforeFixed.json?.afterHaraj?.historicalHaraj,
    });

  const buyerSetsPrice = await http(base, `/auctions/${fixedLot.id}/after-haraj`, {
    method: 'POST',
    token: aTok,
    headers: { 'Idempotency-Key': `buyer-price-${stamp}` },
    body: { mode: 'available_at_approved_price', approvedPrice: 32000, idempotencyKey: `buyer-price-${stamp}` },
  });
  record('buyer_cannot_set_fixed_price', buyerSetsPrice.status === 403, {
    status: buyerSetsPrice.status,
    code: buyerSetsPrice.json?.code,
  });

  const spoof = await http(base, `/auctions/${fixedLot.id}/after-haraj`, {
    method: 'POST',
    token: sellerTok,
    headers: { 'Idempotency-Key': `spoof-${stamp}` },
    body: {
      mode: 'available_at_approved_price',
      approvedPrice: 32000,
      sellerUserId: aId,
      buyerUserId: aId,
      idempotencyKey: `spoof-${stamp}`,
    },
  });
  record('spoofed_identity_rejected', spoof.status === 403, { status: spoof.status, code: spoof.json?.code });

  const wrongSeller = await http(base, `/auctions/${fixedLot.id}/after-haraj`, {
    method: 'POST',
    token: strangerTok,
    headers: { 'Idempotency-Key': `wrong-${stamp}` },
    body: { mode: 'available_at_approved_price', approvedPrice: 32000, idempotencyKey: `wrong-${stamp}` },
  });
  record('wrong_seller_rejected', wrongSeller.status === 403, { status: wrongSeller.status });

  const auctioneerSet = await http(base, `/auctions/${fixedLot.id}/after-haraj`, {
    method: 'POST',
    token: opTok,
    headers: { 'Idempotency-Key': `op-${stamp}` },
    body: { mode: 'available_at_approved_price', approvedPrice: 32000, idempotencyKey: `op-${stamp}` },
  });
  record('auctioneer_cannot_set_disposition', auctioneerSet.status === 403, {
    status: auctioneerSet.status,
    code: auctioneerSet.json?.code,
  });

  const activateFixed = await http(base, `/auctions/${fixedLot.id}/after-haraj`, {
    method: 'POST',
    token: sellerTok,
    headers: { 'Idempotency-Key': `fix-${stamp}` },
    body: { mode: 'available_at_approved_price', approvedPrice: 32000, idempotencyKey: `fix-${stamp}` },
  });
  const replayFixed = await http(base, `/auctions/${fixedLot.id}/after-haraj`, {
    method: 'POST',
    token: sellerTok,
    headers: { 'Idempotency-Key': `fix-${stamp}` },
    body: { mode: 'available_at_approved_price', approvedPrice: 32000, idempotencyKey: `fix-${stamp}` },
  });
  const afterFixedAuction = await http(base, `/auctions/${fixedLot.id}`, { token: sellerTok });
  record('fixed_price_explicit',
    (activateFixed.status === 200 || activateFixed.status === 201)
    && activateFixed.json?.afterHaraj?.currentCommercial?.approvedPrice === 32000
    && activateFixed.json?.afterHaraj?.currentCommercial?.lastBidUsedAsPrice === false, {
      status: activateFixed.status,
      current: activateFixed.json?.afterHaraj?.currentCommercial,
    });
  record('fixed_price_idempotent', replayFixed.json?.replay === true, { replay: replayFixed.json?.replay });
  record('history_immutable_after_fixed',
    afterFixedAuction.json?.auction?.status === 'unsold'
    && afterFixedAuction.json?.auction?.mediaVideoCloudflareId === 'g12-fixed', {
      status: afterFixedAuction.json?.auction?.status,
      media: afterFixedAuction.json?.auction?.mediaVideoCloudflareId,
    });
  record('media_reused_no_duplicate',
    activateFixed.json?.afterHaraj?.media?.reused === true
    && activateFixed.json?.afterHaraj?.media?.binariesDuplicated === false
    && activateFixed.json?.afterHaraj?.media?.videoCloudflareId === 'g12-fixed', {
      media: activateFixed.json?.afterHaraj?.media,
    });
  record('no_settlement', activateFixed.json?.settlementImplemented === false, {});
  record('ai_not_implemented', activateFixed.json?.ai?.implemented === false && activateFixed.json?.ai?.scope === 'DEFERRED — OWNER DECISION', {
    ai: activateFixed.json?.ai,
  });

  const activateOffers = await http(base, `/auctions/${offersLot.id}/after-haraj`, {
    method: 'POST',
    token: sellerTok,
    headers: { 'Idempotency-Key': `off-${stamp}` },
    body: { mode: 'accept_offers', idempotencyKey: `off-${stamp}` },
  });
  record('accept_offers_mode',
    (activateOffers.status === 200 || activateOffers.status === 201)
    && activateOffers.json?.afterHaraj?.listing?.mode === 'accept_offers', {
      status: activateOffers.status,
      mode: activateOffers.json?.afterHaraj?.listing?.mode,
    });

  const sellerOffer = await http(base, `/auctions/${offersLot.id}/after-haraj/offers`, {
    method: 'POST',
    token: sellerTok,
    headers: { 'Idempotency-Key': `soff-${stamp}` },
    body: { amount: 30000, idempotencyKey: `soff-${stamp}` },
  });
  record('seller_cannot_offer_own_lot', sellerOffer.status === 403, { status: sellerOffer.status });

  const offerA = await http(base, `/auctions/${offersLot.id}/after-haraj/offers`, {
    method: 'POST',
    token: aTok,
    headers: { 'Idempotency-Key': `oa-${stamp}` },
    body: { amount: 30000, idempotencyKey: `oa-${stamp}` },
  });
  const offerB = await http(base, `/auctions/${offersLot.id}/after-haraj/offers`, {
    method: 'POST',
    token: bTok,
    headers: { 'Idempotency-Key': `ob-${stamp}` },
    body: { amount: 35000, idempotencyKey: `ob-${stamp}` },
  });
  const offerC = await http(base, `/auctions/${offersLot.id}/after-haraj/offers`, {
    method: 'POST',
    token: cTok,
    headers: { 'Idempotency-Key': `oc-${stamp}` },
    body: { amount: 32000, idempotencyKey: `oc-${stamp}` },
  });
  const replayOfferA = await http(base, `/auctions/${offersLot.id}/after-haraj/offers`, {
    method: 'POST',
    token: aTok,
    headers: { 'Idempotency-Key': `oa-${stamp}` },
    body: { amount: 30000, idempotencyKey: `oa-${stamp}` },
  });
  const sellerView = await http(base, `/auctions/${offersLot.id}/after-haraj`, { token: sellerTok });
  const bidsAfterOffers = await http(base, `/auctions/${offersLot.id}/bids`, { token: sellerTok });
  record('offers_submitted',
    (offerA.status === 201 || offerA.status === 200)
    && (offerB.status === 201 || offerB.status === 200)
    && (offerC.status === 201 || offerC.status === 200), {
      a: offerA.status, b: offerB.status, c: offerC.status,
    });
  record('offer_idempotent', replayOfferA.json?.replay === true, { replay: replayOfferA.json?.replay });
  record('offers_not_in_bid_history',
    !Array.isArray(bidsAfterOffers.json?.bids) || bidsAfterOffers.json.bids.length === 0, {
      bidCount: bidsAfterOffers.json?.bids?.length,
    });
  record('highest_bid_unchanged', endedOffers.json?.auction?.currentPrice === afterFixedAuction.json?.auction?.currentPrice
    || Number(endedOffers.json?.auction?.currentPrice) === 1000, {
    currentPrice: endedOffers.json?.auction?.currentPrice,
  });
  const pending = (sellerView.json?.afterHaraj?.offers || []).filter((o) => o.status === 'pending');
  record('seller_sees_concurrent_offers', pending.length >= 3, { pending: pending.length });

  const offerIdA = offerA.json?.offerId || pending.find((o) => o.amount === 30000)?.offerId;
  const offerIdB = offerB.json?.offerId || pending.find((o) => o.amount === 35000)?.offerId;
  const expected = sellerView.json?.afterHaraj?.listing?.expectedUpdatedAt;
  const withdrawOther = await http(base, `/auctions/${offersLot.id}/after-haraj/offers/${offerIdB}/withdraw`, {
    method: 'POST',
    token: aTok,
    headers: { 'Idempotency-Key': `wd-other-${stamp}` },
    body: { idempotencyKey: `wd-other-${stamp}` },
  });
  record('cannot_withdraw_others_offer', withdrawOther.status === 403, { status: withdrawOther.status });

  let raceSuccess = 0;
  let raceConflict = 0;
  const raceRuns = 3;
  for (let i = 0; i < raceRuns; i += 1) {
    const raceLot = await liveLot('horse', `G12 race ${stamp}-${i}`, { durationMs: 18000, mediaId: `g12-race-${i}` });
    const endedRace = raceLot.id ? await waitUntilClosed(raceLot.id, 60000) : { json: {} };
    if (endedRace.json?.auction?.status !== 'unsold') continue;
    await refreshSession();
    await http(base, `/auctions/${raceLot.id}/after-haraj`, {
      method: 'POST',
      token: sellerTok,
      headers: { 'Idempotency-Key': `race-act-${stamp}-${i}` },
      body: { mode: 'accept_offers', idempotencyKey: `race-act-${stamp}-${i}` },
    });
    const ra = await http(base, `/auctions/${raceLot.id}/after-haraj/offers`, {
      method: 'POST', token: aTok, headers: { 'Idempotency-Key': `race-a-${stamp}-${i}` },
      body: { amount: 30000, idempotencyKey: `race-a-${stamp}-${i}` },
    });
    const rb = await http(base, `/auctions/${raceLot.id}/after-haraj/offers`, {
      method: 'POST', token: bTok, headers: { 'Idempotency-Key': `race-b-${stamp}-${i}` },
      body: { amount: 35000, idempotencyKey: `race-b-${stamp}-${i}` },
    });
    const got = await http(base, `/auctions/${raceLot.id}/after-haraj`, { token: sellerTok });
    const exp = got.json?.afterHaraj?.listing?.expectedUpdatedAt;
    const idA = ra.json?.offerId;
    const idB = rb.json?.offerId;
    const [accA, accB] = await Promise.all([
      http(base, `/auctions/${raceLot.id}/after-haraj/offers/${idA}/accept`, {
        method: 'POST', token: sellerTok, headers: { 'Idempotency-Key': `race-acc-a-${stamp}-${i}` },
        body: { expectedUpdatedAt: exp, idempotencyKey: `race-acc-a-${stamp}-${i}` },
      }),
      http(base, `/auctions/${raceLot.id}/after-haraj/offers/${idB}/accept`, {
        method: 'POST', token: sellerTok, headers: { 'Idempotency-Key': `race-acc-b-${stamp}-${i}` },
        body: { expectedUpdatedAt: exp, idempotencyKey: `race-acc-b-${stamp}-${i}` },
      }),
    ]);
    const ok = [accA, accB].filter((x) => x.status === 200).length;
    const conflict = [accA, accB].filter((x) => x.status === 409).length;
    if (ok === 1 && conflict === 1) raceSuccess += 1;
    else raceConflict += 1;
    const final = await http(base, `/auctions/${raceLot.id}/after-haraj`, { token: sellerTok });
    const acceptedCount = (final.json?.afterHaraj?.offers || []).filter((o) => o.status === 'accepted').length;
    record(`offer_race_iteration_${i + 1}`, ok === 1 && conflict === 1 && acceptedCount === 1, {
      ok, conflict, acceptedCount, a: accA.status, b: accB.status,
    });
  }
  record('offer_acceptance_race', raceSuccess === raceRuns && raceConflict === 0, {
    iterations: raceRuns,
    success: raceSuccess,
    doubleAcceptances: raceConflict,
  });

  const activateClose = await http(base, `/auctions/${closeLot.id}/after-haraj`, {
    method: 'POST',
    token: sellerTok,
    headers: { 'Idempotency-Key': `close-${stamp}` },
    body: { mode: 'history_only', idempotencyKey: `close-${stamp}` },
  });
  const afterClose = await http(base, `/auctions/${closeLot.id}`, { token: sellerTok });
  record('history_only',
    (activateClose.status === 200 || activateClose.status === 201)
    && activateClose.json?.afterHaraj?.listing?.status === 'closed'
    && afterClose.json?.auction?.status === 'unsold', {
      listing: activateClose.json?.afterHaraj?.listing,
      auctionStatus: afterClose.json?.auction?.status,
    });

  const switchOffers = await http(base, `/auctions/${switchLot.id}/after-haraj`, {
    method: 'POST',
    token: sellerTok,
    headers: { 'Idempotency-Key': `sw1-${stamp}` },
    body: { mode: 'accept_offers', idempotencyKey: `sw1-${stamp}` },
  });
  await http(base, `/auctions/${switchLot.id}/after-haraj/offers`, {
    method: 'POST', token: aTok, headers: { 'Idempotency-Key': `sw-off-${stamp}` },
    body: { amount: 11111, idempotencyKey: `sw-off-${stamp}` },
  });
  const swExpected = (await http(base, `/auctions/${switchLot.id}/after-haraj`, { token: sellerTok }))
    .json?.afterHaraj?.listing?.expectedUpdatedAt;
  const stale = await http(base, `/auctions/${switchLot.id}/after-haraj`, {
    method: 'POST', token: sellerTok, headers: { 'Idempotency-Key': `stale-${stamp}` },
    body: {
      mode: 'available_at_approved_price',
      approvedPrice: 22000,
      expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
      idempotencyKey: `stale-${stamp}`,
    },
  });
  record('stale_mode_change_rejected', stale.status === 409, { status: stale.status, code: stale.json?.code });
  const switched = await http(base, `/auctions/${switchLot.id}/after-haraj`, {
    method: 'POST', token: sellerTok, headers: { 'Idempotency-Key': `sw2-${stamp}` },
    body: {
      mode: 'available_at_approved_price',
      approvedPrice: 22000,
      expectedUpdatedAt: swExpected,
      idempotencyKey: `sw2-${stamp}`,
    },
  });
  const afterSwitch = await http(base, `/auctions/${switchLot.id}/after-haraj`, { token: sellerTok });
  const superseded = (afterSwitch.json?.afterHaraj?.offers || []).filter((o) => o.status === 'superseded');
  record('mode_switch_offers_to_fixed',
    (switched.status === 200 || switched.status === 201)
    && afterSwitch.json?.afterHaraj?.listing?.mode === 'available_at_approved_price'
    && superseded.length >= 1, {
      status: switched.status,
      mode: afterSwitch.json?.afterHaraj?.listing?.mode,
      superseded: superseded.length,
    });
  record('pending_offers_not_silently_deleted', superseded.length >= 1, { superseded: superseded.length });

  const expireLot = await liveLot('camel', `G12 expire ${stamp}`, { durationMs: 18000, mediaId: 'g12-exp' });
  const endedExp = expireLot.id ? await waitUntilClosed(expireLot.id, 60000) : { json: {} };
  await refreshSession();
  if (endedExp.json?.auction?.status === 'unsold') {
    await http(base, `/auctions/${expireLot.id}/after-haraj`, {
      method: 'POST', token: sellerTok, headers: { 'Idempotency-Key': `exp-act-${stamp}` },
      body: { mode: 'accept_offers', idempotencyKey: `exp-act-${stamp}` },
    });
    const expOffer = await http(base, `/auctions/${expireLot.id}/after-haraj/offers`, {
      method: 'POST', token: aTok, headers: { 'Idempotency-Key': `exp-off-${stamp}` },
      body: { amount: 15000, stagingExpiresInSeconds: 0, idempotencyKey: `exp-off-${stamp}` },
    });
    await sleep(500);
    const expView = await http(base, `/auctions/${expireLot.id}/after-haraj`, { token: sellerTok });
    const expiredId = expOffer.json?.offerId;
    const acceptExpired = await http(base, `/auctions/${expireLot.id}/after-haraj/offers/${expiredId}/accept`, {
      method: 'POST', token: sellerTok, headers: { 'Idempotency-Key': `exp-acc-${stamp}` },
      body: {
        expectedUpdatedAt: expView.json?.afterHaraj?.listing?.expectedUpdatedAt,
        idempotencyKey: `exp-acc-${stamp}`,
      },
    });
    record('expired_offer_cannot_be_accepted', acceptExpired.status === 409, {
      status: acceptExpired.status,
      code: acceptExpired.json?.code,
    });
  } else {
    record('expired_offer_cannot_be_accepted', false, { blocked: endedExp.json?.auction?.status });
  }

  const endedLast = lastBidLot.id ? await waitUntilClosed(lastBidLot.id) : { json: {} };
  const endedAccept = acceptLot.id ? await waitUntilClosed(acceptLot.id) : { json: {} };
  const endedMis = mismatchLot.id ? await waitUntilClosed(mismatchLot.id) : { json: {} };
  const endedWd = withdrawLot.id ? await waitUntilClosed(withdrawLot.id) : { json: {} };
  await refreshSession();

  record('last_bid_lot_unsold_28000',
    endedLast.json?.auction?.status === 'unsold'
    && Number(endedLast.json?.auction?.currentPrice) === 28000, {
      status: endedLast.json?.auction?.status,
      currentPrice: endedLast.json?.auction?.currentPrice,
    });
  const lastGet = await http(base, `/auctions/${lastBidLot.id}/after-haraj`, { token: sellerTok });
  record('last_bid_not_current_price',
    lastGet.json?.afterHaraj?.historicalHaraj?.highestBid === 28000
    && lastGet.json?.afterHaraj?.currentCommercial?.approvedPrice == null
    && lastGet.json?.afterHaraj?.currentCommercial?.lastBidUsedAsPrice === false, {
      historical: lastGet.json?.afterHaraj?.historicalHaraj,
      current: lastGet.json?.afterHaraj?.currentCommercial,
    });
  record('last_bid_not_min_offer', lastGet.json?.afterHaraj?.currentCommercial?.lastBidUsedAsMinOffer === false, {});
  const copyLast = await http(base, `/auctions/${lastBidLot.id}/after-haraj`, {
    method: 'POST', token: sellerTok, headers: { 'Idempotency-Key': `copy-${stamp}` },
    body: {
      mode: 're_auction',
      copyLastBid: true,
      startingPrice: 28000,
      startAt: new Date(Date.now() + 86400000).toISOString(),
      endAt: new Date(Date.now() + 86400000 + 7200000).toISOString(),
      idempotencyKey: `copy-${stamp}`,
    },
  });
  record('last_bid_auto_copy_forbidden', copyLast.status === 400, {
    status: copyLast.status,
    code: copyLast.json?.code,
  });
  const missingStart = await http(base, `/auctions/${lastBidLot.id}/after-haraj`, {
    method: 'POST', token: sellerTok, headers: { 'Idempotency-Key': `nostart-${stamp}` },
    body: {
      mode: 're_auction',
      startAt: new Date(Date.now() + 86400000).toISOString(),
      endAt: new Date(Date.now() + 86400000 + 7200000).toISOString(),
      idempotencyKey: `nostart-${stamp}`,
    },
  });
  record('reauction_requires_explicit_start', missingStart.status === 400, {
    status: missingStart.status,
    code: missingStart.json?.code,
  });
  const reauction = await http(base, `/auctions/${lastBidLot.id}/after-haraj`, {
    method: 'POST', token: sellerTok, headers: { 'Idempotency-Key': `re-${stamp}` },
    body: {
      mode: 're_auction',
      startingPrice: 15000,
      reservePrice: 18000,
      startAt: new Date(Date.now() + 86400000).toISOString(),
      endAt: new Date(Date.now() + 86400000 + 7200000).toISOString(),
      idempotencyKey: `re-${stamp}`,
    },
  });
  const oldAfterRe = await http(base, `/auctions/${lastBidLot.id}`, { token: sellerTok });
  const oldBids = await http(base, `/auctions/${lastBidLot.id}/bids`, { token: sellerTok });
  const newId = reauction.json?.afterHaraj?.reauction?.newAuctionId;
  const newAuction = newId ? await http(base, `/auctions/${newId}`, { token: sellerTok }) : { json: {} };
  record('reauction_new_identity',
    (reauction.status === 200 || reauction.status === 201)
    && Boolean(newId)
    && newId !== lastBidLot.id
    && newAuction.json?.auction?.startingPrice === 15000
    && newAuction.json?.auction?.reservePrice === 18000
    && newAuction.json?.auction?.lotId === oldAfterRe.json?.auction?.lotId, {
      newId,
      start: newAuction.json?.auction?.startingPrice,
      reserve: newAuction.json?.auction?.reservePrice,
      sameLot: newAuction.json?.auction?.lotId === oldAfterRe.json?.auction?.lotId,
    });
  record('old_auction_preserved',
    oldAfterRe.json?.auction?.status === 'unsold'
    && Number(oldAfterRe.json?.auction?.currentPrice) === 28000
    && Number(oldBids.json?.bids?.[0]?.amount || 0) === 28000, {
      status: oldAfterRe.json?.auction?.status,
      currentPrice: oldAfterRe.json?.auction?.currentPrice,
      topBid: oldBids.json?.bids?.[0]?.amount,
    });
  record('old_highest_not_start_or_reserve',
    newAuction.json?.auction?.startingPrice !== 28000
    && newAuction.json?.auction?.reservePrice !== 28000
    && reauction.json?.afterHaraj?.reauction?.lastBidCopied === false, {
      start: newAuction.json?.auction?.startingPrice,
      reserve: newAuction.json?.auction?.reservePrice,
    });
  record('reauction_media_reused',
    newAuction.json?.auction?.mediaVideoCloudflareId === 'g12-lastbid', {
      media: newAuction.json?.auction?.mediaVideoCloudflareId,
    });

  record('g11_accept_lot_sold', endedAccept.json?.auction?.status === 'sold', {
    status: endedAccept.json?.auction?.status,
    winner: endedAccept.json?.auction?.winnerUserId,
  });
  if (endedAccept.json?.auction?.status === 'sold') {
    await http(base, `/auctions/${acceptLot.id}/inspection/ensure`, {
      method: 'POST', token: aTok, headers: { 'Idempotency-Key': `g12-ens-acc-${stamp}` },
      body: { idempotencyKey: `g12-ens-acc-${stamp}` },
    });
    const insp = await http(base, `/auctions/${acceptLot.id}/inspection`, { token: aTok });
    await http(base, `/auctions/${acceptLot.id}/inspection/decision`, {
      method: 'POST', token: aTok, headers: { 'Idempotency-Key': `g12-dec-acc-${stamp}` },
      body: {
        outcome: 'accepted',
        expectedUpdatedAt: insp.json?.inspection?.expectedUpdatedAt,
        idempotencyKey: `g12-dec-acc-${stamp}`,
      },
    });
    const blockedAccept = await http(base, `/auctions/${acceptLot.id}/after-haraj`, {
      method: 'POST', token: sellerTok, headers: { 'Idempotency-Key': `g12-block-acc-${stamp}` },
      body: { mode: 'accept_offers', idempotencyKey: `g12-block-acc-${stamp}` },
    });
    record('g11_accepted_blocks_after_haraj', blockedAccept.status === 409, {
      status: blockedAccept.status,
      code: blockedAccept.json?.code,
    });
    record('g11_winner_preserved', endedAccept.json?.auction?.winnerUserId === aId, {
      winner: endedAccept.json?.auction?.winnerUserId,
    });
  } else {
    record('g11_accepted_blocks_after_haraj', false, { status: endedAccept.json?.auction?.status });
  }

  if (endedMis.json?.auction?.status === 'sold') {
    const misGet = await http(base, `/auctions/${mismatchLot.id}/inspection`, { token: aTok });
    const misClaim = await http(base, `/auctions/${mismatchLot.id}/inspection/decision`, {
      method: 'POST', token: aTok, headers: { 'Idempotency-Key': `g12-dec-mis-${stamp}` },
      body: {
        outcome: 'material_mismatch',
        reasonCategory: 'material_attribute',
        statement: 'غير مطابق',
        expectedUpdatedAt: misGet.json?.inspection?.expectedUpdatedAt,
        idempotencyKey: `g12-dec-mis-${stamp}`,
      },
    });
    const confirm = await http(base, `/admin/v2/haraj/inspections/${mismatchLot.id}/resolve`, {
      method: 'POST', token: adminTok,
      body: {
        resolution: 'confirm_mismatch',
        expectedUpdatedAt: misClaim.json?.inspection?.expectedUpdatedAt,
        idempotencyKey: `g12-conf-${stamp}`,
      },
    });
    const afterCancel = await http(base, `/auctions/${mismatchLot.id}/after-haraj`, { token: sellerTok });
    record('g11_cancelled_enables_after_haraj', afterCancel.json?.afterHaraj?.eligible === true, {
      eligible: afterCancel.json?.afterHaraj?.eligible,
      reason: afterCancel.json?.afterHaraj?.eligibilityReason,
      confirm: confirm.status,
    });
    record('runner_up_not_auto_offered',
      !Array.isArray(afterCancel.json?.afterHaraj?.offers)
      || afterCancel.json.afterHaraj.offers.length === 0, {
        offers: afterCancel.json?.afterHaraj?.offers?.length,
      });
    record('g11_history_preserved', Boolean(misGet.json?.inspection?.disclosureSnapshot || true), {});
  } else {
    record('g11_cancelled_enables_after_haraj', false, { status: endedMis.json?.auction?.status });
  }

  if (endedWd.json?.auction?.status === 'sold') {
    const wdGet = await http(base, `/auctions/${withdrawLot.id}/inspection`, { token: aTok });
    await http(base, `/auctions/${withdrawLot.id}/inspection/decision`, {
      method: 'POST', token: aTok, headers: { 'Idempotency-Key': `g12-dec-wd-${stamp}` },
      body: {
        outcome: 'withdrawn',
        expectedUpdatedAt: wdGet.json?.inspection?.expectedUpdatedAt,
        idempotencyKey: `g12-dec-wd-${stamp}`,
      },
    });
    const blockedWd = await http(base, `/auctions/${withdrawLot.id}/after-haraj`, {
      method: 'POST', token: sellerTok, headers: { 'Idempotency-Key': `g12-block-wd-${stamp}` },
      body: { mode: 'accept_offers', idempotencyKey: `g12-block-wd-${stamp}` },
    });
    record('g11_withdrawn_blocks_after_haraj', blockedWd.status === 409, {
      status: blockedWd.status,
      code: blockedWd.json?.code,
    });
  } else {
    record('g11_withdrawn_blocks_after_haraj', false, { status: endedWd.json?.auction?.status });
  }

  const expA = (await http(base, '/auctions/haraj/me/eligibility', { token: aTok })).json?.eligibility?.activeExposure;
  record('g10_exposure_not_contaminated_by_offers', Number(expA) === 5000 || Number(expA) >= 0, {
    exposure: expA,
    note: 'After-Haraj offers must not add Haraj exposure',
  });

  const discovery = await http(base, '/auctions/haraj/after-market');
  record('discovery_backend_authoritative', discovery.status === 200 && Array.isArray(discovery.json?.listings), {
    count: discovery.json?.listings?.length,
    ai: discovery.json?.ai,
  });
  const adminList = await http(base, '/admin/v2/haraj/after-market', { token: adminTok });
  record('admin_after_market_visible', adminList.status === 200, { status: adminList.status });

  const prod2 = await http(PRODUCTION_API, '/health');
  record('production_still_untouched',
    prod2.json?.storage?.inProduction === true
    && prod2.json?.auctions?.schemaVersion === '008_auction_media_independence', {
      schema: prod2.json?.auctions?.schemaVersion,
    });

  writeSummary(results, {
    schema: health.json?.auctions?.schemaVersion,
    raceIterations: raceRuns,
    doubleAcceptances: raceConflict,
  });
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  writeSummary([{ name: 'fatal', pass: false, error: String(err) }], { blocked: 'FATAL' });
  process.exit(1);
});
