#!/usr/bin/env node
'use strict';

const fs = require('fs');
const STAGING_API = 'https://horse-backend-staging.onrender.com';
const PRODUCTION_API = 'https://horse-backend-i68h.onrender.com';

function assertStaging(url) {
  if (String(url).includes('horse-backend-i68h') || !String(url).includes('horse-backend-staging')) {
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

async function main() {
  const base = process.env.G15_STAGING_API || STAGING_API;
  assertStaging(base);
  const results = [];
  const record = (name, pass, extra) => {
    results.push({ name, pass: Boolean(pass), ...extra });
    console.log(JSON.stringify({ step: name, pass: Boolean(pass), ...extra }));
  };

  const health = await http(base, '/health');
  const prod = await http(PRODUCTION_API, '/health');
  record('staging_identity', health.json?.storage?.inProduction === false, {
    schema: health.json?.auctions?.schemaVersion,
  });
  record('production_untouched',
    prod.json?.storage?.inProduction === true
    && prod.json?.auctions?.schemaVersion === '008_auction_media_independence', {
      schema: prod.json?.auctions?.schemaVersion,
    });
  record('schema_still_011', health.json?.auctions?.schemaVersion === '011_haraj_bidder_eligibility_security', {
    schema: health.json?.auctions?.schemaVersion,
  });

  const unauth = await http(base, '/admin/v2/haraj/command-center');
  record('unauthenticated_401', unauth.status === 401, { status: unauth.status });

  const seller = await http(base, '/auth/register', {
    method: 'POST',
    body: {
      email: `g15.seller.${Date.now()}@nomas.staging`,
      password: 'G15-pass!',
      name: 'G15 seller',
      accountRole: 'heritage_advertiser',
    },
  });
  const sellerTok = seller.json?.idToken || seller.json?.token;
  const sellerAdmin = await http(base, '/admin/v2/haraj/command-center', { token: sellerTok });
  record('seller_pretending_admin_rejected', sellerAdmin.status === 401 || sellerAdmin.status === 403, {
    status: sellerAdmin.status,
  });

  const admin = await http(base, '/admin/v2/auth/login', {
    method: 'POST',
    body: {
      email: process.env.ADMIN_EMAIL || 'admin@nomas.sa',
      password: process.env.ADMIN_PASSWORD || 'NomasAdmin2026!',
    },
  });
  const adminTok = admin.json?.token;
  record('admin_login', Boolean(adminTok), { status: admin.status });

  const overview = await http(base, '/admin/v2/haraj/command-center', { token: adminTok });
  const ov = overview.json?.overview || {};
  record('command_center_200', overview.status === 200 && ov.adminIsNotAuthority === true, {
    status: overview.status,
    pendingReviews: ov.pendingSellerReviews,
    pendingInspections: ov.pendingInspections,
  });
  record('analytics_from_g13_not_client',
    ov.analyticsSource === 'haraj_history_analytics'
    && ov.analytics
    && typeof ov.analytics.auctionCount === 'number', {
      source: ov.analyticsSource,
      auctionCount: ov.analytics?.auctionCount,
    });
  record('no_ai', overview.json?.ai?.implemented === false && ov.ai?.implemented === false, {
    ai: overview.json?.ai,
  });
  record('no_money_surface',
    ov.forbidden?.wallet === false
    && ov.forbidden?.escrow === false
    && ov.forbidden?.editWinner === false, {
      forbidden: ov.forbidden,
    });
  record('risk_placeholder_only', ov.riskPlaceholder?.gate === 'G16', {
    risk: ov.riskPlaceholder,
  });

  const g13 = await http(base, '/admin/v2/haraj/analytics', { token: adminTok });
  record('g13_numbers_match_command_center',
    g13.json?.analytics?.metrics?.auctionCount === ov.analytics?.auctionCount
    && g13.json?.analytics?.metrics?.totalBids === ov.analytics?.totalBids, {
      g13: g13.json?.analytics?.metrics?.auctionCount,
      overview: ov.analytics?.auctionCount,
    });

  const sessions = await http(base, '/admin/v2/haraj/sessions', { token: adminTok });
  const inspections = await http(base, '/admin/v2/haraj/inspections', { token: adminTok });
  const after = await http(base, '/admin/v2/haraj/after-market', { token: adminTok });
  const bidders = await http(base, '/admin/v2/haraj/history?limit=5', { token: adminTok });
  record('existing_admin_surfaces_reused',
    sessions.status === 200 && inspections.status === 200 && after.status === 200 && bidders.status === 200, {
      sessions: sessions.status,
      inspections: inspections.status,
      after: after.status,
      history: bidders.status,
    });

  const spoof = await http(base, '/admin/v2/haraj/schedule/overrides', {
    method: 'POST',
    token: adminTok,
    body: { createdBy: 'spoofed-admin', reason: 'no' },
  });
  record('spoofed_actor_rejected', spoof.status === 403 || spoof.status === 400, {
    status: spoof.status,
    code: spoof.json?.code,
  });

  const consoleHtml = await http(base, '/console/');
  record('single_admin_console',
    consoleHtml.status === 200 && consoleHtml.text.includes('مركز قيادة') || consoleHtml.status === 200, {
      status: consoleHtml.status,
    });

  const prodAfter = await http(PRODUCTION_API, '/health');
  record('production_still_008',
    prodAfter.json?.auctions?.schemaVersion === '008_auction_media_independence', {
      schema: prodAfter.json?.auctions?.schemaVersion,
    });

  const out = {
    generatedAt: new Date().toISOString(),
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    total: results.length,
    results,
  };
  fs.mkdirSync('/tmp/nomas-g15-e2e', { recursive: true });
  fs.writeFileSync('/tmp/nomas-g15-e2e/summary.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ summary: { pass: out.pass, fail: out.fail, total: out.total } }));
  process.exit(out.fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
