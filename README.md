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

التخزين **في الذاكرة + حفظ تلقائي في ملف** `data/store.json` (يبقى بعد إعادة تشغيل الخادم). يمكن لاحقاً ربط MongoDB أو قاعدة بيانات أخرى.

## ربط التطبيق (Flutter)

في `app/lib/main.dart` (أو عند بدء التشغيل):

```dart
import 'package:horsemax_app/core/services/backend/backend_config.dart';

BackendConfig.setUseEnategaBackend(true);
BackendConfig.setBaseUrl('http://localhost:4000');
```

للأندرويد محاكي: استخدم `http://10.0.2.2:4000` بدلاً من localhost.
