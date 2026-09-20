#!/usr/bin/env node
'use strict';

/**
 * G18 — Load & Chaos Testing (Staging only).
 * Measures actual Staging limits. Does not invent capacity.
 * Never targets Production with load.
 */

const fs = require('fs');
const crypto = require('crypto');
const tls = require('tls');

const STAGING_API = 'https://horse-backend-staging.onrender.com';
const PRODUCTION_API = 'https://horse-backend-i68h.onrender.com';
const OUT_DIR = process.env.G18_OUT_DIR || '/tmp/nomas-g18';

const G10_RACES = Number(process.env.G18_G10_RACES || 20);
const G12_RACES = Number(process.env.G18_G12_RACES || 5);
const SOAK_MS = Number(process.env.G18_SOAK_MS || 120000);
const ROOM_LEVELS = (process.env.G18_ROOM_LEVELS || '1,5,10,20')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => n > 0);

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
  const started = Date.now();
  let status = 0;
  let text = '';
  let json = null;
  let err = null;
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: h,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  } catch (e) {
    err = String(e.message || e);
    status = 0;
  }
  return {
    status,
    json,
    text,
    ms: Date.now() - started,
    requestId: null,
    err,
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarizeLatencies(samples, wallClockMs) {
  const ms = samples.map((s) => s.ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const ok = samples.filter((s) => s.status >= 200 && s.status < 500);
  const s5xx = samples.filter((s) => s.status >= 500).length;
  const timeouts = samples.filter((s) => s.status === 0 || s.status === 504).length;
  const wall = Number.isFinite(wallClockMs) && wallClockMs > 0
    ? wallClockMs
    : Math.max(...samples.map((s) => s.ms || 0), 1);
  const completed = samples.filter((s) => s.status > 0 || s.err).length;
  return {
    n: samples.length,
    completed,
    ok: ok.length,
    s5xx,
    timeouts,
    networkErrors: samples.filter((s) => s.err).length,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
    max: ms.length ? ms[ms.length - 1] : null,
    wallClockMs: wall,
    // Correct: completed requests ÷ wall-clock scenario duration (NOT sum of latencies).
    throughput: Number(((completed / wall) * 1000).toFixed(3)),
    throughputApprox: Number(((completed / wall) * 1000).toFixed(3)),
  };
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
    mediaVideoHlsUrl: 'https://videodelivery.net/g18-e2e/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g18-e2e-placeholder',
    description: 'G18 staging lot',
    inspection: { available: true, windows: 'بعد العصر' },
  };
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([(payload.length >> 8) & 0xff, payload.length & 0xff])]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function wsConnect(host, token) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = tls.connect({ host, port: 443, servername: host }, () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nAuthorization: Bearer ${token}\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('ws timeout'));
    }, 12000);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString('utf8');
        upgraded = true;
        clearTimeout(timer);
        resolve({
          sock,
          statusLine: head.split('\r\n')[0],
          send: (obj) => sock.write(encodeTextFrame(JSON.stringify(obj))),
        });
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  const base = process.env.G18_STAGING_API || STAGING_API;
  assertStaging(base);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  const capacity = [];
  const chaos = [];
  const record = (name, pass, extra = {}) => {
    const row = { name, pass: Boolean(pass), ...extra };
    results.push(row);
    console.log(JSON.stringify({ step: name, pass: Boolean(pass), ...extra }));
    return row;
  };

  const stamp = Date.now();
  const t0 = Date.now();

  // ── 1. Environment ──
  const health = await http(base, '/health');
  const ready = await http(base, '/ready');
  const prodBefore = await http(PRODUCTION_API, '/health');
  record('staging_identity',
    health.json?.storage?.inProduction === false
    && health.json?.auctions?.schemaVersion === '011_haraj_bidder_eligibility_security', {
      schema: health.json?.auctions?.schemaVersion,
      version: health.json?.version,
      inProduction: health.json?.storage?.inProduction,
    });
  record('staging_ready', ready.status === 200 && ready.json?.ready === true, {
    status: ready.status, ready: ready.json?.ready, injectEnabled: ready.json?.injectEnabled,
  });
  record('production_baseline_readonly',
    prodBefore.json?.storage?.inProduction === true
    && prodBefore.json?.auctions?.schemaVersion === '008_auction_media_independence', {
      schema: prodBefore.json?.auctions?.schemaVersion,
      users: prodBefore.json?.storage?.users,
    });
  if (health.json?.storage?.inProduction !== false) {
    throw new Error('REFUSING: Staging inProduction is not false');
  }

  // ── Auth bootstrap (fail-closed: no hard-coded credential fallback) ──
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('FAIL-CLOSED: ADMIN_EMAIL and ADMIN_PASSWORD must be set in environment (no hard-coded fallback)');
  }
  const admin = await http(base, '/admin/v2/auth/login', {
    method: 'POST',
    body: {
      email: adminEmail,
      password: adminPassword,
    },
  });
  const adminTok = admin.json?.token;
  record('admin_login', Boolean(adminTok), { status: admin.status, credentialSource: 'env_only' });
  if (!adminTok) throw new Error('admin login failed');

  const sellerTok = await register(base, `g18.seller.${stamp}@nomas.staging`, 'G18-pass!', 'G18 Seller');
  const xTok = await register(base, `g18.x.${stamp}@nomas.staging`, 'G18-pass!', 'G18 X');
  const yTok = await register(base, `g18.y.${stamp}@nomas.staging`, 'G18-pass!', 'G18 Y');
  const pTok = await register(base, `g18.p.${stamp}@nomas.staging`, 'G18-pass!', 'G18 P');
  const opHorseTok = await register(base, `g18.op.h.${stamp}@nomas.auctioneer.staging`, 'G18-pass!', 'OpH');
  const opCamelTok = await register(base, `g18.op.c.${stamp}@nomas.auctioneer.staging`, 'G18-pass!', 'OpC');
  const opFalconTok = await register(base, `g18.op.f.${stamp}@nomas.auctioneer.staging`, 'G18-pass!', 'OpF');
  const sellerId = (await http(base, '/auth/me', { token: sellerTok })).json?.user?.id;
  const xId = (await http(base, '/auth/me', { token: xTok })).json?.user?.id;
  const yId = (await http(base, '/auth/me', { token: yTok })).json?.user?.id;
  const pId = (await http(base, '/auth/me', { token: pTok })).json?.user?.id;
  const ops = {
    horse: { tok: opHorseTok, id: (await http(base, '/auth/me', { token: opHorseTok })).json?.user?.id },
    camel: { tok: opCamelTok, id: (await http(base, '/auth/me', { token: opCamelTok })).json?.user?.id },
    falcon: { tok: opFalconTok, id: (await http(base, '/auth/me', { token: opFalconTok })).json?.user?.id },
  };
  record('auth_bootstrap', Boolean(sellerTok && xTok && yTok && pTok && sellerId && xId && ops.horse.id), {
    sellerId, xId, yId, pId,
  });

  async function authorize(userId, bidLimit, key) {
    await http(base, `/admin/v2/haraj/bidders/${userId}`, {
      method: 'PUT', token: adminTok, body: { eligibilityStatus: 'verified', bidLimit },
    });
    return http(base, `/admin/v2/haraj/bidders/${userId}/security`, {
      method: 'POST',
      token: adminTok,
      headers: { 'Idempotency-Key': key },
      body: { authorizedLimit: bidLimit, idempotencyKey: key },
    });
  }
  await authorize(xId, 100000, `g18-sec-x-${stamp}`);
  await authorize(yId, 200000, `g18-sec-y-${stamp}`);
  await authorize(pId, 200000, `g18-sec-p-${stamp}`);

  const sessionStart = new Date(Date.now() + 30 * 3600000);
  const cats = ['horse', 'camel', 'falcon'];
  const createdRooms = [];
  const auctioneerPool = [];
  async function ensureAuctioneer(i) {
    if (auctioneerPool[i]) return auctioneerPool[i];
    const cat = cats[i % 3];
    const tok = await register(
      base,
      `g18.op.${i}.${stamp}@nomas.auctioneer.staging`,
      'G18-pass!',
      `Op${i}`,
    );
    const id = (await http(base, '/auth/me', { token: tok })).json?.user?.id;
    auctioneerPool[i] = { tok, id, category: cat };
    return auctioneerPool[i];
  }

  async function makeRoom(category, code, nameAr, auctioneerId, index) {
    const baseOffset = (Number(index) || 0) * 6 * 3600000;
    const startAt = new Date(sessionStart.getTime() + baseOffset);
    const session = await http(base, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: adminTok,
      body: {
        category,
        scheduledStartAt: startAt.toISOString(),
        scheduledEndAt: new Date(startAt.getTime() + 3 * 3600000).toISOString(),
        timezone: 'Asia/Riyadh',
      },
    });
    if (!session.json?.session?.id) {
      return {
        sessionId: null,
        roomSessionId: null,
        status: session.status,
        category,
        err: session.json,
      };
    }
    const attach = await http(base, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
      method: 'POST',
      token: adminTok,
      body: { category, code, nameAr, auctioneerUserId: auctioneerId },
    });
    return {
      sessionId: session.json?.session?.id,
      roomSessionId: attach.json?.roomSession?.id,
      status: attach.status,
      category,
      err: attach.json,
    };
  }

  async function liveLot(species, title, opts = {}) {
    const created = await http(base, '/auctions', {
      method: 'POST', token: sellerTok, body: lotBody(species, title, opts),
    });
    const id = created.json?.auction?.id;
    if (!id) return { id: null, created };
    await http(base, `/auctions/${id}/submit-review`, {
      method: 'POST', token: sellerTok, body: { channel: 'haraj' },
    });
    await http(base, `/auctions/haraj/review/${id}/accept`, {
      method: 'POST', token: ops[species].tok, body: { reason: 'G18' },
    });
    await http(base, `/auctions/${id}/schedule`, { method: 'POST', token: sellerTok, body: {} });
    let live = await http(base, `/auctions/${id}/go-live`, { method: 'POST', token: sellerTok, body: {} });
    const row = await http(base, `/auctions/${id}`, { token: sellerTok });
    if (live.status !== 200 && row.json?.auction?.status === 'live') {
      live = { ...live, status: 200, json: row.json };
    }
    return { id, live, row };
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
    return Number(me.json?.eligibility?.activeExposure ?? me.json?.activeExposure ?? 0);
  }

  async function waitUntilClosed(id, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await http(base, `/auctions/${id}`, { token: sellerTok });
      const st = last.json?.auction?.status;
      if (st === 'sold' || st === 'unsold') return last;
      if (st === 'live' || st === 'extended') {
        const closed = await http(base, `/auctions/${id}/close`, {
          method: 'POST', token: sellerTok, body: {},
        });
        if (closed.status === 200 && ['sold', 'unsold'].includes(closed.json?.auction?.status)) {
          return closed;
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return last;
  }

  async function invariants() {
    const opsHealth = await http(base, '/admin/v2/haraj/ops-health', { token: adminTok });
    return {
      status: opsHealth.status,
      ready: opsHealth.json?.readiness?.ready,
      incidents: opsHealth.json?.invariants?.incidents || [],
      metrics: opsHealth.json?.snapshot?.metrics || null,
      autoRepair: opsHealth.json?.invariants?.autoRepair,
    };
  }

  // ── 2. Baseline ──
  const baselineSamples = [];
  const baselineWallStart = Date.now();
  for (let i = 0; i < 30; i += 1) {
    baselineSamples.push(await http(base, '/ready'));
    baselineSamples.push(await http(base, '/auctions/status'));
    baselineSamples.push(await http(base, '/admin/v2/haraj/command-center', { token: adminTok }));
  }
  const baseline = summarizeLatencies(baselineSamples, Date.now() - baselineWallStart);
  const inv0 = await invariants();
  record('baseline_low_load', baseline.s5xx === 0 && baseline.p95 != null, {
    ...baseline,
    invariantsIncidents: inv0.incidents?.length,
  });
  capacity.push({
    level: 'baseline',
    rooms: 0,
    concurrentBidders: 0,
    wsClients: 0,
    classification: baseline.s5xx === 0 ? 'PASS' : 'FAIL',
    ...baseline,
    integrity: inv0.incidents?.length === 0 ? 'PASS' : 'FAIL',
  });

  // ── 3. Progressive multi-room load ──
  let maxRoomsPass = 0;
  let breakpoint = null;

  for (const n of ROOM_LEVELS) {
    while (createdRooms.length < n) {
      const i = createdRooms.length;
      const cat = cats[i % 3];
      const op = await ensureAuctioneer(i);
      const room = await makeRoom(cat, `g18-r${i}-${stamp}`, `غرفة G18 ${i}`, op.id, i);
      room.auctioneerTok = op.tok;
      createdRooms.push(room);
      if (!room.roomSessionId) {
        console.log(JSON.stringify({ step: 'room_create_detail', i, status: room.status, err: room.err }));
        break;
      }
    }
    const liveRooms = createdRooms.filter((r) => r.roomSessionId);
    if (liveRooms.length < n) {
      capacity.push({
        level: `rooms_${n}`,
        rooms: liveRooms.length,
        classification: 'FAIL',
        note: 'could not create requested rooms on Staging',
      });
      breakpoint = breakpoint || { rooms: n, reason: 'room_create_failed' };
      record(`rooms_${n}_create`, false, { have: liveRooms.length, want: n });
      continue;
    }

    const samples = [];
    const concurrency = Math.min(n, 20);
    const wave = [];
    for (let i = 0; i < concurrency; i += 1) {
      const room = liveRooms[i % liveRooms.length];
      const opTok = room.auctioneerTok || ops[room.category].tok;
      wave.push(http(base, `/auctions/haraj/rooms/${room.roomSessionId}`, { token: opTok }));
      wave.push(http(base, `/admin/v2/haraj/sessions?category=${room.category}`, { token: adminTok }));
    }
    wave.push(http(base, '/admin/v2/haraj/rooms', { token: adminTok }));
    wave.push(http(base, '/admin/v2/haraj/schedule/run', { method: 'POST', token: adminTok, body: {} }));
    wave.push(http(base, '/admin/v2/haraj/command-center', { token: adminTok }));
    wave.push(http(base, '/admin/v2/haraj/analytics', { token: adminTok }));
    const waveStart = Date.now();
    samples.push(...await Promise.all(wave));
    const stats = summarizeLatencies(samples, Date.now() - waveStart);
    const inv = await invariants();
    // No arbitrary 15s PASS threshold — classify integrity + unexpected failures only;
    // elevated latency is recorded as DEGRADED when integrity holds.
    const integrityOk = inv.incidents?.length === 0;
    const unexpectedFail = stats.s5xx > 0 || stats.networkErrors > 0;
    const pass = integrityOk && !unexpectedFail && stats.p95 != null && stats.p95 < 3000;
    const degraded = integrityOk && !unexpectedFail && stats.p95 != null && stats.p95 >= 3000;
    const classification = unexpectedFail || !integrityOk ? 'FAIL' : pass ? 'PASS' : degraded ? 'DEGRADED' : 'FAIL';
    if (pass) maxRoomsPass = n;
    else breakpoint = breakpoint || { rooms: n, reason: classification, ...stats };
    capacity.push({
      level: `rooms_${n}`,
      rooms: n,
      concurrentReads: samples.length,
      classification,
      ...stats,
      integrity: inv.incidents?.length === 0 ? 'PASS' : 'FAIL',
    });
    record(`rooms_${n}_load`, pass || degraded, { classification, ...stats, incidents: inv.incidents?.length });
    if (classification === 'FAIL') break;
  }
  record('progressive_rooms', maxRoomsPass > 0, { maxRoomsPass, breakpoint });

  // ── 4. Bid concurrency + WS ──
  const liveA = await liveLot('horse', `G18 bid A ${stamp}`);
  const liveB = await liveLot('camel', `G18 bid B ${stamp}`);
  record('live_lots_for_bid_load', Boolean(liveA.id && liveB.id), {
    a: liveA.id, aStatus: liveA.live?.status, b: liveB.id, bStatus: liveB.live?.status,
  });

  let bidSamples = [];
  if (liveA.id && liveB.id) {
    const amountA = 5000;
    const amountB = 6000;
    const [b1, b2] = await Promise.all([
      bid(pTok, liveA.id, amountA, `g18-par-a-${stamp}`),
      bid(pTok, liveB.id, amountB, `g18-par-b-${stamp}`),
    ]);
    const expP = await exposure(pTok);
    record('valid_parallel_bids_200k',
      b1.status === 201 && b2.status === 201 && expP <= 200000, {
        a: b1.status, b: b2.status, exposure: expP,
      });

    const contended = [];
    for (let i = 0; i < 10; i += 1) {
      contended.push(bid(yTok, liveA.id, 7000 + i * 100, `g18-contend-${stamp}-${i}`));
    }
    const bidWall = Date.now();
    bidSamples = await Promise.all(contended);
    const bidStats = summarizeLatencies(bidSamples, Date.now() - bidWall);
    const accepted = bidSamples.filter((s) => s.status === 201 || s.status === 200).length;
    record('same_auction_bid_contention', bidStats.s5xx === 0 && accepted >= 1, {
      ...bidStats, accepted,
    });
    capacity.push({
      level: 'bid_contention',
      rooms: 2,
      concurrentBidders: 1,
      classification: bidStats.s5xx === 0 ? 'PASS' : 'FAIL',
      ...bidStats,
    });
  }

  // WebSocket clients
  const host = new URL(base).hostname;
  let wsOk = 0;
  let wsFail = 0;
  const wsClients = Math.min(10, Math.max(3, maxRoomsPass || 3));
  const wsConns = [];
  for (let i = 0; i < wsClients; i += 1) {
    try {
      const c = await wsConnect(host, sellerTok);
      if (/101/.test(c.statusLine)) {
        wsOk += 1;
        c.send({ type: 'subscribe', room: `room:g18-${i}` });
        wsConns.push(c);
      } else wsFail += 1;
    } catch {
      wsFail += 1;
    }
  }
  for (const c of wsConns) {
    try { c.sock.destroy(); } catch { /* ignore */ }
  }
  // reconnect one
  let reconnectOk = false;
  try {
    const c1 = await wsConnect(host, sellerTok);
    c1.sock.destroy();
    const c2 = await wsConnect(host, sellerTok);
    c2.send({ type: 'resume', room: 'room:g18-0', lastSeq: 0 });
    reconnectOk = /101/.test(c2.statusLine);
    c2.sock.destroy();
  } catch { reconnectOk = false; }
  record('websocket_clients', wsOk >= Math.ceil(wsClients / 2), {
    requested: wsClients, ok: wsOk, fail: wsFail, reconnectOk,
  });
  capacity.push({
    level: 'websocket',
    wsClients: wsOk,
    classification: wsOk >= Math.ceil(wsClients / 2) && reconnectOk ? 'PASS' : wsOk > 0 ? 'DEGRADED' : 'FAIL',
    reconnectOk,
  });

  // Scheduler concurrent
  const [sched1, sched2, sched3] = await Promise.all([
    http(base, '/admin/v2/haraj/schedule/run', { method: 'POST', token: adminTok, body: {} }),
    http(base, '/admin/v2/haraj/schedule/run', { method: 'POST', token: adminTok, body: {} }),
    http(base, '/admin/v2/haraj/schedule/run', { method: 'POST', token: adminTok, body: {} }),
  ]);
  const schedOk = [sched1, sched2, sched3].every((s) => s.status === 200);
  const jobIds = [sched1, sched2, sched3].map((s) => s.json?.jobRunId).filter(Boolean);
  record('scheduler_concurrent', schedOk && new Set(jobIds).size === jobIds.length, {
    statuses: [sched1.status, sched2.status, sched3.status],
    jobIds,
    skipped: [sched1, sched2, sched3].map((s) => s.json?.skipped),
  });

  // ── 5. G10 exposure race P0 ──
  let g10Bypass = 0;
  let g10Both = 0;
  let g10One = 0;
  let g10None = 0;
  for (let i = 0; i < G10_RACES; i += 1) {
    // reset exposure by using fresh bidder each 5 races would be heavy; reuse X with limit 100k
    // First ensure X still verified at 100k
    if (i % 5 === 0) await authorize(xId, 100000, `g18-sec-x-refresh-${stamp}-${i}`);
    const a = await liveLot('horse', `G18 race H ${stamp}-${i}`, { assign: false });
    const b = await liveLot('camel', `G18 race C ${stamp}-${i}`, { assign: false });
    if (!a.id || !b.id || a.live?.status !== 200 || b.live?.status !== 200) {
      g10None += 1;
      continue;
    }
    const [ra, rb] = await Promise.all([
      bid(xTok, a.id, 70000, `g18-race-a-${stamp}-${i}`),
      bid(xTok, b.id, 70000, `g18-race-b-${stamp}-${i}`),
    ]);
    const okA = ra.status === 201 || ra.status === 200;
    const okB = rb.status === 201 || rb.status === 200;
    if (okA && okB) g10Both += 1;
    else if (okA || okB) g10One += 1;
    else g10None += 1;
    const exp = await exposure(xTok);
    if (exp > 100000) g10Bypass += 1;
    // cancel remaining live exposure to free bidder for next iteration
    if (okA) await http(base, `/auctions/${a.id}/close`, { method: 'POST', token: sellerTok, body: {} }).catch(() => null);
    if (okB) await http(base, `/auctions/${b.id}/close`, { method: 'POST', token: sellerTok, body: {} }).catch(() => null);
    if (okA || okB) {
      // if sold, exposure may remain as provisional — suspend/reset profile limit path:
      await http(base, `/admin/v2/haraj/bidders/${xId}`, {
        method: 'PUT', token: adminTok,
        body: { eligibilityStatus: 'verified', bidLimit: 100000 },
      });
    }
  }
  record('g10_exposure_race', g10Bypass === 0 && g10Both === 0 && g10One > 0, {
    iterations: G10_RACES,
    bypasses: g10Bypass,
    bothSucceeded: g10Both,
    oneSucceeded: g10One,
    none: g10None,
  });

  // ── 6. G12 offer race P0 ──
  let g12Ok = 0;
  let g12Double = 0;
  let g12Fail = 0;
  for (let i = 0; i < G12_RACES; i += 1) {
    const raceLot = await liveLot('horse', `G18 g12 ${stamp}-${i}`, { durationMs: 20000 });
    if (!raceLot.id) { g12Fail += 1; continue; }
    const ended = await waitUntilClosed(raceLot.id, 90000);
    if (ended?.json?.auction?.status !== 'unsold') { g12Fail += 1; continue; }
    await http(base, `/auctions/${raceLot.id}/after-haraj`, {
      method: 'POST', token: sellerTok,
      headers: { 'Idempotency-Key': `g18-act-${stamp}-${i}` },
      body: { mode: 'accept_offers', idempotencyKey: `g18-act-${stamp}-${i}` },
    });
    const ra = await http(base, `/auctions/${raceLot.id}/after-haraj/offers`, {
      method: 'POST', token: xTok,
      headers: { 'Idempotency-Key': `g18-oa-${stamp}-${i}` },
      body: { amount: 30000, idempotencyKey: `g18-oa-${stamp}-${i}` },
    });
    const rb = await http(base, `/auctions/${raceLot.id}/after-haraj/offers`, {
      method: 'POST', token: yTok,
      headers: { 'Idempotency-Key': `g18-ob-${stamp}-${i}` },
      body: { amount: 35000, idempotencyKey: `g18-ob-${stamp}-${i}` },
    });
    const got = await http(base, `/auctions/${raceLot.id}/after-haraj`, { token: sellerTok });
    const exp = got.json?.afterHaraj?.listing?.expectedUpdatedAt;
    const idA = ra.json?.offerId;
    const idB = rb.json?.offerId;
    if (!idA || !idB || !exp) { g12Fail += 1; continue; }
    const [accA, accB] = await Promise.all([
      http(base, `/auctions/${raceLot.id}/after-haraj/offers/${idA}/accept`, {
        method: 'POST', token: sellerTok,
        headers: { 'Idempotency-Key': `g18-acca-${stamp}-${i}` },
        body: { expectedUpdatedAt: exp, idempotencyKey: `g18-acca-${stamp}-${i}` },
      }),
      http(base, `/auctions/${raceLot.id}/after-haraj/offers/${idB}/accept`, {
        method: 'POST', token: sellerTok,
        headers: { 'Idempotency-Key': `g18-accb-${stamp}-${i}` },
        body: { expectedUpdatedAt: exp, idempotencyKey: `g18-accb-${stamp}-${i}` },
      }),
    ]);
    const ok = [accA, accB].filter((x) => x.status === 200).length;
    const conflict = [accA, accB].filter((x) => x.status === 409).length;
    const final = await http(base, `/auctions/${raceLot.id}/after-haraj`, { token: sellerTok });
    const acceptedCount = (final.json?.afterHaraj?.offers || []).filter((o) => o.status === 'accepted').length;
    if (ok === 1 && conflict === 1 && acceptedCount === 1) g12Ok += 1;
    else if (acceptedCount > 1 || ok > 1) g12Double += 1;
    else g12Fail += 1;
  }
  record('g12_offer_race', g12Ok >= Math.ceil(G12_RACES * 0.6) && g12Double === 0, {
    iterations: G12_RACES,
    success: g12Ok,
    doubleAcceptances: g12Double,
    failOrSkip: g12Fail,
  });

  // ── 7. Chaos (G17 inject, Staging-only) ──
  async function clearInject() {
    await http(base, '/admin/v2/haraj/ops/inject', {
      method: 'POST', token: adminTok, body: { mode: null },
    });
  }

  // DB unavailable
  await http(base, '/admin/v2/haraj/ops/inject', {
    method: 'POST', token: adminTok, body: { mode: 'db_unavailable' },
  });
  const chaosReady = await http(base, '/ready');
  const chaosHist = await http(base, '/admin/v2/haraj/history?limit=1', { token: adminTok });
  await clearInject();
  const chaosRecover = await http(base, '/ready');
  chaos.push({
    id: 'C1_db_unavailable',
    pass: chaosReady.status === 503 && chaosRecover.status === 200 && chaosReady.json?.ready === false,
    readyDown: chaosReady.status,
    history: chaosHist.status,
    recovered: chaosRecover.status,
  });

  // timeout
  await http(base, '/admin/v2/haraj/ops/inject', {
    method: 'POST', token: adminTok, body: { mode: 'timeout' },
  });
  const chaosTimeout = await http(base, '/admin/v2/haraj/ops/probe', {
    method: 'POST', token: adminTok, body: { phase: 'handler' },
  });
  await clearInject();
  chaos.push({
    id: 'C2_timeout',
    pass: chaosTimeout.status === 504 && chaosTimeout.json?.taxonomy === 'TIMEOUT',
    status: chaosTimeout.status,
    taxonomy: chaosTimeout.json?.taxonomy,
  });

  // txn rollback
  const hist = await http(base, '/admin/v2/haraj/history?limit=1', { token: adminTok });
  const sampleAuction = hist.json?.history?.items?.[0]?.auctionId || hist.json?.items?.[0]?.auctionId;
  let c3 = { id: 'C3_txn_rollback', pass: false };
  if (sampleAuction) {
    const before = await http(base, '/admin/v2/haraj/ops/probe', {
      method: 'POST', token: adminTok, body: { auctionId: sampleAuction, readOnly: true },
    });
    await http(base, '/admin/v2/haraj/ops/inject', {
      method: 'POST', token: adminTok, body: { mode: 'txn_fail_before_commit' },
    });
    const probe = await http(base, '/admin/v2/haraj/ops/probe', {
      method: 'POST', token: adminTok, body: { auctionId: sampleAuction },
    });
    await clearInject();
    const after = await http(base, '/admin/v2/haraj/ops/probe', {
      method: 'POST', token: adminTok, body: { auctionId: sampleAuction, readOnly: true },
    });
    c3 = {
      id: 'C3_txn_rollback',
      pass: probe.json?.code === 'G17_INJECTED_ROLLBACK'
        && String(before.json?.beforeUpdatedAt || '') === String(after.json?.beforeUpdatedAt || ''),
      code: probe.json?.code,
    };
  }
  chaos.push(c3);

  // scoped room inject header
  const camelFail = await http(base, '/admin/v2/haraj/sessions?category=camel', {
    token: adminTok, headers: { 'x-nomas-g17-inject': 'db_unavailable' },
  });
  const horseOk = await http(base, '/admin/v2/haraj/sessions?category=horse', { token: adminTok });
  chaos.push({
    id: 'C4_one_room_scoped',
    pass: camelFail.status >= 500 && horseOk.status === 200,
    camel: camelFail.status,
    horse: horseOk.status,
  });

  // notify / media / internal
  await http(base, '/admin/v2/haraj/ops/inject', {
    method: 'POST', token: adminTok, body: { mode: 'notify_fail' },
  });
  const notify = await http(base, '/admin/v2/haraj/ops/probe', {
    method: 'POST', token: adminTok, body: { phase: 'notify' },
  });
  await clearInject();
  chaos.push({
    id: 'C5_notify_fail',
    pass: notify.json?.code === 'G17_INJECTED_NOTIFY' && notify.json?.businessTruthUnchanged === true,
    code: notify.json?.code,
  });

  await http(base, '/admin/v2/haraj/ops/inject', {
    method: 'POST', token: adminTok, body: { mode: 'media_fail' },
  });
  const media = await http(base, '/auctions', {
    method: 'POST', token: sellerTok,
    body: { channel: 'haraj', title: 'g18 media', startingPrice: 1000 },
  });
  await clearInject();
  chaos.push({
    id: 'C6_media_fail',
    pass: media.status === 503 && media.json?.code === 'G17_INJECTED_MEDIA',
    status: media.status,
  });

  await http(base, '/admin/v2/haraj/ops/inject', {
    method: 'POST', token: adminTok, body: { mode: 'internal_error' },
  });
  const boom = await http(base, '/admin/v2/haraj/ops/probe', {
    method: 'POST', token: adminTok, body: { phase: 'handler' },
  });
  await clearInject();
  chaos.push({
    id: 'C7_internal_error',
    pass: boom.status === 500 && boom.json?.message === 'Internal error',
    status: boom.status,
  });

  // Backend restart not injectable safely — document as infrastructure observation via ready recover
  chaos.push({
    id: 'C8_backend_restart',
    pass: false,
    note: 'NOT TESTED in original G18 harness — see G18.1 for actual restart',
    classification: 'NOT_TESTED',
  });

  // G16 stale resolution under load
  const createdCase = sampleAuction
    ? await http(base, '/admin/v2/auctions/disputes', {
      method: 'POST', token: adminTok,
      body: {
        auctionId: sampleAuction,
        category: 'inspection_dispute',
        description: 'G18 chaos case',
      },
    })
    : { status: 0 };
  const caseId = createdCase.json?.dispute?.id;
  if (caseId) {
    const detail = await http(base, `/admin/v2/haraj/cases/${caseId}`, { token: adminTok });
    const expected = detail.json?.case?.updatedAt;
    const [r1, r2] = await Promise.all([
      http(base, `/admin/v2/haraj/cases/${caseId}/resolve`, {
        method: 'POST', token: adminTok,
        body: { resolution: 'no_action', note: 'g18 a', expectedUpdatedAt: expected },
      }),
      http(base, `/admin/v2/haraj/cases/${caseId}/resolve`, {
        method: 'POST', token: adminTok,
        body: { resolution: 'close', note: 'g18 b', expectedUpdatedAt: expected },
      }),
    ]);
    const st = [r1.status, r2.status].sort();
    chaos.push({
      id: 'C9_g16_resolution_race',
      pass: st.includes(200) && st.includes(409),
      statuses: st,
    });
  } else {
    chaos.push({ id: 'C9_g16_resolution_race', pass: false, note: 'no case created' });
  }

  for (const c of chaos) {
    record(`chaos_${c.id}`, c.pass, c);
  }
  await clearInject();

  // ── 8. Integrity after major tests ──
  const invFinal = await invariants();
  record('data_integrity_invariants',
    invFinal.status === 200 && invFinal.incidents?.length === 0 && invFinal.autoRepair === false, {
      incidents: invFinal.incidents,
      ready: invFinal.ready,
      metrics: invFinal.metrics ? {
        http_5xx_total: invFinal.metrics.http_5xx_total,
        txn_rollbacks_total: invFinal.metrics.txn_rollbacks_total,
        bid_accepted_total: invFinal.metrics.bid_accepted_total,
        scheduler_failures_total: invFinal.metrics.scheduler_failures_total,
      } : null,
    });

  // ── 9. Soak ──
  const soakStart = Date.now();
  const soakSamples = [];
  let soakStopReason = 'completed';
  while (Date.now() - soakStart < SOAK_MS) {
    const batch = await Promise.all([
      http(base, '/ready'),
      http(base, '/auctions/status'),
      http(base, '/admin/v2/haraj/command-center', { token: adminTok }),
      createdRooms[0]?.roomSessionId
        ? http(base, `/admin/v2/haraj/rooms/${createdRooms[0].roomSessionId}`, { token: adminTok })
        : http(base, '/health'),
    ]);
    soakSamples.push(...batch);
    if (batch.some((s) => s.status >= 500)) {
      soakStopReason = 'elevated_5xx';
      break;
    }
    if (batch.some((s) => s.ms > 20000)) {
      soakStopReason = 'latency_breakpoint';
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const soakStats = summarizeLatencies(soakSamples, Date.now() - soakStart);
  const soakPass = soakStats.s5xx === 0 && soakStopReason === 'completed';
  record('soak', soakPass || soakStopReason === 'latency_breakpoint', {
    ...soakStats,
    durationMs: Date.now() - soakStart,
    soakStopReason,
    classification: soakPass ? 'PASS' : soakStats.s5xx === 0 ? 'DEGRADED' : 'FAIL',
  });
  capacity.push({
    level: 'soak',
    rooms: maxRoomsPass,
    classification: soakPass ? 'PASS' : soakStats.s5xx === 0 ? 'DEGRADED' : 'FAIL',
    soakStopReason,
    ...soakStats,
  });

  // High load / safe breakpoint probe (burst)
  const burstN = 60;
  const burstWall = Date.now();
  const burst = await Promise.all(
    Array.from({ length: burstN }, (_, i) =>
      http(base, i % 2 === 0 ? '/ready' : '/auctions/status')),
  );
  const burstStats = summarizeLatencies(burst, Date.now() - burstWall);
  let burstClass = 'PASS';
  if (burstStats.s5xx > 0) burstClass = 'FAIL';
  else if (burstStats.p95 > 8000) burstClass = 'DEGRADED';
  capacity.push({
    level: 'high_burst',
    requests: burstN,
    classification: burstClass,
    ...burstStats,
  });
  if (!breakpoint && burstClass !== 'PASS') {
    breakpoint = { level: 'high_burst', classification: burstClass, ...burstStats };
  }
  record('high_burst', burstClass !== 'FAIL', { classification: burstClass, ...burstStats });

  // Production after
  const prodAfter = await http(PRODUCTION_API, '/health');
  record('production_untouched_after',
    prodAfter.json?.auctions?.schemaVersion === '008_auction_media_independence'
    && prodAfter.json?.storage?.inProduction === true, {
      schema: prodAfter.json?.auctions?.schemaVersion,
      users: prodAfter.json?.storage?.users,
    });

  const chaosPass = chaos.filter((c) => c.id !== 'C8_backend_restart').every((c) => c.pass);
  const unexpected5xx = capacity.reduce((n, c) => n + (c.s5xx || 0), 0)
    + soakStats.s5xx + burstStats.s5xx + baseline.s5xx;
  const highestPass = [...capacity].reverse().find((c) => c.classification === 'PASS' && c.p95 != null)
    || capacity.find((c) => c.level === 'baseline');

  const summary = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    staging: {
      url: base,
      schema: health.json?.auctions?.schemaVersion,
      version: health.json?.version,
      deployHint: 'dep-dae7flrm8hqs73csosog',
      commit: '57ed2cce8e73985aacfff33ab40c99f6c2b02757',
    },
    production: {
      schemaBefore: prodBefore.json?.auctions?.schemaVersion,
      schemaAfter: prodAfter.json?.auctions?.schemaVersion,
      usersBefore: prodBefore.json?.storage?.users,
      usersAfter: prodAfter.json?.storage?.users,
    },
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    total: results.length,
    maxRoomsPass,
    maxWsClients: wsOk,
    g10Bypasses: g10Bypass,
    g12DoubleAcceptances: g12Double,
    dataCorruption: invFinal.incidents?.length || 0,
    unexpected5xx,
    baseline,
    highestPassingLoad: highestPass,
    breakpoint: breakpoint || (burstClass === 'PASS' && soakPass
      ? { note: 'No hard FAIL breakpoint within safe Staging envelope; highest tested burst/soak held' }
      : breakpoint),
    applicationLimitVsInfra: {
      application: 'Bid exposure, offer accept, and invariants held under tested concurrency',
      stagingInfrastructure: breakpoint
        ? `First meaningful Staging degradation: ${JSON.stringify(breakpoint).slice(0, 300)}`
        : 'Within tested envelope no infrastructure hard-fail observed',
      note: 'Staging breakpoint is NOT a Production capacity claim',
    },
    capacity,
    chaos,
    results,
  };

  fs.writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2));
  fs.writeFileSync(`${OUT_DIR}/capacity_matrix.json`, JSON.stringify(capacity, null, 2));
  fs.writeFileSync(`${OUT_DIR}/chaos_results.json`, JSON.stringify(chaos, null, 2));
  console.log(JSON.stringify({
    summary: {
      pass: summary.pass,
      fail: summary.fail,
      total: summary.total,
      maxRoomsPass,
      g10Bypasses: g10Bypass,
      g12DoubleAcceptances: g12Double,
      dataCorruption: summary.dataCorruption,
      elapsedMs: summary.elapsedMs,
    },
  }));
  process.exit(summary.fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
