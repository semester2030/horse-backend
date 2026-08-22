#!/usr/bin/env bash
# Phase 5 — Live Audio E2E Gate
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_URL="${AUCTIONS_TEST_DATABASE_URL:-${AUCTIONS_DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: set AUCTIONS_TEST_DATABASE_URL"
  exit 1
fi

export AUCTIONS_TEST_DATABASE_URL="$DB_URL"
export AUCTIONS_DATABASE_URL="$DB_URL"
EVIDENCE_DIR="$ROOT/auctions/evidence"
mkdir -p "$EVIDENCE_DIR"
OUT="$EVIDENCE_DIR/audio_gate_$(date -u +%Y%m%dT%H%M%SZ).txt"

{
  echo "=== NOMAS Auction Phase 5 Audio Gate ==="
  echo "UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "▶ Core regression"
  node --test auctions/auction_core.test.js
  echo ""
  echo "▶ Realtime regression"
  node --test auctions/auction_realtime.test.js
  echo ""
  echo "▶ Host Phase 4 regression"
  node --test auctions/host_phase4.test.js
  echo ""
  echo "▶ Audio Phase 5"
  node --test auctions/audio_phase5.test.js
} 2>&1 | tee "$OUT"

if grep -q "ℹ pass 19" "$OUT" && grep -q "ℹ pass 11" "$OUT" && grep -q "ℹ pass 13" "$OUT"; then
  if grep -q "Phase 5" "$OUT" && ! grep -q "✖" "$OUT"; then
    AUDIO_PASS=$(grep -E "ℹ pass [0-9]+" "$OUT" | tail -1 | sed -E 's/.*pass ([0-9]+).*/\1/')
    if [[ "${AUDIO_PASS:-0}" -ge 12 ]]; then
      echo ""
      echo "VERDICT: A — core + realtime + host + audio gates PASS"
      echo "Evidence: $OUT"
      exit 0
    fi
  fi
fi

echo "VERDICT: FAIL — see $OUT"
exit 1
