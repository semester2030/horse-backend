#!/usr/bin/env bash
# AUCTION_PHASE6_FINAL_GATE — full regression + ownership/approval + Phase 6 ops
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_URL="${AUCTIONS_TEST_DATABASE_URL:-${AUCTIONS_DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: set AUCTIONS_TEST_DATABASE_URL (e.g. postgresql://localhost:5432/nomas_auctions_test)"
  exit 1
fi

export AUCTIONS_TEST_DATABASE_URL="$DB_URL"
export AUCTIONS_DATABASE_URL="$DB_URL"

EVIDENCE_DIR="$ROOT/auctions/evidence"
mkdir -p "$EVIDENCE_DIR"
OUT="$EVIDENCE_DIR/phase6_final_gate_$(date -u +%Y%m%dT%H%M%SZ).txt"

RUN="node --test --test-concurrency=1"

{
  echo "=== NOMAS AUCTION_PHASE6_FINAL_GATE ==="
  echo "UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "DB: $DB_URL"
  echo ""
  echo "▶ Ownership / Approval remediation"
  $RUN auctions/auction_flow_remediation.test.js
  echo ""
  echo "▶ Core"
  $RUN auctions/auction_core.test.js
  echo ""
  echo "▶ Realtime"
  $RUN auctions/auction_realtime.test.js
  echo ""
  echo "▶ Host Phase 4"
  $RUN auctions/host_phase4.test.js
  echo ""
  echo "▶ Audio Phase 5"
  $RUN auctions/audio_phase5.test.js
  echo ""
  echo "▶ Phase 6 Admin/Ops"
  $RUN auctions/phase6_ops.test.js
} 2>&1 | tee "$OUT"

FAIL_COUNT=$(grep -c 'ℹ fail 0' "$OUT" || true)
if [[ "$FAIL_COUNT" -lt 6 ]]; then
  echo "VERDICT: FAIL — not all suites reported fail 0"
  echo "Evidence: $OUT"
  exit 1
fi

if grep -q '✖' "$OUT"; then
  echo "VERDICT: FAIL — see failures in $OUT"
  exit 1
fi

echo ""
echo "VERDICT: A — PHASE 6 CLOSED"
echo "Evidence: $OUT"
echo "NOTE: WS multi-instance replay remains P0 (see auctions/MULTI_INSTANCE.md)"
echo "NOTE: ENABLE_AUCTIONS=false remains default for Store Release"
exit 0
