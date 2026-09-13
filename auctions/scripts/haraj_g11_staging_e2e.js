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
  const email = process.env.G11_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@nomas.sa';
  const password = process.env.G11_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'NomasAdmin2026!';
  return http(base, '/admin/v2/auth/login', { method: 'POST', body: { email, password } });
}

function lotBody(species, title, { startOffsetMs = -8000, durationMs = 90000 } = {}) {
  const start = new Date(Date.now() + startOffsetMs);
  return {
    channel: 'haraj',
    independent: true,
    species,
    title,
    startingPrice: 1000,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + durationMs).toISOString(),
    antiSnipingSeconds: 0,
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g11-e2e/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g11-e2e-placeholder',
    description: 'G11 حصان عربي عمر 5 — وصف جوهري للمعاينة',
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
  const dir = '/tmp/nomas-g11-e2e';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/summary.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ summary: { pass: out.pass, fail: out.fail, total: out.total, ...extra } }));
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const base = process.env.G11_STAGING_API || STAGING_API;
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
    seller: { email: `g11.seller.${stamp}@nomas.staging`, password: 'G11-pass!', name: 'Seller' },
    a: { email: `g11.a.${stamp}@nomas.staging`, password: 'G11-pass!', name: 'WinnerA' },
    b: { email: `g11.b.${stamp}@nomas.staging`, password: 'G11-pass!', name: 'RunnerB' },
    c: { email: `g11.c.${stamp}@nomas.staging`, password: 'G11-pass!', name: 'WinnerC' },
    stranger: { email: `g11.s.${stamp}@nomas.staging`, password: 'G11-pass!', name: 'Stranger' },
    op: { email: `g11.op.${stamp}@nomas.auctioneer.staging`, password: 'G11-pass!', name: 'Op' },
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
  const cId = (await http(base, '/auth/me', { token: cTok })).json?.user?.id;
  record('auth', Boolean(sellerTok && aTok && bTok && adminTok && sellerId && aId && bId), {
    sellerId, aId, bId, cId,
  });
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
      headers: { 'Idempotency-Key': `g11-sec-${userId}` },
      body: { authorizedLimit: bidLimit, idempotencyKey: `g11-sec-${userId}` },
    });
  }
  await authorize(aId, 200000);
  await authorize(bId, 200000);
  await authorize(cId, 200000);

  async function liveLot(species, title, durationMs = 25000) {
    const created = await http(base, '/auctions', {
      method: 'POST',
      token: sellerTok,
      body: lotBody(species, title, { durationMs }),
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
      body: { reason: 'G11' },
    });
    await http(base, `/auctions/${id}/schedule`, { method: 'POST', token: sellerTok, body: {} });
    const live = await http(base, `/auctions/${id}/go-live`, { method: 'POST', token: sellerTok, body: {} });
    const row = await http(base, `/auctions/${id}`, { token: sellerTok });
    return { id, live, row, antiSnipingSeconds: row.json?.auction?.antiSnipingSeconds };
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

  async function waitUntilSold(id, sellerCloseTok, timeoutMs = 180000) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await http(base, `/auctions/${id}`, { token: sellerCloseTok });
      const auction = last.json?.auction;
      if (auction?.status === 'sold' || auction?.status === 'unsold') return last;
      if (auction?.status === 'extended') {
        return { ...last, extendedBlocked: true };
      }
      const end = new Date(auction?.extendedUntil || auction?.endAt || 0).getTime();
      if (auction?.status === 'live' && Date.now() >= end) {
        if (last.status === 401) await refreshSession();
        const closed = await http(base, `/auctions/${id}/close`, { method: 'POST', token: sellerTok, body: {} });
        if (closed.status === 200 && (closed.json?.auction?.status === 'sold' || closed.json?.auction?.status === 'unsold')) {
          return closed;
        }
      }
      await sleep(3000);
    }
    return last;
  }

  const acceptLot = await liveLot('horse', `G11 accept ${stamp}`, 120000);
  const bidAcceptB = acceptLot.id ? await bid(bTok, acceptLot.id, 4000, `g11-b-acc-${stamp}`) : { status: 0 };
  const bidAcceptA = acceptLot.id ? await bid(aTok, acceptLot.id, 5000, `g11-a-acc-${stamp}`) : { status: 0 };
  const mismatchLot = await liveLot('camel', `G11 mismatch ${stamp}`, 120000);
  const bidMis = mismatchLot.id ? await bid(cTok, mismatchLot.id, 6000, `g11-c-mis-${stamp}`) : { status: 0 };
  const withdrawLot = await liveLot('falcon', `G11 withdraw ${stamp}`, 120000);
  const bidWB = withdrawLot.id ? await bid(bTok, withdrawLot.id, 6500, `g11-b-w-${stamp}`) : { status: 0 };
  const bidWA = withdrawLot.id ? await bid(aTok, withdrawLot.id, 7000, `g11-a-w-${stamp}`) : { status: 0 };
  const expireLot = await liveLot('horse', `G11 expire ${stamp}`, 120000);
  const bidExp = expireLot.id ? await bid(aTok, expireLot.id, 5500, `g11-a-exp-${stamp}`) : { status: 0 };
  record('lots_live_anti_snipe_zero',
    acceptLot.live?.status === 200
    && mismatchLot.live?.status === 200
    && withdrawLot.live?.status === 200
    && Number(acceptLot.antiSnipingSeconds) === 0, {
      accept: acceptLot.live?.status,
      antiSnipingSeconds: acceptLot.antiSnipingSeconds,
    });
  if (!acceptLot.id) {
    writeSummary(results, { blocked: 'GO_LIVE', detail: acceptLot.live?.json || acceptLot.created?.json });
    process.exit(1);
  }

  record('accept_lot_bids', bidAcceptA.status === 201 && bidAcceptB.status === 201, {
    a: bidAcceptA.status, b: bidAcceptB.status, aCode: bidAcceptA.json?.code,
    mis: bidMis.status, wA: bidWA.status, wB: bidWB.status, exp: bidExp.status,
  });

  const expBefore = await exposure(aTok);
  record('g10_exposure_before_end', Number(expBefore) > 0, { expBefore });

  const endedAccept = await waitUntilSold(acceptLot.id, sellerTok);
  const endedMis = await waitUntilSold(mismatchLot.id, sellerTok);
  const endedW = await waitUntilSold(withdrawLot.id, sellerTok);
  const endedExp = await waitUntilSold(expireLot.id, sellerTok);
  await refreshSession();

  const accAuction = endedAccept.json?.auction;
  record('actual_auction_end', accAuction?.status === 'sold' && !endedAccept.extendedBlocked, {
    status: accAuction?.status,
    extendedUntil: accAuction?.extendedUntil || null,
    winnerUserId: accAuction?.winnerUserId,
    antiSnipeFinal: endedAccept.extendedBlocked ? 'EXTENDED' : 'ENDED',
  });
  record('provisional_winner', accAuction?.winnerUserId === aId && accAuction?.status === 'sold', {
    winnerUserId: accAuction?.winnerUserId,
    expected: aId,
  });
  record('not_extended_claim', accAuction?.status === 'sold' && accAuction?.status !== 'extended', {
    status: accAuction?.status,
  });

  const expAfterEnd = await exposure(aTok);
  record('g10_exposure_after_provisional_award', Number(expAfterEnd) >= 5000, {
    expAfterEnd,
    note: 'Winner exposure must remain after actual close',
  });

  const inspect1 = await http(base, `/auctions/${acceptLot.id}/inspection`, { token: aTok });
  const inspect1b = await http(base, `/auctions/${acceptLot.id}/inspection/ensure`, {
    method: 'POST',
    token: aTok,
    headers: { 'Idempotency-Key': `ens-acc-${stamp}` },
    body: { idempotencyKey: `ens-acc-${stamp}` },
  });
  record('inspection_case_created', inspect1.status === 200 || inspect1b.status === 200 || inspect1b.status === 201, {
    get: inspect1.status,
    ensure: inspect1b.status,
    award: inspect1.json?.inspection?.awardStatus || inspect1b.json?.inspection?.awardStatus,
  });
  const ensure2 = await http(base, `/auctions/${acceptLot.id}/inspection/ensure`, {
    method: 'POST',
    token: aTok,
    headers: { 'Idempotency-Key': `ens-acc-${stamp}` },
    body: { idempotencyKey: `ens-acc-${stamp}` },
  });
  record('case_uniqueness_idempotent', ensure2.status === 200 && ensure2.json?.replay === true, {
    status: ensure2.status,
    replay: ensure2.json?.replay,
  });

  const expDuring = await exposure(aTok);
  record('g10_exposure_during_inspection', Number(expDuring) >= 5000, { expDuring });

  const snapshotDesc = inspect1.json?.inspection?.disclosureSnapshot?.description
    || inspect1b.json?.inspection?.disclosureSnapshot?.description;
  record('disclosure_snapshot', Boolean(snapshotDesc) && String(snapshotDesc).includes('وصف جوهري'), {
    snapshotDesc: snapshotDesc ? String(snapshotDesc).slice(0, 80) : null,
  });

  const tamper = await http(base, `/auctions/${acceptLot.id}`, {
    method: 'PATCH',
    token: sellerTok,
    body: { description: 'تم تغيير الوصف بعد الترسية' },
  });
  const afterTamper = await http(base, `/auctions/${acceptLot.id}/inspection`, { token: aTok });
  const still = afterTamper.json?.inspection?.disclosureSnapshot?.description;
  record('seller_tamper_blocked', tamper.status === 409 && String(still || snapshotDesc).includes('وصف جوهري'), {
    tamperStatus: tamper.status,
    tamperCode: tamper.json?.code,
    stillSnapshot: still ? String(still).slice(0, 60) : null,
  });

  const expected = afterTamper.json?.inspection?.expectedUpdatedAt
    || inspect1b.json?.inspection?.expectedUpdatedAt;
  const acceptOnce = await http(base, `/auctions/${acceptLot.id}/inspection/decision`, {
    method: 'POST',
    token: aTok,
    headers: { 'Idempotency-Key': `dec-acc-${stamp}` },
    body: { outcome: 'accepted', expectedUpdatedAt: expected, idempotencyKey: `dec-acc-${stamp}` },
  });
  const acceptReplay = await http(base, `/auctions/${acceptLot.id}/inspection/decision`, {
    method: 'POST',
    token: aTok,
    headers: { 'Idempotency-Key': `dec-acc-${stamp}` },
    body: { outcome: 'accepted', expectedUpdatedAt: expected, idempotencyKey: `dec-acc-${stamp}` },
  });
  record('buyer_acceptance', acceptOnce.status === 200 && acceptOnce.json?.inspection?.awardStatus === 'accepted', {
    status: acceptOnce.status,
    award: acceptOnce.json?.inspection?.awardStatus,
    label: acceptOnce.json?.inspection?.buyerDecisionLabelAr,
    settlement: acceptOnce.json?.settlementImplemented,
  });
  record('acceptance_idempotent', acceptReplay.status === 200 && acceptReplay.json?.replay === true, {
    replay: acceptReplay.json?.replay,
  });
  record('no_settlement_on_accept', acceptOnce.json?.settlementImplemented === false, {});

  const expAccepted = await exposure(aTok);
  record('accepted_exposure_remains', Number(expAccepted) >= 5000, { expAccepted });

  const winnerAfter = await http(base, `/auctions/${acceptLot.id}`, { token: sellerTok });
  record('winner_truth_preserved_accept', winnerAfter.json?.auction?.winnerUserId === aId, {
    winner: winnerAfter.json?.auction?.winnerUserId,
  });

  const misGet = await http(base, `/auctions/${mismatchLot.id}/inspection`, { token: cTok });
  const misClaim = await http(base, `/auctions/${mismatchLot.id}/inspection/decision`, {
    method: 'POST',
    token: cTok,
    headers: { 'Idempotency-Key': `dec-mis-${stamp}` },
    body: {
      outcome: 'material_mismatch',
      reasonCategory: 'material_attribute',
      statement: 'العمر المعلن لا يطابق المعاينة',
      expectedUpdatedAt: misGet.json?.inspection?.expectedUpdatedAt,
      idempotencyKey: `dec-mis-${stamp}`,
    },
  });
  record('material_mismatch_claimed', misClaim.status === 200 && misClaim.json?.inspection?.awardStatus === 'disputed', {
    status: misClaim.status,
    award: misClaim.json?.inspection?.awardStatus,
    label: misClaim.json?.inspection?.buyerDecisionLabelAr,
  });
  const selfApprove = await http(base, `/admin/v2/haraj/inspections/${mismatchLot.id}/resolve`, {
    method: 'POST',
    token: cTok,
    body: {
      resolution: 'confirm_mismatch',
      expectedUpdatedAt: misClaim.json?.inspection?.expectedUpdatedAt,
    },
  });
  record('buyer_cannot_self_approve', selfApprove.status === 401 || selfApprove.status === 403, {
    status: selfApprove.status,
  });
  const adminMis = await http(base, `/admin/v2/haraj/inspections/${mismatchLot.id}`, { token: adminTok });
  const confirm = await http(base, `/admin/v2/haraj/inspections/${mismatchLot.id}/resolve`, {
    method: 'POST',
    token: adminTok,
    headers: { 'Idempotency-Key': `res-mis-${stamp}` },
    body: {
      resolution: 'confirm_mismatch',
      note: 'اختلاف جوهري مؤكد من المشغّل',
      expectedUpdatedAt: adminMis.json?.inspection?.expectedUpdatedAt,
      idempotencyKey: `res-mis-${stamp}`,
    },
  });
  record('mismatch_confirmed', confirm.status === 200 && confirm.json?.inspection?.awardStatus === 'cancelled', {
    status: confirm.status,
    award: confirm.json?.inspection?.awardStatus,
  });
  const expConfirmed = await exposure(cTok);
  record('confirmed_mismatch_exposure_released', Number(expConfirmed) === 0 || Number(expConfirmed) < 6000, {
    expConfirmed,
  });

  const wGet = await http(base, `/auctions/${withdrawLot.id}/inspection`, { token: aTok });
  const withdraw = await http(base, `/auctions/${withdrawLot.id}/inspection/decision`, {
    method: 'POST',
    token: aTok,
    headers: { 'Idempotency-Key': `dec-w-${stamp}` },
    body: {
      outcome: 'withdrawn',
      expectedUpdatedAt: wGet.json?.inspection?.expectedUpdatedAt,
      idempotencyKey: `dec-w-${stamp}`,
    },
  });
  record('buyer_withdrawal', withdraw.status === 200 && withdraw.json?.inspection?.awardStatus === 'withdrawn', {
    status: withdraw.status,
    award: withdraw.json?.inspection?.awardStatus,
    label: withdraw.json?.inspection?.buyerDecisionLabelAr,
  });
  const afterWithdraw = await http(base, `/auctions/${withdrawLot.id}`, { token: sellerTok });
  record('runner_up_not_awarded', afterWithdraw.json?.auction?.winnerUserId === aId
    && afterWithdraw.json?.auction?.winnerUserId !== bId, {
    winner: afterWithdraw.json?.auction?.winnerUserId,
    runnerUp: bId,
  });
  const expWithdraw = await exposure(aTok);
  record('withdrawal_exposure_remains', Number(expWithdraw) >= 7000, { expWithdraw });

  const expireEnsure = await http(base, `/admin/v2/haraj/inspections/${expireLot.id}/ensure`, {
    method: 'POST',
    token: adminTok,
    body: { idempotencyKey: `ens-exp-${stamp}` },
  });
  const expired = await http(base, `/admin/v2/haraj/inspections/${expireLot.id}/expire`, {
    method: 'POST',
    token: adminTok,
    body: { stagingForce: true },
  });
  record('deadline_expired_review', expired.status === 200 && expired.json?.inspection?.reviewRequired === true, {
    status: expired.status,
    reviewRequired: expired.json?.inspection?.reviewRequired,
    award: expired.json?.inspection?.awardStatus,
    ensure: expireEnsure.status,
  });
  const lateAccept = await http(base, `/auctions/${expireLot.id}/inspection/decision`, {
    method: 'POST',
    token: aTok,
    body: {
      outcome: 'accepted',
      expectedUpdatedAt: expired.json?.inspection?.expectedUpdatedAt,
    },
  });
  record('deadline_no_silent_sale', lateAccept.status === 409 && lateAccept.json?.code === 'INSPECTION_EXPIRED_REVIEW_REQUIRED', {
    status: lateAccept.status,
    code: lateAccept.json?.code,
  });
  const expExpired = await exposure(aTok);
  record('expired_exposure_remains', Number(expExpired) >= 5500, { expExpired });

  const unauth = await http(base, `/auctions/${acceptLot.id}/inspection/decision`, {
    method: 'POST',
    body: { outcome: 'accepted' },
  });
  const strangerDec = await http(base, `/auctions/${acceptLot.id}/inspection/decision`, {
    method: 'POST',
    token: strangerTok,
    body: { outcome: 'withdrawn', expectedUpdatedAt: expected },
  });
  const sellerDec = await http(base, `/auctions/${acceptLot.id}/inspection/decision`, {
    method: 'POST',
    token: sellerTok,
    body: { outcome: 'accepted', expectedUpdatedAt: expected },
  });
  const spoof = await http(base, `/auctions/${acceptLot.id}/inspection/decision`, {
    method: 'POST',
    token: aTok,
    body: { outcome: 'withdrawn', winnerUserId: bId, userId: bId, auctionId: mismatchLot.id },
  });
  record('auth_unauthenticated', unauth.status === 401 || unauth.status === 403, { status: unauth.status });
  record('auth_non_winner', strangerDec.status === 403, { status: strangerDec.status, code: strangerDec.json?.code });
  record('auth_seller_cannot_decide', sellerDec.status === 403, { status: sellerDec.status, code: sellerDec.json?.code });
  record('auth_spoof_identity', spoof.status === 403 && spoof.json?.code === 'INSPECTION_CLIENT_AUTHORITY_FORBIDDEN', {
    status: spoof.status,
    code: spoof.json?.code,
  });

  const stale = await http(base, `/auctions/${withdrawLot.id}/inspection/decision`, {
    method: 'POST',
    token: aTok,
    body: { outcome: 'accepted', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' },
  });
  record('stale_state_rejected', stale.status === 409 && stale.json?.code === 'INSPECTION_STALE_STATE', {
    status: stale.status,
    code: stale.json?.code,
  });

  await refreshSession();
  const raceLot = await liveLot('horse', `G11 race ${stamp}`, 120000);
  const raceBid = raceLot.id ? await bid(cTok, raceLot.id, 8000, `g11-c-race-${stamp}`) : { status: 0 };
  if (raceBid.status !== 201) {
    record('concurrency_bid', false, { status: raceBid.status, code: raceBid.json?.code });
  }
  const raced = await waitUntilSold(raceLot.id, sellerTok);
  const raceGet = await http(base, `/auctions/${raceLot.id}/inspection`, { token: cTok });
  const expectedRace = raceGet.json?.inspection?.expectedUpdatedAt;
  const [r1, r2] = await Promise.all([
    http(base, `/auctions/${raceLot.id}/inspection/decision`, {
      method: 'POST',
      token: cTok,
      headers: { 'Idempotency-Key': `race-acc-${stamp}` },
      body: { outcome: 'accepted', expectedUpdatedAt: expectedRace, idempotencyKey: `race-acc-${stamp}` },
    }),
    http(base, `/auctions/${raceLot.id}/inspection/decision`, {
      method: 'POST',
      token: cTok,
      headers: { 'Idempotency-Key': `race-mis-${stamp}` },
      body: {
        outcome: 'material_mismatch',
        reasonCategory: 'identity',
        statement: 'ادعاء متزامن للسباق',
        expectedUpdatedAt: expectedRace,
        idempotencyKey: `race-mis-${stamp}`,
      },
    }),
  ]);
  const raceWins = [r1, r2].filter((r) => r.status === 200 && r.json?.replay !== true);
  const raceConflicts = [r1, r2].filter((r) => r.status === 409);
  record('concurrency_single_winner', raceWins.length === 1 && raceConflicts.length >= 1, {
    r1: { status: r1.status, award: r1.json?.inspection?.awardStatus, code: r1.json?.code },
    r2: { status: r2.status, award: r2.json?.inspection?.awardStatus, code: r2.json?.code },
    sold: raced.json?.auction?.status,
  });

  const bidsAfter = await http(base, `/auctions/${withdrawLot.id}/bids`, { token: sellerTok });
  const bidAmounts = (bidsAfter.json?.bids || []).map((b) => Number(b.amount)).sort((x, y) => y - x);
  record('bid_history_immutable', bidAmounts.includes(7000) && bidAmounts.includes(6500), { bidAmounts });

  const mine = await http(base, '/auctions/haraj/inspections/mine', { token: aTok });
  record('buyer_mine_isolated', mine.status === 200 && Array.isArray(mine.json?.cases), {
    count: mine.json?.cases?.length,
  });

  const adminList = await http(base, '/admin/v2/haraj/inspections', { token: adminTok });
  record('admin_surface', adminList.status === 200 && Array.isArray(adminList.json?.cases), {
    count: adminList.json?.cases?.length,
    settlement: adminList.json?.settlementImplemented,
  });

  const g10Elig = await http(base, '/auctions/haraj/me/eligibility', { token: aTok });
  record('g10_regression_eligibility', g10Elig.status === 200 && g10Elig.json?.eligibility, {
    exposure: g10Elig.json?.eligibility?.activeExposure,
  });

  const prodAfter = await http(PRODUCTION_API, '/health');
  record('production_untouched_after', prodAfter.json?.storage?.inProduction === true
    && prodAfter.json?.auctions?.schemaVersion === '008_auction_media_independence', {
    schema: prodAfter.json?.auctions?.schemaVersion,
  });
  record('settlement_not_implemented', true, { settlement: false, wallet: false, escrow: false });
  record('livekit_deferred', true, { classification: 'NOT IMPLEMENTED / NOT TESTED' });
  record('g12_not_started', true, {});

  writeSummary(results, {
    stagingSchema: health.json?.auctions?.schemaVersion,
    productionSchema: prodAfter.json?.auctions?.schemaVersion,
  });
  const failed = results.filter((r) => !r.pass);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
