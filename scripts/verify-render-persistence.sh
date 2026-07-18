#!/usr/bin/env bash
# تحقق سريع من ثبات البيانات و SMS على Render — شغّله بعد كل نشر.
set -euo pipefail

BASE_URL="${RENDER_BACKEND_URL:-https://horse-backend-i68h.onrender.com}"

echo "=== GET $BASE_URL/health ==="
HEALTH="$(curl -sS -m 30 "$BASE_URL/health")"
echo "$HEALTH" | python3 -m json.tool

FAIL=0

if echo "$HEALTH" | grep -q '"persistent": false'; then
  echo ""
  echo "❌ FAIL: persistent=false — البيانات ما زالت في مسار مؤقت."
  echo "   Render Dashboard → horse-backend → Disks → /var/data"
  echo "   Environment → DATA_DIR=/var/data → Manual Deploy"
  FAIL=1
fi

if echo "$HEALTH" | grep -q '"/opt/render/project/src/data"'; then
  echo ""
  echo "❌ FAIL: dataDir لا يزال على المسار المؤقت."
  FAIL=1
fi

if echo "$HEALTH" | grep -q '"persistent": true'; then
  echo ""
  echo "✅ OK: قرص دائم مفعّل (/var/data)."
fi

if echo "$HEALTH" | grep -q '"sms"'; then
  if echo "$HEALTH" | grep -q '"configured": true'; then
    echo "✅ OK: AWS SNS مفعّل للـ SMS."
  else
    echo "⚠️  SMS: AWS SNS غير مُعد بعد (أضف AWS_ACCESS_KEY_ID على Render)."
  fi
else
  echo "⚠️  استجابة /health قديمة — انتظر انتهاء النشر أو ادفع آخر commit."
fi

exit "$FAIL"
