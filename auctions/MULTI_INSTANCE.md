# Auction Multi-Instance Readiness — Phase 6

## Authoritative layers

| Layer | Multi-instance safe? | Mechanism |
|-------|---------------------|-----------|
| Bid acceptance | **Yes** | PostgreSQL `SELECT … FOR UPDATE` + transaction |
| Auction transitions / close / freeze | **Yes** | Row lock + `pg_advisory_xact_lock(hashtext('nomas:auction:{id}'))` |
| Host booking conflicts | **Yes** | Transaction + overlap queries |
| REST read / resync | **Yes** | PostgreSQL |
| WebSocket replay / seq | **No — P0 blocker for WS HA** | In-process `ws_hub` sequencer + replay buffer |

## What Phase 6 added

- `domain/locking.js` — advisory xact lock on every auction mutation path
- Race tests: bid↔freeze, close↔freeze across concurrent connections

## Production HA guidance

1. **Scale REST/bid path** — safe behind load balancer (PostgreSQL is authority).
2. **WebSocket** — requires one of:
   - Sticky sessions to same Node instance, **or**
   - Shared pub/sub + global seq (Redis/NATS), **or**
   - Client REST resync only (accept WS as best-effort transport)
3. **Do not claim Production HA** until WS replay is externalized.

## WS incident runbook

See `docs/js/auctions.js → OPERATIONS_RUNBOOK.wsIncident`.
