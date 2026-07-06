# باك اند تطبيق العاديات

باك اند Node + Express لتطبيق عرض وبيع الخيل. يعمل على المنفذ **4000** ويتوافق مع تطبيق Flutter (`app/lib/core/services/backend/*`).

## تشغيل الخادم

```bash
cd /Users/fayez/Desktop/horse/backend
npm install
npm start
```

بعد التشغيل:
- **التحقق:** `http://localhost:4000` أو `http://localhost:4000/health`
- **لوحة الإدارة (داش بورد):** `http://localhost:4000/admin` — واجهة تفاعلية لعرض وتنظيم كل البيانات (مستخدمون، خيل، فيديوهات، تعليقات، مفضلة، حجوزات، خدمات) مع بحث وعدادات.
- **توثيق API (Swagger):** `http://localhost:4000/api-docs` — واجهة لتجربة الطلبات مع التوكن.

## واجهات API (ملخص)

| المسار | الوصف |
|--------|--------|
| `GET /`, `GET /health` | التحقق من أن الخادم يعمل |
| `POST /auth/register` | تسجيل مستخدم جديد |
| `POST /auth/login` | تسجيل الدخول |
| `POST /auth/refresh` | تجديد التوكن |
| `GET/PUT/PATCH /users/:id`, `GET /users` | المستخدمون |
| `GET/POST/PATCH /horses`, `GET /horses/:id` | الخيل |
| `GET/PATCH /favorites/:userId` | المفضلة |
| `GET/POST/PATCH /bookings`, `GET /bookings?providerId=&status=` | الحجوزات |
| `GET/POST/PATCH/DELETE /services` | الخدمات |
| `GET/POST/PATCH /videos` | الفيديوهات |

جميع المسارات (ما عدا Auth و Health) تتطلب رأس: `Authorization: Bearer <token>`.

## لوحة الإدارة (داش بورد)

افتح **http://localhost:4000/admin** في المتصفح.

1. **دخول الإدارة:** أدخل **كلمة سر الإدارة** (الافتراضي للتطوير: `admin123`). يمكن تغييرها عبر متغير البيئة: `ADMIN_SECRET=كلمتك node index.js`.
2. **الصلاحيات بعد الدخول:**
   - عرض كل البيانات (مستخدمون، خيل، فيديوهات، تعليقات، مفضلة، حجوزات، خدمات) في جداول منظمة مع بحث
   - **حذف:** زر "حذف" في كل صف (مستخدم، خيل، فيديو، تعليق، حجز، خدمة)
   - **تعديل:** يمكن إضافة واجهة تعديل لاحقاً؛ حالياً الـ API يدعم `PATCH /admin/users/:id`, `PATCH /admin/horses/:id`, `PATCH /admin/videos/:id` من Swagger أو Postman مع رأس `X-Admin-Key: كلمة_السر`

## الحصول على البيانات كاملة (JSON)

1. **من المتصفح أو Postman (API):**
   - **شغّل الباك اند أولاً:** من الطرفية: `cd backend` ثم `npm start` (يجب أن تظهر رسالة مثل "باك اند العاديات يعمل على http://localhost:4000").
   - **افتح الرابط في شريط العنوان في المتصفح** (لا تبحث عنه في جوجل): اكتب أو الصق `http://localhost:4000/admin/data` في شريط العنوان ثم Enter.
   - يرجع JSON يحتوي على: `users`, `horses`, `videos`, `videoComments`, `favorites`, `bookings`, `services`
   - يمكنك نسخ النتيجة أو حفظها كملف JSON

2. **من الملف مباشرة (بدون تشغيل الخادم):**
   - بعد تشغيل الباك اند، تُحفظ البيانات في مجلد المشروع:
   - **المسار:** `backend/data/store.json`
   - افتح الملف بأي محرر نصوص أو استورده في Excel/قاعدة بيانات إن أردت

## التخزين الحالي

التخزين **في الذاكرة + حفظ تلقائي** في `store.json`:

| البيئة | المسار |
|--------|--------|
| محلي | `backend/data/store.json` |
| Render (إنتاج) | `/var/data/store.json` على **قرص دائم** |

### Render — عدم مسح البيانات بعد كل نشر

ملف `render.yaml` يفعّل:

- `plan: starter` (القرص الدائم **لا يعمل** على الخطة المجانية free)
- قرص `mountPath: /var/data` + `DATA_DIR=/var/data`

بعد دفع `render.yaml` إلى GitHub:

1. في [Render Dashboard](https://dashboard.render.com) → **horse-backend** → تأكد أن الخطة **Starter** (أو أعلى).
2. إن كان الخدمة على **Free**، غيّرها إلى **Starter** ثم أعد النشر من Blueprint أو Sync.
3. تحقق: `GET https://horse-backend-i68h.onrender.com/health` — يجب أن يظهر:
   - `"dataDir": "/var/data"`
   - `"persistent": true`
   - `"warning": null`

إذا ظهر `dataDir: "/opt/render/project/src/data"` و `"persistent": false` فالبيانات **تُمسح مع كل نشر** — هذا سبب اختفاء الحساب والفيديوهات.

### استعادة نسخة محلية

بعد تفعيل القرص الدائم:

```bash
cd backend
ADMIN_SECRET=كلمة_سر_الإدارة ./scripts/restore-production-store.sh data/store.json
```

**تحذير:** البيانات التي فُقدت قبل تفعيل القرص لا تُستعاد تلقائياً — أعد إدخالها أو استورد نسخة من `data/store.json` المحلي إن وُجدت.

يمكن لاحقاً ربط PostgreSQL إذا كبر حجم البيانات.

## Taqnyat (تقنيات) — رمز التحقق SMS للسعودية (موصى به)

**الخيار الافتراضي** لـ OTP في السعودية (+966).

1. سجّل في [portal.taqnyat.sa](https://portal.taqnyat.sa)
2. **المطورين → التطبيقات** → أنشئ تطبيقاً (SMS) → انسخ **Bearer Token**
3. **أكمل الوثائق** + سجّل **اسم المرسل** (مثل `NOMAS`) في إدارة SMS
4. على **Render** → Environment:

| المتغير | القيمة |
|---------|--------|
| `SMS_PROVIDER` | `taqnyat` |
| `TAQNYAT_BEARER_TOKEN` | من portal |
| `TAQNYAT_SENDER` | `NOMAS` (اسم معتمد) |
| `OTP_EXPOSE_CODE` | `false` |

5. تحقق: `GET /health` → `"sms": { "configured": true, "provider": "taqnyat", "sender": "NOMAS" }`

**التطوير المحلي:** بدون Taqnyat، اترك `OTP_EXPOSE_CODE=true` — الرمز يظهر في Debug فقط.

## Amazon SNS — بديل (احتياطي)

عند `SMS_PROVIDER=sns` أو عدم وجود Taqnyat:

1. **IAM** → Users → Create user (مثلاً `nomas-sns`)
2. Attach policy مخصصة:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["sns:Publish"],
    "Resource": "*"
  }]
}
```

3. أنشئ **Access key** واحفظ `Access key ID` + `Secret`
4. **SNS** → Text messaging (SMS) → **Account settings**:
   - اطلب **Production access** (رفع حد Sandbox) لإرسال لأرقام حقيقية
   - اضبط **Default SMS type** = Transactional
5. على **Render** → Environment:

| المتغير | القيمة |
|---------|--------|
| `AWS_ACCESS_KEY_ID` | من IAM |
| `AWS_SECRET_ACCESS_KEY` | من IAM |
| `AWS_REGION` | `eu-north-1` (أو منطقتك) |
| `AWS_SNS_SMS_TYPE` | `Transactional` |
| `OTP_EXPOSE_CODE` | `false` |

6. أعد النشر ثم جرّب تسجيل الدخول من التطبيق.

**التكلفة التقريبية:** ~0.05–0.08 USD لكل رسالة إلى السعودية (يُخصم من رصيد AWS 100$).

**التطوير المحلي:** بدون AWS، اترك `OTP_EXPOSE_CODE=true` — الرمز يظهر في Debug فقط.

## Cloudflare (رفع فيديو / صور من التطبيق)

التوكن **لا يُخزَّن في تطبيق Flutter** (متطلبات أمان ومتاجر التطبيقات).  
اضبط المتغيرات على **Render** (أو `.env` محلياً):

| المتغير | الوصف |
|---------|--------|
| `CLOUDFLARE_ACCOUNT_ID` | من لوحة Cloudflare → Overview → Account ID |
| `CLOUDFLARE_API_TOKEN` | Token بصلاحيات **Stream: Edit** و **Cloudflare Images: Edit** (أو أنشئ من Templates) |

الباك اند يعرّض:

- `POST /media/stream/direct-upload` (يتطلب `Authorization: Bearer <jwt>`)
- `POST /media/images/direct-upload`
- `GET /media/stream/:videoId`

التطبيق يطلب جلسة رفع ثم يرفع الملف إلى رابط Cloudflare لمرة واحدة.

مرجع: انسخ من `.env.example`.

## ربط التطبيق (Flutter)

في `app/lib/main.dart` (أو عند بدء التشغيل):

```dart
import 'package:horsemax_app/core/services/backend/backend_config.dart';

BackendConfig.setUseEnategaBackend(true);
BackendConfig.setBaseUrl('http://localhost:4000');
```

للأندرويد محاكي: استخدم `http://10.0.2.2:4000` بدلاً من localhost.
