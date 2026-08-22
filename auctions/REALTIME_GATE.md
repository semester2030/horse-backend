# Phase 3 — Auction Bid Realtime Gate

## Verdict

**A** when `run-auction-realtime-gate.sh` reports:
- Core: **19/19 PASS** (`auction_core.test.js`)
- Realtime: **11/11 PASS** (`auction_realtime.test.js`)

## Command

```bash
AUCTIONS_TEST_DATABASE_URL=postgresql://localhost:5432/nomas_auctions_test \
  ./scripts/run-auction-realtime-gate.sh
```

## Proofs

| ID | Test | Proves |
|----|------|--------|
| RT-01 | Monotonic seq per `auction:{id}` | Ordering |
| RT-02 | Replay without duplicates | T4.1 replay contract |
| RT-03 | 100 sequenced events | Load ordering |
| RT-04 | Sanitized bidder label | No raw userId on WS |
| RT-05 | Subscribe auth (draft/owner) | Unauthorized room blocked |
| RT-06 | Post-commit bid.accepted publish | WS transport after DB |
| RT-07 | Concurrent bids | PostgreSQL truth unchanged |
| RT-08 | Anti-snipe → auction.extended | Extension propagation |
| RT-09 | Close → sold events | Exactly one winner |
| RT-10 | WS disconnect | Accepted bid persists in DB |

## Architecture rule

**WebSocket is transport only.** Bid acceptance remains in PostgreSQL via REST POST.
