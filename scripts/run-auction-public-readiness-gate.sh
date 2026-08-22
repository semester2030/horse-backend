#!/usr/bin/env bash
# AUCTION_PUBLIC_READINESS_GATE — final gate before ENABLE_AUCTIONS=true
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
OUT="$EVIDENCE_DIR/public_readiness_gate_$(date -u +%Y%m%dT%H%M%SZ).txt"

RUN="node --test --test-concurrency=1"
P0=0

{
  echo "=== NOMAS AUCTION_PUBLIC_READINESS_GATE ==="
  echo "UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "DB: $DB_URL"
  echo ""
  echo "▶ PR-11 Regression — Phase 6 final gate suites"
  $RUN auctions/auction_flow_remediation.test.js
  $RUN auctions/auction_core.test.js
  $RUN auctions/auction_realtime.test.js
  $RUN auctions/host_phase4.test.js
  $RUN auctions/audio_phase5.test.js
  $RUN auctions/phase6_ops.test.js
  echo ""
  echo "▶ PR-01 WS multi-instance (PostgreSQL fan-out)"
  $RUN auctions/auction_ws_multi_instance.test.js
  echo ""
  echo "▶ PR-02 HTTP RBAC denial"
  $RUN auctions/auction_public_rbac_http.test.js
  echo ""
  echo "▶ PR-03 Legal — auction terms section"
  if grep -q 'المزادات' "$ROOT/public/legal/terms.html" 2>/dev/null; then
    echo "PASS: terms.html contains auction section"
  else
    echo "FAIL: terms.html missing auction section — PR-03 P0"
    P0=$((P0 + 1))
  fi
  echo ""
  echo "▶ PR-04–06 Legal / privacy / UX compliance"
  $RUN auctions/auction_public_compliance.test.js
  echo ""
  echo "▶ PR-12 Feature flag isolation (in core suite above)"
} 2>&1 | tee "$OUT"

if grep -q '✖' "$OUT"; then
  echo ""
  echo "VERDICT: C — NOT READY (test failures)"
  echo "Evidence: $OUT"
  exit 1
fi

if [[ "$P0" -gt 0 ]]; then
  echo ""
  echo "VERDICT: C — NOT READY ($P0 automated P0 proof(s) missing)"
  echo "See: backend/auctions/PUBLIC_READINESS_GATE.md"
  echo "Evidence: $OUT"
  exit 1
fi

echo ""
echo "▶ PR-07–10 Smoke evidence verifier"
SMOKE_VERIFY=0
if ./scripts/verify-auction-smoke-evidence.sh; then
  SMOKE_VERIFY=1
else
  echo "Smoke evidence: not complete (expected until manual PR-07–10 signed)"
fi

if [[ "$SMOKE_VERIFY" -eq 1 ]] && grep -q '^SMOKE_GATE_VERDICT: A' "$ROOT/auctions/evidence/AUCTION_PUBLIC_SMOKE_EVIDENCE.md"; then
  echo ""
  echo "VERDICT: A — PUBLIC ACTIVATION APPROVED"
  echo "Evidence: $OUT"
  echo "Smoke: backend/auctions/evidence/AUCTION_PUBLIC_SMOKE_EVIDENCE.md"
  echo "NOTE: Set ENABLE_AUCTIONS=true manually after product sign-off — not automated"
  exit 0
fi

echo ""
echo "VERDICT: B — LIMITED BLOCKERS (automated PR-01–06 PASS; manual smoke PR-07–10 required for A)"
echo "Evidence: $OUT"
echo "Smoke template: backend/auctions/evidence/AUCTION_PUBLIC_SMOKE_EVIDENCE.md"
echo "Helper: ./scripts/run-auction-production-smoke-helper.sh"
echo "NOTE: ENABLE_AUCTIONS=false remains default until SMOKE_GATE_VERDICT: A"
exit 0
