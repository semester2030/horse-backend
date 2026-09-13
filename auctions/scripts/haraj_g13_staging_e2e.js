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
  const email = process.env.G13_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@nomas.sa';
  const password = process.env.G13_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'NomasAdmin2026!';
  return http(base, '/admin/v2/auth/login', { method: 'POST', body: { email, password } });
}

function lotBody(species, title, {
  startOffsetMs = -8000,
  durationMs = 18000,
  startingPrice = 1000,
  mediaId = 'g13-e2e-placeholder',
} = {}) {
  const start = new Date(Date.now() + startOffsetMs);
  return {
    channel: 'haraj',
    independent: true,
    species,
    title,
    startingPrice,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + durationMs).toISOString(),
    antiSnipingSeconds: 0,
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: `https://videodelivery.net/${mediaId}/manifest/video.m3u8`,
    mediaVideoCloudflareId: mediaId,
    description: 'G13 History & Analytics — وصف المعروض الأصلي',
    breed: 'عربي',
    gender: 'stallion',
    ageLabel: '5',
    inspection: { available: true, windows: 'بعد العصر' },
  };
}

function riyadhToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
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
  const dir = '/tmp/nomas-g13-e2e';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/summary.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ summary: { pass: out.pass, fail: out.fail, total: out.total, ...extra } }));
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function diffZero(name, expected, actual) {
  return {
    name,
    expected,
    actual,
    difference: Number(actual) - Number(expected),
  };
}

async function main() {
  const base = process.env.G13_STAGING_API || STAGING_API;
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
    seller: { email: `g13.seller.${stamp}@nomas.staging`, password: 'G13-pass!', name: 'Seller' },
    a: { email: `g13.a.${stamp}@nomas.staging`, password: 'G13-pass!', name: 'BuyerA' },
    stranger: { email: `g13.s.${stamp}@nomas.staging`, password: 'G13-pass!', name: 'Stranger' },
    op: { email: `g13.op.${stamp}@nomas.auctioneer.staging`, password: 'G13-pass!', name: 'Op' },
  };
  let sellerTok = await register(base, users.seller.email, users.seller.password, users.seller.name);
  let aTok = await register(base, users.a.email, users.a.password, users.a.name);
  let strangerTok = await register(base, users.stranger.email, users.stranger.password, users.stranger.name);
  let opTok = await register(base, users.op.email, users.op.password, users.op.name);
  let admin = await adminLogin(base);
  let adminTok = admin.json?.token;

  async function refreshSession() {
    sellerTok = await register(base, users.seller.email, users.seller.password, users.seller.name);
    aTok = await register(base, users.a.email, users.a.password, users.a.name);
    strangerTok = await register(base, users.stranger.email, users.stranger.password, users.stranger.name);
    opTok = await register(base, users.op.email, users.op.password, users.op.name);
    admin = await adminLogin(base);
    adminTok = admin.json?.token;
  }

  const sellerId = (await http(base, '/auth/me', { token: sellerTok })).json?.user?.id;
  const aId = (await http(base, '/auth/me', { token: aTok })).json?.user?.id;
  record('auth', Boolean(sellerTok && aTok && adminTok && sellerId), { sellerId, aId });
  if (!adminTok) {
    writeSummary(results, { blocked: 'ADMIN_LOGIN' });
    process.exit(1);
  }

  const unauthHist = await http(base, '/auctions/haraj/history');
  const unauthAn = await http(base, '/auctions/haraj/analytics');
  record('public_history_401', unauthHist.status === 401, { status: unauthHist.status });
  record('public_analytics_401', unauthAn.status === 401, { status: unauthAn.status });

  await http(base, `/admin/v2/haraj/bidders/${aId}`, {
    method: 'PUT',
    token: adminTok,
    body: { eligibilityStatus: 'verified', bidLimit: 200000 },
  });
  await http(base, `/admin/v2/haraj/bidders/${aId}/security`, {
    method: 'POST',
    token: adminTok,
    headers: { 'Idempotency-Key': `g13-sec-${aId}` },
    body: { authorizedLimit: 200000, idempotencyKey: `g13-sec-${aId}` },
  });

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
      body: { reason: 'G13' },
    });
    await http(base, `/auctions/${id}/schedule`, { method: 'POST', token: sellerTok, body: {} });
    const live = await http(base, `/auctions/${id}/go-live`, { method: 'POST', token: sellerTok, body: {} });
    return { id, live, created };
  }

  async function waitUntilClosed(id, timeoutMs = 120000) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await http(base, `/auctions/${id}`, { token: sellerTok });
      const auction = last.json?.auction;
      if (auction?.status === 'sold' || auction?.status === 'unsold') return last;
      const end = new Date(auction?.extendedUntil || auction?.endAt || 0).getTime();
      if (auction?.status === 'live' && Date.now() >= end) {
        if (last.status === 401) await refreshSession();
        const closed = await http(base, `/auctions/${id}/close`, { method: 'POST', token: sellerTok, body: {} });
        if (closed.status === 200 && ['sold', 'unsold'].includes(closed.json?.auction?.status)) {
          return closed;
        }
      }
      await sleep(2000);
    }
    return last;
  }

  const horse = await liveLot('horse', `G13 horse ${stamp}`, { mediaId: 'g13-horse' });
  if (horse.id) {
    await http(base, `/auctions/${horse.id}/bids`, {
      method: 'POST',
      token: aTok,
      headers: { 'Idempotency-Key': `g13-h-${stamp}` },
      body: { amount: 28000, idempotencyKey: `g13-h-${stamp}` },
    });
  }
  const camel = await liveLot('camel', `G13 camel ${stamp}`, { mediaId: 'g13-camel' });
  const falcon = await liveLot('falcon', `G13 falcon ${stamp}`, { mediaId: 'g13-falcon' });
  record('lots_created_three_species', Boolean(horse.id && camel.id && falcon.id), {
    horse: horse.id, camel: camel.id, falcon: falcon.id,
  });

  const endedHorse = horse.id ? await waitUntilClosed(horse.id) : { json: {} };
  const endedCamel = camel.id ? await waitUntilClosed(camel.id) : { json: {} };
  const endedFalcon = falcon.id ? await waitUntilClosed(falcon.id) : { json: {} };
  await refreshSession();
  record('lots_closed', ['sold', 'unsold'].includes(endedHorse.json?.auction?.status)
    && ['sold', 'unsold'].includes(endedCamel.json?.auction?.status)
    && ['sold', 'unsold'].includes(endedFalcon.json?.auction?.status), {
    horse: endedHorse.json?.auction?.status,
    camel: endedCamel.json?.auction?.status,
    falcon: endedFalcon.json?.auction?.status,
  });

  const day = riyadhToday();
  const sellerAn = await http(base, `/auctions/haraj/analytics?from=${day}&to=${day}`, { token: sellerTok });
  const metrics = sellerAn.json?.analytics?.metrics || {};
  const money = sellerAn.json?.analytics?.moneyTerms || {};
  const labels = sellerAn.json?.analytics?.labels || {};
  const expected = {
    auctionCount: 3,
    horse: 1,
    camel: 1,
    falcon: 1,
    withBids: endedHorse.json?.auction?.status === 'sold' ? 1 : metrics.withBidsCount,
    totalBids: 1,
    uniqueBidders: 1,
  };
  const recs = [
    diffZero('auctionCount', expected.auctionCount, metrics.auctionCount),
    diffZero('horse', expected.horse, metrics.speciesDistribution?.horse),
    diffZero('camel', expected.camel, metrics.speciesDistribution?.camel),
    diffZero('falcon', expected.falcon, metrics.speciesDistribution?.falcon),
    diffZero('totalBids', expected.totalBids, metrics.totalBids),
    diffZero('uniqueBidders', expected.uniqueBidders, metrics.uniqueBidders),
    diffZero('highestBidVolumeSar', 28000, metrics.highestBidVolumeSar),
  ];
  record('reconciliation_zero_diff', recs.every((r) => r.difference === 0), { recs, metrics });
  record('timezone_riyadh', sellerAn.json?.analytics?.timezone === 'Asia/Riyadh', {
    timezone: sellerAn.json?.analytics?.timezone,
  });
  record('money_terminology',
    money.notRevenue === true
    && money.notGmvSettled === true
    && money.notCashReceived === true
    && money.notSellerPayout === true
    && /NOT revenue/i.test(labels.highestBidVolumeSar || '')
    && !JSON.stringify(sellerAn.json).toLowerCase().includes('"revenue"'), {
      money, labels,
    });
  record('ai_absent',
    sellerAn.json?.ai?.implemented === false
    && sellerAn.json?.analytics?.ai?.implemented === false, {
      ai: sellerAn.json?.ai,
    });

  const horseOnly = await http(base, `/auctions/haraj/analytics?species=horse&from=${day}&to=${day}`, { token: sellerTok });
  record('filter_species_horse',
    horseOnly.json?.analytics?.metrics?.auctionCount === 1
    && horseOnly.json?.analytics?.metrics?.speciesDistribution?.horse === 1, {
      metrics: horseOnly.json?.analytics?.metrics,
    });

  const sellerHist = await http(base, `/auctions/haraj/history?from=${day}&to=${day}`, { token: sellerTok });
  const sellerIds = (sellerHist.json?.history?.items || []).map((i) => i.auctionId);
  record('seller_history_own_lots',
    [horse.id, camel.id, falcon.id].every((id) => sellerIds.includes(id)), {
      count: sellerIds.length, sellerIds,
    });

  const buyerHist = await http(base, `/auctions/haraj/history?from=${day}&to=${day}`, { token: aTok });
  const buyerIds = (buyerHist.json?.history?.items || []).map((i) => i.auctionId);
  record('buyer_history_only_participated',
    buyerIds.includes(horse.id) && !buyerIds.includes(falcon.id), {
      buyerIds,
    });

  const strangerHorse = await http(base, `/auctions/${horse.id}/haraj-history`, { token: strangerTok });
  record('stranger_record_403', strangerHorse.status === 403, {
    status: strangerHorse.status, code: strangerHorse.json?.code,
  });
  const buyerFalcon = await http(base, `/auctions/${falcon.id}/haraj-history`, { token: aTok });
  record('buyer_nonparticipant_403', buyerFalcon.status === 403, {
    status: buyerFalcon.status, code: buyerFalcon.json?.code,
  });
  const sellerHorse = await http(base, `/auctions/${horse.id}/haraj-history`, { token: sellerTok });
  const timeline = sellerHorse.json?.history?.timeline || [];
  record('timeline_not_fabricated',
    sellerHorse.status === 200
    && timeline.length >= 1
    && timeline.every((e) => e.fabricated === false)
    && timeline.some((e) => e.eventType === 'bid.accepted' || e.phase === 'bid'), {
      status: sellerHorse.status,
      phases: timeline.map((e) => e.phase),
    });
  record('privacy_no_limits_in_history',
    !JSON.stringify(sellerHorse.json).includes('bidLimit')
    && !JSON.stringify(sellerHorse.json).includes('pspReference')
    && !JSON.stringify(sellerHist.json).includes('authorizedLimit'), {
      keys: Object.keys(sellerHorse.json?.history || {}),
    });

  const opAn = await http(base, '/auctions/haraj/analytics', { token: opTok });
  record('auctioneer_analytics_403', opAn.status === 403, { status: opAn.status, code: opAn.json?.code });

  const strangerAn = await http(base, `/auctions/haraj/analytics?from=${day}&to=${day}`, { token: strangerTok });
  record('stranger_analytics_empty_own_scope',
    strangerAn.status === 200 && strangerAn.json?.analytics?.metrics?.auctionCount === 0, {
      count: strangerAn.json?.analytics?.metrics?.auctionCount,
    });

  const adminAn = await http(base, `/admin/v2/haraj/analytics?ownerUserId=${sellerId}&from=${day}&to=${day}`, { token: adminTok });
  const adminRecs = [
    diffZero('adminAuctionCount', 3, adminAn.json?.analytics?.metrics?.auctionCount),
    diffZero('adminHorse', 1, adminAn.json?.analytics?.metrics?.speciesDistribution?.horse),
    diffZero('adminCamel', 1, adminAn.json?.analytics?.metrics?.speciesDistribution?.camel),
    diffZero('adminFalcon', 1, adminAn.json?.analytics?.metrics?.speciesDistribution?.falcon),
  ];
  record('admin_reconciliation_zero_diff', adminRecs.every((r) => r.difference === 0), {
    adminRecs, metrics: adminAn.json?.analytics?.metrics,
  });

  const existingHorse = await http(base, '/admin/v2/haraj/history?species=horse&limit=50', { token: adminTok });
  const existingCamel = await http(base, '/admin/v2/haraj/history?species=camel&limit=50', { token: adminTok });
  const existingFalcon = await http(base, '/admin/v2/haraj/history?species=falcon&limit=50', { token: adminTok });
  record('existing_staging_horse_history',
    (existingHorse.json?.history?.items || []).some((i) => i.species === 'horse'), {
      count: existingHorse.json?.history?.count,
    });
  record('existing_staging_camel_history',
    (existingCamel.json?.history?.items || []).some((i) => i.species === 'camel'), {
      count: existingCamel.json?.history?.count,
    });
  record('existing_staging_falcon_history',
    (existingFalcon.json?.history?.items || []).some((i) => i.species === 'falcon'), {
      count: existingFalcon.json?.history?.count,
    });

  const csv = await http(base, `/admin/v2/haraj/history?ownerUserId=${sellerId}&from=${day}&to=${day}&format=csv`, { token: adminTok });
  record('admin_csv_export',
    csv.status === 200
    && csv.text.includes('auctionId')
    && csv.text.includes(horse.id)
    && !csv.text.includes('bidLimit')
    && !csv.text.includes('psp')
    && !csv.text.includes('authorizedLimit'), {
      status: csv.status,
      bytes: csv.text.length,
    });

  if (endedCamel.json?.auction?.status === 'unsold' && camel.id) {
    const activate = await http(base, `/auctions/${camel.id}/after-haraj`, {
      method: 'POST',
      token: sellerTok,
      headers: { 'Idempotency-Key': `g13-re-${stamp}` },
      body: {
        mode: 're_auction',
        startingPrice: 15000,
        reservePrice: 18000,
        startAt: new Date(Date.now() + 86400000).toISOString(),
        endAt: new Date(Date.now() + 86400000 + 7200000).toISOString(),
        idempotencyKey: `g13-re-${stamp}`,
      },
    });
    const newId = activate.json?.afterHaraj?.reauction?.newAuctionId
      || activate.json?.afterHaraj?.reauctionNewAuctionId;
    const sourceRec = await http(base, `/auctions/${camel.id}/haraj-history`, { token: sellerTok });
    const newRec = newId ? await http(base, `/auctions/${newId}/haraj-history`, { token: sellerTok }) : { json: {} };
    const sourceBids = sourceRec.json?.history?.bidHistory || [];
    const newBids = newRec.json?.history?.bidHistory || [];
    record('reauction_chain_preserved',
      Boolean(newId)
      && sourceRec.json?.history?.reauction?.newAuctionId === newId
      && newRec.json?.history?.lotId === sourceRec.json?.history?.lotId
      && sourceRec.json?.history?.bidHistoriesNotMergedAcrossReauction === true
      && activate.json?.afterHaraj?.reauction?.lastBidCopied !== true, {
        newId,
        lotId: sourceRec.json?.history?.lotId,
        sourceBids: sourceBids.length,
        newBids: newBids.length,
        activate: activate.status,
      });
    record('reauction_bid_histories_not_merged', newBids.length === 0, {
      sourceBids: sourceBids.length, newBids: newBids.length,
    });
  } else {
    record('reauction_chain_preserved', false, { reason: 'camel_not_unsold', status: endedCamel.json?.auction?.status });
    record('reauction_bid_histories_not_merged', false, { reason: 'camel_not_unsold' });
  }

  const afterWriteHorse = await http(base, `/auctions/${horse.id}`, { token: sellerTok });
  record('history_read_does_not_mutate',
    afterWriteHorse.json?.auction?.currentPrice === endedHorse.json?.auction?.currentPrice
    && afterWriteHorse.json?.auction?.status === endedHorse.json?.auction?.status, {
      status: afterWriteHorse.json?.auction?.status,
      price: afterWriteHorse.json?.auction?.currentPrice,
    });

  const prodAfter = await http(PRODUCTION_API, '/health');
  record('production_still_008_after_e2e',
    prodAfter.json?.storage?.inProduction === true
    && prodAfter.json?.auctions?.schemaVersion === '008_auction_media_independence', {
      schema: prodAfter.json?.auctions?.schemaVersion,
    });

  writeSummary(results, {
    environment: base,
    schema: health.json?.auctions?.schemaVersion,
    sellerId,
    horse: horse.id,
    camel: camel.id,
    falcon: falcon.id,
    riyadhDay: day,
  });
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
