#!/usr/bin/env node
'use strict';

/**
 * G19.1 — Seller authorization negative proof (Staging only).
 * Normal seller POST /auctions with channel=haraj creates draft only;
 * cannot enter Haraj queue without auctioneer accept.
 * Env: ADMIN_EMAIL/ADMIN_PASSWORD optional for positive contrast; seller self-registers.
 */

const STAGING = process.env.G19_STAGING_API || 'https://horse-backend-staging.onrender.com';

function assertStaging(url) {
  if (!String(url).includes('horse-backend-staging') || String(url).includes('horse-backend-i68h')) {
    throw new Error(`STAGING ONLY: ${url}`);
  }
}

async function http(base, p, { method = 'GET', token, body } = {}) {
  const h = { Accept: 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body != null) h['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${p}`, {
    method,
    headers: h,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json };
}

async function register(base, email, password, name) {
  await http(base, '/auth/register', {
    method: 'POST',
    body: { email, password, name, accountRole: 'heritage_advertiser' },
  });
  const login = await http(base, '/auth/login', { method: 'POST', body: { email, password } });
  const tok = login.json?.idToken || login.json?.token || login.json?.accessToken;
  if (!tok) throw new Error(`login failed ${email} ${login.status}`);
  return tok;
}

async function main() {
  assertStaging(STAGING);
  const stamp = Date.now();
  const sellerTok = await register(STAGING, `g191.seller.${stamp}@nomas.staging`, 'G191-pass!', 'G191 Seller');

  const create = await http(STAGING, '/auctions', {
    method: 'POST',
    token: sellerTok,
    body: {
      channel: 'haraj',
      independent: true,
      species: 'horse',
      title: `G19.1 auth ${stamp}`,
      startingPrice: 1000,
      startAt: new Date(Date.now() - 60000).toISOString(),
      endAt: new Date(Date.now() + 3600000).toISOString(),
      location: { city: 'الرياض', lat: 24.71, lng: 46.67 },
      mediaVideoHlsUrl: 'https://videodelivery.net/g191/manifest/video.m3u8',
      mediaVideoCloudflareId: 'g191-auth',
      description: 'G19.1 authorization negative',
      inspection: { available: true, windows: 'بعد العصر' },
    },
  });
  const lotId = create.json?.auction?.id;
  const status = create.json?.auction?.status;
  console.log(JSON.stringify({ step: 'create_haraj_draft', status: create.status, lotStatus: status, lotId }));

  const submit = await http(STAGING, `/auctions/${lotId}/submit-review`, {
    method: 'POST',
    token: sellerTok,
    body: { channel: 'haraj' },
  });
  console.log(JSON.stringify({
    step: 'submit_review',
    status: submit.status,
    auctionStatus: submit.json?.auction?.status || submit.json?.status,
  }));

  // Attempt schedule / go-live without auctioneer accept — must fail.
  const schedule = await http(STAGING, `/auctions/${lotId}/schedule`, {
    method: 'POST', token: sellerTok, body: {},
  });
  const live = await http(STAGING, `/auctions/${lotId}/go-live`, {
    method: 'POST', token: sellerTok, body: {},
  });

  // Attempt inventing a room queue attach without admin — should be forbidden.
  const queueProbe = await http(STAGING, '/admin/v2/haraj/sessions', {
    method: 'POST', token: sellerTok,
    body: {
      category: 'horse',
      scheduledStartAt: new Date().toISOString(),
      scheduledEndAt: new Date(Date.now() + 3600000).toISOString(),
      timezone: 'Asia/Riyadh',
    },
  });

  const afterCreate = await http(STAGING, `/auctions/${lotId}`, { token: sellerTok });
  const finalStatus = afterCreate.json?.auction?.status;

  const pass = Boolean(lotId)
    && (status === 'draft' || status === 'review' || create.status === 200 || create.status === 201)
    && schedule.status >= 400
    && live.status >= 400
    && queueProbe.status >= 400
    && finalStatus !== 'live'
    && finalStatus !== 'scheduled';

  console.log(JSON.stringify({
    summary: 'seller_cannot_bypass_haraj_review',
    pass,
    createStatus: create.status,
    lotStatusAfter: finalStatus,
    scheduleStatus: schedule.status,
    scheduleCode: schedule.json?.code,
    liveStatus: live.status,
    liveCode: live.json?.code,
    adminSessionAsSeller: queueProbe.status,
  }));
  if (!pass) process.exit(2);
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: String(e.message || e) }));
  process.exit(1);
});
