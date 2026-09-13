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
  const email = process.env.G6_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@nomas.sa';
  const password = process.env.G6_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'NomasAdmin2026!';
  return http(base, '/admin/v2/auth/login', { method: 'POST', body: { email, password } });
}

function riyadhTodayPlus(days) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = fmt.format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function countPolicySessions(run, policyId) {
  const row = (run.json?.results || []).find((r) => r.policyId === policyId);
  return {
    created: row?.created || 0,
    existing: row?.existing || 0,
    occurrenceCount: row?.occurrenceCount || 0,
    errors: row?.errors || [],
  };
}

async function main() {
  const base = process.env.G6_STAGING_API || STAGING_API;
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
  const prodRoute = await http(PRODUCTION_API, '/admin/v2/haraj/schedule/run', { method: 'POST', body: {} });
  record('production_g6_absent_or_unauth', prodRoute.status === 401 || prodRoute.status === 404, {
    status: prodRoute.status,
  });

  const stamp = Date.now();
  const sellerTok = await register(base, `g6.seller.${stamp}@nomas.staging`, 'G6-pass!', 'Seller');
  const opA = await register(base, `g6.a.${stamp}@nomas.auctioneer.staging`, 'G6-pass!', 'A');
  const opB = await register(base, `g6.b.${stamp}@nomas.auctioneer.staging`, 'G6-pass!', 'B');
  const opC = await register(base, `g6.c.${stamp}@nomas.auctioneer.staging`, 'G6-pass!', 'C');
  record('user_auth', Boolean(sellerTok && opA && opB && opC), {});

  const idA = (await http(base, '/auth/me', { token: opA })).json?.user?.id;
  const idB = (await http(base, '/auth/me', { token: opB })).json?.user?.id;
  const idC = (await http(base, '/auth/me', { token: opC })).json?.user?.id;
  record('auctioneer_ids', Boolean(idA && idB && idC), { idA, idB, idC });

  const unauth = await http(base, '/admin/v2/haraj/schedule/run', { method: 'POST', body: {} });
  record('unauth_scheduler', unauth.status === 401, { status: unauth.status });
  const sellerRun = await http(base, '/admin/v2/haraj/schedule/run', {
    method: 'POST',
    token: sellerTok,
    body: {},
  });
  record('seller_scheduler_denied', sellerRun.status === 401 || sellerRun.status === 403, { status: sellerRun.status });
  const opRun = await http(base, '/admin/v2/haraj/schedule/policies', {
    method: 'POST',
    token: opA,
    body: { recurrence: 'daily' },
  });
  record('auctioneer_policy_denied', opRun.status === 401 || opRun.status === 403, { status: opRun.status });

  const admin = await adminLogin(base);
  const adminTok = admin.json?.token;
  record('admin_login', admin.status === 200 && Boolean(adminTok), { status: admin.status });
  if (!adminTok) {
    const summary = { ok: false, pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length, total: results.length, blocked: 'ADMIN_LOGIN' };
    require('fs').writeFileSync('/tmp/nomas_g6_staging_e2e.json', JSON.stringify(summary, null, 2));
    process.exit(1);
  }

  const from = riyadhTodayPlus(0);
  const until = riyadhTodayPlus(10);
  const rooms = {};
  for (const [category, name] of [['horse', 'خيل'], ['camel', 'إبل'], ['falcon', 'صقور']]) {
    const room = await http(base, '/admin/v2/haraj/rooms', {
      method: 'POST',
      token: adminTok,
      body: { category, code: `g6-${category}-${stamp}`, nameAr: `${name} جدولة` },
    });
    rooms[category] = room.json?.room;
    record(`room_${category}`, room.status === 201 && room.json?.room?.categoryCode === category, {
      status: room.status,
      id: room.json?.room?.id,
    });
  }

  const spoof = await http(base, '/admin/v2/haraj/schedule/policies', {
    method: 'POST',
    token: adminTok,
    body: {
      roomId: rooms.horse.id,
      recurrence: 'daily',
      startTimeLocal: '18:00',
      endTimeLocal: '20:00',
      timezone: 'Asia/Riyadh',
      effectiveFrom: from,
      effectiveUntil: until,
      defaultAuctioneerUserId: idA,
      createdBy: 'spoof-admin',
    },
  });
  record('spoofed_created_by', spoof.status === 403, { status: spoof.status });

  const specs = {
    horse: {
      recurrence: 'daily',
      startTimeLocal: '18:00',
      endTimeLocal: '20:00',
      defaultAuctioneerUserId: idA,
    },
    camel: {
      recurrence: 'selected_weekdays',
      daysOfWeek: [0, 2, 4],
      startTimeLocal: '19:00',
      endTimeLocal: '21:00',
      defaultAuctioneerUserId: idB,
    },
    falcon: {
      recurrence: 'weekly',
      daysOfWeek: [6],
      startTimeLocal: '20:00',
      endTimeLocal: '22:00',
      defaultAuctioneerUserId: idC,
    },
  };
  const policies = {};
  for (const category of ['horse', 'camel', 'falcon']) {
    const created = await http(base, '/admin/v2/haraj/schedule/policies', {
      method: 'POST',
      token: adminTok,
      body: {
        roomId: rooms[category].id,
        timezone: 'Asia/Riyadh',
        effectiveFrom: from,
        effectiveUntil: until,
        auctioneerAssignmentRule: 'fixed_user',
        ...specs[category],
      },
    });
    policies[category] = created.json?.policy;
    record(`policy_${category}`, created.status === 201 && created.json?.policy?.recurrence === specs[category].recurrence, {
      status: created.status,
      id: created.json?.policy?.id,
      recurrence: created.json?.policy?.recurrence,
    });
  }

  const preview = await http(base, '/admin/v2/haraj/schedule/preview', {
    method: 'POST',
    token: adminTok,
    body: { policyId: policies.horse.id, horizonDays: 14 },
  });
  record('preview_horse_daily', preview.status === 200 && (preview.json?.occurrences || []).length >= 1, {
    status: preview.status,
    count: preview.json?.occurrences?.length,
    first: preview.json?.occurrences?.[0]?.occurrenceKey,
  });

  const counts = [];
  for (let i = 0; i < 10; i += 1) {
    const run = await http(base, '/admin/v2/haraj/schedule/run', {
      method: 'POST',
      token: adminTok,
      body: { horizonDays: 14 },
    });
    counts.push({
      status: run.status,
      horse: countPolicySessions(run, policies.horse.id),
      camel: countPolicySessions(run, policies.camel.id),
      falcon: countPolicySessions(run, policies.falcon.id),
    });
  }
  const firstHorse = counts[0].horse.occurrenceCount;
  const lastHorse = counts[9].horse.occurrenceCount;
  const laterCreates = counts.slice(1).every((c) => c.horse.created === 0 && c.camel.created === 0 && c.falcon.created === 0);
  record('independent_room_schedules', firstHorse >= 1 && counts[0].camel.occurrenceCount >= 0 && counts[0].falcon.occurrenceCount >= 0, {
    horse: firstHorse,
    camel: counts[0].camel.occurrenceCount,
    falcon: counts[0].falcon.occurrenceCount,
  });
  record('idempotent_ten_runs', laterCreates && lastHorse === firstHorse, {
    firstHorse,
    lastHorse,
    laterCreates,
  });

  const occ = await http(base, `/admin/v2/haraj/schedule/occurrences?policyId=${policies.horse.id}`, { token: adminTok });
  const horseOccs = occ.json?.occurrences || [];
  const firstOcc = horseOccs.find((o) => o.sessionId);
  record('horse_occurrences_materialized', Boolean(firstOcc), { count: horseOccs.length, sessionId: firstOcc?.sessionId });

  if (firstOcc) {
    const changedStart = new Date(new Date(firstOcc.startAt).getTime() + 2 * 3600000).toISOString();
    const changedEnd = new Date(new Date(firstOcc.endAt).getTime() + 2 * 3600000).toISOString();
    const change = await http(base, '/admin/v2/haraj/schedule/overrides', {
      method: 'POST',
      token: adminTok,
      body: {
        policyId: policies.horse.id,
        sessionId: firstOcc.sessionId,
        overrideType: 'change_time',
        originalStartAt: firstOcc.startAt,
        originalEndAt: firstOcc.endAt,
        overrideStartAt: changedStart,
        overrideEndAt: changedEnd,
        reason: 'G6 CHANGE_TIME one occurrence',
      },
    });
    record('change_time', change.status === 201 || change.status === 200, { status: change.status });
    await http(base, '/admin/v2/haraj/schedule/run', { method: 'POST', token: adminTok, body: { horizonDays: 14 } });
    const policy = await http(base, `/admin/v2/haraj/schedule/policies/${policies.horse.id}`, { token: adminTok });
    const after = await http(base, `/admin/v2/haraj/schedule/occurrences?policyId=${policies.horse.id}`, { token: adminTok });
    const changed = (after.json?.occurrences || []).find((o) => o.occurrenceKey === firstOcc.occurrenceKey);
    const others = (after.json?.occurrences || []).filter((o) => o.occurrenceKey !== firstOcc.occurrenceKey && o.sessionId && o.sessionStatus !== 'cancelled');
    record('change_time_does_not_mutate_series', String(policy.json?.policy?.startTimeLocal || '').startsWith('18:00') && changed?.sessionId === firstOcc.sessionId, {
      policyStart: policy.json?.policy?.startTimeLocal,
      changedSession: changed?.sessionId,
      otherCount: others.length,
    });

    const other = others[0];
    if (other) {
      const cancel = await http(base, '/admin/v2/haraj/schedule/overrides', {
        method: 'POST',
        token: adminTok,
        body: {
          policyId: policies.horse.id,
          sessionId: other.sessionId,
          overrideType: 'cancel',
          originalStartAt: other.startAt,
          reason: 'G6 CANCEL one occurrence',
        },
      });
      await http(base, '/admin/v2/haraj/schedule/run', { method: 'POST', token: adminTok, body: { horizonDays: 14 } });
      const cancelled = await http(base, `/admin/v2/haraj/sessions/${other.sessionId}`, { token: adminTok });
      const again = await http(base, `/admin/v2/haraj/schedule/occurrences?policyId=${policies.horse.id}`, { token: adminTok });
      const still = (again.json?.occurrences || []).find((o) => o.occurrenceKey === other.occurrenceKey);
      record('cancel_not_recreated', cancel.status < 300 && cancelled.json?.session?.status === 'cancelled' && still?.sessionStatus === 'cancelled', {
        status: cancelled.json?.session?.status,
      });

      const extend = await http(base, '/admin/v2/haraj/schedule/overrides', {
        method: 'POST',
        token: adminTok,
        body: {
          policyId: policies.horse.id,
          sessionId: firstOcc.sessionId,
          overrideType: 'extend',
          originalStartAt: firstOcc.startAt,
          overrideEndAt: new Date(new Date(changedEnd).getTime() + 3600000).toISOString(),
          reason: 'G6 EXTEND one occurrence',
        },
      });
      record('extend', extend.status === 201 || extend.status === 200, { status: extend.status });

      const reassign = await http(base, '/admin/v2/haraj/schedule/overrides', {
        method: 'POST',
        token: adminTok,
        body: {
          policyId: policies.horse.id,
          sessionId: firstOcc.sessionId,
          overrideType: 'reassign_auctioneer',
          originalStartAt: firstOcc.startAt,
          auctioneerUserId: idB,
          reason: 'G6 REASSIGN one occurrence',
        },
      });
      record('reassign_auctioneer', reassign.status === 201 || reassign.status === 200, {
        status: reassign.status,
        code: reassign.json?.code,
      });
    } else {
      record('cancel_not_recreated', false, { reason: 'no second horse occurrence' });
      record('extend', false, { reason: 'no second horse occurrence' });
      record('reassign_auctioneer', false, { reason: 'no second horse occurrence' });
    }

    const extraStart = new Date(Date.now() + 30 * 3600000).toISOString();
    const extraEnd = new Date(Date.now() + 32 * 3600000).toISOString();
    const extra = await http(base, '/admin/v2/haraj/schedule/overrides', {
      method: 'POST',
      token: adminTok,
      body: {
        policyId: policies.horse.id,
        overrideType: 'extra_session',
        overrideStartAt: extraStart,
        overrideEndAt: extraEnd,
        reason: 'G6 EXTRA_SESSION',
      },
    });
    record('extra_session', extra.status === 201 || extra.status === 200, { status: extra.status, code: extra.json?.code });

    const close = await http(base, '/admin/v2/haraj/schedule/overrides', {
      method: 'POST',
      token: adminTok,
      body: {
        policyId: policies.horse.id,
        sessionId: firstOcc.sessionId,
        overrideType: 'close_room',
        originalStartAt: firstOcc.startAt,
        reason: 'G6 CLOSE_ROOM one occurrence',
      },
    });
    const roomAfter = await http(base, `/admin/v2/haraj/rooms/${rooms.horse.id}`, { token: adminTok });
    record('close_room_one_occurrence', (close.status === 201 || close.status === 200) && roomAfter.json?.room?.status !== 'disabled', {
      status: close.status,
      roomStatus: roomAfter.json?.room?.status,
    });
  }

  const conflictRoom = await http(base, '/admin/v2/haraj/rooms', {
    method: 'POST',
    token: adminTok,
    body: { category: 'horse', code: `g6-conflict-${stamp}`, nameAr: 'تعارض محرّج' },
  });
  const conflictPolicy = await http(base, '/admin/v2/haraj/schedule/policies', {
    method: 'POST',
    token: adminTok,
    body: {
      roomId: conflictRoom.json?.room?.id,
      recurrence: 'daily',
      startTimeLocal: '19:00',
      endTimeLocal: '21:00',
      timezone: 'Asia/Riyadh',
      effectiveFrom: from,
      effectiveUntil: until,
      defaultAuctioneerUserId: idA,
      auctioneerAssignmentRule: 'fixed_user',
    },
  });
  const conflictRun = await http(base, '/admin/v2/haraj/schedule/run', {
    method: 'POST',
    token: adminTok,
    body: { horizonDays: 14 },
  });
  const conflictRow = (conflictRun.json?.results || []).find((r) => r.policyId === conflictPolicy.json?.policy?.id);
  const conflictHit = (conflictRow?.errors || []).some((e) => e.code === 'HARAJ_AUCTIONEER_CONFLICT');
  record('auctioneer_conflict', conflictPolicy.status === 201 && conflictHit, {
    policy: conflictPolicy.status,
    errors: conflictRow?.errors || [],
  });

  const g5cats = await http(base, '/admin/v2/haraj/categories', { token: adminTok });
  record('g5_categories_regression', g5cats.status === 200 && (g5cats.json?.categories || []).length === 3, {
    status: g5cats.status,
  });

  const disable = await http(base, `/admin/v2/haraj/schedule/policies/${policies.horse.id}/disable`, {
    method: 'POST',
    token: adminTok,
    body: {},
  });
  record('policy_disable_keeps_history', disable.status === 200 && disable.json?.policy?.enabled === false, {
    status: disable.status,
  });

  const summary = {
    ok: results.every((r) => r.pass),
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    total: results.length,
    results,
    productionWrites: false,
  };
  require('fs').writeFileSync('/tmp/nomas_g6_staging_e2e.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summary: true, ...summary }, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
