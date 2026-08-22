# Phase 1.1 — PostgreSQL Integration Gate

## Local dev database (provisioned)

```bash
createdb nomas_auctions_test
# or: psql -d postgres -c "CREATE DATABASE nomas_auctions_test;"
```

## Run gate

```bash
export AUCTIONS_TEST_DATABASE_URL="postgresql://localhost:5432/nomas_auctions_test"
cd backend
./scripts/run-auction-integration-gate.sh
```

## Staging / Render Postgres

Set on CI or staging only (not production store.json path):

```
AUCTIONS_TEST_DATABASE_URL=postgresql://user:pass@host:5432/nomas_auctions_test
```

Migrations run automatically on first test `before()` hook via `runMigrations()`.

## Verdict criteria

**A** = all 19 tests pass (10 unit + 9 integration), `ℹ fail 0`.

## Proofs covered

| Proof | Test |
|-------|------|
| Idempotency | atomic bid + idempotency |
| Min increment | atomic bid + idempotency |
| Owner forbidden | owner cannot bid |
| Close race / one winner | close race yields exactly one winner |
| Host conflict | host scheduling conflict detected |
| Immutable timeline | immutable event timeline appended |
| Stale bid | stale bid rejected |
| Concurrent bids | concurrent same-amount bids |
| Anti-sniping | anti-sniping extends end |
| Reserve unsold | reserve price — unsold |
