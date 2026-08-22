#!/usr/bin/env bash
# Pre-deploy activation gate — all auction suites + Flutter (no deploy).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_ROOT="$(cd "$ROOT/../app" && pwd)"
DB_URL="${AUCTIONS_TEST_DATABASE_URL:-${AUCTIONS_DATABASE_URL:-postgresql://localhost:5432/nomas_auctions_test}}"

export AUCTIONS_TEST_DATABASE_URL="$DB_URL"
export AUCTIONS_DATABASE_URL="$DB_URL"

echo "=== NOMAS AUCTION PRE-DEPLOY ACTIVATION GATE ==="
echo "UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

cd "$ROOT"
./scripts/run-auction-phase6-final-gate.sh

echo ""
echo "▶ Public readiness automated (PR-01–06)"
./scripts/run-auction-public-readiness-gate.sh

echo ""
echo "▶ Smoke evidence verifier"
./scripts/verify-auction-smoke-evidence.sh

echo ""
echo "▶ Flutter auction tests"
cd "$APP_ROOT"
flutter test test/features/auctions/

echo ""
echo "▶ Flutter analyzer (auctions)"
flutter analyze lib/features/auctions lib/shared/constants/app_config.dart

echo ""
echo "PRE-DEPLOY GATE: PASS — ready for Render deploy + ENABLE_AUCTIONS=true on production"
