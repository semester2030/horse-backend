# Haraj Migrations — Staging-Only Execution Policy (G2.1)

## Status

- Proposed SQL: `migrations/proposed/009_*.sql`, `010_*.sql`
- **NOT EXECUTED** — review required before any run
- Production: **NEVER** until Production Readiness Gate + owner approval

## Preflight (readiness check only)

```bash
# Local dev review (localhost DB):
APP_ENV=staging \
AUCTIONS_DATABASE_URL=postgresql://localhost:5432/nomas_auctions \
HARAJ_MIGRATION_ALLOW_LOCALHOST=true \
node backend/auctions/scripts/haraj_migration_preflight.js

# Cloud staging (when provisioned):
APP_ENV=staging \
AUCTIONS_STAGING_DATABASE_URL=postgresql://...@staging-host/nomas_auctions_staging \
node backend/auctions/scripts/haraj_migration_preflight.js
```

## Future forward migration (NOT G2.1 — explicit approval required)

1. Snapshot staging DB
2. Preflight PASS
3. Apply `009_haraj_core_orchestration.sql` manually or via approved runner
4. Validate schema + run tests
5. Apply `010_haraj_post_close.sql` or rollback 009

Rollback scripts: `009_*.rollback.sql`, `010_*.rollback.sql`

## Environment variables

| Variable | Purpose |
|----------|---------|
| `APP_ENV=staging` | Required for migration preflight |
| `AUCTIONS_STAGING_DATABASE_URL` | Dedicated staging PG (cloud) |
| `HARAJ_MIGRATION_ALLOW_LOCALHOST=true` | Local dev only |
| `NOMAS_PRODUCTION_DB_HOSTMARKERS` | Comma-separated prod host patterns |
