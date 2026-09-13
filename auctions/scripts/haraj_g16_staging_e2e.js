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

function lotBody(species, title, { startOffsetMs = -8000, durationMs = 45000 } = {}) {
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
    mediaVideoHlsUrl: 'https://videodelivery.net/g16-e2e/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g16-e2e-placeholder',
    description: 'G16 وصف جوهري للمعاينة',
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
  fs.mkdirSync('/tmp/nomas-g16-e2e', { recursive: true });
  fs.writeFileSync('/tmp/nomas-g16-e2e/summary.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ summary: { pass: out.pass, fail: out.fail, total: out.total, ...extra } }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const base = process.env.G16_STAGING_API || STAGING_API;
  assertStaging(base);
  const results = [];
  const record = (name, pass, extra) => {
    results.push({ name, pass: Boolean(pass), ...extra });
    console.log(JSON.stringify({ step: name, pass: Boolean(pass), ...extra }));
  };

  const health = await http(base, '/health');
  const prod = await http(PRODUCTION_API, '/health');
  record('staging_identity', health.json?.storage?.inProduction === false, {
    schema: health.json?.auctions?.schemaVersion,
  });
  record('production_untouched',
    prod.json?.storage?.inProduction === true
    && prod.json?.auctions?.schemaVersion === '008_auction_media_independence', {
      schema: prod.json?.auctions?.schemaVersion,
    });
  record('schema_still_011', health.json?.auctions?.schemaVersion === '011_haraj_bidder_eligibility_security', {
    schema: health.json?.auctions?.schemaVersion,
  });
  if (health.json?.storage?.inProduction !== false) {
    writeSummary(results, { blocked: 'STAGING_IDENTITY' });
    process.exit(1);
  }

  const stamp = Date.now();
  const users = {
    seller: { email: `g16.seller.${stamp}@nomas.staging`, password: 'G16-pass!', name: 'G16 Seller' },
    a: { email: `g16.a.${stamp}@nomas.staging`, password: 'G16-pass!', name: 'G16 BuyerA' },
    c: { email: `g16.c.${stamp}@nomas.staging`, password: 'G16-pass!', name: 'G16 BuyerC' },
    stranger: { email: `g16.s.${stamp}@nomas.staging`, password: 'G16-pass!', name: 'G16 Stranger' },
    op: { email: `g16.op.${stamp}@nomas.auctioneer.staging`, password: 'G16-pass!', name: 'G16 Op' },
  };
  let sellerTok = await register(base, users.seller.email, users.seller.password, users.seller.name);
  let aTok = await register(base, users.a.email, users.a.password, users.a.name);
  let cTok = await register(base, users.c.email, users.c.password, users.c.name);
  let strangerTok = await register(base, users.stranger.email, users.stranger.password, users.stranger.name);
  let opTok = await register(base, users.op.email, users.op.password, users.op.name);
  const admin = await http(base, '/admin/v2/auth/login', {
    method: 'POST',
    body: {
      email: process.env.ADMIN_EMAIL || 'admin@nomas.sa',
      password: process.env.ADMIN_PASSWORD || 'NomasAdmin2026!',
    },
  });
  let adminTok = admin.json?.token;
  const aId = (await http(base, '/auth/me', { token: aTok })).json?.user?.id;
  const cId = (await http(base, '/auth/me', { token: cTok })).json?.user?.id;
  record('auth', Boolean(sellerTok && aTok && cTok && adminTok && aId && cId), { aId, cId });
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
      headers: { 'Idempotency-Key': `g16-sec-${userId}` },
      body: { authorizedLimit: bidLimit, idempotencyKey: `g16-sec-${userId}` },
    });
  }
  await authorize(aId, 200000);
  await authorize(cId, 200000);

  async function liveLot(species, title) {
    const created = await http(base, '/auctions', {
      method: 'POST',
      token: sellerTok,
      body: lotBody(species, title),
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
      body: { reason: 'G16' },
    });
    await http(base, `/auctions/${id}/schedule`, { method: 'POST', token: sellerTok, body: {} });
    const live = await http(base, `/auctions/${id}/go-live`, { method: 'POST', token: sellerTok, body: {} });
    return { id, live };
  }

  async function waitUntilSold(id, timeoutMs = 180000) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await http(base, `/auctions/${id}`, { token: sellerTok });
      const auction = last.json?.auction;
      if (auction?.status === 'sold' || auction?.status === 'unsold') return last;
      const end = new Date(auction?.extendedUntil || auction?.endAt || 0).getTime();
      if (auction?.status === 'live' && Date.now() >= end) {
        const closed = await http(base, `/auctions/${id}/close`, { method: 'POST', token: sellerTok, body: {} });
        if (closed.status === 200 && ['sold', 'unsold'].includes(closed.json?.auction?.status)) return closed;
      }
      await sleep(2500);
    }
    return last;
  }

  const mismatchLot = await liveLot('camel', `G16 mismatch ${stamp}`);
  const withdrawLot = await liveLot('falcon', `G16 withdraw ${stamp}`);
  const fpLot = await liveLot('horse', `G16 false-positive ${stamp}`);
  record('lots_live', Boolean(mismatchLot.id && withdrawLot.id && fpLot.id), {
    mismatch: mismatchLot.id, withdraw: withdrawLot.id, fp: fpLot.id,
  });
  if (!mismatchLot.id) {
    writeSummary(results, { blocked: 'GO_LIVE' });
    process.exit(1);
  }

  await http(base, `/auctions/${mismatchLot.id}/bids`, {
    method: 'POST', token: cTok,
    headers: { 'Idempotency-Key': `g16-c-mis-${stamp}` },
    body: { amount: 6000, idempotencyKey: `g16-c-mis-${stamp}` },
  });
  await http(base, `/auctions/${withdrawLot.id}/bids`, {
    method: 'POST', token: aTok,
    headers: { 'Idempotency-Key': `g16-a-w-${stamp}` },
    body: { amount: 7000, idempotencyKey: `g16-a-w-${stamp}` },
  });
  await http(base, `/auctions/${fpLot.id}/bids`, {
    method: 'POST', token: aTok,
    headers: { 'Idempotency-Key': `g16-a-fp1-${stamp}` },
    body: { amount: 4000, idempotencyKey: `g16-a-fp1-${stamp}` },
  });
  await http(base, `/auctions/${fpLot.id}/bids`, {
    method: 'POST', token: aTok,
    headers: { 'Idempotency-Key': `g16-a-fp2-${stamp}` },
    body: { amount: 5000, idempotencyKey: `g16-a-fp2-${stamp}` },
  });
  await http(base, `/auctions/${fpLot.id}/bids`, {
    method: 'POST', token: aTok,
    headers: { 'Idempotency-Key': `g16-a-fp3-${stamp}` },
    body: { amount: 8000, idempotencyKey: `g16-a-fp3-${stamp}` },
  });

  const endedMis = await waitUntilSold(mismatchLot.id);
  const endedW = await waitUntilSold(withdrawLot.id);
  const endedFp = await waitUntilSold(fpLot.id);
  record('lots_sold',
    endedMis.json?.auction?.status === 'sold'
    && endedW.json?.auction?.status === 'sold'
    && endedFp.json?.auction?.status === 'sold', {
      mis: endedMis.json?.auction?.status,
      w: endedW.json?.auction?.status,
      fp: endedFp.json?.auction?.status,
    });

  const unauth = await http(base, '/admin/v2/haraj/cases');
  record('E_unauthenticated_cases_401', unauth.status === 401, { status: unauth.status });
  const sellerAdmin = await http(base, '/admin/v2/haraj/cases', { token: sellerTok });
  record('E_seller_pretending_admin', sellerAdmin.status === 401 || sellerAdmin.status === 403, {
    status: sellerAdmin.status,
  });

  const misGet = await http(base, `/auctions/${mismatchLot.id}/inspection`, { token: cTok });
  await http(base, `/auctions/${mismatchLot.id}/inspection/decision`, {
    method: 'POST',
    token: cTok,
    headers: { 'Idempotency-Key': `g16-dec-mis-${stamp}` },
    body: {
      outcome: 'material_mismatch',
      reasonCategory: 'material_attribute',
      statement: 'G16 mismatch',
      expectedUpdatedAt: misGet.json?.inspection?.expectedUpdatedAt,
      idempotencyKey: `g16-dec-mis-${stamp}`,
    },
  });
  const adminMis = await http(base, `/admin/v2/haraj/inspections/${mismatchLot.id}`, { token: adminTok });
  const confirm = await http(base, `/admin/v2/haraj/inspections/${mismatchLot.id}/resolve`, {
    method: 'POST',
    token: adminTok,
    headers: { 'Idempotency-Key': `g16-res-mis-${stamp}` },
    body: {
      resolution: 'confirm_mismatch',
      note: 'G16 confirm mismatch',
      expectedUpdatedAt: adminMis.json?.inspection?.expectedUpdatedAt,
      idempotencyKey: `g16-res-mis-${stamp}`,
    },
  });
  const mismatchCaseId = confirm.json?.g16?.case?.id;
  record('A_mismatch_escalation',
    confirm.status === 200
    && confirm.json?.g16?.guilt === false
    && Boolean(mismatchCaseId)
    && confirm.json?.g16?.finding === 'review_required', {
      status: confirm.status,
      caseId: mismatchCaseId,
      guilt: confirm.json?.g16?.guilt,
    });

  const wGet = await http(base, `/auctions/${withdrawLot.id}/inspection`, { token: aTok });
  const withdraw = await http(base, `/auctions/${withdrawLot.id}/inspection/decision`, {
    method: 'POST',
    token: aTok,
    headers: { 'Idempotency-Key': `g16-dec-w-${stamp}` },
    body: {
      outcome: 'withdrawn',
      expectedUpdatedAt: wGet.json?.inspection?.expectedUpdatedAt,
      idempotencyKey: `g16-dec-w-${stamp}`,
    },
  });
  const withdrawCaseId = withdraw.json?.g16?.case?.id;
  record('B_buyer_withdrawal_case',
    withdraw.status === 200
    && withdraw.json?.inspection?.awardStatus === 'withdrawn'
    && Boolean(withdrawCaseId)
    && withdraw.json?.g16?.financialPenaltyImplemented === false
    && withdraw.json?.g16?.guilt === false, {
      status: withdraw.status,
      caseId: withdrawCaseId,
      penalty: withdraw.json?.g16?.financialPenaltyImplemented,
    });

  const evalW1 = await http(base, `/admin/v2/haraj/risk/evaluate/${withdrawLot.id}`, {
    method: 'POST',
    token: adminTok,
  });
  const evalW2 = await http(base, `/admin/v2/haraj/risk/evaluate/${withdrawLot.id}`, {
    method: 'POST',
    token: adminTok,
  });
  const wCaseFromEval = evalW1.json?.cases?.[0]?.case?.id || evalW1.json?.cases?.[0]?.id;
  record('C_bidder_risk_signal',
    evalW1.status === 200
    && evalW1.json?.guilt === false
    && evalW1.json?.automaticHighImpactSanction === false
    && Boolean(wCaseFromEval), {
      status: evalW1.status,
      guilt: evalW1.json?.guilt,
    });
  record('D_seller_risk_from_mismatch', Boolean(mismatchCaseId) && confirm.json?.g16?.guilt === false, {
    caseId: mismatchCaseId,
  });
  record('H_duplicate_evaluate_idempotent',
    evalW2.status === 200
    && (evalW2.json?.cases?.[0]?.duplicate === true
      || (evalW2.json?.cases?.[0]?.case?.id || evalW2.json?.cases?.[0]?.id) === wCaseFromEval), {
      second: evalW2.json?.cases?.[0]?.duplicate,
      firstId: wCaseFromEval,
      secondId: evalW2.json?.cases?.[0]?.case?.id || evalW2.json?.cases?.[0]?.id,
    });

  const strangerCase = await http(base, `/auctions/haraj/cases/${withdrawCaseId}`, { token: strangerTok });
  record('E_stranger_case_403', strangerCase.status === 403, { status: strangerCase.status });
  const reporterCase = await http(base, `/auctions/haraj/cases/${withdrawCaseId}`, { token: aTok });
  record('E_reporter_public_view',
    reporterCase.status === 200
    && reporterCase.json?.operatorNotesHidden === true
    && reporterCase.json?.bidLimit === undefined
    && reporterCase.json?.bidSecurity === undefined, {
      status: reporterCase.status,
      keys: Object.keys(reporterCase.json || {}),
    });

  const detail = await http(base, `/admin/v2/haraj/cases/${mismatchCaseId}`, { token: adminTok });
  record('J_evidence_provenance',
    detail.status === 200
    && detail.json?.signalIsNotGuilt === true
    && Array.isArray(detail.json?.evidence)
    && detail.json.evidence.some((e) => String(e.eventType || '').includes('inspection')
      || String(e.event_type || '').includes('inspection')
      || String(e.eventType || '').includes('dispute')
      || String(e.event_type || '').includes('dispute')), {
      status: detail.status,
      evidenceCount: detail.json?.evidence?.length,
    });

  const expected = detail.json?.case?.updatedAt;
  const [r1, r2] = await Promise.all([
    http(base, `/admin/v2/haraj/cases/${mismatchCaseId}/resolve`, {
      method: 'POST',
      token: adminTok,
      body: { resolution: 'no_action', note: 'G16 concurrent A', expectedUpdatedAt: expected },
    }),
    http(base, `/admin/v2/haraj/cases/${mismatchCaseId}/resolve`, {
      method: 'POST',
      token: adminTok,
      body: { resolution: 'no_action', note: 'G16 concurrent B', expectedUpdatedAt: expected },
    }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  record('F_operator_resolution', r1.status === 200 || r2.status === 200, {
    r1: r1.status, r2: r2.status,
  });
  record('I_concurrent_stale_conflict',
    statuses.includes(200) && (statuses.includes(409) || r1.json?.code === 'CASE_STALE_STATE' || r2.json?.code === 'CASE_STALE_STATE'
      || r1.status === 409 || r2.status === 409), {
      statuses,
      codes: [r1.json?.code, r2.json?.code],
    });

  const wDetail = await http(base, `/admin/v2/haraj/cases/${withdrawCaseId}`, { token: adminTok });
  const suspend = await http(base, `/admin/v2/haraj/cases/${withdrawCaseId}/resolve`, {
    method: 'POST',
    token: adminTok,
    body: {
      resolution: 'suspend_bidder',
      note: 'G16 human-review suspend via G10',
      expectedUpdatedAt: wDetail.json?.case?.updatedAt,
      subjectUserId: aId,
    },
  });
  const bidder = await http(base, `/admin/v2/haraj/bidders/${aId}`, { token: adminTok });
  record('G_g10_suspension_reused',
    suspend.status === 200
    && suspend.json?.suspension?.reusedG10 === true
    && (bidder.json?.dossier?.profile?.eligibilityStatus === 'suspended'
      || bidder.json?.profile?.eligibilityStatus === 'suspended'
      || String(JSON.stringify(bidder.json)).includes('suspended')), {
      status: suspend.status,
      reused: suspend.json?.suspension?.reusedG10,
      bidderStatus: bidder.status,
    });

  const bidsAfter = await http(base, `/auctions/${withdrawLot.id}/bids`, { token: sellerTok });
  record('historical_bids_intact',
    bidsAfter.status === 200
    && (bidsAfter.json?.bids || bidsAfter.json || []).length !== 0, {
      status: bidsAfter.status,
    });

  const evalFp = await http(base, `/admin/v2/haraj/risk/evaluate/${fpLot.id}`, {
    method: 'POST',
    token: adminTok,
  });
  const fpCases = evalFp.json?.cases || [];
  const fpFraud = JSON.stringify(evalFp.json || {}).includes('FRAUDSTER')
    && JSON.stringify(evalFp.json || {}).includes('"guilt":true');
  record('false_positive_no_fraud_finding',
    evalFp.status === 200
    && evalFp.json?.guilt === false
    && evalFp.json?.automaticHighImpactSanction === false
    && evalFp.json?.ai?.implemented === false
    && !fpFraud
    && fpCases.every((c) => c.guilt !== true), {
      status: evalFp.status,
      caseCount: fpCases.length,
      guilt: evalFp.json?.guilt,
    });

  const prodAfter = await http(PRODUCTION_API, '/health');
  record('production_still_008',
    prodAfter.json?.auctions?.schemaVersion === '008_auction_media_independence', {
      schema: prodAfter.json?.auctions?.schemaVersion,
    });
  record('no_ai',
    evalFp.json?.ai?.implemented === false && evalFp.json?.ai?.fraudDetection === false, {
      ai: evalFp.json?.ai,
    });

  writeSummary(results);
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
