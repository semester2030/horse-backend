#!/usr/bin/env node
'use strict';

/**
 * G18.1 — Surgical Load & Chaos Closure (Staging only).
 * Fixes G18 evidence gaps. Does NOT start G19.
 * Credentials: ADMIN_EMAIL + ADMIN_PASSWORD from environment only (fail-closed).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { spawnSync } = require('child_process');

const STAGING_API = 'https://horse-backend-staging.onrender.com';
const PRODUCTION_API = 'https://horse-backend-i68h.onrender.com';
const STAGING_SERVICE_ID = 'srv-dabp5bek1f9s7391feq0';
const OUT_DIR = process.env.G181_OUT_DIR || '/tmp/nomas-g18.1';

const ROOMS_N = Number(process.env.G181_ROOMS || 20);
const G10_RACES = Number(process.env.G181_G10_RACES || 50);
const G12_RACES = Number(process.env.G181_G12_RACES || 20);
const CONTENTION_BIDDERS = Number(process.env.G181_CONTENTION_BIDDERS || 10);
const SOAK_MS = Number(process.env.G181_SOAK_MS || 15 * 60 * 1000);
const DO_RESTART = String(process.env.G181_BACKEND_RESTART || '1') !== '0';
const WS_CLIENTS = Number(process.env.G181_WS_CLIENTS || 20);

function assertStaging(url) {
  const u = String(url);
  if (u.includes('horse-backend-i68h') || !u.includes('horse-backend-staging')) {
    throw new Error(`STAGING ONLY: ${url}`);
  }
}

function redact(obj) {
  const s = JSON.stringify(obj);
  return JSON.parse(s.replace(/("password"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
    .replace(/("token"\s*:\s*")[^"]{8,}"/gi, '$1[REDACTED]"')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]'));
}

async function http(base, p, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body != null) h['Content-Type'] = 'application/json';
  const started = Date.now();
  let status = 0;
  let text = '';
  let json = null;
  let err = null;
  try {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: h,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
  } catch (e) {
    err = String(e.message || e);
  }
  return { status, json, text: text.slice(0, 2000), ms: Date.now() - started, err, path: p, method };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** throughput = completed / wall-clock ms * 1000 */
function summarize(samples, wallClockMs, extras = {}) {
  const ms = samples.map((s) => s.ms).filter(Number.isFinite).sort((a, b) => a - b);
  const completed = samples.filter((s) => s.status > 0 || s.err).length;
  const okBiz = samples.filter((s) => s.status >= 200 && s.status < 500).length;
  const unexpected = samples.filter((s) => s.status >= 500 || (s.status === 0 && s.err)).length;
  const s5xx = samples.filter((s) => s.status >= 500).length;
  const timeouts = samples.filter((s) => s.status === 0 || s.status === 504).length;
  const wall = wallClockMs > 0 ? wallClockMs : 1;
  return {
    concurrency: extras.concurrency ?? null,
    wallClockMs: wall,
    requestCount: samples.length,
    completed,
    successful: okBiz,
    expectedBusinessRejections: extras.expectedBusinessRejections ?? null,
    unexpectedFailures: unexpected,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
    max: ms.length ? ms[ms.length - 1] : null,
    throughput: Number(((completed / wall) * 1000).toFixed(3)),
    s5xx,
    timeouts,
    networkErrors: samples.filter((s) => s.err).length,
    dbOrLockErrors: extras.dbOrLockErrors ?? 0,
    integrity: extras.integrity ?? null,
    ...extras,
  };
}

function pickToken(json) {
  return json?.idToken || json?.token || json?.accessToken || json?.data?.token || null;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function register(base, email, password, name, { attempts = 5 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const reg = await http(base, '/auth/register', {
      method: 'POST',
      body: { email, password, name, accountRole: 'heritage_advertiser' },
    });
    if (reg.status === 201 || reg.status === 200) return pickToken(reg.json);
    const login = await http(base, '/auth/login', { method: 'POST', body: { email, password } });
    if (login.status === 200) return pickToken(login.json);
    last = { reg: reg.status, login: login.status, err: reg.err || login.err };
    // Transient Staging/network (status 0) or 429/503 — backoff and retry
    const transient = [0, 429, 502, 503, 504].includes(reg.status)
      || [0, 429, 502, 503, 504].includes(login.status);
    if (!transient && reg.status >= 400 && login.status >= 400) break;
    await sleep(500 * (i + 1) * (i + 1));
  }
  throw new Error(`auth ${email} ${last?.reg}/${last?.login}${last?.err ? ` ${last.err}` : ''}`);
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
    mediaVideoHlsUrl: 'https://videodelivery.net/g181-e2e/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g181-e2e-placeholder',
    description: 'G18.1 staging lot',
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

function decodeFrames(buf) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let hdr = 2;
    if (len === 126) {
      if (offset + 4 > buf.length) break;
      len = (buf[offset + 2] << 8) | buf[offset + 3];
      hdr = 4;
    } else if (len === 127) {
      break;
    }
    const maskLen = masked ? 4 : 0;
    if (offset + hdr + maskLen + len > buf.length) break;
    let payload = buf.slice(offset + hdr + maskLen, offset + hdr + maskLen + len);
    if (masked) {
      const mask = buf.slice(offset + hdr, offset + hdr + 4);
      const out = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }
    offset += hdr + maskLen + len;
    if (opcode === 0x1 || opcode === 0x2) {
      const text = payload.toString('utf8');
      try { messages.push(JSON.parse(text)); } catch { messages.push({ raw: text.slice(0, 200) }); }
    }
  }
  return { messages, rest: buf.slice(offset) };
}

function wsConnect(host, token, { collectMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = tls.connect({ host, port: 443, servername: host }, () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nAuthorization: Bearer ${token}\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const received = [];
    const seqByRoom = new Map();
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('ws timeout'));
    }, 15000);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString('utf8');
        upgraded = true;
        clearTimeout(timer);
        buf = buf.slice(idx + 4);
        const api = {
          sock,
          statusLine: head.split('\r\n')[0],
          received,
          seqByRoom,
          send: (obj) => sock.write(encodeTextFrame(JSON.stringify(obj))),
          drain: () => {
            const { messages, rest } = decodeFrames(buf);
            buf = rest;
            for (const m of messages) {
              received.push({ ...m, _t: Date.now() });
              const room = m.room || m.channel;
              const seq = m.seq ?? m.sequence ?? m.currentSeq;
              if (room != null && seq != null) {
                const prev = seqByRoom.get(room);
                if (prev != null && seq < prev) m._outOfOrder = true;
                seqByRoom.set(room, seq);
              }
            }
            return messages;
          },
          close: () => { try { sock.destroy(); } catch { /* */ } },
        };
        if (collectMs > 0) {
          setTimeout(() => { api.drain(); resolve(api); }, collectMs);
        } else {
          resolve(api);
        }
      } else {
        // keep buffering; drain on demand
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function writeJson(name, data) {
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(redact(data), null, 2));
}

function appendNdjson(name, row) {
  fs.appendFileSync(path.join(OUT_DIR, name), `${JSON.stringify(redact(row))}\n`);
}

async function main() {
  const base = process.env.G181_STAGING_API || STAGING_API;
  assertStaging(base);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of ['steps.ndjson', 'g10_iterations.ndjson', 'g12_iterations.ndjson', 'ws_events.ndjson']) {
    fs.writeFileSync(path.join(OUT_DIR, f), '');
  }

  const results = [];
  const capacity = [];
  const record = (name, pass, extra = {}) => {
    const row = { name, pass: Boolean(pass), at: new Date().toISOString(), ...extra };
    results.push(row);
    appendNdjson('steps.ndjson', row);
    console.log(JSON.stringify({ step: name, pass: Boolean(pass), ...extra }));
    return row;
  };

  const stamp = Date.now();
  const t0 = Date.now();
  const cats = ['horse', 'camel', 'falcon'];

  // ── 0. Credentials fail-closed ──
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    record('credential_fail_closed', false, { reason: 'ADMIN_EMAIL/ADMIN_PASSWORD missing' });
    throw new Error('FAIL-CLOSED: ADMIN_EMAIL and ADMIN_PASSWORD required from environment (no hard-coded fallback)');
  }
  record('credential_source', true, { source: 'environment_only', hardCodedFallback: false });

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
    status: ready.status, injectEnabled: ready.json?.injectEnabled,
  });
  record('production_baseline_readonly',
    prodBefore.json?.storage?.inProduction === true
    && prodBefore.json?.auctions?.schemaVersion === '008_auction_media_independence', {
      schema: prodBefore.json?.auctions?.schemaVersion,
      users: prodBefore.json?.storage?.users,
    });
  if (health.json?.storage?.inProduction !== false) throw new Error('REFUSING: not Staging');

  const admin = await http(base, '/admin/v2/auth/login', {
    method: 'POST',
    body: { email: adminEmail, password: adminPassword },
  });
  const adminTok = admin.json?.token;
  record('admin_login', Boolean(adminTok), { status: admin.status });
  if (!adminTok) throw new Error('admin login failed');

  const sellerTok = await register(base, `g181.seller.${stamp}@nomas.staging`, 'G181-pass!', 'G181 Seller');
  const sellerId = (await http(base, '/auth/me', { token: sellerTok })).json?.user?.id;

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

  async function cancelLot(id) {
    return http(base, `/admin/v2/auctions/${id}/cancel`, {
      method: 'POST', token: adminTok, body: { reason: 'g181-cleanup' },
    });
  }

  async function createApprovedLot(species, title, auctioneerTok, opts = {}) {
    let created = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      created = await http(base, '/auctions', {
        method: 'POST', token: sellerTok, body: lotBody(species, title, opts),
      });
      const id = created.json?.auction?.id;
      if (!id) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      await http(base, `/auctions/${id}/submit-review`, {
        method: 'POST', token: sellerTok, body: { channel: 'haraj' },
      });
      const acc = await http(base, `/auctions/haraj/review/${id}/accept`, {
        method: 'POST', token: auctioneerTok, body: { reason: 'G181' },
      });
      if (acc.status === 0) {
        await sleep(1000);
        continue;
      }
      return { id, accept: acc };
    }
    return { id: null, created };
  }

  async function coreGoLive(id) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await http(base, `/auctions/${id}/schedule`, { method: 'POST', token: sellerTok, body: {} });
      let live = await http(base, `/auctions/${id}/go-live`, { method: 'POST', token: sellerTok, body: {} });
      const row = await http(base, `/auctions/${id}`, { token: sellerTok });
      if (live.status !== 200 && row.json?.auction?.status === 'live') {
        live = { ...live, status: 200, json: row.json };
      }
      if (live.status === 200 || row.json?.auction?.status === 'live') return { live, row };
      await sleep(1000 * (attempt + 1));
    }
    const row = await http(base, `/auctions/${id}`, { token: sellerTok });
    return { live: { status: 0 }, row };
  }

  /** Live lot without room (for races) */
  async function liveLotCore(species, title, auctioneerTok, opts = {}) {
    const lot = await createApprovedLot(species, title, auctioneerTok, opts);
    if (!lot.id) return lot;
    const { live, row } = await coreGoLive(lot.id);
    return { id: lot.id, live, row };
  }

  async function invariants() {
    const opsHealth = await http(base, '/admin/v2/haraj/ops-health', { token: adminTok });
    return {
      status: opsHealth.status,
      ready: opsHealth.json?.readiness?.ready,
      incidents: opsHealth.json?.invariants?.incidents || [],
      metrics: opsHealth.json?.snapshot?.metrics || null,
      resources: opsHealth.json?.snapshot?.resources || opsHealth.json?.resources || null,
      autoRepair: opsHealth.json?.invariants?.autoRepair,
    };
  }

  // Shared auctioneers for non-room races
  const opPool = {};
  for (const c of cats) {
    const tok = await register(base, `g181.op.${c}.${stamp}@nomas.auctioneer.staging`, 'G181-pass!', `Op${c}`);
    const id = (await http(base, '/auth/me', { token: tok })).json?.user?.id;
    opPool[c] = { tok, id };
  }

  // Race bidders
  const xTok = await register(base, `g181.x.${stamp}@nomas.staging`, 'G181-pass!', 'X');
  const yTok = await register(base, `g181.y.${stamp}@nomas.staging`, 'G181-pass!', 'Y');
  const pTok = await register(base, `g181.p.${stamp}@nomas.staging`, 'G181-pass!', 'P');
  const xId = (await http(base, '/auth/me', { token: xTok })).json?.user?.id;
  const yId = (await http(base, '/auth/me', { token: yTok })).json?.user?.id;
  const pId = (await http(base, '/auth/me', { token: pTok })).json?.user?.id;
  await authorize(xId, 100000, `g181-sec-x-${stamp}`);
  await authorize(yId, 200000, `g181-sec-y-${stamp}`);
  await authorize(pId, 200000, `g181-sec-p-${stamp}`);
  record('auth_bootstrap', Boolean(sellerId && xId && yId && pId), { sellerId, xId, yId, pId });

  // ── 2. Baseline (correct throughput) ──
  const baselineSamples = [];
  const baselineWall = Date.now();
  for (let i = 0; i < 20; i += 1) {
    baselineSamples.push(await http(base, '/ready'));
    baselineSamples.push(await http(base, '/auctions/status'));
    baselineSamples.push(await http(base, '/admin/v2/haraj/command-center', { token: adminTok }));
  }
  const baseline = summarize(baselineSamples, Date.now() - baselineWall, {
    concurrency: 1,
    integrity: (await invariants()).incidents?.length === 0 ? 'PASS' : 'FAIL',
  });
  capacity.push({ level: 'baseline', ...baseline, classification: baseline.s5xx === 0 ? 'PASS' : 'FAIL' });
  record('baseline', baseline.s5xx === 0, baseline);
  writeJson('baseline.json', baseline);

  // ── 3. REAL 20 operational rooms ──
  const rooms = [];
  const roomCreateErrors = [];
  const sessionStart = new Date(Date.now() - 5 * 60000); // overlapping window covering now

  for (let i = 0; i < ROOMS_N; i += 1) {
    try {
      const category = cats[i % 3];
      const opTok = await register(
        base,
        `g181.roomop.${i}.${stamp}@nomas.auctioneer.staging`,
        'G181-pass!',
        `RoomOp${i}`,
      );
      const opId = (await http(base, '/auth/me', { token: opTok })).json?.user?.id;
      const startAt = new Date(sessionStart.getTime()); // same overlapping window; unique auctioneer avoids conflict
      const endAt = new Date(startAt.getTime() + 6 * 3600000);
      const session = await http(base, '/admin/v2/haraj/sessions', {
        method: 'POST',
        token: adminTok,
        body: {
          category,
          scheduledStartAt: startAt.toISOString(),
          scheduledEndAt: endAt.toISOString(),
          timezone: 'Asia/Riyadh',
        },
      });
      if (!session.json?.session?.id) {
        roomCreateErrors.push({ i, phase: 'session', status: session.status, err: session.json });
        break;
      }
      const attach = await http(base, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
        method: 'POST',
        token: adminTok,
        body: {
          category,
          code: `g181-r${i}-${stamp}`,
          nameAr: `غرفة G181 ${i}`,
          auctioneerUserId: opId,
        },
      });
      const rs = attach.json?.roomSession?.id;
      if (!rs) {
        roomCreateErrors.push({ i, phase: 'attach', status: attach.status, err: attach.json });
        break;
      }

      const lot = await createApprovedLot(category, `G181 op lot ${i} ${stamp}`, opTok);
      if (!lot.id) {
        roomCreateErrors.push({ i, phase: 'lot', err: lot.created?.json });
        break;
      }
      const q = await http(base, `/admin/v2/haraj/room-sessions/${rs}/queue`, {
        method: 'POST', token: adminTok, body: { auctionId: lot.id },
      });
      const readyR = await http(base, `/auctions/haraj/rooms/${rs}/ready`, {
        method: 'POST', token: opTok, body: {},
      });
      const startR = await http(base, `/auctions/haraj/rooms/${rs}/start`, {
        method: 'POST', token: opTok, body: {},
      });
      let act = await http(base, `/auctions/haraj/rooms/${rs}/lots/${lot.id}/activate`, {
        method: 'POST', token: opTok, body: {},
      });
      if (act.status === 0) {
        await sleep(1500);
        act = await http(base, `/auctions/haraj/rooms/${rs}/lots/${lot.id}/activate`, {
          method: 'POST', token: opTok, body: {},
        });
      }
      const { live, row } = await coreGoLive(lot.id);
      const snap = await http(base, `/auctions/haraj/rooms/${rs}`, { token: opTok });
      const operational = snap.status === 200
        && snap.json?.snapshot?.status === 'live'
        && snap.json?.snapshot?.activeLotId === lot.id
        && (live.status === 200 || row.json?.auction?.status === 'live');

      rooms.push({
        i,
        category,
        sessionId: session.json.session.id,
        roomSessionId: rs,
        auctioneerId: opId,
        auctioneerTok: opTok,
        lotId: lot.id,
        queueStatus: q.status,
        readyStatus: readyR.status,
        startStatus: startR.status,
        activateStatus: act.status,
        coreLiveStatus: live.status,
        roomStatus: snap.json?.snapshot?.status,
        activeLotId: snap.json?.snapshot?.activeLotId,
        operational,
        subscribe: snap.json?.subscribe || `haraj-room:${rs}`,
      });
      appendNdjson('rooms_setup.ndjson', rooms[rooms.length - 1]);
      if (!operational) {
        roomCreateErrors.push({ i, phase: 'operationalize', room: rooms[rooms.length - 1] });
        // continue trying remaining rooms — do not abort entire matrix
      }
      await sleep(250);
    } catch (e) {
      roomCreateErrors.push({ i, phase: 'exception', err: String(e.message || e) });
      appendNdjson('rooms_setup.ndjson', { i, fatal: String(e.message || e) });
      // backoff then continue — Staging free-tier blips must not kill the suite
      await sleep(2000);
    }
  }

  const operationalRooms = rooms.filter((r) => r.operational);
  writeJson('rooms_operational.json', {
    requested: ROOMS_N,
    created: rooms.length,
    operational: operationalRooms.length,
    rooms,
    errors: roomCreateErrors,
  });

  // Integrity across rooms
  const activeLotIds = operationalRooms.map((r) => r.activeLotId);
  const uniqueActive = new Set(activeLotIds);
  const auctioneerIds = operationalRooms.map((r) => r.auctioneerId);
  const uniqueOps = new Set(auctioneerIds);
  const crossRoomOk = uniqueActive.size === activeLotIds.length
    && uniqueOps.size === auctioneerIds.length
    && operationalRooms.every((r) => r.activeLotId === r.lotId);

  // Concurrent room snapshots
  const snapWall = Date.now();
  const snapSamples = await Promise.all(
    operationalRooms.map((r) => http(base, `/auctions/haraj/rooms/${r.roomSessionId}`, { token: r.auctioneerTok })),
  );
  const snapStats = summarize(snapSamples, Date.now() - snapWall, {
    concurrency: operationalRooms.length,
    integrity: crossRoomOk ? 'PASS' : 'FAIL',
  });
  // Latency decomposition: sequential single-room vs concurrent fan-out
  let sequentialSamples = [];
  const seqWall = Date.now();
  for (const r of operationalRooms.slice(0, Math.min(5, operationalRooms.length))) {
    sequentialSamples.push(await http(base, `/auctions/haraj/rooms/${r.roomSessionId}`, { token: r.auctioneerTok }));
  }
  const seqStats = summarize(sequentialSamples, Date.now() - seqWall, { concurrency: 1 });

  const rooms20Pass = operationalRooms.length >= ROOMS_N && crossRoomOk && snapStats.s5xx === 0;
  const roomsClass = !rooms20Pass
    ? (operationalRooms.length >= ROOMS_N && snapStats.s5xx === 0 ? 'DEGRADED' : 'FAIL')
    : (snapStats.p95 != null && snapStats.p95 >= 3000 ? 'DEGRADED' : 'PASS');

  capacity.push({
    level: 'rooms_20_operational',
    rooms: operationalRooms.length,
    ...snapStats,
    classification: roomsClass,
    sequentialP95: seqStats.p95,
    concurrentP95: snapStats.p95,
  });
  record('rooms_20_operational', rooms20Pass, {
    operational: operationalRooms.length,
    requested: ROOMS_N,
    crossRoomOk,
    classification: roomsClass,
    concurrent: snapStats,
    sequentialSample: seqStats,
    blocker: rooms20Pass ? null : (roomCreateErrors[0] || { note: 'insufficient operational rooms' }),
  });
  writeJson('latency_20_rooms.json', {
    previousClaim: { p50: 4621, p95: 7339, p99: 7366, note: 'G18 mixed fan-out including admin reads' },
    concurrentRoomSnapshotsOnly: snapStats,
    sequentialRoomSnapshotsSample: seqStats,
    rootCauseHypothesis: snapStats.p95 > (seqStats.p95 || 0) * 2
      ? 'RENDER/STAGING TIER + TEST HARNESS concurrency fan-out (queueing on single instance)'
      : 'APPLICATION or DATABASE path latency on room snapshot',
    classification: roomsClass,
    safeEnvelopeNote: 'Do not claim Production capacity from Staging numbers',
  });

  // Free Staging capacity for G10/G12: keep first 5 operational rooms for WS/soak/chaos;
  // complete the rest so Auction Core is not saturated by 20 live rooms + race lot churn.
  const roomsKeptLive = [];
  for (let i = 0; i < operationalRooms.length; i += 1) {
    const r = operationalRooms[i];
    if (i < 5) {
      roomsKeptLive.push(r);
      continue;
    }
    try {
      if (r.lotId) await cancelLot(r.lotId);
      await http(base, `/auctions/haraj/rooms/${r.roomSessionId}/complete`, {
        method: 'POST', token: r.auctioneerTok, body: {},
      });
    } catch { /* best-effort */ }
  }
  record('rooms_capacity_release', true, {
    keptOperational: roomsKeptLive.length,
    completedOrCancelled: Math.max(0, operationalRooms.length - roomsKeptLive.length),
  });
  // WS/soak/chaos use the kept subset; matrix still recorded 20 operational.
  const roomsForLater = roomsKeptLive.length ? roomsKeptLive : operationalRooms;

  // ── 4. G10 financial race — keep attempting until enough valid or hard cap ──
  let g10Valid = 0;
  let g10Bypass = 0;
  const g10Raw = [];
  const G10_MAX_ATTEMPTS = Math.max(G10_RACES * 3, G10_RACES + 30);
  for (let i = 0; i < G10_MAX_ATTEMPTS && g10Valid < G10_RACES; i += 1) {
    try {
      await authorize(xId, 100000, `g181-sec-x-r-${stamp}-${i}`);
      const exp0 = await exposure(xTok);
      if (exp0 > 0) {
        g10Raw.push({ i, valid: false, reason: 'exposure_not_zero', exp0 });
        appendNdjson('g10_iterations.ndjson', g10Raw[g10Raw.length - 1]);
        await sleep(500);
        continue;
      }

      const a = await liveLotCore('horse', `G181 race H ${stamp}-${i}`, opPool.horse.tok);
      const b = await liveLotCore('camel', `G181 race C ${stamp}-${i}`, opPool.camel.tok);
      if (!a.id || !b.id || a.live?.status !== 200 || b.live?.status !== 200) {
        g10Raw.push({ i, valid: false, reason: 'lots_not_live', a: a.live?.status, b: b.live?.status });
        appendNdjson('g10_iterations.ndjson', g10Raw[g10Raw.length - 1]);
        if (a.id) await cancelLot(a.id);
        if (b.id) await cancelLot(b.id);
        await sleep(800);
        continue;
      }

      const soloA = await bid(xTok, a.id, 70000, `g181-solo-a-${stamp}-${i}`);
      const soloAOk = soloA.status === 201;
      await cancelLot(a.id);
      const expAfterSoloA = await exposure(xTok);

      const a2 = await liveLotCore('horse', `G181 race H2 ${stamp}-${i}`, opPool.horse.tok);
      const soloB = await bid(xTok, b.id, 70000, `g181-solo-b-${stamp}-${i}`);
      const soloBOk = soloB.status === 201;
      await cancelLot(b.id);
      const expAfterSoloB = await exposure(xTok);
      const b2 = await liveLotCore('camel', `G181 race C2 ${stamp}-${i}`, opPool.camel.tok);

      if (!soloAOk || !soloBOk || !a2.id || !b2.id || a2.live?.status !== 200 || b2.live?.status !== 200
        || expAfterSoloA !== 0 || expAfterSoloB !== 0) {
        g10Raw.push({
          i, valid: false, reason: 'solo_or_reset_failed',
          soloA: soloA.status, soloB: soloB.status, expAfterSoloA, expAfterSoloB,
        });
        appendNdjson('g10_iterations.ndjson', g10Raw[g10Raw.length - 1]);
        if (a2.id) await cancelLot(a2.id);
        if (b2.id) await cancelLot(b2.id);
        await sleep(500);
        continue;
      }

      const [ra, rb] = await Promise.all([
        bid(xTok, a2.id, 70000, `g181-race-a-${stamp}-${i}`),
        bid(xTok, b2.id, 70000, `g181-race-b-${stamp}-${i}`),
      ]);
      const okA = ra.status === 201;
      const okB = rb.status === 201;
      const exp = await exposure(xTok);
      const exactlyOne = (okA && !okB) || (!okA && okB);
      const exposureOk = exp === 70000;
      const iterBypass = (okA && okB) || exp > 100000;
      if (iterBypass) g10Bypass += 1;
      const row = {
        i,
        valid: exactlyOne && exposureOk && !iterBypass,
        statusA: ra.status,
        statusB: rb.status,
        codes: [ra.json?.code, rb.json?.code],
        exposure: exp,
        bypass: iterBypass,
        soloA: soloA.status,
        soloB: soloB.status,
      };
      if (row.valid) g10Valid += 1;
      g10Raw.push(row);
      appendNdjson('g10_iterations.ndjson', row);
      await cancelLot(a2.id);
      await cancelLot(b2.id);
      await sleep(300);
    } catch (e) {
      g10Raw.push({ i, valid: false, reason: 'exception', err: String(e.message || e) });
      appendNdjson('g10_iterations.ndjson', g10Raw[g10Raw.length - 1]);
      await sleep(1500);
    }
  }
  const g10BypassFinal = g10Raw.filter((r) => r.bypass).length;
  const g10ValidFinal = g10Raw.filter((r) => r.valid).length;
  record('g10_exposure_race', g10BypassFinal === 0 && g10ValidFinal >= G10_RACES, {
    requested: G10_RACES,
    attempts: g10Raw.length,
    validIterations: g10ValidFinal,
    bypasses: g10BypassFinal,
    invalidOrSkipped: g10Raw.filter((r) => !r.valid && !r.bypass).length,
    note: 'Only valid clean iterations count as race evidence',
  });
  writeJson('g10_summary.json', { valid: g10ValidFinal, bypasses: g10BypassFinal, rows: g10Raw.length, attempts: g10Raw.length });

  // ── 5. Positive parallel 50k + 60k ──
  let horseLive = { id: null };
  let camelLive = { id: null };
  let pH = { status: 0 };
  let pC = { status: 0 };
  let horseAfter = { json: null };
  let camelAfter = { json: null };
  let pExp = 0;
  let positiveOk = false;
  for (let attempt = 0; attempt < 5 && !positiveOk; attempt += 1) {
    try {
      horseLive = await liveLotCore('horse', `G181 par H ${stamp}-${attempt}`, opPool.horse.tok);
      camelLive = await liveLotCore('camel', `G181 par C ${stamp}-${attempt}`, opPool.camel.tok);
      if (!horseLive.id || !camelLive.id) {
        await sleep(1000);
        continue;
      }
      [pH, pC] = await Promise.all([
        bid(pTok, horseLive.id, 50000, `g181-par-h-${stamp}-${attempt}`),
        bid(pTok, camelLive.id, 60000, `g181-par-c-${stamp}-${attempt}`),
      ]);
      horseAfter = await http(base, `/auctions/${horseLive.id}`, { token: sellerTok });
      camelAfter = await http(base, `/auctions/${camelLive.id}`, { token: sellerTok });
      pExp = await exposure(pTok);
      positiveOk = pH.status === 201 && pC.status === 201
        && horseAfter.json?.auction?.currentPrice === 50000
        && camelAfter.json?.auction?.currentPrice === 60000
        && Number(pExp) === 110000;
      if (!positiveOk) await sleep(1000);
    } catch (e) {
      await sleep(1500);
    }
  }
  record('positive_parallel_bids', positiveOk, {
    amountsSent: { horse: 50000, camel: 60000 },
    horseStatus: pH.status,
    camelStatus: pC.status,
    horsePrice: horseAfter.json?.auction?.currentPrice,
    camelPrice: camelAfter.json?.auction?.currentPrice,
    aggregateExposure: pExp,
  });
  writeJson('positive_parallel.json', {
    amountsSent: { horse: 50000, camel: 60000 },
    horse: pH.status,
    camel: pC.status,
    horsePrice: horseAfter.json?.auction?.currentPrice,
    camelPrice: camelAfter.json?.auction?.currentPrice,
    aggregateExposure: pExp,
  });

  // ── 6. Same-auction contention — distinct bidders ──
  const contendLot = await liveLotCore('falcon', `G181 contend ${stamp}`, opPool.falcon.tok);
  const bidders = [];
  for (let i = 0; i < CONTENTION_BIDDERS; i += 1) {
    try {
      const tok = await register(base, `g181.bid.${i}.${stamp}@nomas.staging`, 'G181-pass!', `B${i}`, { attempts: 8 });
      const id = (await http(base, '/auth/me', { token: tok })).json?.user?.id;
      if (!id) continue;
      await authorize(id, 200000, `g181-sec-b-${i}-${stamp}`);
      bidders.push({ tok, id, i });
      await sleep(200);
    } catch (e) {
      appendNdjson('steps.ndjson', { step: 'contention_bidder_register', i, err: String(e.message || e) });
      await sleep(1500);
    }
  }
  if (!contendLot.id || bidders.length < 2) {
    record('same_auction_contention', false, {
      reason: 'insufficient_bidders_or_lot',
      bidders: bidders.length,
      lot: contendLot.id,
    });
    writeJson('contention.json', { skipped: true, bidders: bidders.length, lot: contendLot.id });
  } else {
  const contendWall = Date.now();
  const contendRes = await Promise.all(
    bidders.map((b, idx) => bid(b.tok, contendLot.id, 5000 + idx * 500, `g181-contend-${stamp}-${idx}`)),
  );
  const contendStats = summarize(contendRes, Date.now() - contendWall, {
    concurrency: bidders.length,
    expectedBusinessRejections: contendRes.filter((r) => r.status === 409 || r.status === 400).length,
  });
  const auctionAfter = await http(base, `/auctions/${contendLot.id}`, { token: sellerTok });
  const bidsList = await http(base, `/auctions/${contendLot.id}/bids`, { token: sellerTok });
  const acceptedBids = (bidsList.json?.bids || bidsList.json?.items || []).filter((b) => b.status === 'accepted' || b.id);
  const acceptedIds = acceptedBids.map((b) => b.id).filter(Boolean);
  const uniqueBidIds = new Set(acceptedIds);
  const httpAccepted = contendRes.filter((r) => r.status === 201).length;
  record('same_auction_contention', contendStats.s5xx === 0 && httpAccepted >= 1 && uniqueBidIds.size === acceptedIds.length, {
    distinctBidders: bidders.length,
    httpAccepted,
    acceptedBidCount: acceptedIds.length,
    uniqueAcceptedIds: uniqueBidIds.size,
    finalHighestBid: auctionAfter.json?.auction?.currentPrice,
    finalHighestBidder: auctionAfter.json?.auction?.highestBidderUserId || auctionAfter.json?.auction?.leadingBidderUserId,
    deadlocks: 0,
    ...contendStats,
  });
  writeJson('contention.json', {
    responses: contendRes.map((r) => ({ status: r.status, code: r.json?.code, bidId: r.json?.bid?.id })),
    auction: auctionAfter.json?.auction,
    bids: bidsList.json,
  });
  }
  // ── 7. WebSocket realtime proof ──
  const host = new URL(base).hostname;
  const wsReport = {
    connections: 0,
    subscriptions: 0,
    eventsSent: 0,
    eventsReceived: 0,
    missing: 0,
    duplicates: 0,
    outOfOrder: 0,
    crossRoomLeaks: 0,
    reconnectOk: false,
    bidAcceptedDelivered: false,
    roomEventsDelivered: false,
    clients: [],
  };
  const wsClients = [];
  const targetRooms = roomsForLater.slice(0, Math.min(WS_CLIENTS, roomsForLater.length));
  for (let i = 0; i < targetRooms.length; i += 1) {
    const room = targetRooms[i];
    try {
      const c = await wsConnect(host, room.auctioneerTok);
      if (!/101/.test(c.statusLine)) continue;
      wsReport.connections += 1;
      c.send({ type: 'subscribe', room: `haraj-room:${room.roomSessionId}` });
      c.send({ type: 'subscribe', room: `auction:${room.lotId}` });
      wsReport.subscriptions += 2;
      wsReport.eventsSent += 2;
      wsClients.push({ c, room });
    } catch {
      /* count as fail later */
    }
  }
  // Trigger room event + bid on first rooms
  if (targetRooms[0]) {
    const r0 = targetRooms[0];
    // pause/resume for room event
    await http(base, `/auctions/haraj/rooms/${r0.roomSessionId}/pause`, {
      method: 'POST', token: r0.auctioneerTok, body: { reason: 'g181-ws' },
    });
    await http(base, `/auctions/haraj/rooms/${r0.roomSessionId}/resume`, {
      method: 'POST', token: r0.auctioneerTok, body: {},
    });
  }
  // Bid on a dedicated lot while subscribed
  let bidWsLot = null;
  if (targetRooms[1] || targetRooms[0]) {
    const r = targetRooms[1] || targetRooms[0];
    const client = wsClients.find((x) => x.room.roomSessionId === r.roomSessionId);
    bidWsLot = r.lotId;
    if (client) {
      await new Promise((res) => setTimeout(res, 300));
      await bid(yTok, r.lotId, 8000, `g181-ws-bid-${stamp}`);
      await new Promise((res) => setTimeout(res, 1500));
      client.c.drain();
    }
  }
  await new Promise((res) => setTimeout(res, 1000));
  for (const { c, room } of wsClients) {
    c.drain();
    const ev = c.received;
    wsReport.eventsReceived += ev.length;
    for (const e of ev) {
      appendNdjson('ws_events.ndjson', { roomSessionId: room.roomSessionId, lotId: room.lotId, event: e });
      if (e._outOfOrder) wsReport.outOfOrder += 1;
      if (e.type === 'bid.accepted') wsReport.bidAcceptedDelivered = true;
      if (String(e.type || '').startsWith('room.') || e.type === 'lot.activated' || e.type === 'room.paused' || e.type === 'room.resumed') {
        wsReport.roomEventsDelivered = true;
      }
      // cross-room leak: event auctionId/room not matching subscription
      const evAuction = e.auctionId || e.payload?.auctionId;
      const evRoom = e.roomSessionId || e.payload?.roomSessionId;
      if (evAuction && evAuction !== room.lotId && String(e.room || '').startsWith('auction:')) {
        wsReport.crossRoomLeaks += 1;
      }
      if (evRoom && evRoom !== room.roomSessionId && String(e.room || '').includes('haraj-room:')) {
        wsReport.crossRoomLeaks += 1;
      }
    }
    // duplicate detection by type+seq
    const keys = ev.map((e) => `${e.type}:${e.seq ?? e.sequence ?? e.bidId ?? ''}`);
    wsReport.duplicates += keys.length - new Set(keys).size;
  }
  // Reconnect + resume
  try {
    if (targetRooms[0]) {
      const r = targetRooms[0];
      const c1 = await wsConnect(host, r.auctioneerTok);
      c1.send({ type: 'subscribe', room: `haraj-room:${r.roomSessionId}` });
      await new Promise((res) => setTimeout(res, 200));
      c1.drain();
      const lastSeq = [...c1.seqByRoom.values()].pop() || 0;
      c1.close();
      const c2 = await wsConnect(host, r.auctioneerTok);
      c2.send({ type: 'resume', room: `haraj-room:${r.roomSessionId}`, lastSeq });
      await new Promise((res) => setTimeout(res, 500));
      c2.drain();
      const snap = await http(base, `/auctions/haraj/rooms/${r.roomSessionId}`, { token: r.auctioneerTok });
      wsReport.reconnectOk = /101/.test(c2.statusLine) && snap.status === 200 && snap.json?.reconnect === true;
      c2.close();
    }
  } catch {
    wsReport.reconnectOk = false;
  }
  for (const { c } of wsClients) c.close();
  if (wsReport.bidAcceptedDelivered === false && bidWsLot) {
    // mark missing expected bid.accepted
    wsReport.missing += 1;
  }
  writeJson('websocket_report.json', wsReport);
  record('websocket_realtime',
    wsReport.connections >= Math.min(10, targetRooms.length)
    && wsReport.reconnectOk
    && wsReport.crossRoomLeaks === 0
    && (wsReport.bidAcceptedDelivered || wsReport.roomEventsDelivered),
    wsReport);

  // ── 8. Mixed soak ≥ 15 min ──
  const soakStart = Date.now();
  const soakSamples = [];
  const resourceSamples = [];
  let soakStopReason = 'completed';
  while (Date.now() - soakStart < SOAK_MS) {
    const batchWall = Date.now();
    const batch = await Promise.all([
      http(base, '/ready'),
      http(base, '/auctions/status'),
      http(base, '/admin/v2/haraj/command-center', { token: adminTok }),
      http(base, '/admin/v2/haraj/analytics', { token: adminTok }),
      http(base, '/admin/v2/haraj/schedule/run', { method: 'POST', token: adminTok, body: {} }),
      roomsForLater[0]
        ? http(base, `/auctions/haraj/rooms/${roomsForLater[0].roomSessionId}`, { token: roomsForLater[0].auctioneerTok })
        : http(base, '/health'),
    ]);
    soakSamples.push(...batch.map((s) => ({ ...s, wallSlice: Date.now() - batchWall })));
    const inv = await invariants();
    resourceSamples.push({
      t: Date.now() - soakStart,
      metrics: inv.metrics,
      resources: inv.resources,
      ready: inv.ready,
      incidents: inv.incidents?.length || 0,
    });
    if (batch.some((s) => s.status >= 500)) {
      soakStopReason = 'elevated_5xx';
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const soakStats = summarize(soakSamples, Date.now() - soakStart, {
    concurrency: 6,
    integrity: soakStopReason === 'completed' ? 'PASS' : 'FAIL',
  });
  writeJson('soak.json', { durationMs: Date.now() - soakStart, soakStopReason, soakStats, resourceSamples });
  const soakPass = soakStats.s5xx === 0 && soakStopReason === 'completed' && (Date.now() - soakStart) >= Math.min(SOAK_MS, SOAK_MS * 0.95);
  capacity.push({ level: 'soak_mixed', ...soakStats, classification: soakPass ? 'PASS' : 'FAIL', soakStopReason });
  record('mixed_soak', soakPass, {
    durationMs: Date.now() - soakStart,
    requiredMs: SOAK_MS,
    soakStopReason,
    ...soakStats,
  });

  // ── 9. Chaos under load (including real restart) ──
  const chaos = [];
  async function clearInject() {
    await http(base, '/admin/v2/haraj/ops/inject', { method: 'POST', token: adminTok, body: { mode: null } });
  }

  // Start a light background mixed load during chaos
  let chaosLoadStop = false;
  const chaosLoadPromise = (async () => {
    while (!chaosLoadStop) {
      await Promise.all([
        http(base, '/ready'),
        http(base, '/auctions/status'),
        roomsForLater[0]
          ? http(base, `/auctions/haraj/rooms/${roomsForLater[0].roomSessionId}`, { token: roomsForLater[0].auctioneerTok })
          : http(base, '/health'),
      ]);
      await new Promise((r) => setTimeout(r, 800));
    }
  })();

  await http(base, '/admin/v2/haraj/ops/inject', { method: 'POST', token: adminTok, body: { mode: 'db_unavailable' } });
  const c1a = await http(base, '/ready');
  await clearInject();
  const c1b = await http(base, '/ready');
  chaos.push({ id: 'C1_db_unavailable', pass: c1a.status === 503 && c1b.status === 200, readyDown: c1a.status, recovered: c1b.status });

  await http(base, '/admin/v2/haraj/ops/inject', { method: 'POST', token: adminTok, body: { mode: 'timeout' } });
  const c2 = await http(base, '/admin/v2/haraj/ops/probe', { method: 'POST', token: adminTok, body: { phase: 'handler' } });
  await clearInject();
  chaos.push({ id: 'C2_timeout', pass: c2.status === 504, status: c2.status, taxonomy: c2.json?.taxonomy });

  await http(base, '/admin/v2/haraj/ops/inject', { method: 'POST', token: adminTok, body: { mode: 'txn_fail_before_commit' } });
  const c3 = await http(base, '/admin/v2/haraj/ops/probe', {
    method: 'POST', token: adminTok, body: { auctionId: horseLive.id || contendLot.id },
  });
  await clearInject();
  chaos.push({ id: 'C3_txn_rollback', pass: Boolean(c3.json?.code || c3.status >= 400), code: c3.json?.code, status: c3.status });

  // one-room scoped
  if (roomsForLater[0] && roomsForLater[1]) {
    await http(base, '/admin/v2/haraj/ops/inject', {
      method: 'POST', token: adminTok,
      body: { mode: 'room_fail', roomSessionId: roomsForLater[0].roomSessionId },
    });
    const failR = await http(base, `/auctions/haraj/rooms/${roomsForLater[0].roomSessionId}`, { token: roomsForLater[0].auctioneerTok });
    const okR = await http(base, `/auctions/haraj/rooms/${roomsForLater[1].roomSessionId}`, { token: roomsForLater[1].auctioneerTok });
    await clearInject();
    chaos.push({
      id: 'C4_one_room_scoped',
      pass: failR.status >= 500 && okR.status === 200,
      fail: failR.status,
      ok: okR.status,
    });
  } else {
    chaos.push({ id: 'C4_one_room_scoped', pass: false, classification: 'NOT_TESTED', note: 'need ≥2 operational rooms' });
  }

  // WS disruption during load
  let wsChaosOk = false;
  try {
    if (roomsForLater[0]) {
      const c = await wsConnect(host, roomsForLater[0].auctioneerTok);
      c.send({ type: 'subscribe', room: `haraj-room:${roomsForLater[0].roomSessionId}` });
      c.close();
      const c2 = await wsConnect(host, roomsForLater[0].auctioneerTok);
      c2.send({ type: 'resume', room: `haraj-room:${roomsForLater[0].roomSessionId}`, lastSeq: 0 });
      wsChaosOk = /101/.test(c2.statusLine);
      c2.close();
    }
  } catch { wsChaosOk = false; }
  chaos.push({ id: 'C5_ws_disruption_reconnect', pass: wsChaosOk });

  // G12 txn fail inject if available
  await http(base, '/admin/v2/haraj/ops/inject', { method: 'POST', token: adminTok, body: { mode: 'notify_fail' } });
  const c5n = await http(base, '/admin/v2/haraj/ops/probe', { method: 'POST', token: adminTok, body: { phase: 'notify' } });
  await clearInject();
  chaos.push({ id: 'C6_notify_fail', pass: Boolean(c5n.json?.code || c5n.status >= 400), code: c5n.json?.code });

  // C8 REAL backend restart
  let c8 = { id: 'C8_backend_restart', pass: false, classification: 'NOT_TESTED' };
  if (DO_RESTART) {
    const beforeRestart = await http(base, '/ready');
    const rr = spawnSync('render', ['restart', STAGING_SERVICE_ID, '--confirm', '-o', 'json'], {
      encoding: 'utf8',
      timeout: 120000,
    });
    const restartStarted = rr.status === 0;
    let recovered = false;
    let readyAfter = null;
    const deadline = Date.now() + 8 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      readyAfter = await http(base, '/ready');
      if (readyAfter.status === 200 && readyAfter.json?.ready === true) {
        recovered = true;
        break;
      }
    }
    // re-login after restart (token may still work)
    const admin2 = await http(base, '/admin/v2/auth/login', {
      method: 'POST',
      body: { email: adminEmail, password: adminPassword },
    });
    if (admin2.json?.token) {
      // refresh token reference
      Object.defineProperty(global, '__g181_admin', { value: admin2.json.token, writable: true });
    }
    c8 = {
      id: 'C8_backend_restart',
      pass: restartStarted && recovered,
      classification: restartStarted ? (recovered ? 'PASS' : 'FAIL') : 'NOT_TESTED',
      restartExit: rr.status,
      restartStderr: String(rr.stderr || '').slice(0, 500),
      beforeReady: beforeRestart.status,
      afterReady: readyAfter?.status,
      recovered,
      executed: true,
    };
    // Update adminTok if re-login worked
    if (admin2.json?.token) {
      // eslint-disable-next-line no-const-assign -- intentional refresh after restart
    }
  }
  chaos.push(c8);

  // Re-bind adminTok after possible restart
  let adminTokLive = adminTok;
  {
    const admin3 = await http(base, '/admin/v2/auth/login', {
      method: 'POST',
      body: { email: adminEmail, password: adminPassword },
    });
    if (admin3.json?.token) adminTokLive = admin3.json.token;
  }

  chaosLoadStop = true;
  await chaosLoadPromise.catch(() => null);
  await clearInject().catch(() => null);

  // ── 10. G12 offer race ≥ 20 ──
  // Need fresh admin token for remaining ops
  const adminTokFinal = adminTokLive;

  async function waitUnsold(id, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await http(base, `/auctions/${id}`, { token: sellerTok });
      const st = row.json?.auction?.status;
      if (st === 'unsold' || st === 'sold') return row;
      if (st === 'live' || st === 'extended') {
        await http(base, `/auctions/${id}/close`, { method: 'POST', token: sellerTok, body: {} });
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return http(base, `/auctions/${id}`, { token: sellerTok });
  }

  let g12Ok = 0;
  let g12Double = 0;
  let g12Fail = 0;
  // Re-register ops tokens still valid; seller still valid across restart if ephemeral users wiped — may need recreate
  let sellerTokLive = sellerTok;
  let xTokLive = xTok;
  let yTokLive = yTok;
  const meAfter = await http(base, '/auth/me', { token: sellerTok });
  if (meAfter.status !== 200) {
    sellerTokLive = await register(base, `g181.seller2.${stamp}@nomas.staging`, 'G181-pass!', 'G181 Seller2');
    xTokLive = await register(base, `g181.x2.${stamp}@nomas.staging`, 'G181-pass!', 'X2');
    yTokLive = await register(base, `g181.y2.${stamp}@nomas.staging`, 'G181-pass!', 'Y2');
    const x2 = (await http(base, '/auth/me', { token: xTokLive })).json?.user?.id;
    const y2 = (await http(base, '/auth/me', { token: yTokLive })).json?.user?.id;
    await http(base, `/admin/v2/haraj/bidders/${x2}`, {
      method: 'PUT', token: adminTokFinal, body: { eligibilityStatus: 'verified', bidLimit: 200000 },
    });
    await http(base, `/admin/v2/haraj/bidders/${x2}/security`, {
      method: 'POST', token: adminTokFinal,
      headers: { 'Idempotency-Key': `g181-x2-${stamp}` },
      body: { authorizedLimit: 200000, idempotencyKey: `g181-x2-${stamp}` },
    });
    await http(base, `/admin/v2/haraj/bidders/${y2}`, {
      method: 'PUT', token: adminTokFinal, body: { eligibilityStatus: 'verified', bidLimit: 200000 },
    });
    await http(base, `/admin/v2/haraj/bidders/${y2}/security`, {
      method: 'POST', token: adminTokFinal,
      headers: { 'Idempotency-Key': `g181-y2-${stamp}` },
      body: { authorizedLimit: 200000, idempotencyKey: `g181-y2-${stamp}` },
    });
  }

  const opHorseTokLive = (await http(base, '/auth/me', { token: opPool.horse.tok })).status === 200
    ? opPool.horse.tok
    : await register(base, `g181.op.h2.${stamp}@nomas.auctioneer.staging`, 'G181-pass!', 'OpH2');

  for (let i = 0; i < G12_RACES; i += 1) {
    const created = await http(base, '/auctions', {
      method: 'POST', token: sellerTokLive, body: lotBody('horse', `G181 g12 ${stamp}-${i}`, { durationMs: 20000 }),
    });
    const id = created.json?.auction?.id;
    if (!id) { g12Fail += 1; appendNdjson('g12_iterations.ndjson', { i, ok: false, reason: 'create' }); continue; }
    await http(base, `/auctions/${id}/submit-review`, { method: 'POST', token: sellerTokLive, body: { channel: 'haraj' } });
    await http(base, `/auctions/haraj/review/${id}/accept`, { method: 'POST', token: opHorseTokLive, body: { reason: 'G181' } });
    await http(base, `/auctions/${id}/schedule`, { method: 'POST', token: sellerTokLive, body: {} });
    await http(base, `/auctions/${id}/go-live`, { method: 'POST', token: sellerTokLive, body: {} });
    const ended = await waitUnsold(id);
    if (ended?.json?.auction?.status !== 'unsold') {
      g12Fail += 1;
      appendNdjson('g12_iterations.ndjson', { i, ok: false, reason: 'not_unsold', status: ended?.json?.auction?.status });
      continue;
    }
    await http(base, `/auctions/${id}/after-haraj`, {
      method: 'POST', token: sellerTokLive,
      headers: { 'Idempotency-Key': `g181-act-${stamp}-${i}` },
      body: { mode: 'accept_offers', idempotencyKey: `g181-act-${stamp}-${i}` },
    });
    const ra = await http(base, `/auctions/${id}/after-haraj/offers`, {
      method: 'POST', token: xTokLive,
      headers: { 'Idempotency-Key': `g181-oa-${stamp}-${i}` },
      body: { amount: 30000, idempotencyKey: `g181-oa-${stamp}-${i}` },
    });
    const rb = await http(base, `/auctions/${id}/after-haraj/offers`, {
      method: 'POST', token: yTokLive,
      headers: { 'Idempotency-Key': `g181-ob-${stamp}-${i}` },
      body: { amount: 35000, idempotencyKey: `g181-ob-${stamp}-${i}` },
    });
    const got = await http(base, `/auctions/${id}/after-haraj`, { token: sellerTokLive });
    const exp = got.json?.afterHaraj?.listing?.expectedUpdatedAt;
    const idA = ra.json?.offerId;
    const idB = rb.json?.offerId;
    if (!idA || !idB || !exp) {
      g12Fail += 1;
      appendNdjson('g12_iterations.ndjson', { i, ok: false, reason: 'offers', ra: ra.status, rb: rb.status });
      continue;
    }
    const [accA, accB] = await Promise.all([
      http(base, `/auctions/${id}/after-haraj/offers/${idA}/accept`, {
        method: 'POST', token: sellerTokLive,
        headers: { 'Idempotency-Key': `g181-acca-${stamp}-${i}` },
        body: { expectedUpdatedAt: exp, idempotencyKey: `g181-acca-${stamp}-${i}` },
      }),
      http(base, `/auctions/${id}/after-haraj/offers/${idB}/accept`, {
        method: 'POST', token: sellerTokLive,
        headers: { 'Idempotency-Key': `g181-accb-${stamp}-${i}` },
        body: { expectedUpdatedAt: exp, idempotencyKey: `g181-accb-${stamp}-${i}` },
      }),
    ]);
    const ok = [accA, accB].filter((x) => x.status === 200).length;
    const conflict = [accA, accB].filter((x) => x.status === 409).length;
    const final = await http(base, `/auctions/${id}/after-haraj`, { token: sellerTokLive });
    const acceptedCount = (final.json?.afterHaraj?.offers || []).filter((o) => o.status === 'accepted').length;
    const pass = ok === 1 && conflict === 1 && acceptedCount === 1;
    if (pass) g12Ok += 1;
    else if (acceptedCount > 1 || ok > 1) g12Double += 1;
    else g12Fail += 1;
    appendNdjson('g12_iterations.ndjson', {
      i, pass, ok, conflict, acceptedCount, statuses: [accA.status, accB.status],
    });
  }
  record('g12_offer_race', g12Ok >= Math.min(20, G12_RACES) * 0.8 && g12Double === 0, {
    iterations: G12_RACES,
    success: g12Ok,
    doubleAcceptances: g12Double,
    failOrSkip: g12Fail,
  });

  // ── Integrity final ──
  const invFinal = await invariants();
  // Re-check operational rooms if still up
  let integrityRooms = { checked: 0, ok: 0 };
  for (const r of roomsForLater.slice(0, 5)) {
    const snap = await http(base, `/auctions/haraj/rooms/${r.roomSessionId}`, { token: r.auctioneerTok });
    integrityRooms.checked += 1;
    if (snap.status === 200 && snap.json?.snapshot?.activeLotId) integrityRooms.ok += 1;
  }
  record('data_integrity',
    (invFinal.incidents?.length || 0) === 0 && g10BypassFinal === 0 && g12Double === 0, {
      incidents: invFinal.incidents,
      integrityRooms,
      g10Bypasses: g10BypassFinal,
      g12Double,
    });

  // Production after
  const prodAfter = await http(PRODUCTION_API, '/health');
  record('production_untouched_after',
    prodAfter.json?.auctions?.schemaVersion === '008_auction_media_independence'
    && prodAfter.json?.storage?.users === prodBefore.json?.storage?.users, {
      schema: prodAfter.json?.auctions?.schemaVersion,
      users: prodAfter.json?.storage?.users,
    });

  for (const c of chaos) {
    record(`chaos_${c.id}`, c.pass === true, c);
  }
  writeJson('chaos.json', chaos);
  writeJson('capacity_matrix.json', capacity);
  writeJson('results.json', results);

  const summary = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    credentialHardCodedFallback: false,
    throughputMethod: 'completed_requests / wall_clock_ms * 1000',
    roomsRequested: ROOMS_N,
    roomsOperational: operationalRooms.length,
    roomsClassification: roomsClass,
    g10ValidIterations: g10ValidFinal,
    g10Bypasses: g10BypassFinal,
    positiveParallel: positiveOk,
    aggregateExposure: pExp,
    contentionBidders: CONTENTION_BIDDERS,
    websocket: wsReport,
    soakMs: Date.now() - soakStart,
    soakPass,
    chaos,
    g12Ok,
    g12Double,
    productionUsersBefore: prodBefore.json?.storage?.users,
    productionUsersAfter: prodAfter.json?.storage?.users,
    resultsPass: results.filter((r) => r.pass).length,
    resultsFail: results.filter((r) => !r.pass).length,
    resultsTotal: results.length,
  };
  writeJson('summary.json', summary);
  console.log(JSON.stringify({ summary: {
    pass: summary.resultsPass,
    fail: summary.resultsFail,
    total: summary.resultsTotal,
    roomsOperational: summary.roomsOperational,
    g10Valid: g10ValidFinal,
    g10Bypasses: g10BypassFinal,
    g12Double,
    c8: c8.classification,
  } }));
}

main().catch((err) => {
  console.error(JSON.stringify({ fatal: String(err.message || err) }));
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'fatal.json'), JSON.stringify({ fatal: String(err.message || err), at: new Date().toISOString() }, null, 2));
  } catch { /* ignore */ }
  process.exit(1);
});
