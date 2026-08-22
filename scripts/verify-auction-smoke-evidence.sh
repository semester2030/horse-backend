#!/usr/bin/env bash
# Verify AUCTION_PUBLIC_SMOKE_EVIDENCE.md verdict lines for PR-07–10.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE="${AUCTION_SMOKE_EVIDENCE_PATH:-$ROOT/auctions/evidence/AUCTION_PUBLIC_SMOKE_EVIDENCE.md}"

if [[ ! -f "$EVIDENCE" ]]; then
  echo "FAIL: evidence file missing: $EVIDENCE"
  exit 1
fi

read_verdict() {
  local key="$1"
  grep -E "^${key}:" "$EVIDENCE" | tail -1 | sed "s/^${key}:[[:space:]]*//" | tr -d '\r'
}

PR07=$(read_verdict "PR-07_VERDICT")
PR08=$(read_verdict "PR-08_VERDICT")
PR09=$(read_verdict "PR-09_VERDICT")
PR10=$(read_verdict "PR-10_VERDICT")
SMOKE=$(read_verdict "SMOKE_GATE_VERDICT")

echo "=== Auction Smoke Evidence Verifier ==="
echo "File: $EVIDENCE"
echo "PR-07: $PR07"
echo "PR-08: $PR08"
echo "PR-09: $PR09"
echo "PR-10: $PR10"
echo "SMOKE_GATE: $SMOKE"
echo ""

pass_ok() {
  [[ "$1" == "PASS" ]]
}

blocked_ok() {
  [[ "$1" == "BLOCKED_EXTERNAL" ]]
}

P0=0
FAIL_MSG=""

check_pass() {
  local label="$1"
  local value="$2"
  if pass_ok "$value"; then
    echo "OK: $label PASS"
  else
    echo "BLOCK: $label is '$value' (need PASS)"
    P0=$((P0 + 1))
    FAIL_MSG="${FAIL_MSG} ${label}"
  fi
}

check_pass "PR-07" "$PR07"
check_pass "PR-08" "$PR08"
check_pass "PR-10" "$PR10"

if pass_ok "$PR09" || blocked_ok "$PR09"; then
  echo "OK: PR-09 $PR09"
  if blocked_ok "$PR09"; then
    echo "NOTE: PR-09 BLOCKED_EXTERNAL — document LiveKit workaround in evidence"
  fi
else
  echo "BLOCK: PR-09 is '$PR09' (need PASS or BLOCKED_EXTERNAL)"
  P0=$((P0 + 1))
  FAIL_MSG="${FAIL_MSG} PR-09"
fi

if [[ "$P0" -gt 0 ]]; then
  echo ""
  echo "VERDICT: C — smoke evidence incomplete ($FAIL_MSG)"
  exit 1
fi

if [[ "$SMOKE" == "A" ]]; then
  echo ""
  echo "VERDICT: A — PUBLIC ACTIVATION APPROVED (evidence signed)"
  exit 0
fi

echo ""
echo "VERDICT: B — smoke proofs PASS; set SMOKE_GATE_VERDICT: A after sign-off"
exit 0
