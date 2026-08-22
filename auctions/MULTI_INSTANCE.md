# Auction Multi-Instance Readiness — PR-01 CLOSED

## Authoritative layers

| Layer | Multi-instance safe? | Mechanism |
|-------|---------------------|-----------|
| Bid acceptance | **Yes** | PostgreSQL `SELECT … FOR UPDATE` + transaction |
| Auction transitions / close / freeze | **Yes** | Row lock + `pg_advisory_xact_lock(hashtext('nomas:auction:{id}'))` |
| Host booking conflicts | **Yes** | Transaction + overlap queries |
| REST read / resync | **Yes** | PostgreSQL |
| WebSocket replay / seq | **Yes** | `auction_ws_events` + `NOTIFY auction_ws_fanout` + per-instance LISTEN |

## PR-01 implementation

- Migration `005_ws_multi_instance.sql` — `auction_ws_events (auction_id, seq, payload)`
- `auctions/services/ws_event_store.js` — append + replay queries
- `ws_pg_broker.js` — `createPgAuctionWsBridge` LISTEN/fan-out
- `ws_hub.js` — `setAuctionCrossInstance`, `publishSequenced`, PG replay on subscribe
- Tests: `auction_ws_multi_instance.test.js`

## Production HA guidance

1. **Scale REST/bid path** — safe behind load balancer (PostgreSQL is authority).
2. **WebSocket** — all instances share same `AUCTIONS_DATABASE_URL`; bridge auto-starts when auctions module ready.
3. **WS incident** — REST GET `/auctions/:id` + replay from PG on reconnect.

## Limitations

- NOTIFY delivery requires live Postgres connection per instance (dedicated LISTEN client).
- Very high event volume may need retention job on `auction_ws_events` (not V1).
