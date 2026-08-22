#!/usr/bin/env bash
# Phase 1.1 — Auction PostgreSQL Integration Gate
# Usage: ./scripts/run-auction-integration-gate.sh
# Or:    AUCTIONS_TEST_DATABASE_URL=postgresql://... ./scripts/run-auction-integration-gate.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_URL="${AUCTIONS_TEST_DATABASE_URL:-${AUCTIONS_DATABASE_URL:-}}"

if [[ -z "$DB_URL" ]]; then
  echo "ERROR: set AUCTIONS_TEST_DATABASE_URL (e.g. postgresql://localhost:5432/nomas_auctions_test)"
  exit 1
fi

export AUCTIONS_TEST_DATABASE_URL="$DB_URL"
EVIDENCE_DIR="$ROOT/auctions/evidence"
mkdir -p "$EVIDENCE_DIR"
OUT="$EVIDENCE_DIR/integration_gate_$(date -u +%Y%m%dT%H%M%SZ).txt"

{
  echo "=== NOMAS Auction Phase 1.1 Integration Gate ==="
  echo "UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "AUCTIONS_TEST_DATABASE_URL: $DB_URL"
  echo ""
  node --test auctions/auction_core.test.js
} 2>&1 | tee "$OUT"

if grep -q "ℹ fail 0" "$OUT" && grep -q "ℹ pass 1[89]" "$OUT"; then
  echo ""
  echo "VERDICT: A — all integration tests PASS"
  echo "Evidence: $OUT"
  exit 0
fi

echo "VERDICT: FAIL — see $OUT"
exit 1
