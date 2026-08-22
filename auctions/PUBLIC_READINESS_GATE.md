# FINAL AUCTION PUBLIC-READINESS GATE

**Status:** NOT STARTED (Verdict pending)  
**Prerequisite:** Phase 6 — Verdict **A** (CLOSED)  
**Kill switch:** `ENABLE_AUCTIONS=false` remains default until this gate returns **A** with **zero P0**.

## Readiness taxonomy (official)

| Metric | Value | Meaning |
|--------|-------|---------|
| Auction Product | ~90%+ | Feature + ops layer complete (Phases 1–6) |
| Auction Public Production Readiness | ~82% | Safe to expose to all users + store |
| Phase 6 | **A — CLOSED** | Admin/ops/hardening evidence |
| Public Activation | **NOT YET** | Blocked until this gate |

## Non-P0 reclassifications (product policy)

| Item | Classification | Notes |
|------|----------------|-------|
| Payments / Escrow | **Out of V1 scope** | Winner + final price only; settlement offline |
| `ENABLE_AUCTIONS=false` | **Launch kill switch** | Not a technical P0 — flipped only after gate A |
| Store legal / mic / UGC | **Public gate P0** | Required before general store release with auctions |

## Gate proofs

| ID | Area | Proof required | Status |
|----|------|----------------|--------|
| PR-01 | WS multi-instance | Two logical instances share seq + replay via PostgreSQL; no duplicate seq; reconnect replay works cross-instance | **PASS** |
| PR-02 | HTTP RBAC | Unauthorized admin routes return 403; least-privilege matrix at HTTP layer | **PASS** |
| PR-03 | Auction legal terms | `terms.html` § auctions: no in-app payment, winner obligation, offline settlement, moderation, disputes | **PASS** |
| PR-04 | Privacy / data safety | `privacy.html` §7 + PrivacyInfo AudioData + bid history documented | **PASS** |
| PR-05 | Mic / UGC store impact | `auction-store-impact.md` + manifest strings | **PASS** |
| PR-06 | V1 payment policy UX | `auction_v1_policy.dart` + bid confirm dialog | **PASS** |
| PR-07 | Production smoke — owner | Create → review → schedule → go live (real accounts) | **MANUAL** |
| PR-08 | Production smoke — bidder | REST bid + WS receive + anti-snipe + close | **MANUAL** |
| PR-09 | Production smoke — host | Booking accept + optional audio + force-end isolation | **MANUAL** |
| PR-10 | Production smoke — admin | Review, freeze, timeline, dispute, risk ack | **MANUAL** |
| PR-11 | Regression | Re-run `AUCTION_PHASE6_FINAL_GATE` (93/93) | **PASS** (baseline) |
| PR-12 | Feature flag isolation | `ENABLE_AUCTIONS=false` → no auction routes/surfaces for public | **PASS** (baseline) |

## PR-01 implementation target

PostgreSQL-authoritative WS fan-out (no Redis dependency):

1. Migration `005_ws_multi_instance.sql` — `auction_ws_events (auction_id, seq, payload)`
2. `ws_pg_broker.js` — append with advisory lock + `NOTIFY auction_ws_fanout`
3. All Node instances `LISTEN` → hydrate local replay buffer → fan-out to local WS clients
4. REST remains authority; WS is transport + replay only

Alternative acceptable for gate **A**: documented sticky sessions **plus** automated proof that REST resync recovers bid truth when WS instance mismatches (degraded mode). Full PG fan-out is preferred.

## Verdict criteria

| Verdict | Condition |
|---------|-----------|
| **A** | All PR-01–PR-06 automated PASS; PR-07–PR-10 manual checklist signed; PR-11–PR-12 PASS; **zero P0** |
| **B** | ≤2 P1 blockers with documented workaround (e.g. sticky-only WS + REST resync proven) |
| **C** | Any unresolved P0 |

## P0 for this gate only

1. Production smoke not signed (PR-07–PR-10)

## Resolved P0 (automated)

- PR-01 WS multi-instance · PR-02 HTTP RBAC · PR-03–06 legal/privacy/UX

## Script

```bash
AUCTIONS_TEST_DATABASE_URL=postgresql://localhost:5432/nomas_auctions_test \
  ./scripts/run-auction-public-readiness-gate.sh
```

## Production smoke checklist (manual)

- [ ] Owner: listing-linked create → review queue → approved → scheduled
- [ ] Bidder: bid via REST; WS shows `bid.accepted`; cannot bid when frozen
- [ ] Host: accept booking; audio start/end; admin force-end; bids continue
- [ ] Admin: freeze → inspect timeline → resolve dispute → resume or cancel
- [ ] Cross-device: bidder on instance B receives WS events published from instance A (PR-01)

## After Verdict A

Product owner may set `ENABLE_AUCTIONS=true` for public activation. Store submission remains a separate decision with updated metadata/screenshots.
