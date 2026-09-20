#!/usr/bin/env node
'use strict';

const { Client } = require('pg');
const { assertStagingMigrationAllowed, parseDatabaseIdentity } = require('../environment');

function clientFromUrl(url) {
  const clean = url.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
  return new Client({
    connectionString: clean,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
}

async function main() {
  const url = String(process.env.AUCTIONS_STAGING_DATABASE_URL || '').trim();
  assertStagingMigrationAllowed({ databaseUrl: url });
  const parsed = parseDatabaseIdentity(url);
  if (parsed.database !== 'nomas_auctions_staging') throw new Error('not staging db');

  process.env.ENABLE_AUCTIONS = 'true';
  const auctionService = require('../services/auction_service');
  const bidService = require('../services/bid_service');

  const client = clientFromUrl(url);
  await client.connect();
  try {
    const before = await client.query('SELECT id FROM auctions ORDER BY id');
    const beforeIds = before.rows.map((r) => r.id);
    const now = Date.now();
    const draft = await auctionService.createAuctionDraft(client, {
      listingId: `G22-${now}`,
      videoId: `G22V-${now}`,
      species: 'horse',
      ownerUserId: 'g22-owner',
      createdByUserId: 'g22-owner',
      createdByRole: 'seller',
      startingPrice: 1000,
      minimumIncrement: 50,
      startAt: new Date(now - 60000).toISOString(),
      endAt: new Date(now + 120000).toISOString(),
      antiSnipingSeconds: 30,
    });
    const mode = await client.query('SELECT haraj_mode FROM auctions WHERE id = $1', [draft.id]);
    if (mode.rows[0].haraj_mode !== 'standalone') {
      throw new Error('new auction must default haraj_mode=standalone');
    }
    await auctionService.transitionAuction(client, draft.id, 'review', { actorUserId: 'admin' });
    const { approveAuctionReview } = require('../services/approval_flow');
    await approveAuctionReview(client, draft.id, 'admin', { bypass: 'admin' });
    await auctionService.transitionAuction(client, draft.id, 'live', { actorUserId: 'admin' });
    const bid1 = await bidService.placeBid(client, {
      auctionId: draft.id,
      bidderUserId: 'g22-bidder',
      amount: 1050,
      idempotencyKey: `g22-${now}`,
    });
    const bid2 = await bidService.placeBid(client, {
      auctionId: draft.id,
      bidderUserId: 'g22-bidder',
      amount: 1050,
      idempotencyKey: `g22-${now}`,
    });
    const after = await client.query('SELECT id FROM auctions ORDER BY id');
    const afterIds = after.rows.map((r) => r.id);
    console.log(
      JSON.stringify({
        ok: true,
        auctionId: draft.id,
        harajMode: mode.rows[0].haraj_mode,
        bid1: summarize(bid1),
        bid2: summarize(bid2),
        existingIdsPreserved: beforeIds.every((x) => afterIds.includes(x)),
        auctionCountBefore: beforeIds.length,
        auctionCountAfter: afterIds.length,
      }),
    );
  } finally {
    await client.end();
  }
}

function summarize(result) {
  if (!result || typeof result !== 'object') return { type: typeof result };
  return {
    keys: Object.keys(result),
    id: result.id || result.bid?.id || null,
    amount: result.amount || result.bid?.amount || null,
    duplicate: result.duplicate || result.idempotent || result.replayed || null,
  };
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
