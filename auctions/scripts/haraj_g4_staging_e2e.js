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

async function http(base, path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
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
  if (reg.status === 201 || reg.status === 200) {
    return pickToken(reg.json);
  }
  const login = await http(base, '/auth/login', { method: 'POST', body: { email, password } });
  if (login.status !== 200) throw new Error(`auth ${email} ${reg.status}/${login.status}`);
  return pickToken(login.json);
}

function lotBody() {
  const start = new Date(Date.now() + 7 * 86400000);
  return {
    channel: 'haraj',
    independent: true,
    species: 'horse',
    title: `G4 ${Date.now()}`,
    startingPrice: 1800,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 2 * 3600000).toISOString(),
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g4-e2e/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g4-e2e-placeholder',
    description: 'G4 staging review lot',
    inspection: { available: true, windows: 'بعد العصر' },
  };
}

async function main() {
  const base = process.env.G4_STAGING_API || STAGING_API;
  assertStaging(base);
  const results = [];
  const record = (name, pass, extra) => {
    results.push({ name, pass, ...extra });
    console.log(JSON.stringify({ step: name, pass, ...extra }));
  };

  const health = await http(base, '/health');
  record('staging_identity', health.status === 200 && health.json?.storage?.inProduction === false, {
    inProduction: health.json?.storage?.inProduction,
    schema: health.json?.auctions?.schemaVersion,
  });
  const prod = await http(PRODUCTION_API, '/health');
  record('production_read_only', prod.status === 200, {
    inProduction: prod.json?.storage?.inProduction,
    note: 'GET only',
  });

  const stamp = Date.now();
  const sellerTok = await register(base, `g4.seller.${stamp}@nomas.staging`, 'G4-pass!', 'Seller');
  const opTok = await register(base, `g4.op.${stamp}@nomas.auctioneer.staging`, 'G4-pass!', 'Auctioneer');
  const sellerB = await register(base, `g4.seller.b.${stamp}@nomas.staging`, 'G4-pass!', 'SellerB');
  record('auth', Boolean(sellerTok && opTok && sellerB), {});

  const unauth = await http(base, '/auctions/haraj/review/queue');
  record('unauth_queue', unauth.status === 401, { status: unauth.status });

  const sellerQueue = await http(base, '/auctions/haraj/review/queue', { token: sellerTok });
  record('seller_queue_denied', sellerQueue.status === 403, { status: sellerQueue.status });

  const created = await http(base, '/auctions', { method: 'POST', token: sellerTok, body: lotBody() });
  const auctionId = created.json?.auction?.id;
  record('create', created.status === 201 && Boolean(auctionId), { auctionId, status: created.status });
  const submitted = await http(base, `/auctions/${auctionId}/submit-review`, {
    method: 'POST',
    token: sellerTok,
    body: { channel: 'haraj' },
  });
  record('submit', submitted.status === 200 && submitted.json?.auction?.status === 'review', {
    status: submitted.status,
  });

  const self = await http(base, `/auctions/haraj/review/${auctionId}/accept`, {
    method: 'POST',
    token: sellerTok,
    body: {},
  });
  record('seller_accept_denied', self.status === 403, { status: self.status, code: self.json?.code });

  const spoof = await http(base, `/auctions/haraj/review/${auctionId}/accept`, {
    method: 'POST',
    token: opTok,
    body: { auctioneerId: 'not-me' },
  });
  record('spoof_auctioneer_id', spoof.status === 403, { status: spoof.status, code: spoof.json?.code });

  const queue = await http(base, '/auctions/haraj/review/queue?bucket=under_review', { token: opTok });
  record('queue_sees_lot', queue.status === 200 && (queue.json?.auctions || []).some((a) => a.id === auctionId), {
    status: queue.status,
    count: queue.json?.auctions?.length,
  });

  const accept = await http(base, `/auctions/haraj/review/${auctionId}/accept`, {
    method: 'POST',
    token: opTok,
    body: { reason: 'مكتمل' },
  });
  record('accept', accept.status === 200 && accept.json?.auction?.harajReview?.operationalStatus === 'approved_for_haraj', {
    status: accept.status,
    lotStatus: accept.json?.auction?.status,
    op: accept.json?.auction?.harajReview?.operationalStatus,
    room: accept.json?.auction?.harajReview?.roomAssigned,
  });

  const again = await http(base, `/auctions/haraj/review/${auctionId}/accept`, {
    method: 'POST',
    token: opTok,
    body: {},
  });
  record('accept_idempotent', again.status === 200 && again.json?.auction?.id === auctionId, {
    status: again.status,
  });

  const created2 = await http(base, '/auctions', { method: 'POST', token: sellerTok, body: lotBody() });
  const id2 = created2.json?.auction?.id;
  await http(base, `/auctions/${id2}/submit-review`, { method: 'POST', token: sellerTok, body: { channel: 'haraj' } });
  const ch = await http(base, `/auctions/haraj/review/${id2}/request-changes`, {
    method: 'POST',
    token: opTok,
    body: { reason: 'أضف صور' },
  });
  record('request_changes', ch.status === 200 && ch.json?.auction?.status === 'draft', {
    status: ch.status,
    op: ch.json?.auction?.harajReview?.operationalStatus,
  });
  const mine = await http(base, '/auctions/mine', { token: sellerTok });
  const row = (mine.json?.auctions || []).find((a) => a.id === id2);
  record('seller_sees_changes', Boolean(row?.harajReview?.operationalStatus === 'needs_changes'), {
    op: row?.harajReview?.operationalStatus,
  });

  const created3 = await http(base, '/auctions', { method: 'POST', token: sellerTok, body: lotBody() });
  const id3 = created3.json?.auction?.id;
  await http(base, `/auctions/${id3}/submit-review`, { method: 'POST', token: sellerTok, body: { channel: 'haraj' } });
  const rej = await http(base, `/auctions/haraj/review/${id3}/reject`, {
    method: 'POST',
    token: opTok,
    body: { reason: 'خارج السياسة' },
  });
  record('reject', rej.status === 200 && rej.json?.auction?.status === 'cancelled' && rej.json?.auction?.id === id3, {
    status: rej.status,
  });

  const sellerBAccept = await http(base, `/auctions/haraj/review/${auctionId}/accept`, {
    method: 'POST',
    token: sellerB,
    body: {},
  });
  record('seller_b_denied', sellerBAccept.status === 403, { status: sellerBAccept.status });

  const spoofRole = await http(base, `/auctions/haraj/review/${auctionId}/accept`, {
    method: 'POST',
    token: sellerTok,
    body: { role: 'AUCTIONEER', accountRole: 'admin' },
  });
  record('spoofed_role_ignored', spoofRole.status === 403, { status: spoofRole.status });

  const invalidLot = await http(base, '/auctions/haraj/review/not-a-uuid', { token: opTok });
  record('invalid_lot', invalidLot.status === 404, { status: invalidLot.status });

  const note = await http(base, `/auctions/haraj/review/${auctionId}/notes`, {
    method: 'POST',
    token: opTok,
    body: { note: 'ملاحظة داخلية G4' },
  });
  record('internal_note', note.status === 200, { status: note.status });
  const publicGet = await http(base, `/auctions/${auctionId}`);
  record('note_not_public', publicGet.status === 200 && publicGet.json?.auction?.harajReview?.internalNote == null, {
    status: publicGet.status,
  });

  const created4 = await http(base, '/auctions', { method: 'POST', token: sellerTok, body: lotBody() });
  const id4 = created4.json?.auction?.id;
  await http(base, `/auctions/${id4}/submit-review`, { method: 'POST', token: sellerTok, body: { channel: 'haraj', inspection: { available: true } } });
  const stale = await http(base, `/auctions/haraj/review/${id4}/reject`, {
    method: 'POST',
    token: opTok,
    body: { reason: 'stale', expectedStatus: 'draft' },
  });
  record('stale_state_conflict', stale.status === 409, { status: stale.status, code: stale.json?.code });

  const summary = {
    ok: results.every((r) => r.pass),
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    total: results.length,
    results,
    productionWrites: false,
  };
  require('fs').writeFileSync('/tmp/nomas_g4_staging_e2e.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summary: true, ...summary }, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
