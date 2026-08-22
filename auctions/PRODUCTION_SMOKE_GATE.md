# PR-07–10 — Production Smoke Final Gate

**Mode:** MANUAL / ASSISTED VALIDATION ONLY  
**No product changes · No deploy · No automatic `ENABLE_AUCTIONS=true`**

## Prerequisites (automated — closed)

| ID | Status |
|----|--------|
| PR-01 → PR-06 | PASS |
| PR-11–12 | PASS |
| Public Production Readiness | ~93% (pre-smoke) |

## Evidence file (required for Verdict A)

`backend/auctions/evidence/AUCTION_PUBLIC_SMOKE_EVIDENCE.md`

Every step: PASS / FAIL / BLOCKED_EXTERNAL + timestamp + account + auction ID + API result + screenshot ref.

Update summary verdict lines at bottom when complete:

```text
PR-07_VERDICT: PENDING | PASS | FAIL | BLOCKED_EXTERNAL
PR-08_VERDICT: ...
PR-09_VERDICT: ...
PR-10_VERDICT: ...
SMOKE_GATE_VERDICT: PENDING | A | B | C
```

## Helper (read-only)

```bash
AUCTION_SMOKE_BASE_URL=https://your-backend.onrender.com \
  ./scripts/run-auction-production-smoke-helper.sh
```

## Verify evidence + full gate

```bash
./scripts/verify-auction-smoke-evidence.sh
./scripts/run-auction-public-readiness-gate.sh
```

## Verdict rules

| Verdict | Condition |
|---------|-----------|
| **A — PUBLIC ACTIVATION APPROVED** | PR-07–10 PASS (or PR-09 BLOCKED_EXTERNAL only if audio optional path proven); P0=0; no security/transactional failure |
| **B** | External-only blocker (e.g. LiveKit creds) with documented workaround |
| **C** | Any bid integrity, ownership, auth, DB, winner, WS, or admin safety failure |

## Cross-checks (record in evidence § Cross-checks)

- `/health` 200
- `/auctions/status` 200
- PostgreSQL connected
- WS endpoint reachable
- No duplicate winner · no lost accepted bid · no 500s
- No auth bypass · no owner bidding
- Map = Home · species hub · horse/camel/falcon filters
- Kill switch OFF isolation still documented

## After Verdict A

Product owner sets `ENABLE_AUCTIONS=true` on backend + `AppConfig.enableAuctions` for release build — **manual decision, not automated**.
