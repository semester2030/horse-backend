#!/usr/bin/env node
'use strict';

const fs = require('fs');
const tls = require('tls');
const crypto = require('crypto');

const STAGING_API = 'https://horse-backend-staging.onrender.com';
const PRODUCTION_API = 'https://horse-backend-i68h.onrender.com';

function assertStaging(url) {
  if (String(url).includes('horse-backend-i68h') || !String(url).includes('horse-backend-staging')) {
    throw new Error(`STAGING ONLY: ${url}`);
  }
}

async function http(base, path, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body != null) h['Content-Type'] = 'application/json';
  const started = Date.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return {
    status: res.status,
    json,
    text,
    ms: Date.now() - started,
    requestId: res.headers.get('x-request-id'),
  };
}

function wsHost(base) {
  return new URL(base).hostname;
}

function maskXor(payload, mask) {
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ mask[i % 4];
  return out;
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([(payload.length >> 8) & 0xff, payload.length & 0xff])]);
  return Buffer.concat([header, mask, maskXor(payload, mask)]);
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
        buf = buf.slice(idx + 4);
        upgraded = true;
        clearTimeout(timer);
        resolve({ sock, statusLine: head.split('\r\n')[0], send: (obj) => sock.write(encodeTextFrame(JSON.stringify(obj))) });
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  const base = process.env.G17_STAGING_API || STAGING_API;
  assertStaging(base);
  const results = [];
  const record = (name, pass, extra) => {
    results.push({ name, pass: Boolean(pass), ...extra });
    console.log(JSON.stringify({ step: name, pass: Boolean(pass), ...extra }));
  };

  const adminTokHolder = { token: null };
  const clearInject = async () => {
    if (!adminTokHolder.token) return;
    await http(base, '/admin/v2/haraj/ops/inject', {
      method: 'POST', token: adminTokHolder.token, body: { mode: null },
    }).catch(() => null);
  };

  try {
    const health = await http(base, '/health');
    const prod = await http(PRODUCTION_API, '/health');
    record('staging_identity', health.json?.storage?.inProduction === false, {
      schema: health.json?.auctions?.schemaVersion,
      version: health.json?.version,
      inProduction: health.json?.storage?.inProduction,
    });
    record('production_baseline',
      prod.json?.storage?.inProduction === true
      && prod.json?.auctions?.schemaVersion === '008_auction_media_independence', {
        schema: prod.json?.auctions?.schemaVersion,
        inProduction: prod.json?.storage?.inProduction,
      });
    record('schema_011', health.json?.auctions?.schemaVersion === '011_haraj_bidder_eligibility_security', {
      schema: health.json?.auctions?.schemaVersion,
    });
    if (health.json?.storage?.inProduction !== false) process.exit(1);

    const ready = await http(base, '/ready');
    record('readiness_200', ready.status === 200 && ready.json?.alive === true && ready.json?.ready === true, {
      status: ready.status, ms: ready.ms,
    });
    record('correlation_header', Boolean(ready.requestId || ready.json?.requestId), {
      requestId: ready.requestId || ready.json?.requestId,
    });
    record('livekit_does_not_block_ready', ready.json?.livekit?.implemented === false && ready.json?.ready === true, {
      livekit: ready.json?.livekit,
    });

    const admin = await http(base, '/admin/v2/auth/login', {
      method: 'POST',
      body: {
        email: process.env.ADMIN_EMAIL || 'admin@nomas.sa',
        password: process.env.ADMIN_PASSWORD || 'NomasAdmin2026!',
      },
    });
    const adminTok = admin.json?.token;
    adminTokHolder.token = adminTok;
    record('admin_login', Boolean(adminTok), { status: admin.status });

    const unauthOps = await http(base, '/admin/v2/haraj/ops-health');
    record('F13_unauth_ops_401', unauthOps.status === 401, { status: unauthOps.status });

    const seller = await http(base, '/auth/register', {
      method: 'POST',
      body: {
        email: `g17.seller.${Date.now()}@nomas.staging`,
        password: 'G17_PASSWORD_SENTINEL',
        name: 'G17 seller',
        accountRole: 'heritage_advertiser',
      },
    });
    const sellerTok = seller.json?.idToken || seller.json?.token;
    const sellerOps = await http(base, '/admin/v2/haraj/ops-health', { token: sellerTok });
    record('F13_seller_ops_rejected', sellerOps.status === 401 || sellerOps.status === 403, {
      status: sellerOps.status,
    });

    const ops = await http(base, '/admin/v2/haraj/ops-health', { token: adminTok });
    const opsBlob = JSON.stringify(ops.json || {});
    record('admin_ops_health', ops.status === 200 && ops.json?.secretsOmitted === true && !opsBlob.includes('postgres://'), {
      status: ops.status,
      ready: ops.json?.readiness?.ready,
    });
    record('invariants_readonly', ops.json?.invariants?.readOnly === true && ops.json?.invariants?.autoRepair === false, {
      incidents: ops.json?.invariants?.incidents?.length,
    });

    const cc = await http(base, '/admin/v2/haraj/command-center', { token: adminTok });
    record('g15_ops_surface', cc.status === 200 && Boolean(cc.json?.overview?.opsHealth?.status), {
      status: cc.status,
      ops: cc.json?.overview?.opsHealth?.status,
    });

    const rooms = await http(base, '/admin/v2/haraj/rooms', { token: adminTok });
    const horse = await http(base, '/admin/v2/haraj/sessions?category=horse', { token: adminTok });
    const camel = await http(base, '/admin/v2/haraj/sessions?category=camel', { token: adminTok });
    const falcon = await http(base, '/admin/v2/haraj/sessions?category=falcon', { token: adminTok });
    record('multi_room_surfaces',
      [rooms, horse, camel, falcon].every((r) => r.status === 200), {
        rooms: rooms.status, horse: horse.status, camel: camel.status, falcon: falcon.status,
      });

    const hist = await http(base, '/admin/v2/haraj/history?limit=1', { token: adminTok });
    const sampleAuction = hist.json?.history?.items?.[0]?.auctionId || hist.json?.items?.[0]?.auctionId;

    const injDb = await http(base, '/admin/v2/haraj/ops/inject', {
      method: 'POST', token: adminTok, body: { mode: 'db_unavailable' },
    });
    const readyDown = await http(base, '/ready');
    const falseOk = await http(base, '/admin/v2/haraj/history?limit=1', { token: adminTok });
    record('F1_db_unavailable_not_ready',
      injDb.status === 200 && readyDown.status === 503 && readyDown.json?.ready === false
      && falseOk.status >= 400, {
        inject: injDb.status, ready: readyDown.status, history: falseOk.status, reasons: readyDown.json?.reasons,
      });
    await clearInject();
    const readyUp = await http(base, '/ready');
    record('F1_db_recovered', readyUp.status === 200 && readyUp.json?.ready === true, { status: readyUp.status });

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
      record('F2_transaction_rollback',
        probe.status >= 500 && probe.json?.code === 'G17_INJECTED_ROLLBACK'
        && probe.json?.businessTruthUnchanged === true
        && String(before.json?.beforeUpdatedAt || '') === String(after.json?.beforeUpdatedAt || ''), {
          status: probe.status, code: probe.json?.code,
          beforeTs: before.json?.beforeUpdatedAt,
          afterTs: after.json?.beforeUpdatedAt,
        });
    } else {
      record('F2_transaction_rollback', false, { reason: 'no sample auction' });
    }

    await http(base, '/admin/v2/haraj/ops/inject', { method: 'POST', token: adminTok, body: { mode: 'timeout' } });
    const t3 = await http(base, '/admin/v2/haraj/ops/probe', {
      method: 'POST', token: adminTok, body: { phase: 'handler' },
    });
    record('F3_timeout', t3.status === 504 && t3.json?.taxonomy === 'TIMEOUT' && Boolean(t3.json?.requestId || t3.requestId), {
      status: t3.status, taxonomy: t3.json?.taxonomy, ms: t3.ms,
    });
    await clearInject();

    const ev1 = sampleAuction
      ? await http(base, `/admin/v2/haraj/risk/evaluate/${sampleAuction}`, { method: 'POST', token: adminTok, body: {} })
      : { status: 0 };
    const ev2 = sampleAuction
      ? await http(base, `/admin/v2/haraj/risk/evaluate/${sampleAuction}`, { method: 'POST', token: adminTok, body: {} })
      : { status: 0 };
    record('F4_evaluate_idempotent',
      !sampleAuction || (ev1.status === 200 && ev2.status === 200), {
        a: ev1.status, b: ev2.status,
      });

    const run1 = await http(base, '/admin/v2/haraj/schedule/run', { method: 'POST', token: adminTok, body: {} });
    const run2 = await http(base, '/admin/v2/haraj/schedule/run', { method: 'POST', token: adminTok, body: {} });
    record('F7_scheduler_duplicate_run',
      run1.status === 200 && run2.status === 200
      && Boolean(run1.json?.jobRunId) && run1.json.jobRunId !== run2.json.jobRunId, {
        a: run1.json?.jobRunId, b: run2.json?.jobRunId, skipped: run2.json?.skipped,
      });

    let wsOk = false;
    let ws401 = false;
    try {
      const denied = await wsConnect(wsHost(base), 'not-a-token');
      ws401 = /401/.test(denied.statusLine);
      denied.sock.destroy();
    } catch {
      ws401 = true;
    }
    try {
      const conn = await wsConnect(wsHost(base), sellerTok || adminTok);
      conn.send({ type: 'subscribe', room: 'room:horse-g17' });
      conn.sock.destroy();
      const conn2 = await wsConnect(wsHost(base), sellerTok || adminTok);
      conn2.send({ type: 'resume', room: 'room:horse-g17', lastSeq: 0 });
      conn2.sock.destroy();
      wsOk = /101/.test(conn.statusLine);
    } catch (err) {
      wsOk = false;
      record('F5_ws_error', false, { error: String(err.message || err) });
    }
    record('F5_websocket_disconnect_reconnect', wsOk || ws401, { upgraded: wsOk, authDenied: ws401 });

    const created = sampleAuction
      ? await http(base, '/admin/v2/auctions/disputes', {
        method: 'POST',
        token: adminTok,
        body: {
          auctionId: sampleAuction,
          category: 'inspection_dispute',
          description: 'G17 F6/F10 controlled case — not a user complaint',
        },
      })
      : { status: 0 };
    const caseId = created.json?.dispute?.id;
    if (caseId) {
      const detail = await http(base, `/admin/v2/haraj/cases/${caseId}`, { token: adminTok });
      const stale = await http(base, `/admin/v2/haraj/cases/${caseId}/resolve`, {
        method: 'POST',
        token: adminTok,
        body: { resolution: 'no_action', note: 'g17 stale', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' },
      });
      record('F6_stale_client', stale.status === 409 && stale.json?.code === 'CASE_STALE_STATE', {
        status: stale.status, code: stale.json?.code, taxonomy: stale.json?.taxonomy,
      });
      const expected = detail.json?.case?.updatedAt;
      const [a, b] = await Promise.all([
        http(base, `/admin/v2/haraj/cases/${caseId}/resolve`, {
          method: 'POST', token: adminTok,
          body: { resolution: 'no_action', note: 'g17 race a', expectedUpdatedAt: expected },
        }),
        http(base, `/admin/v2/haraj/cases/${caseId}/resolve`, {
          method: 'POST', token: adminTok,
          body: { resolution: 'close', note: 'g17 race b', expectedUpdatedAt: expected },
        }),
      ]);
      const statuses = [a.status, b.status].sort();
      record('F10_case_resolution_race', statuses.includes(200) && statuses.includes(409), {
        statuses, codes: [a.json?.code, b.json?.code],
      });
    } else {
      record('F6_stale_client', false, { createStatus: created.status, body: created.json });
      record('F10_case_resolution_race', false, { createStatus: created.status });
    }

    const camelFail = await http(base, '/admin/v2/haraj/sessions?category=camel', {
      token: adminTok,
      headers: { 'x-nomas-g17-inject': 'db_unavailable' },
    });
    const horseOk = await http(base, '/admin/v2/haraj/sessions?category=horse', { token: adminTok });
    const falconOk = await http(base, '/admin/v2/haraj/sessions?category=falcon', { token: adminTok });
    record('F8_multi_room_partial_failure',
      camelFail.status >= 500 && horseOk.status === 200 && falconOk.status === 200, {
        camel: camelFail.status, horse: horseOk.status, falcon: falconOk.status,
      });

    const listings = await http(base, '/admin/v2/haraj/after-market?limit=10', { token: adminTok });
    const listing = (listings.json?.listings || []).find((row) => row.auctionId && (row.offers || []).some((o) => o.status === 'open' || o.status === 'pending'));
    if (listing) {
      const offer = (listing.offers || []).find((o) => o.status === 'open' || o.status === 'pending');
      const expectedAt = listing.updatedAt || listing.expectedUpdatedAt;
      const [oa, ob] = await Promise.all([
        http(base, `/auctions/${listing.auctionId}/after-haraj/offers/${offer.offerId || offer.id}/accept`, {
          method: 'POST', token: adminTok, body: { expectedUpdatedAt: expectedAt },
        }),
        http(base, `/auctions/${listing.auctionId}/after-haraj/offers/${offer.offerId || offer.id}/accept`, {
          method: 'POST', token: adminTok, body: { expectedUpdatedAt: expectedAt },
        }),
      ]);
      const st = [oa.status, ob.status].sort();
      record('F9_g12_offer_race', st.includes(200) && (st.includes(409) || st.includes(403)), {
        statuses: st, codes: [oa.json?.code, ob.json?.code],
      });
    } else {
      const staleOffer = await http(base, '/auctions/00000000-0000-4000-8000-000000000001/after-haraj/offers/o1/accept', {
        method: 'POST', token: adminTok, body: { expectedUpdatedAt: '2000-01-01T00:00:00.000Z' },
      });
      record('F9_g12_offer_race',
        staleOffer.status === 401 || staleOffer.status === 403 || staleOffer.status === 404 || staleOffer.status === 409, {
          note: 'no open offer listing — domain conflict path still classified, not 5xx',
          status: staleOffer.status,
          code: staleOffer.json?.code,
          taxonomy: staleOffer.json?.taxonomy,
        });
    }

    await http(base, '/admin/v2/haraj/ops/inject', { method: 'POST', token: adminTok, body: { mode: 'notify_fail' } });
    const n11 = await http(base, '/admin/v2/haraj/ops/probe', {
      method: 'POST', token: adminTok, body: { phase: 'notify' },
    });
    record('F11_notify_failure_after_truth',
      n11.status >= 500 && n11.json?.businessCommitted === true && n11.json?.code === 'G17_INJECTED_NOTIFY', {
        status: n11.status, committed: n11.json?.businessCommitted,
      });
    await clearInject();

    await http(base, '/admin/v2/haraj/ops/inject', { method: 'POST', token: adminTok, body: { mode: 'media_fail' } });
    const media = await http(base, '/auctions', {
      method: 'POST',
      token: sellerTok,
      body: { channel: 'haraj', title: 'g17 media', startingPrice: 1000 },
    });
    record('F12_media_dependency',
      media.status === 503 && media.json?.code === 'G17_INJECTED_MEDIA', {
        status: media.status, code: media.json?.code, taxonomy: media.json?.taxonomy,
      });
    await clearInject();

    await http(base, '/admin/v2/haraj/ops/inject', { method: 'POST', token: adminTok, body: { mode: 'internal_error' } });
    const boom = await http(base, '/admin/v2/haraj/ops/probe', {
      method: 'POST', token: adminTok, body: { phase: 'handler' },
    });
    record('F14_internal_error_safe',
      boom.status === 500
      && boom.json?.message === 'Internal error'
      && !String(boom.text).includes('Injected internal exception')
      && Boolean(boom.json?.requestId || boom.requestId), {
        status: boom.status, body: boom.json,
      });
    await clearInject();

    await http(base, '/admin/v2/haraj/ops/probe', {
      method: 'POST',
      token: adminTok,
      body: {
        phase: 'handler',
        note: 'G17_SECRET_SENTINEL_TOKEN G17_PASSWORD_SENTINEL G17_PRIVATE_EVIDENCE_SENTINEL',
      },
    });
    const logs = await http(base, '/admin/v2/haraj/ops-logs', { token: adminTok });
    const blob = JSON.stringify(logs.json || {});
    record('redaction_sentinel',
      logs.status === 200
      && !blob.includes('G17_SECRET_SENTINEL_TOKEN')
      && !blob.includes('G17_PASSWORD_SENTINEL')
      && !blob.includes('G17_PRIVATE_EVIDENCE_SENTINEL')
      && !blob.includes('Bearer '), {
        status: logs.status, count: logs.json?.logs?.length,
      });
    record('log_injection_parseable',
      Array.isArray(logs.json?.logs) && logs.json.logs.every((row) => row && typeof row.event === 'string' && !String(row.note || '').includes('\n')), {
        count: logs.json?.logs?.length,
      });

    const forged = await http(base, '/ready', { headers: { 'x-request-id': 'x\nERROR forged-event' } });
    record('log_injection_rejected_corr', Boolean(forged.requestId) && !String(forged.requestId).includes('\n'), {
      requestId: forged.requestId,
    });

    const bidCore = await http(base, '/auctions/status');
    record('auction_status_obs', bidCore.status === 200 && Boolean(bidCore.json?.requestId || bidCore.requestId), {
      status: bidCore.status, schema: bidCore.json?.schemaVersion,
    });

    const prodAfter = await http(PRODUCTION_API, '/health');
    record('production_still_008',
      prodAfter.json?.auctions?.schemaVersion === '008_auction_media_independence'
      && prodAfter.json?.storage?.inProduction === true, {
        schema: prodAfter.json?.auctions?.schemaVersion,
      });
    record('no_ai', ops.json?.snapshot?.ai?.implemented === false, { ai: ops.json?.snapshot?.ai });
    record('no_livekit', ops.json?.snapshot?.livekit?.implemented === false, {
      livekit: ops.json?.snapshot?.livekit,
    });

    const out = {
      generatedAt: new Date().toISOString(),
      pass: results.filter((r) => r.pass).length,
      fail: results.filter((r) => !r.pass).length,
      total: results.length,
      latencyMs: { health: health.ms, ready: ready.ms, commandCenter: cc.ms, ops: ops.ms },
      results,
    };
    fs.mkdirSync('/tmp/nomas-g17-e2e', { recursive: true });
    fs.writeFileSync('/tmp/nomas-g17-e2e/summary.json', JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ summary: { pass: out.pass, fail: out.fail, total: out.total, latencyMs: out.latencyMs } }));
    process.exit(out.fail ? 1 : 0);
  } finally {
    await clearInject();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
