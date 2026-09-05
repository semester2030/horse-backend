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
  const email = process.env.G5_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@nomas.sa';
  const password = process.env.G5_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'NomasAdmin2026!';
  return http(base, '/admin/v2/auth/login', { method: 'POST', body: { email, password } });
}

function windowFor(hours = 48) {
  const start = new Date(Date.now() + hours * 3600000);
  return {
    scheduledStartAt: start.toISOString(),
    scheduledEndAt: new Date(start.getTime() + 4 * 3600000).toISOString(),
    timezone: 'Asia/Riyadh',
  };
}

async function main() {
  const base = process.env.G5_STAGING_API || STAGING_API;
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
  const prodRoute = await http(PRODUCTION_API, '/admin/v2/haraj/sessions');
  record('production_g5_absent_or_unauth', prodRoute.status === 401 || prodRoute.status === 404, {
    status: prodRoute.status,
  });

  const stamp = Date.now();
  const sellerTok = await register(base, `g5.seller.${stamp}@nomas.staging`, 'G5-pass!', 'Seller');
  const opTok = await register(base, `g5.op.${stamp}@nomas.auctioneer.staging`, 'G5-pass!', 'Auctioneer');
  const op2Tok = await register(base, `g5.op2.${stamp}@nomas.auctioneer.staging`, 'G5-pass!', 'Auctioneer2');
  record('user_auth', Boolean(sellerTok && opTok && op2Tok), {});

  const meOp = await http(base, '/auth/me', { token: opTok });
  const opId = meOp.json?.user?.id;
  const meOp2 = await http(base, '/auth/me', { token: op2Tok });
  const op2Id = meOp2.json?.user?.id;
  record('auctioneer_ids', Boolean(opId && op2Id), { opId, op2Id });

  const unauth = await http(base, '/admin/v2/haraj/sessions', { method: 'POST', body: { category: 'horse', ...windowFor() } });
  record('unauth_create', unauth.status === 401, { status: unauth.status });
  const sellerCreate = await http(base, '/admin/v2/haraj/sessions', {
    method: 'POST',
    token: sellerTok,
    body: { category: 'horse', ...windowFor() },
  });
  record('seller_create_denied', sellerCreate.status === 401 || sellerCreate.status === 403, { status: sellerCreate.status });
  const opCreate = await http(base, '/admin/v2/haraj/sessions', {
    method: 'POST',
    token: opTok,
    body: { category: 'horse', ...windowFor() },
  });
  record('auctioneer_create_denied', opCreate.status === 401 || opCreate.status === 403, { status: opCreate.status });

  const admin = await adminLogin(base);
  const adminTok = admin.json?.token;
  record('admin_login', admin.status === 200 && Boolean(adminTok), { status: admin.status });
  if (!adminTok) {
    const summary = { ok: false, pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length, total: results.length, results, blocked: 'ADMIN_LOGIN' };
    require('fs').writeFileSync('/tmp/nomas_g5_staging_e2e.json', JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ summary: true, ...summary }, null, 2));
    process.exit(1);
  }

  const cats = await http(base, '/admin/v2/haraj/categories', { token: adminTok });
  record('categories', cats.status === 200 && (cats.json?.categories || []).length === 3, {
    status: cats.status,
    codes: (cats.json?.categories || []).map((c) => c.code),
  });

  const sheep = await http(base, '/admin/v2/haraj/sessions', {
    method: 'POST',
    token: adminTok,
    body: { category: 'sheep', ...windowFor() },
  });
  record('invalid_category', sheep.status === 400, { status: sheep.status, code: sheep.json?.code });

  const badRange = await http(base, '/admin/v2/haraj/sessions', {
    method: 'POST',
    token: adminTok,
    body: {
      category: 'horse',
      scheduledStartAt: '2026-09-10T22:00:00+03:00',
      scheduledEndAt: '2026-09-10T18:00:00+03:00',
      timezone: 'Asia/Riyadh',
    },
  });
  record('invalid_time_range', badRange.status === 400, { status: badRange.status, code: badRange.json?.code });

  const spoofActor = await http(base, '/admin/v2/haraj/sessions', {
    method: 'POST',
    token: adminTok,
    body: { category: 'horse', ...windowFor(), createdBy: 'not-admin' },
  });
  record('spoofed_created_by', spoofActor.status === 403, { status: spoofActor.status });

  const created = [];
  const offsets = { horse: 48, camel: 60, falcon: 72 };
  for (const category of ['horse', 'camel', 'falcon']) {
    const key = `g5-${category}-${stamp}`;
    const session = await http(base, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: adminTok,
      headers: { 'Idempotency-Key': key },
      body: { category, ...windowFor(offsets[category]) },
    });
    const replay = await http(base, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: adminTok,
      headers: { 'Idempotency-Key': key },
      body: { category, ...windowFor(offsets[category] + 24) },
    });
    created.push({ category, session: session.json?.session, replayId: replay.json?.session?.id });
    record(`session_${category}`, session.status === 201 && replay.json?.session?.id === session.json?.session?.id, {
      status: session.status,
      id: session.json?.session?.id,
      tz: session.json?.session?.timezone,
      source: session.json?.session?.generationSource,
    });
  }

  const horse = created.find((c) => c.category === 'horse')?.session;
  const camel = created.find((c) => c.category === 'camel')?.session;
  const falcon = created.find((c) => c.category === 'falcon')?.session;

  const camelRoomOnHorse = await http(base, `/admin/v2/haraj/sessions/${horse.id}/rooms`, {
    method: 'POST',
    token: adminTok,
    body: { category: 'camel', code: `camel-wrong-${stamp}`, nameAr: 'إبل خطأ', auctioneerUserId: opId },
  });
  record('category_mismatch', camelRoomOnHorse.status === 409, {
    status: camelRoomOnHorse.status,
    code: camelRoomOnHorse.json?.code,
  });

  const horseA = await http(base, `/admin/v2/haraj/sessions/${horse.id}/rooms`, {
    method: 'POST',
    token: adminTok,
    body: { category: 'horse', code: `horse-a-${stamp}`, nameAr: 'غرفة الخيل أ', auctioneerUserId: opId },
  });
  record('horse_room_a', horseA.status === 201 && horseA.json?.roomSession?.activeLotId == null, {
    status: horseA.status,
    rooms: horseA.json?.session?.rooms?.length,
  });

  const conflict = await http(base, `/admin/v2/haraj/sessions/${horse.id}/rooms`, {
    method: 'POST',
    token: adminTok,
    body: { category: 'horse', code: `horse-b-${stamp}`, nameAr: 'غرفة الخيل ب', auctioneerUserId: opId },
  });
  record('auctioneer_overlap', conflict.status === 409 && conflict.json?.code === 'HARAJ_AUCTIONEER_CONFLICT', {
    status: conflict.status,
    code: conflict.json?.code,
  });

  const horseB = await http(base, `/admin/v2/haraj/sessions/${horse.id}/rooms`, {
    method: 'POST',
    token: adminTok,
    body: { category: 'horse', code: `horse-b-${stamp}`, nameAr: 'غرفة الخيل ب', auctioneerUserId: op2Id },
  });
  const camelR = await http(base, `/admin/v2/haraj/sessions/${camel.id}/rooms`, {
    method: 'POST',
    token: adminTok,
    body: { category: 'camel', code: `camel-a-${stamp}`, nameAr: 'غرفة الإبل', auctioneerUserId: opId },
  });
  const falconR = await http(base, `/admin/v2/haraj/sessions/${falcon.id}/rooms`, {
    method: 'POST',
    token: adminTok,
    body: { category: 'falcon', code: `falcon-a-${stamp}`, nameAr: 'غرفة الصقور', auctioneerUserId: op2Id },
  });
  record('multi_category_rooms', horseB.status === 201 && camelR.status === 201 && falconR.status === 201, {
    horseRooms: horseB.json?.session?.rooms?.length,
    camel: camelR.status,
    falcon: falconR.status,
  });

  const scale = [];
  for (let i = 0; i < 4; i += 1) {
    const extraOp = await register(base, `g5.scale.${i}.${stamp}@nomas.auctioneer.staging`, 'G5-pass!', `Scale${i}`);
    const extraMe = await http(base, '/auth/me', { token: extraOp });
    const extraId = extraMe.json?.user?.id;
    const extraSess = await http(base, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: adminTok,
      body: { category: 'horse', ...windowFor(80 + i) },
    });
    const extraRoom = await http(base, `/admin/v2/haraj/sessions/${extraSess.json?.session?.id}/rooms`, {
      method: 'POST',
      token: adminTok,
      body: { category: 'horse', code: `horse-scale-${i}-${stamp}`, nameAr: `غرفة ${i}`, auctioneerUserId: extraId },
    });
    scale.push(extraRoom.status === 201);
  }
  record('multi_room_architecture', scale.every(Boolean) && scale.length === 4, { created: scale.length });

  const read = await http(base, `/admin/v2/haraj/sessions/${horse.id}`, { token: adminTok });
  record('read_session_rooms', read.status === 200 && (read.json?.session?.rooms || []).length === 2, {
    rooms: (read.json?.session?.rooms || []).map((r) => r.room?.code),
  });

  const invalidSession = await http(base, '/admin/v2/haraj/sessions/not-a-uuid', { token: adminTok });
  record('invalid_session', invalidSession.status >= 400, { status: invalidSession.status });

  const cancel = await http(base, `/admin/v2/haraj/sessions/${horse.id}/cancel`, {
    method: 'POST',
    token: adminTok,
    body: { reason: 'e2e' },
  });
  const mutateCancelled = await http(base, `/admin/v2/haraj/sessions/${horse.id}/rooms`, {
    method: 'POST',
    token: adminTok,
    body: { category: 'horse', code: `horse-late-${stamp}`, auctioneerUserId: op2Id },
  });
  record('cancel_then_block', cancel.status === 200 && mutateCancelled.status === 409, {
    cancel: cancel.json?.session?.status,
    mutate: mutateCancelled.status,
  });

  const eligible = await http(base, '/admin/v2/haraj/lots/eligible?species=horse', { token: adminTok });
  record('eligible_lots_endpoint', eligible.status === 200, {
    status: eligible.status,
    count: eligible.json?.auctions?.length,
    queueAssigned: eligible.json?.queueAssigned,
  });

  const summary = {
    ok: results.every((r) => r.pass),
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    total: results.length,
    results,
    productionWrites: false,
  };
  require('fs').writeFileSync('/tmp/nomas_g5_staging_e2e.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summary: true, ...summary }, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
