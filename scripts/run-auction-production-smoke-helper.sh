#!/usr/bin/env bash
# Read-only production/staging smoke helper — does NOT bid, deploy, or enable auctions.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${AUCTION_SMOKE_BASE_URL:-${BACKEND_URL:-http://localhost:4000}}"
BASE="${BASE%/}"

mask_url() {
  local u="$1"
  if [[ -z "$u" ]]; then
    echo "not set"
    return
  fi
  # Show scheme + host only; hide credentials and path secrets
  node -e "
    const u = process.argv[1];
    try {
      const p = new URL(u);
      console.log(p.protocol + '//' + p.hostname + (p.port ? ':' + p.port : '') + '/…');
    } catch { console.log('set (invalid URL)'); }
  " "$u"
}

env_set() {
  if [[ -n "${1:-}" ]]; then echo "SET"; else echo "NOT SET"; fi
}

http_code() {
  curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 15 --max-time 30 "$1" 2>/dev/null || echo "000"
}

json_get() {
  curl -sS --connect-timeout 15 --max-time 30 "$1" 2>/dev/null || echo "{}"
}

echo "=== NOMAS Auction Production Smoke Helper (read-only) ==="
echo "UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Base URL: $BASE"
echo ""

echo "--- Environment readiness (secrets not printed) ---"
echo "ENABLE_AUCTIONS: ${ENABLE_AUCTIONS:-not set in shell}"
echo "AUCTIONS_DATABASE_URL: $(mask_url "${AUCTIONS_DATABASE_URL:-}")"
echo "AUCTIONS_TEST_DATABASE_URL: $(mask_url "${AUCTIONS_TEST_DATABASE_URL:-}")"
echo "AUCTION_DEVELOPER_USER_ID: $(env_set "${AUCTION_DEVELOPER_USER_ID:-}")"
echo "LIVEKIT_URL: $(env_set "${LIVEKIT_URL:-}")"
echo "LIVEKIT_API_KEY: $(env_set "${LIVEKIT_API_KEY:-}")"
echo "LIVEKIT_API_SECRET: $(env_set "${LIVEKIT_API_SECRET:-}")"
echo "AUCTION_AUDIO_PROVIDER: ${AUCTION_AUDIO_PROVIDER:-default}"
echo ""

echo "--- HTTP probes ---"
HEALTH_CODE=$(http_code "$BASE/health")
echo "GET /health → HTTP $HEALTH_CODE"
if [[ "$HEALTH_CODE" != "200" ]]; then
  ROOT_CODE=$(http_code "$BASE/")
  echo "GET / → HTTP $ROOT_CODE (fallback health)"
fi

STATUS_CODE=$(http_code "$BASE/auctions/status")
echo "GET /auctions/status → HTTP $STATUS_CODE"
if [[ "$STATUS_CODE" == "200" ]]; then
  STATUS_JSON=$(json_get "$BASE/auctions/status")
  node -e "
    const j = JSON.parse(process.argv[1]);
    const lines = [
      ['enabled', j.enabled],
      ['dbConfigured', j.dbConfigured],
      ['audioProvider', j.audioProvider],
      ['audioConfigured', j.audioConfigured],
      ['realtimeMode', j.realtimeMode],
      ['v1Species', Array.isArray(j.v1Species) ? j.v1Species.join(',') : '—'],
    ];
    for (const [k,v] of lines) console.log('  ' + k + ': ' + v);
  " "$STATUS_JSON"
fi

echo ""
echo "--- WebSocket endpoint (auth expected without token) ---"
WS_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  --connect-timeout 10 --max-time 15 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "$BASE/ws" 2>/dev/null || echo "000")
echo "GET /ws (upgrade probe) → HTTP $WS_CODE (401/400/426 acceptable; 000 = unreachable)"

echo ""
echo "--- PostgreSQL reachability (local env only) ---"
DB_URL="${AUCTIONS_DATABASE_URL:-${AUCTIONS_TEST_DATABASE_URL:-}}"
if [[ -n "$DB_URL" ]]; then
  node -e "
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.argv[1], connectionTimeoutMillis: 8000 });
    c.connect()
      .then(() => c.query('SELECT 1 AS ok'))
      .then((r) => {
        console.log('PostgreSQL: CONNECTED (SELECT 1 → ' + r.rows[0].ok + ')');
        return c.end();
      })
      .catch((e) => {
        console.log('PostgreSQL: FAIL — ' + e.message);
        process.exit(0);
      });
  " "$DB_URL" 2>/dev/null || echo "PostgreSQL: pg module or connect failed"
else
  echo "PostgreSQL: SKIP — no AUCTIONS_DATABASE_URL in shell (check remote /health auctions block)"
fi

echo ""
echo "--- Optional read-only API (requires AUCTION_SMOKE_USER_TOKEN) ---"
if [[ -n "${AUCTION_SMOKE_USER_TOKEN:-}" ]]; then
  for species in horse camel falcon; do
    CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
      --connect-timeout 15 --max-time 30 \
      -H "Authorization: Bearer ${AUCTION_SMOKE_USER_TOKEN}" \
      "$BASE/auctions?species=$species&limit=3" 2>/dev/null || echo "000")
    echo "GET /auctions?species=$species → HTTP $CODE"
  done
else
  echo "SKIP — set AUCTION_SMOKE_USER_TOKEN for species list probes (token not printed)"
fi

echo ""
echo "--- Next steps ---"
echo "1. Execute manual steps in: backend/auctions/evidence/AUCTION_PUBLIC_SMOKE_EVIDENCE.md"
echo "2. Update PR-07–10 verdict lines at bottom of evidence file"
echo "3. Run: ./scripts/verify-auction-smoke-evidence.sh"
echo "4. Run: ./scripts/run-auction-public-readiness-gate.sh"
echo ""
echo "NOTE: This script does not create bids, enable auctions, or expose secrets."
