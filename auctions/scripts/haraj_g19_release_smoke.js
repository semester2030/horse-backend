#!/usr/bin/env node
'use strict';

/**
 * G19 — Critical Staging smoke (seller→…→history) + realtime + integrity.
 * STAGING ONLY. No Production. No soak.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

const STAGING = 'https://horse-backend-staging.onrender.com';
const PRODUCTION = 'https://horse-backend-i68h.onrender.com';
const OUT = process.env.G19_OUT_DIR || '/tmp/nomas-g19';

function assertStaging(url) {
  if (!String(url).includes('horse-backend-staging') || String(url).includes('horse-backend-i68h')) {
    throw new Error(`STAGING ONLY: ${url}`);
  }
}

async function http(base, p, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body != null) h['Content-Type'] = 'application/json';
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: h,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 400) }; }
    return { status: res.status, json, text: text.slice(0, 800), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, json: null, text: '', ms: Date.now() - t0, err: String(e.message || e) };
  }
}

function tok(j) {
  return j?.idToken || j?.token || j?.accessToken || null;
}

async function register(base, email, password, name) {
  for (let i = 0; i < 6; i += 1) {
    const reg = await http(base, '/auth/register', {
      method: 'POST',
      body: { email, password, name, accountRole: 'heritage_advertiser' },
    });
    if (reg.status === 200 || reg.status === 201) return tok(reg.json);
    const login = await http(base, '/auth/login', { method: 'POST', body: { email, password } });
    if (login.status === 200) return tok(login.json);
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error(`auth ${email}`);
}

function lotBody(species, title) {
  const start = new Date(Date.now() - 120000);
  return {
    channel: 'haraj',
    independent: true,
    species,
    title,
    startingPrice: 1000,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 45000).toISOString(),
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g19/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g19-placeholder',
    description: 'G19 smoke lot',
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
    const b1 = buf[offset + 1];
    const opcode = buf[offset] & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let hdr = 2;
    if (len === 126) {
      if (offset + 4 > buf.length) break;
      len = (buf[offset + 2] << 8) | buf[offset + 3];
      hdr = 4;
    } else if (len === 127) break;
    const maskLen = masked ? 4 : 0;
    if (offset + hdr + maskLen + len > buf.length) break;
    let payload = buf.slice(offset + hdr + maskLen, offset + hdr + maskLen + len);
    if (masked) {
      const m = buf.slice(offset + hdr, offset + hdr + 4);
      const out = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ m[i % 4];
      payload = out;
    }
    offset += hdr + maskLen + len;
    if (opcode === 0x1 || opcode === 0x2) {
      try { messages.push(JSON.parse(payload.toString('utf8'))); } catch { /* */ }
    }
  }
  return { messages, rest: buf.slice(offset) };
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
    const received = [];
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('ws timeout')); }, 15000);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString('utf8');
        upgraded = true;
        clearTimeout(timer);
        buf = buf.slice(idx + 4);
        resolve({
          sock,
          statusLine: head.split('\r\n')[0],
          received,
          send: (o) => sock.write(encodeTextFrame(JSON.stringify(o))),
          drain: () => {
            const { messages, rest } = decodeFrames(buf);
            buf = rest;
            for (const m of messages) received.push(m);
            return messages;
          },
          close: () => { try { sock.destroy(); } catch { /* */ } },
        });
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  const base = process.env.G19_STAGING_API || STAGING;
  assertStaging(base);
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  const record = (name, pass, extra = {}) => {
    const row = { name, pass: Boolean(pass), at: new Date().toISOString(), ...extra };
    results.push(row);
    console.log(JSON.stringify({ step: name, pass: Boolean(pass), ...extra }));
    return row;
  };

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) throw new Error('FAIL-CLOSED: ADMIN_EMAIL/ADMIN_PASSWORD required');

  const stamp = Date.now();
  const health = await http(base, '/health');
  const ready = await http(base, '/ready');
  const prod = await http(PRODUCTION, '/health');
  record('staging_identity', health.json?.storage?.inProduction === false
    && health.json?.auctions?.schemaVersion === '011_haraj_bidder_eligibility_security', {
    schema: health.json?.auctions?.schemaVersion,
    version: health.json?.version,
    inProduction: health.json?.storage?.inProduction,
  });
  record('staging_ready', ready.status === 200 && ready.json?.ready === true, {
    status: ready.status,
    ready: ready.json?.ready,
    injectEnabled: ready.json?.injectEnabled,
    injectActive: ready.json?.injectActive,
  });
  record('inject_inactive_default', ready.json?.injectActive == null || ready.json?.injectActive === false, {
    injectActive: ready.json?.injectActive,
  });
  record('production_baseline_ro', prod.json?.storage?.inProduction === true
    && prod.json?.auctions?.schemaVersion === '008_auction_media_independence', {
    schema: prod.json?.auctions?.schemaVersion,
    users: prod.json?.storage?.users,
  });

  // Prod inject must be impossible — probe Production /ready for injectEnabled
  const prodReady = await http(PRODUCTION, '/ready');
  record('production_inject_disabled_or_absent',
    prodReady.status !== 200 || prodReady.json?.injectEnabled !== true, {
      status: prodReady.status,
      injectEnabled: prodReady.json?.injectEnabled ?? 'absent',
      note: 'Production must never expose inject',
    });

  const admin = await http(base, '/admin/v2/auth/login', {
    method: 'POST', body: { email: adminEmail, password: adminPassword },
  });
  const adminTok = admin.json?.token;
  record('admin_login', Boolean(adminTok), { status: admin.status });
  if (!adminTok) throw new Error('admin login failed');

  const sellerTok = await register(base, `g19.seller.${stamp}@nomas.staging`, 'G19-pass!', 'G19 Seller');
  const bidderTok = await register(base, `g19.bid.${stamp}@nomas.staging`, 'G19-pass!', 'G19 Bidder');
  const strangerTok = await register(base, `g19.str.${stamp}@nomas.staging`, 'G19-pass!', 'G19 Stranger');
  const opTok = await register(base, `g19.op.${stamp}@nomas.auctioneer.staging`, 'G19-pass!', 'G19 Op');
  const sellerId = (await http(base, '/auth/me', { token: sellerTok })).json?.user?.id;
  const bidderId = (await http(base, '/auth/me', { token: bidderTok })).json?.user?.id;
  const strangerId = (await http(base, '/auth/me', { token: strangerTok })).json?.user?.id;
  const opId = (await http(base, '/auth/me', { token: opTok })).json?.user?.id;

  await http(base, `/admin/v2/haraj/bidders/${bidderId}`, {
    method: 'PUT', token: adminTok, body: { eligibilityStatus: 'verified', bidLimit: 200000 },
  });
  await http(base, `/admin/v2/haraj/bidders/${bidderId}/security`, {
    method: 'POST', token: adminTok,
    headers: { 'Idempotency-Key': `g19-sec-${stamp}` },
    body: { authorizedLimit: 200000, idempotencyKey: `g19-sec-${stamp}` },
  });

  // Security smokes
  const created = await http(base, '/auctions', {
    method: 'POST', token: sellerTok, body: lotBody('horse', `G19 smoke ${stamp}`),
  });
  const lotId = created.json?.auction?.id;
  record('seller_create_lot', Boolean(lotId), { lotId, status: created.status });
  await http(base, `/auctions/${lotId}/submit-review`, {
    method: 'POST', token: sellerTok, body: { channel: 'haraj' },
  });
  const accept = await http(base, `/auctions/haraj/review/${lotId}/accept`, {
    method: 'POST', token: opTok, body: { reason: 'G19' },
  });
  record('auctioneer_accept', accept.status === 200, { status: accept.status });

  const startAt = new Date(Date.now() - 60000);
  const session = await http(base, '/admin/v2/haraj/sessions', {
    method: 'POST', token: adminTok,
    body: {
      category: 'horse',
      scheduledStartAt: startAt.toISOString(),
      scheduledEndAt: new Date(Date.now() + 4 * 3600000).toISOString(),
      timezone: 'Asia/Riyadh',
    },
  });
  const sid = session.json?.session?.id;
  const attach = await http(base, `/admin/v2/haraj/sessions/${sid}/rooms`, {
    method: 'POST', token: adminTok,
    body: { category: 'horse', code: `g19-${stamp}`, nameAr: 'G19 Room', auctioneerUserId: opId },
  });
  const rs = attach.json?.roomSession?.id;
  record('session_room', Boolean(sid && rs), { sid, rs });

  const queue = await http(base, `/admin/v2/haraj/room-sessions/${rs}/queue`, {
    method: 'POST', token: adminTok, body: { auctionId: lotId },
  });
  await http(base, `/auctions/haraj/rooms/${rs}/ready`, { method: 'POST', token: opTok, body: {} });
  await http(base, `/auctions/haraj/rooms/${rs}/start`, { method: 'POST', token: opTok, body: {} });
  const act = await http(base, `/auctions/haraj/rooms/${rs}/lots/${lotId}/activate`, {
    method: 'POST', token: opTok, body: {},
  });
  await http(base, `/auctions/${lotId}/schedule`, { method: 'POST', token: sellerTok, body: {} });
  const live = await http(base, `/auctions/${lotId}/go-live`, { method: 'POST', token: sellerTok, body: {} });
  const snap = await http(base, `/auctions/haraj/rooms/${rs}`, { token: opTok });
  record('queue_activate_live',
    queue.status === 201
    && act.status === 200
    && (live.status === 200 || snap.json?.snapshot?.activeLotId === lotId)
    && snap.json?.snapshot?.status === 'live'
    && snap.json?.snapshot?.activeLotId === lotId, {
      queue: queue.status, act: act.status, live: live.status,
      roomStatus: snap.json?.snapshot?.status,
      activeLotId: snap.json?.snapshot?.activeLotId,
    });

  // Realtime
  const host = new URL(base).hostname;
  let wsOk = false;
  let bidAccepted = false;
  let roomEvent = false;
  let reconnectOk = false;
  let crossLeak = false;
  try {
    const c = await wsConnect(host, bidderTok);
    wsOk = /101/.test(c.statusLine);
    c.send({ type: 'subscribe', room: `haraj-room:${rs}` });
    c.send({ type: 'subscribe', room: `auction:${lotId}` });
    await new Promise((r) => setTimeout(r, 400));
    c.drain();
    const bid = await http(base, `/auctions/${lotId}/bids`, {
      method: 'POST', token: bidderTok,
      headers: { 'Idempotency-Key': `g19-bid-${stamp}` },
      body: { amount: 5000, idempotencyKey: `g19-bid-${stamp}` },
    });
    record('valid_bid', bid.status === 201, { status: bid.status });
    await http(base, `/auctions/haraj/rooms/${rs}/pause`, {
      method: 'POST', token: opTok, body: { reason: 'g19' },
    });
    await http(base, `/auctions/haraj/rooms/${rs}/resume`, {
      method: 'POST', token: opTok, body: {},
    });
    await new Promise((r) => setTimeout(r, 1200));
    c.drain();
    bidAccepted = c.received.some((e) => e.type === 'bid.accepted');
    roomEvent = c.received.some((e) => e.type === 'room.paused' || e.type === 'room.resumed');
    crossLeak = c.received.some((e) => {
      const room = e.room || '';
      return room && room !== `haraj-room:${rs}` && room !== `auction:${lotId}`
        && !String(e.type || '').startsWith('replay') && e.type !== 'connected' && e.type !== 'subscribed';
    });
    let lastSeq = 0;
    for (const e of c.received) {
      if (e.room === `haraj-room:${rs}` && e.seq != null) lastSeq = Math.max(lastSeq, Number(e.seq) || 0);
    }
    c.close();
    const c2 = await wsConnect(host, bidderTok);
    c2.send({ type: 'resume', room: `haraj-room:${rs}`, lastSeq });
    await new Promise((r) => setTimeout(r, 800));
    c2.drain();
    reconnectOk = /101/.test(c2.statusLine);
    c2.close();
  } catch (e) {
    record('realtime_exception', false, { err: String(e.message || e) });
  }
  record('realtime_smoke', wsOk && bidAccepted && roomEvent && reconnectOk && !crossLeak, {
    wsOk, bidAccepted, roomEvent, reconnectOk, crossLeak,
  });

  // Security: self-bid
  const selfBid = await http(base, `/auctions/${lotId}/bids`, {
    method: 'POST', token: sellerTok,
    headers: { 'Idempotency-Key': `g19-self-${stamp}` },
    body: { amount: 6000, idempotencyKey: `g19-self-${stamp}` },
  });
  record('seller_self_bid_blocked', selfBid.status === 403, {
    status: selfBid.status, code: selfBid.json?.code,
  });

  // Unverified stranger bid
  const strangerBid = await http(base, `/auctions/${lotId}/bids`, {
    method: 'POST', token: strangerTok,
    headers: { 'Idempotency-Key': `g19-str-${stamp}` },
    body: { amount: 5500, idempotencyKey: `g19-str-${stamp}` },
  });
  record('ineligible_bidder_blocked', strangerBid.status === 403 || strangerBid.status === 409, {
    status: strangerBid.status, code: strangerBid.json?.code,
  });

  // Close → provisional
  let closed = await http(base, `/auctions/${lotId}/close`, { method: 'POST', token: sellerTok, body: {} });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const row = await http(base, `/auctions/${lotId}`, { token: sellerTok });
    const st = row.json?.auction?.status;
    if (st === 'sold' || st === 'unsold' || st === 'ended') {
      closed = row;
      break;
    }
    if (st === 'live' || st === 'extended') {
      await http(base, `/auctions/${lotId}/close`, { method: 'POST', token: sellerTok, body: {} });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const closeStatus = closed.json?.auction?.status;
  record('auction_close_provisional', ['sold', 'unsold', 'ended'].includes(closeStatus), {
    status: closeStatus,
  });

  // Inspection if sold
  if (closeStatus === 'sold') {
    const insp = await http(base, `/auctions/${lotId}/inspection`, {
      method: 'POST', token: bidderTok,
      headers: { 'Idempotency-Key': `g19-insp-${stamp}` },
      body: { outcome: 'matches_description', idempotencyKey: `g19-insp-${stamp}` },
    });
    const strangerInsp = await http(base, `/auctions/${lotId}/inspection`, {
      method: 'POST', token: strangerTok,
      headers: { 'Idempotency-Key': `g19-insp-str-${stamp}` },
      body: { outcome: 'matches_description', idempotencyKey: `g19-insp-str-${stamp}` },
    });
    record('inspection_winner', insp.status === 200 || insp.status === 201, {
      status: insp.status, code: insp.json?.code,
    });
    record('inspection_non_winner_blocked', strangerInsp.status === 403 || strangerInsp.status === 409, {
      status: strangerInsp.status, code: strangerInsp.json?.code,
    });
  } else {
    record('inspection_winner', true, { skipped: true, reason: 'not_sold', status: closeStatus });
    record('inspection_non_winner_blocked', true, { skipped: true });
  }

  // After-Haraj if unsold
  if (closeStatus === 'unsold') {
    const ah = await http(base, `/auctions/${lotId}/after-haraj`, {
      method: 'POST', token: sellerTok,
      headers: { 'Idempotency-Key': `g19-ah-${stamp}` },
      body: { mode: 'fixed_price', fixedPrice: 4000, idempotencyKey: `g19-ah-${stamp}` },
    });
    const wrongSeller = await http(base, `/auctions/${lotId}/after-haraj`, {
      method: 'POST', token: bidderTok,
      headers: { 'Idempotency-Key': `g19-ah-wrong-${stamp}` },
      body: { mode: 'fixed_price', fixedPrice: 3000, idempotencyKey: `g19-ah-wrong-${stamp}` },
    });
    record('after_haraj_seller', ah.status === 200 || ah.status === 201, { status: ah.status });
    record('after_haraj_wrong_seller_blocked', wrongSeller.status === 403 || wrongSeller.status === 409, {
      status: wrongSeller.status, code: wrongSeller.json?.code,
    });
  } else {
    // still try disposition path via accept_offers if sold completed inspection — optional
    record('after_haraj_seller', true, { skipped: true, reason: closeStatus });
    record('after_haraj_wrong_seller_blocked', true, { skipped: true });
  }

  // Admin surfaces
  const cc = await http(base, '/admin/v2/haraj/command-center', { token: adminTok });
  const ops = await http(base, '/admin/v2/haraj/ops-health', { token: adminTok });
  const hist = await http(base, `/admin/v2/haraj/history?auctionId=${lotId}&limit=20`, { token: adminTok });
  const analytics = await http(base, '/admin/v2/haraj/analytics', { token: adminTok });
  record('admin_command_center', cc.status === 200, { status: cc.status });
  record('admin_ops_health', ops.status === 200 && (ops.json?.invariants?.incidents || []).length === 0, {
    status: ops.status,
    incidents: ops.json?.invariants?.incidents || [],
  });
  record('history_visible', hist.status === 200, { status: hist.status });
  record('analytics_visible', analytics.status === 200, { status: analytics.status });

  // Integrity
  const inv = ops.json?.invariants?.incidents || [];
  record('data_integrity', inv.length === 0, { incidents: inv });

  const prodAfter = await http(PRODUCTION, '/health');
  record('production_untouched_after',
    prodAfter.json?.auctions?.schemaVersion === '008_auction_media_independence'
    && prodAfter.json?.storage?.users === prod.json?.storage?.users, {
      schema: prodAfter.json?.auctions?.schemaVersion,
      users: prodAfter.json?.storage?.users,
    });

  const summary = {
    generatedAt: new Date().toISOString(),
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    total: results.length,
    lotId,
    roomSessionId: rs,
    results,
  };
  fs.writeFileSync(path.join(OUT, 'smoke_summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'smoke_results.ndjson'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify({ summary: { pass: summary.pass, fail: summary.fail, total: summary.total } }));
  if (summary.fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: String(e.message || e) }));
  process.exit(1);
});
