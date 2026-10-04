/**
 * PH-02 Closure — Lightweight public entity web fallback + Universal/App Link files.
 * Uses the same Public Visitor DTO as the mobile API (no parallel data source).
 */

const {
  findBySlug,
  validateSlug,
  toPublicVisitorDto,
  publicBaseUrl,
  normalizeSlug,
  ensurePeStore,
} = require('./professional_entity');

const TYPE_LABELS = {
  camel_showroom: 'معرض إبل',
  horse_showroom: 'معرض خيل',
  falcon_showroom: 'معرض صقور',
  store: 'متجر',
  trailer_showroom: 'معرض مقطورات',
  equipment_showroom: 'معرض معدات',
  feed_provider: 'بائع أعلاف',
  service_provider: 'مقدم خدمات',
  mixed: 'متعدد / مختلط',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appStoreUrl() {
  const u = String(process.env.NOMAS_APP_STORE_URL || '').trim();
  return u || '';
}

function playStoreUrl() {
  const u = String(process.env.NOMAS_PLAY_STORE_URL || '').trim();
  return u || '';
}

function appleTeamId() {
  return String(process.env.NOMAS_APPLE_TEAM_ID || 'A97F7227YM').trim();
}

function iosBundleId() {
  return String(process.env.NOMAS_IOS_BUNDLE_ID || 'sa.nomas.app').trim();
}

function androidPackage() {
  return String(process.env.NOMAS_ANDROID_PACKAGE || 'com.horse.app').trim();
}

/** SHA-256 fingerprints (colon-hex or bare). Debug only unless env provides more. */
function androidSha256Fingerprints() {
  const raw = String(process.env.NOMAS_ANDROID_SHA256_FINGERPRINTS || '').trim();
  const list = raw
    ? raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
    : [];
  // Verified local debug keystore fingerprint (not production).
  const debugFp =
    '80:62:F2:D8:C2:87:4B:EE:2C:C2:46:93:E0:7F:7F:34:AF:00:39:06:84:C0:81:96:76:1E:7A:D0:CD:06:DA:C6';
  if (!list.includes(debugFp)) list.push(debugFp);
  return list;
}

function renderStatePage({ title, message, code, status }) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message || '');
  const safeCode = escapeHtml(code || '');
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${safeTitle} — نوماس</title>
  <style>
    :root { --bg:#0f1410; --card:#1a221c; --text:#f3f6f2; --muted:#9aa89c; --accent:#2f6b4f; }
    body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:linear-gradient(160deg,#0f1410,#1a2a20 55%,#122018); color:var(--text); min-height:100vh; }
    main { max-width:560px; margin:0 auto; padding:48px 20px; }
    h1 { font-size:1.4rem; margin:0 0 12px; }
    p { color:var(--muted); line-height:1.6; }
    .code { font-size:0.75rem; opacity:0.7; margin-top:24px; }
  </style>
</head>
<body>
  <main>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    ${safeCode ? `<p class="code">${safeCode} · HTTP ${escapeHtml(String(status))}</p>` : ''}
  </main>
</body>
</html>`;
}

function renderEntityPage(dto) {
  const name = escapeHtml(dto.displayName || 'معرض نوماس');
  const typeLabel = escapeHtml(TYPE_LABELS[dto.entityType] || dto.entityType || '');
  const desc = escapeHtml(dto.description || '');
  const city = escapeHtml(dto.city || '');
  const locLabel = escapeHtml(dto.publicLocation?.label || '');
  const logo = escapeHtml(dto.logoUrl || '');
  const cover = escapeHtml(dto.coverUrl || '');
  const canonical = escapeHtml(dto.canonicalUrl || '');
  const appLink = escapeHtml(dto.canonicalUrl || '');
  const store = appStoreUrl();
  const play = playStoreUrl();
  const policy = dto.contactPolicy || 'in_app';
  const contactAvailable = dto.contactAvailable === true && policy !== 'hidden';
  const publicPhone = String(dto.publicPhone || '').replace(/[^0-9+]/g, '');

  let contactBlock = '';
  if (!contactAvailable) {
    contactBlock = '<p class="muted">لا تتوفر وسيلة تواصل عامة لهذه الجهة</p>';
  } else if (publicPhone && (policy === 'phone' || policy === 'whatsapp')) {
    const tel = escapeHtml(publicPhone.replace(/^\+/, ''));
    contactBlock = `<div class="actions">
      ${policy === 'phone' || policy === 'in_app' ? `<a class="btn" href="tel:${tel}">اتصال</a>` : ''}
      ${policy === 'whatsapp' || policy === 'in_app' ? `<a class="btn secondary" href="https://wa.me/${tel}">واتساب</a>` : ''}
    </div>`;
  } else {
    contactBlock = `<p class="muted">للتواصل الكامل افتح المعرض في تطبيق نوماس</p>`;
  }

  const storeLinks = [
    store ? `<a class="btn secondary" href="${escapeHtml(store)}">App Store</a>` : '',
    play ? `<a class="btn secondary" href="${escapeHtml(play)}">Google Play</a>` : '',
  ]
    .filter(Boolean)
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="index,follow"/>
  <title>${name} — نوماس</title>
  <style>
    :root { --bg:#0f1410; --card:#1a221c; --text:#f3f6f2; --muted:#9aa89c; --accent:#2f6b4f; --line:rgba(255,255,255,0.08); }
    * { box-sizing:border-box; }
    body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:linear-gradient(160deg,#0f1410,#1a2a20 55%,#122018); color:var(--text); min-height:100vh; }
    .cover { width:100%; height:180px; object-fit:cover; background:#243028; display:block; }
    .cover-fallback { height:180px; background:linear-gradient(120deg,#243028,#1a3326); }
    main { max-width:560px; margin:-48px auto 0; padding:0 16px 40px; position:relative; }
    .card { background:rgba(26,34,28,0.92); border:1px solid var(--line); border-radius:16px; padding:20px; backdrop-filter: blur(8px); }
    .row { display:flex; gap:14px; align-items:flex-start; }
    .logo { width:72px; height:72px; border-radius:14px; object-fit:cover; background:#243028; flex-shrink:0; }
    .logo-fallback { width:72px; height:72px; border-radius:14px; background:#243028; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:12px; }
    h1 { margin:0 0 6px; font-size:1.35rem; line-height:1.3; }
    .meta { color:var(--muted); font-size:0.92rem; margin:0 0 4px; }
    .desc { margin:16px 0 0; line-height:1.7; white-space:pre-wrap; }
    .muted { color:var(--muted); }
    .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:20px; }
    .btn { display:inline-block; background:var(--accent); color:#fff; text-decoration:none; padding:12px 16px; border-radius:10px; font-weight:600; }
    .btn.secondary { background:transparent; border:1px solid var(--line); color:var(--text); }
    .canon { margin-top:18px; font-size:0.78rem; color:var(--muted); word-break:break-all; }
  </style>
</head>
<body>
  ${cover ? `<img class="cover" src="${cover}" alt=""/>` : '<div class="cover-fallback"></div>'}
  <main>
    <section class="card">
      <div class="row">
        ${logo ? `<img class="logo" src="${logo}" alt=""/>` : '<div class="logo-fallback">NOMAS</div>'}
        <div>
          <h1>${name}</h1>
          <p class="meta">${typeLabel}</p>
          ${city || locLabel ? `<p class="meta">${[city, locLabel].filter(Boolean).join(' · ')}</p>` : ''}
        </div>
      </div>
      ${desc ? `<p class="desc">${desc}</p>` : ''}
      ${contactBlock}
      <div class="actions">
        <a class="btn" href="${appLink}">فتح في نوماس</a>
        ${storeLinks}
      </div>
      <p class="canon">${canonical}</p>
    </section>
  </main>
</body>
</html>`;
}

function registerProfessionalEntityWebRoutes(app, { store }) {
  ensurePeStore(store);

  // Apple App Site Association — no redirect; application/json
  app.get('/.well-known/apple-app-site-association', (req, res) => {
    const team = appleTeamId();
    const bundle = iosBundleId();
    const body = {
      applinks: {
        apps: [],
        details: [
          {
            appID: `${team}.${bundle}`,
            paths: ['/s/*'],
          },
        ],
      },
    };
    res.set({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    });
    return res.status(200).send(JSON.stringify(body));
  });

  // Android asset links — debug fingerprint verified; production only if env set
  app.get('/.well-known/assetlinks.json', (req, res) => {
    const body = [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: androidPackage(),
          sha256_cert_fingerprints: androidSha256Fingerprints(),
        },
      },
    ];
    res.set({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    });
    return res.status(200).json(body);
  });

  /**
   * GET /s/:slug — lightweight public web page (OD-001 web fallback)
   */
  app.get('/s/:slug', (req, res) => {
    const slugCheck = validateSlug(req.params.slug);
    if (!slugCheck.ok) {
      res.status(404);
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(
        renderStatePage({
          title: 'المعرض غير موجود',
          message: 'رابط المعرض غير صالح.',
          code: 'INVALID_SLUG',
          status: 404,
        }),
      );
    }

    const entity = findBySlug(store, slugCheck.value);
    const status = entity?.publicationStatus || 'draft';

    if (!entity || status === 'draft') {
      res.status(404);
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(
        renderStatePage({
          title: 'المعرض غير موجود',
          message: 'لا يوجد معرض عام بهذا الرابط.',
          code: 'ENTITY_PUBLIC_NOT_FOUND',
          status: 404,
        }),
      );
    }

    if (status === 'paused') {
      res.status(403);
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(
        renderStatePage({
          title: 'هذا المعرض غير متاح حاليًا',
          message: 'المعرض متوقف مؤقتًا. حاول لاحقًا.',
          code: 'ENTITY_PAUSED',
          status: 403,
        }),
      );
    }

    try {
      const dto = toPublicVisitorDto(entity, { store });
      res.status(200);
      res.set('Cache-Control', 'public, max-age=60');
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderEntityPage(dto));
    } catch (err) {
      res.status(500);
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(
        renderStatePage({
          title: 'تعذّر تحميل المعرض',
          message: 'حدث خطأ في الخادم. ليست حالة «غير موجود».',
          code: 'SERVER_ERROR',
          status: 500,
        }),
      );
    }
  });
}

module.exports = {
  registerProfessionalEntityWebRoutes,
  escapeHtml,
  renderEntityPage,
  renderStatePage,
  publicBaseUrl,
  normalizeSlug,
};
