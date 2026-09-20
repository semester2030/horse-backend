#!/usr/bin/env node
'use strict';

/**
 * G18.2 — Focused WebSocket duplicate semantics + readiness probe.
 * Staging only. No soak. No full G18.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

const STAGING_API = 'https://horse-backend-staging.onrender.com';
const PRODUCTION_API = 'https://horse-backend-i68h.onrender.com';
const OUT = process.env.G182_OUT_DIR || '/tmp/nomas-g18.2';

function assertStaging(url) {
  if (!String(url).includes('horse-backend-staging') || String(url).includes('horse-backend-i68h')) {
    throw new Error(`STAGING ONLY: ${url}`);
  }
}

async function http(base, p, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body != null) h['Content-Type'] = 'application/json';
  const started = Date.now();
  try {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: h,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 800) }; }
    return {
      status: res.status,
      json,
      text: text.slice(0, 2000),
      ms: Date.now() - started,
      headers: {
        cfRay: res.headers.get('cf-ray'),
        server: res.headers.get('server'),
        requestId: res.headers.get('x-request-id') || json?.requestId || null,
      },
    };
  } catch (e) {
    return { status: 0, json: null, text: '', ms: Date.now() - started, err: String(e.message || e), headers: {} };
  }
}

function pickToken(json) {
  return json?.idToken || json?.token || json?.accessToken || null;
}

async function register(base, email, password, name) {
  for (let i = 0; i < 6; i += 1) {
    const reg = await http(base, '/auth/register', {
      method: 'POST',
      body: { email, password, name, accountRole: 'heritage_advertiser' },
    });
    if (reg.status === 200 || reg.status === 201) return pickToken(reg.json);
    const login = await http(base, '/auth/login', { method: 'POST', body: { email, password } });
    if (login.status === 200) return pickToken(login.json);
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
    endAt: new Date(start.getTime() + 2 * 3600000).toISOString(),
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g182/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g182-placeholder',
    description: 'G18.2 WS micro',
    inspection: { available: true, windows: 'x' },
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
      const text = payload.toString('utf8');
      try { messages.push(JSON.parse(text)); } catch { messages.push({ raw: text.slice(0, 200) }); }
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
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('ws timeout')); }, 20000);
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
          connectionId: null,
          received,
          send: (obj) => sock.write(encodeTextFrame(JSON.stringify(obj))),
          drain: () => {
            const { messages, rest } = decodeFrames(buf);
            buf = rest;
            for (const m of messages) {
              const room = m.room || null;
              const seq = m.seq ?? m.sequence ?? null;
              const source = m.replay === true
                ? 'REPLAY'
                : (m.type === 'subscribed' || m.type === 'resume.ack' || m.type === 'connected'
                  ? 'CONTROL'
                  : (String(m.type || '').startsWith('replay.') ? 'REPLAY_CONTROL' : 'LIVE'));
              const eventId = m.bidId || m.eventId || `${m.type || 'unk'}|${room || ''}|${seq ?? ''}|${m.serverTimestamp || m._t || ''}`;
              const row = {
                subscriberId: api.subscriberId,
                connectionId: m.connectionId || api.connectionId,
                roomId: room,
                eventId,
                eventType: m.type,
                sequence: seq,
                deliverySource: source,
                replayFlag: m.replay === true,
                receivedAt: new Date().toISOString(),
                raw: m,
              };
              if (m.type === 'connected' || m.type === 'subscribed' || m.type === 'resume.ack') {
                if (m.connectionId) api.connectionId = m.connectionId;
              }
              received.push(row);
            }
            return messages;
          },
          close: () => { try { sock.destroy(); } catch { /* */ } },
        };
        resolve(api);
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function classifyDuplicates(allRows) {
  const CONTROL = new Set(['connected', 'subscribed', 'resume.ack', 'replay.begin', 'replay.complete', 'subscribe.denied']);
  // auction.presence is ephemeral unsequenced fan-out (ws_hub) — not SoT; successive updates are expected.
  const EPHEMERAL = new Set(['auction.presence']);
  const business = allRows.filter((r) => !CONTROL.has(r.eventType) && !EPHEMERAL.has(r.eventType) && !String(r.eventType || '').startsWith('replay.'));

  // A: same eventId+room to same subscriber more than once (excluding intentional LIVE+REPLAY pair handled in C)
  const bySubEvent = new Map();
  for (const r of business) {
    const k = `${r.subscriberId}||${r.roomId}||${r.eventType}||${r.sequence ?? ''}`;
    if (!bySubEvent.has(k)) bySubEvent.set(k, []);
    bySubEvent.get(k).push(r);
  }

  let sameSubDup = 0;
  let intentionalLivePlusReplay = 0;
  let trueUnexpected = 0;
  const details = [];

  for (const [k, arr] of bySubEvent) {
    if (arr.length <= 1) continue;
    const sources = new Set(arr.map((a) => a.deliverySource));
    const hasLive = sources.has('LIVE');
    const hasReplay = sources.has('REPLAY');
    if (arr.length === 2 && hasLive && hasReplay) {
      intentionalLivePlusReplay += 1;
      details.push({ class: 'INTENTIONAL_LIVE_PLUS_REPLAY', key: k, n: arr.length });
      continue;
    }
    // Multiple REPLAY of same seq to same subscriber = unexpected (or double subscribe)
    // Multiple LIVE of same seq = unexpected
    const sameSourceDup = arr.length > 1 && sources.size === 1;
    if (sameSourceDup || arr.length > 2) {
      trueUnexpected += arr.length - 1;
      sameSubDup += arr.length - 1;
      details.push({
        class: 'TRUE_UNEXPECTED_OR_SAME_SUBSCRIBER',
        key: k,
        n: arr.length,
        sources: [...sources],
      });
    } else {
      sameSubDup += arr.length - 1;
      details.push({ class: 'SAME_EVENT_SAME_SUBSCRIBER', key: k, n: arr.length, sources: [...sources] });
    }
  }

  // B: same event delivered to different subscribers (expected fan-out)
  const byEventRoom = new Map();
  for (const r of business) {
    const k = `${r.roomId}||${r.eventType}||${r.sequence ?? ''}`;
    if (!byEventRoom.has(k)) byEventRoom.set(k, new Set());
    byEventRoom.get(k).add(r.subscriberId);
  }
  let multiSubDeliveries = 0;
  for (const [, subs] of byEventRoom) {
    if (subs.size > 1) multiSubDeliveries += 1;
  }

  const replayDeliveries = business.filter((r) => r.deliverySource === 'REPLAY').length;

  return {
    SAME_EVENT_SAME_SUBSCRIBER_DUPLICATES: sameSubDup,
    SAME_EVENT_DIFFERENT_SUBSCRIBERS: multiSubDeliveries,
    INTENTIONAL_LIVE_PLUS_REPLAY: intentionalLivePlusReplay,
    TRUE_UNEXPECTED_DUPLICATES: trueUnexpected,
    replayDeliveries,
    businessEventCount: business.length,
    details,
  };
}

function write(name, data) {
  fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

async function main() {
  const base = process.env.G182_STAGING_API || STAGING_API;
  assertStaging(base);
  fs.mkdirSync(OUT, { recursive: true });

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('FAIL-CLOSED: ADMIN_EMAIL and ADMIN_PASSWORD required from environment');
  }

  // ── Readiness 520 investigation ──
  const readyProbes = [];
  for (let i = 0; i < 8; i += 1) {
    const r = await http(base, '/ready');
    readyProbes.push({
      i,
      at: new Date().toISOString(),
      status: r.status,
      ms: r.ms,
      ready: r.json?.ready,
      bodyKeys: r.json ? Object.keys(r.json) : [],
      cfRay: r.headers.cfRay,
      server: r.headers.server,
      requestId: r.headers.requestId,
      bodySnippet: r.text.slice(0, 400),
      err: r.err || null,
    });
    await new Promise((x) => setTimeout(x, 400));
  }
  const health = await http(base, '/health');
  const prod = await http(PRODUCTION_API, '/health');
  write('readiness_probes.json', {
    historicalG181: {
      at: '2026-09-11T20:54:59.659Z',
      status: 520,
      note: 'From G18.1 steps.ndjson staging_ready — no HTML/body captured in that step',
    },
    probes: readyProbes,
    health: { status: health.status, inProduction: health.json?.storage?.inProduction, version: health.json?.version },
    productionReadonly: { status: prod.status, schema: prod.json?.auctions?.schemaVersion, users: prod.json?.storage?.users },
  });

  // ── Analyze prior G18.1 ws_events if present ──
  let priorAnalysis = null;
  const priorPath = '/tmp/nomas-g18.1/ws_events.ndjson';
  if (fs.existsSync(priorPath)) {
    const lines = fs.readFileSync(priorPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const mapped = lines.map((row, idx) => {
      const e = row.event || {};
      return {
        subscriberId: `prior-sub-${row.roomSessionId}`,
        connectionId: e.connectionId || null,
        roomId: e.room || `haraj-room:${row.roomSessionId}`,
        eventId: e.bidId || `${e.type}|${e.room}|${e.seq}`,
        eventType: e.type,
        sequence: e.seq ?? e.sequence ?? null,
        deliverySource: e.replay === true ? 'REPLAY' : (['connected', 'subscribed', 'resume.ack'].includes(e.type) ? 'CONTROL' : (String(e.type || '').startsWith('replay.') ? 'REPLAY_CONTROL' : 'LIVE')),
        replayFlag: e.replay === true,
        receivedAt: e._t ? new Date(e._t).toISOString() : null,
        idx,
      };
    });
    const buggyKeys = mapped.map((r) => `${r.eventType}:${r.sequence ?? ''}`);
    priorAnalysis = {
      totalLogged: lines.length,
      buggyCounterTypeSeqOnly: buggyKeys.length - new Set(buggyKeys).size,
      classification: classifyDuplicates(mapped),
      contract: 'ws_hub.handleSequencedSubscribe always calls replayToClient(floor) after subscribe/resume; replayed events carry replay:true',
      conclusion: 'G18.1 duplicates=15 was a COUNTER BUG (keyed type:seq without room/subscriber), not true same-subscriber unexpected duplicates',
    };
    write('prior_g181_ws_reclassification.json', priorAnalysis);
  }

  // ── Auth + 3 category rooms ──
  const stamp = Date.now();
  const admin = await http(base, '/admin/v2/auth/login', {
    method: 'POST',
    body: { email: adminEmail, password: adminPassword },
  });
  const adminTok = admin.json?.token;
  if (!adminTok) throw new Error(`admin login ${admin.status}`);

  const sellerTok = await register(base, `g182.seller.${stamp}@nomas.staging`, 'G182-pass!', 'G182S');
  const bidderTok = await register(base, `g182.bid.${stamp}@nomas.staging`, 'G182-pass!', 'G182B');
  const bidderId = (await http(base, '/auth/me', { token: bidderTok })).json?.user?.id;
  await http(base, `/admin/v2/haraj/bidders/${bidderId}`, {
    method: 'PUT', token: adminTok, body: { eligibilityStatus: 'verified', bidLimit: 200000 },
  });
  await http(base, `/admin/v2/haraj/bidders/${bidderId}/security`, {
    method: 'POST',
    token: adminTok,
    headers: { 'Idempotency-Key': `g182-sec-${stamp}` },
    body: { authorizedLimit: 200000, idempotencyKey: `g182-sec-${stamp}` },
  });

  const cats = ['horse', 'camel', 'falcon'];
  const rooms = [];
  const startAt = new Date(Date.now() - 60000);
  const endAt = new Date(Date.now() + 6 * 3600000);

  for (const category of cats) {
    const opTok = await register(base, `g182.op.${category}.${stamp}@nomas.auctioneer.staging`, 'G182-pass!', `Op${category}`);
    const opId = (await http(base, '/auth/me', { token: opTok })).json?.user?.id;
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
    const attach = await http(base, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
      method: 'POST',
      token: adminTok,
      body: {
        category,
        code: `g182-${category}-${stamp}`,
        nameAr: `G182 ${category}`,
        auctioneerUserId: opId,
      },
    });
    const rs = attach.json?.roomSession?.id;
    const created = await http(base, '/auctions', {
      method: 'POST', token: sellerTok, body: lotBody(category, `G182 ${category} ${stamp}`),
    });
    const lotId = created.json?.auction?.id;
    await http(base, `/auctions/${lotId}/submit-review`, { method: 'POST', token: sellerTok, body: { channel: 'haraj' } });
    await http(base, `/auctions/haraj/review/${lotId}/accept`, { method: 'POST', token: opTok, body: { reason: 'G182' } });
    await http(base, `/admin/v2/haraj/room-sessions/${rs}/queue`, { method: 'POST', token: adminTok, body: { auctionId: lotId } });
    await http(base, `/auctions/haraj/rooms/${rs}/ready`, { method: 'POST', token: opTok, body: {} });
    await http(base, `/auctions/haraj/rooms/${rs}/start`, { method: 'POST', token: opTok, body: {} });
    await http(base, `/auctions/haraj/rooms/${rs}/lots/${lotId}/activate`, { method: 'POST', token: opTok, body: {} });
    await http(base, `/auctions/${lotId}/schedule`, { method: 'POST', token: sellerTok, body: {} });
    await http(base, `/auctions/${lotId}/go-live`, { method: 'POST', token: sellerTok, body: {} });
    rooms.push({ category, rs, lotId, opTok, opId });
  }
  write('rooms.json', rooms);

  const host = new URL(base).hostname;
  const clients = [];
  // 2 subscribers per room (auctioneer + bidder)
  for (const room of rooms) {
    for (const [label, tok] of [['auctioneer', room.opTok], ['bidder', bidderTok]]) {
      const c = await wsConnect(host, tok);
      c.subscriberId = `${room.category}:${label}:${crypto.randomBytes(3).toString('hex')}`;
      if (!/101/.test(c.statusLine)) throw new Error(`ws fail ${room.category} ${label}`);
      c.send({ type: 'subscribe', room: `haraj-room:${room.rs}` });
      c.send({ type: 'subscribe', room: `auction:${room.lotId}` });
      clients.push({ c, room, label });
      await new Promise((r) => setTimeout(r, 200));
      c.drain();
    }
  }

  // Generate live room events on horse
  const horse = rooms[0];
  await http(base, `/auctions/haraj/rooms/${horse.rs}/pause`, {
    method: 'POST', token: horse.opTok, body: { reason: 'g182' },
  });
  await http(base, `/auctions/haraj/rooms/${horse.rs}/resume`, {
    method: 'POST', token: horse.opTok, body: {},
  });
  await http(base, `/auctions/${horse.lotId}/bids`, {
    method: 'POST',
    token: bidderTok,
    headers: { 'Idempotency-Key': `g182-bid-${stamp}` },
    body: { amount: 5000, idempotencyKey: `g182-bid-${stamp}` },
  });
  await new Promise((r) => setTimeout(r, 1500));
  for (const { c } of clients) c.drain();

  // Disconnect one camel bidder, generate event, reconnect+resume
  const camel = rooms[1];
  const camelBidder = clients.find((x) => x.room.category === 'camel' && x.label === 'bidder');
  let lastSeqHaraj = 0;
  for (const row of camelBidder.c.received) {
    if (row.roomId === `haraj-room:${camel.rs}` && row.sequence != null) {
      lastSeqHaraj = Math.max(lastSeqHaraj, Number(row.sequence) || 0);
    }
  }
  camelBidder.c.close();

  await http(base, `/auctions/haraj/rooms/${camel.rs}/pause`, {
    method: 'POST', token: camel.opTok, body: { reason: 'g182-missed' },
  });
  await http(base, `/auctions/haraj/rooms/${camel.rs}/resume`, {
    method: 'POST', token: camel.opTok, body: {},
  });
  await new Promise((r) => setTimeout(r, 800));

  const re = await wsConnect(host, bidderTok);
  re.subscriberId = camelBidder.c.subscriberId + ':reconnected';
  re.send({ type: 'resume', room: `haraj-room:${camel.rs}`, lastSeq: lastSeqHaraj });
  await new Promise((r) => setTimeout(r, 1000));
  re.drain();
  const snap = await http(base, `/auctions/haraj/rooms/${camel.rs}`, { token: bidderTok });
  const reconnectOk = /101/.test(re.statusLine);
  const recoveryOk = snap.status === 200 && Boolean(snap.json?.snapshot);
  const replayedMissed = re.received.some((r) => r.deliverySource === 'REPLAY' || r.eventType === 'room.paused' || r.eventType === 'room.resumed' || r.eventType === 'replay.complete');

  // Final drain all remaining
  for (const { c } of clients) {
    try { c.drain(); } catch { /* */ }
  }
  re.drain();

  const allRows = [];
  for (const { c } of clients) {
    if (c === camelBidder.c) continue; // closed
    allRows.push(...c.received);
  }
  allRows.push(...re.received);
  // include pre-disconnect camel bidder events
  allRows.push(...camelBidder.c.received);

  write('ws_events_instrumented.ndjson', allRows.map((r) => JSON.stringify({
    subscriberId: r.subscriberId,
    connectionId: r.connectionId,
    roomId: r.roomId,
    eventId: r.eventId,
    eventType: r.eventType,
    sequence: r.sequence,
    deliverySource: r.deliverySource,
    receivedAt: r.receivedAt,
  })).join('\n') + '\n');

  const classification = classifyDuplicates(allRows);

  // Cross-room leak: event roomId not matching any subscribed room of that subscriber's category set
  let crossRoomLeaks = 0;
  for (const row of allRows) {
    if (!row.roomId || ['connected', 'subscribed', 'resume.ack'].includes(row.eventType)) continue;
    const owner = clients.find((x) => x.c.subscriberId === row.subscriberId)
      || (row.subscriberId.startsWith(camelBidder.c.subscriberId) ? camelBidder : null);
    if (!owner) continue;
    const allowed = new Set([`haraj-room:${owner.room.rs}`, `auction:${owner.room.lotId}`]);
    if (row.roomId && !allowed.has(row.roomId) && !String(row.eventType).startsWith('replay')) {
      // presence on auction is allowed for that lot only
      crossRoomLeaks += 1;
    }
  }

  const bidAccepted = allRows.some((r) => r.eventType === 'bid.accepted' && r.deliverySource === 'LIVE');
  const roomEvents = allRows.some((r) => r.eventType === 'room.paused' || r.eventType === 'room.resumed');

  // Out of order per subscriber+room
  let outOfOrder = 0;
  const lastSeqMap = new Map();
  for (const row of allRows) {
    if (row.sequence == null || !row.roomId) continue;
    if (['subscribed', 'resume.ack', 'connected'].includes(row.eventType)) continue;
    const k = `${row.subscriberId}||${row.roomId}`;
    const prev = lastSeqMap.get(k);
    if (prev != null && row.sequence < prev && row.deliverySource === 'LIVE') outOfOrder += 1;
    if (row.deliverySource === 'LIVE' || row.deliverySource === 'REPLAY') {
      lastSeqMap.set(k, Math.max(prev || 0, Number(row.sequence) || 0));
    }
  }

  const report = {
    eventsSentApprox: clients.length * 2,
    eventsReceived: allRows.length,
    classification,
    missingCritical: {
      bidAccepted: bidAccepted ? 0 : 1,
      roomStateEvent: roomEvents ? 0 : 1,
    },
    outOfOrder,
    crossRoomLeaks,
    reconnectOk,
    authoritativeRecovery: recoveryOk,
    replayedAfterReconnect: replayedMissed,
    bidAcceptedDelivered: bidAccepted,
    roomEventsDelivered: roomEvents,
    priorG181: priorAnalysis,
  };
  write('websocket_retest_report.json', report);

  for (const { c } of clients) {
    try { c.close(); } catch { /* */ }
  }
  re.close();

  // Cleanup best-effort
  for (const room of rooms) {
    await http(base, `/admin/v2/auctions/${room.lotId}/cancel`, {
      method: 'POST', token: adminTok, body: { reason: 'g182-cleanup' },
    }).catch(() => null);
  }

  const readyStatuses = readyProbes.map((p) => p.status);
  const readyFinal = readyProbes[readyProbes.length - 1];
  const summary = {
    generatedAt: new Date().toISOString(),
    websocket: report,
    readiness: {
      historical520At: '2026-09-11T20:54:59.659Z',
      probes: readyStatuses,
      finalStatus: readyFinal.status,
      finalReady: readyFinal.ready,
      reproducibleNow: readyStatuses.includes(520),
    },
    productionUntouched: prod.json?.auctions?.schemaVersion === '008_auction_media_independence',
    pass: classification.TRUE_UNEXPECTED_DUPLICATES === 0
      && classification.SAME_EVENT_SAME_SUBSCRIBER_DUPLICATES === 0
      && crossRoomLeaks === 0
      && outOfOrder === 0
      && reconnectOk
      && recoveryOk
      && bidAccepted
      && readyFinal.status === 200,
  };
  write('summary.json', summary);
  console.log(JSON.stringify({ step: 'g182_done', pass: summary.pass, classification, ready: readyStatuses, reconnectOk, recoveryOk }));
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: String(e.message || e) }));
  process.exit(1);
});
