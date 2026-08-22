#!/usr/bin/env bash
# Phase 3 — Auction Realtime Gate (WS transport + PostgreSQL authority)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_URL="${AUCTIONS_TEST_DATABASE_URL:-${AUCTIONS_DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: set AUCTIONS_TEST_DATABASE_URL"
  exit 1
fi

export AUCTIONS_TEST_DATABASE_URL="$DB_URL"
EVIDENCE_DIR="$ROOT/auctions/evidence"
mkdir -p "$EVIDENCE_DIR"
OUT="$EVIDENCE_DIR/realtime_gate_$(date -u +%Y%m%dT%H%M%SZ).txt"

{
  echo "=== NOMAS Auction Phase 3 Realtime Gate ==="
  echo "UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "AUCTIONS_TEST_DATABASE_URL: $DB_URL"
  echo ""
  echo "▶ Core regression (Phase 1.1)"
  node --test auctions/auction_core.test.js
  echo ""
  echo "▶ Realtime gate (Phase 3)"
  node --test auctions/auction_realtime.test.js
} 2>&1 | tee "$OUT"

if grep -q "ℹ fail 0" "$OUT" && grep -q "ℹ pass 19" "$OUT" && grep -q "ℹ pass 11" "$OUT"; then
  echo ""
  echo "VERDICT: A — core + realtime gates PASS"
  echo "Evidence: $OUT"
  exit 0
fi

echo "VERDICT: FAIL — see $OUT"
exit 1
