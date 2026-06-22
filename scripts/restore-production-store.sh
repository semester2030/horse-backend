#!/usr/bin/env bash
# استعادة backend/data/store.json إلى خادم Render بعد تفعيل القرص الدائم.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE_FILE="${1:-$ROOT/data/store.json}"
BASE_URL="${RENDER_BACKEND_URL:-https://horse-backend-i68h.onrender.com}"
ADMIN_KEY="${ADMIN_SECRET:-admin123}"

if [[ ! -f "$STORE_FILE" ]]; then
  echo "ملف غير موجود: $STORE_FILE" >&2
  exit 1
fi

echo "فحص الخادم..."
HEALTH="$(curl -s "$BASE_URL/health")"
echo "$HEALTH" | python3 -m json.tool

if echo "$HEALTH" | grep -q '"persistent": false'; then
  echo ""
  echo "تحذير: الخادم لا يستخدم قرصاً دائماً (/var/data)." >&2
  echo "فعّل DATA_DIR=/var/data وقرص Persistent Disk على Render قبل الاستعادة." >&2
  read -r -p "متابعة على أي حال؟ (y/N) " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || exit 1
fi

echo ""
echo "رفع $STORE_FILE إلى $BASE_URL/admin/restore-store ..."
curl -sS -X POST "$BASE_URL/admin/restore-store" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  --data-binary "@$STORE_FILE" | python3 -m json.tool

echo ""
echo "تحقق بعد الاستعادة:"
curl -s "$BASE_URL/health" | python3 -m json.tool
