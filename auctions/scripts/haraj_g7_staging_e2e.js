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
  const email = process.env.G7_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@nomas.sa';
  const password = process.env.G7_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'NomasAdmin2026!';
  return http(base, '/admin/v2/auth/login', { method: 'POST', body: { email, password } });
}

function lotBody(species, title) {
  const start = new Date(Date.now() + 7 * 86400000);
  return {
    channel: 'haraj',
    independent: true,
    species,
    title,
    startingPrice: 1900,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 2 * 3600000).toISOString(),
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g7-e2e/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g7-e2e-placeholder',
    description: 'G7 staging lot',
    inspection: { available: true, windows: 'بعد العصر' },
  };
}

function windowFor(hours) {
  const start = new Date(Date.now() + hours * 3600000);
  return {
    scheduledStartAt: start.toISOString(),
    scheduledEndAt: new Date(start.getTime() + 4 * 3600000).toISOString(),
    timezone: 'Asia/Riyadh',
  };
}

async function main() {
  const base = process.env.G7_STAGING_API || STAGING_API;
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
  const prodRoute = await http(PRODUCTION_API, '/admin/v2/haraj/room-sessions/00000000-0000-4000-8000-000000000000/queue', {
    method: 'POST',
    body: { auctionId: '00000000-0000-4000-8000-000000000000' },
  });
  record('production_g7_absent_or_unauth', prodRoute.status === 401 || prodRoute.status === 404, {
    status: prodRoute.status,
  });

  const stamp = Date.now();
  const sellerTok = await register(base, `g7.seller.${stamp}@nomas.staging`, 'G7-pass!', 'Seller');
  const bidderTok = await register(base, `g7.bidder.${stamp}@nomas.staging`, 'G7-pass!', 'Bidder');
  const opTok = await register(base, `g7.op.${stamp}@nomas.auctioneer.staging`, 'G7-pass!', 'Auctioneer');
  const op2Tok = await register(base, `g7.op2.${stamp}@nomas.auctioneer.staging`, 'G7-pass!', 'Auctioneer2');
  record('user_auth', Boolean(sellerTok && bidderTok && opTok && op2Tok), {});

  const opId = (await http(base, '/auth/me', { token: opTok })).json?.user?.id;
  const op2Id = (await http(base, '/auth/me', { token: op2Tok })).json?.user?.id;
  record('auctioneer_ids', Boolean(opId && op2Id), { opId, op2Id });

  const admin = await adminLogin(base);
  const adminTok = admin.json?.token;
  record('admin_login', admin.status === 200 && Boolean(adminTok), { status: admin.status });
  if (!adminTok) {
    const summary = {
      ok: false,
      pass: results.filter((r) => r.pass).length,
      fail: results.filter((r) => !r.pass).length,
      total: results.length,
      blocked: 'ADMIN_LOGIN',
    };
    require('fs').writeFileSync('/tmp/nomas_g7_staging_e2e.json', JSON.stringify({ ...summary, results }, null, 2));
    process.exit(1);
  }

  async function createApproved(species, title) {
    const created = await http(base, '/auctions', {
      method: 'POST',
      token: sellerTok,
      body: lotBody(species, title),
    });
    const id = created.json?.auction?.id;
    await http(base, `/auctions/${id}/submit-review`, {
      method: 'POST',
      token: sellerTok,
      body: { channel: 'haraj' },
    });
    const accept = await http(base, `/auctions/haraj/review/${id}/accept`, {
      method: 'POST',
      token: opTok,
      body: { reason: 'G7 approved' },
    });
    return { id, created, accept };
  }

  const horseA = await createApproved('horse', `G7 horse A ${stamp}`);
  const horseB = await createApproved('horse', `G7 horse B ${stamp}`);
  const camelLot = await createApproved('camel', `G7 camel ${stamp}`);
  record('seller_submit_auctioneer_approve', Boolean(horseA.id && horseB.id && camelLot.id)
    && horseA.accept.json?.auction?.status === 'review'
    && horseA.accept.json?.auction?.id === horseA.id, {
    horseA: horseA.id,
    horseB: horseB.id,
    camel: camelLot.id,
    status: horseA.accept.json?.auction?.status,
  });

  const draft = await http(base, '/auctions', {
    method: 'POST',
    token: sellerTok,
    body: lotBody('horse', `G7 draft ${stamp}`),
  });
  const draftId = draft.json?.auction?.id;
  record('draft_created', draft.status === 201 && Boolean(draftId), { draftId });

  const horseSession = await http(base, '/admin/v2/haraj/sessions', {
    method: 'POST',
    token: adminTok,
    body: { category: 'horse', ...windowFor(40) },
  });
  const camelSession = await http(base, '/admin/v2/haraj/sessions', {
    method: 'POST',
    token: adminTok,
    body: { category: 'camel', ...windowFor(52) },
  });
  record('sessions', horseSession.status === 201 && camelSession.status === 201, {
    horse: horseSession.json?.session?.id,
    camel: camelSession.json?.session?.id,
  });

  const horseAttach = await http(base, `/admin/v2/haraj/sessions/${horseSession.json.session.id}/rooms`, {
    method: 'POST',
    token: adminTok,
    body: {
      category: 'horse',
      code: `g7-horse-${stamp}`,
      nameAr: 'خيل G7',
      auctioneerUserId: opId,
    },
  });
  const camelAttach = await http(base, `/admin/v2/haraj/sessions/${camelSession.json.session.id}/rooms`, {
    method: 'POST',
    token: adminTok,
    body: {
      category: 'camel',
      code: `g7-camel-${stamp}`,
      nameAr: 'إبل G7',
      auctioneerUserId: op2Id,
    },
  });
  const horseRs = horseAttach.json?.roomSession?.id;
  const camelRs = camelAttach.json?.roomSession?.id;
  record('room_occurrences', horseAttach.status === 201 && camelAttach.status === 201 && Boolean(horseRs && camelRs), {
    horseRs,
    camelRs,
    activeLot: horseAttach.json?.roomSession?.activeLotId || null,
  });

  const unauth = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, {
    method: 'POST',
    body: { auctionId: horseA.id },
  });
  record('unauth_assign', unauth.status === 401, { status: unauth.status });

  const sellerAssign = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, {
    method: 'POST',
    token: sellerTok,
    body: { auctionId: horseA.id },
  });
  record('seller_assign_denied', sellerAssign.status === 401 || sellerAssign.status === 403, {
    status: sellerAssign.status,
  });

  const bidderAssign = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, {
    method: 'POST',
    token: bidderTok,
    body: { auctionId: horseA.id },
  });
  record('bidder_assign_denied', bidderAssign.status === 401 || bidderAssign.status === 403, {
    status: bidderAssign.status,
  });

  const opAssign = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, {
    method: 'POST',
    token: opTok,
    body: { auctionId: horseA.id },
  });
  record('auctioneer_assign_denied', opAssign.status === 401 || opAssign.status === 403, {
    status: opAssign.status,
  });

  const spoof = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, {
    method: 'POST',
    token: adminTok,
    body: { auctionId: horseA.id, createdBy: 'spoof-operator' },
  });
  record('spoofed_created_by', spoof.status === 403, { status: spoof.status, code: spoof.json?.code });

  const draftAssign = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, {
    method: 'POST',
    token: adminTok,
    body: { auctionId: draftId },
  });
  record('draft_rejected', draftAssign.status === 409 && draftAssign.json?.code === 'HARAJ_LOT_NOT_APPROVED', {
    status: draftAssign.status,
    code: draftAssign.json?.code,
  });

  const mismatch = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, {
    method: 'POST',
    token: adminTok,
    body: { auctionId: camelLot.id },
  });
  record('category_mismatch', mismatch.status === 409 && mismatch.json?.code === 'HARAJ_CATEGORY_MISMATCH', {
    status: mismatch.status,
    code: mismatch.json?.code,
  });

  const key = `g7-assign-${stamp}`;
  const [c1, c2] = await Promise.all([
    http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, {
      method: 'POST',
      token: adminTok,
      headers: { 'Idempotency-Key': key },
      body: { auctionId: horseA.id },
    }),
    http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, {
      method: 'POST',
      token: adminTok,
      headers: { 'Idempotency-Key': key },
      body: { auctionId: horseA.id },
    }),
  ]);
  const assignA = c1.status === 201 ? c1 : c2;
  record('assign_approved_lot', assignA.status === 201
    && assignA.json?.entry?.auctionId === horseA.id
    && assignA.json?.entry?.lotId === horseA.id
    && assignA.json?.lotId === horseA.id, {
    status: assignA.status,
    entryId: assignA.json?.entry?.id,
    lotId: assignA.json?.lotId,
  });
  record('concurrent_idempotent_one_entry', c1.json?.entry?.id === c2.json?.entry?.id
    && (c1.status === 201 || c1.status === 200)
    && (c2.status === 201 || c2.status === 200), {
    a: c1.status,
    b: c2.status,
    idA: c1.json?.entry?.id,
    idB: c2.json?.entry?.id,
  });

  const replay = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, {
    method: 'POST',
    token: adminTok,
    headers: { 'Idempotency-Key': key },
    body: { auctionId: horseA.id },
  });
  record('replay_same_entry', replay.status === 201 && replay.json?.entry?.id === assignA.json?.entry?.id, {
    status: replay.status,
    entryId: replay.json?.entry?.id,
  });

  const assignB = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, {
    method: 'POST',
    token: adminTok,
    body: { auctionId: horseB.id },
  });
  record('second_lot_queued', assignB.status === 201 && assignB.json?.entry?.position === 2, {
    status: assignB.status,
    position: assignB.json?.entry?.position,
  });

  const crossRoom = await http(base, `/admin/v2/haraj/room-sessions/${camelRs}/queue`, {
    method: 'POST',
    token: adminTok,
    body: { auctionId: horseA.id },
  });
  record('duplicate_cross_room_or_mismatch', crossRoom.status === 409, {
    status: crossRoom.status,
    code: crossRoom.json?.code,
  });

  const listed = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue`, { token: adminTok });
  const queued = (listed.json?.entries || []).filter((e) => e.status === 'queued' || e.status === 'ready');
  record('queue_read', listed.status === 200 && listed.json?.lotIdIsAuctionId === true && listed.json?.liveActivated === false && queued.length === 2, {
    status: listed.status,
    count: queued.length,
  });

  const reorder = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/queue/reorder`, {
    method: 'POST',
    token: adminTok,
    body: { entryIds: [assignB.json.entry.id, assignA.json.entry.id] },
  });
  const afterOrder = (reorder.json?.entries || []).filter((e) => e.status === 'queued');
  record('reorder', reorder.status === 200 && afterOrder[0]?.id === assignB.json.entry.id && afterOrder[0]?.position === 1, {
    status: reorder.status,
    first: afterOrder[0]?.auctionId,
  });

  const noReason = await http(base, `/admin/v2/haraj/queue-entries/${assignB.json.entry.id}/withdraw`, {
    method: 'POST',
    token: adminTok,
    body: {},
  });
  record('withdraw_requires_reason', noReason.status === 400, { status: noReason.status });

  const withdraw = await http(base, `/admin/v2/haraj/queue-entries/${assignB.json.entry.id}/withdraw`, {
    method: 'POST',
    token: adminTok,
    body: { reason: 'انسحاب G7 قبل التشغيل' },
  });
  const still = await http(base, `/auctions/${horseB.id}`, { token: sellerTok });
  record('withdraw_keeps_auction', withdraw.status === 200
    && withdraw.json?.entry?.status === 'withdrawn'
    && still.json?.auction?.id === horseB.id, {
    status: withdraw.status,
    auctionId: still.json?.auction?.id,
    auctionStatus: still.json?.auction?.status,
  });

  const eligible = await http(base, '/admin/v2/haraj/lots/eligible?species=horse', { token: adminTok });
  const rowA = (eligible.json?.auctions || []).find((a) => a.id === horseA.id);
  record('eligible_queue_flag', eligible.status === 200 && rowA?.queueAssigned === true && eligible.json?.lotIdIsAuctionId === true, {
    status: eligible.status,
    queueAssigned: rowA?.queueAssigned,
  });

  const auctionUnchanged = await http(base, `/auctions/${horseA.id}`, { token: sellerTok });
  record('auction_id_preserved', auctionUnchanged.status === 200
    && auctionUnchanged.json?.auction?.id === horseA.id
    && auctionUnchanged.json?.auction?.status === 'review', {
    id: auctionUnchanged.json?.auction?.id,
    status: auctionUnchanged.json?.auction?.status,
    currentPrice: auctionUnchanged.json?.auction?.currentPrice,
  });

  const activateMissing = await http(base, `/admin/v2/haraj/room-sessions/${horseRs}/activate`, {
    method: 'POST',
    token: adminTok,
    body: { auctionId: horseA.id },
  });
  record('g8_activate_absent', activateMissing.status === 404 || activateMissing.status === 401, {
    status: activateMissing.status,
  });

  const summary = {
    ok: results.every((r) => r.pass),
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    total: results.length,
    schema: health.json?.auctions?.schemaVersion,
    results,
  };
  require('fs').writeFileSync('/tmp/nomas_g7_staging_e2e.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summary: true, ...summary }, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
