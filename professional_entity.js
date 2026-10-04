/**
 * PH-01 — Professional Entity Identity Foundation
 * Owner-only v1 · one entity per owner · store.json Map persistence
 */

const DISPLAY_NAME_MAX = 80;
const DESCRIPTION_MAX = 2000;
const SLUG_MIN = 3;
const SLUG_MAX = 48;

const ENTITY_TYPES = new Set([
  'camel_showroom',
  'horse_showroom',
  'falcon_showroom',
  'store',
  'trailer_showroom',
  'equipment_showroom',
  'feed_provider',
  'service_provider',
  'mixed',
]);

const PUBLICATION_STATUSES = new Set(['draft', 'active', 'paused']);

const CONTACT_POLICIES = new Set([
  'in_app',
  'phone',
  'whatsapp',
  'hidden',
]);

const RESERVED_SLUGS = new Set([
  'me',
  'admin',
  'api',
  'www',
  'nomas',
  'null',
  'undefined',
  'create',
  'new',
  'edit',
  'settings',
  'official',
  'support',
  'help',
  'public',
  's',
]);

function ensurePeStore(store) {
  if (!store.professionalEntities) store.professionalEntities = new Map();
}

function ensureImageAssets(store) {
  if (!store.imageAssets) store.imageAssets = new Map();
}

function normalizeSlug(raw) {
  let s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/[^a-z0-9\u0600-\u06ff-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s;
}

function slugFromDisplayName(name) {
  const base = normalizeSlug(
    String(name || '')
      .replace(/[^\w\u0600-\u06ff\s-]/g, '')
      .slice(0, SLUG_MAX),
  );
  if (base.length >= SLUG_MIN) return base.slice(0, SLUG_MAX);
  return `entity-${Date.now().toString(36)}`;
}

function findByOwner(store, userId) {
  ensurePeStore(store);
  return [...store.professionalEntities.values()].find(
    (e) => String(e.ownerUserId) === String(userId),
  );
}

function findBySlug(store, slug, { excludeId } = {}) {
  ensurePeStore(store);
  const n = normalizeSlug(slug);
  return [...store.professionalEntities.values()].find(
    (e) =>
      normalizeSlug(e.publicSlug) === n &&
      (!excludeId || String(e.id) !== String(excludeId)),
  );
}

function isHttpsUrl(u) {
  try {
    const url = new URL(String(u || ''));
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Extract Cloudflare Images id from imagedelivery.net/{hash}/{id}/{variant} */
function extractCloudflareImageId(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.hostname !== 'imagedelivery.net') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const imageId = parts[1];
    if (!imageId || imageId.length < 1) return null;
    return imageId;
  } catch {
    return null;
  }
}

/**
 * Logo/cover must be https imagedelivery.net URL owned by the authenticated user
 * (registered at /media/images/direct-upload). Empty clears the field.
 * Same current URL may be kept without re-checking registry (grandfather).
 */
function assertOwnedMediaUrl(store, ownerUserId, url, { field, currentUrl } = {}) {
  const label = field === 'cover' ? 'الغلاف' : 'الشعار';
  const codePrefix = field === 'cover' ? 'COVER' : 'LOGO';
  const raw = String(url || '').trim();
  if (!raw) return { ok: true, value: '', assetId: '' };
  if (currentUrl && raw === String(currentUrl)) {
    return {
      ok: true,
      value: raw,
      assetId: extractCloudflareImageId(raw) || '',
    };
  }
  if (!isHttpsUrl(raw)) {
    return {
      ok: false,
      message: `رابط ${label} يجب أن يكون https صالحاً`,
      code: `INVALID_${codePrefix}_URL`,
    };
  }
  const assetId = extractCloudflareImageId(raw);
  if (!assetId) {
    return {
      ok: false,
      message: `${label} يجب أن يكون من وسائط نوماس (imagedelivery.net) وليس رابطاً خارجياً`,
      code: `INVALID_${codePrefix}_URL`,
    };
  }
  ensureImageAssets(store);
  const asset = store.imageAssets.get(assetId);
  if (!asset) {
    return {
      ok: false,
      message: `${label}: الأصل غير معروف — ارفع الصورة عبر نوماس أولاً`,
      code: `${codePrefix}_ASSET_UNKNOWN`,
    };
  }
  if (String(asset.ownerUserId) !== String(ownerUserId)) {
    return {
      ok: false,
      message: `${label}: هذا الأصل لا يخص حسابك`,
      code: `${codePrefix}_ASSET_UNAUTHORIZED`,
    };
  }
  if (asset.kind && asset.kind !== 'image') {
    return {
      ok: false,
      message: `${label}: نوع الأصل غير صالح كصورة`,
      code: `INVALID_${codePrefix}_URL`,
    };
  }
  return { ok: true, value: raw, assetId };
}

function validatePublicLocation(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      message: 'الموقع العام غير صالح',
      code: 'INVALID_PUBLIC_LOCATION',
    };
  }
  const label = String(raw.label || '').trim().slice(0, 120);
  let lat;
  let lng;
  if (raw.lat != null && raw.lat !== '') {
    lat = Number(raw.lat);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return {
        ok: false,
        message: 'إحداثي العرض (lat) غير صالح',
        code: 'INVALID_PUBLIC_LOCATION',
      };
    }
  }
  if (raw.lng != null && raw.lng !== '') {
    lng = Number(raw.lng);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      return {
        ok: false,
        message: 'إحداثي الطول (lng) غير صالح',
        code: 'INVALID_PUBLIC_LOCATION',
      };
    }
  }
  if (!label && lat == null && lng == null) {
    return { ok: true, value: null };
  }
  const value = { label };
  if (lat != null) value.lat = lat;
  if (lng != null) value.lng = lng;
  return { ok: true, value };
}

function validateContactPolicy(raw, { required = false } = {}) {
  if (raw == null || String(raw).trim() === '') {
    if (required) {
      return {
        ok: false,
        message: 'سياسة التواصل مطلوبة',
        code: 'INVALID_CONTACT_POLICY',
      };
    }
    return { ok: true, value: 'in_app' };
  }
  const v = String(raw).trim().toLowerCase();
  if (!CONTACT_POLICIES.has(v)) {
    return {
      ok: false,
      message: 'سياسة التواصل غير صالحة',
      code: 'INVALID_CONTACT_POLICY',
    };
  }
  return { ok: true, value: v };
}

function validatePublicationStatus(raw, { defaultValue = 'draft' } = {}) {
  if (raw == null || String(raw).trim() === '') {
    return { ok: true, value: defaultValue };
  }
  const v = String(raw).trim().toLowerCase();
  if (!PUBLICATION_STATUSES.has(v)) {
    return {
      ok: false,
      message: 'حالة النشر غير صالحة',
      code: 'INVALID_PUBLICATION_STATUS',
    };
  }
  return { ok: true, value: v };
}

/** Staging HTTPS origin for PH-02 runtime — NOT permanent Production QR identity. */
const STAGING_CANONICAL_ORIGIN = 'https://horse-backend-i68h.onrender.com';

/**
 * Canonical origin for public QR/Share/Web/AASA paths.
 * - Default = STAGING_CANONICAL_ORIGIN (Render).
 * - PRODUCTION_CANONICAL_DOMAIN via env only when owner-controlled DNS is ready.
 * - nomas.app is parked externally — never default.
 * Override active origin: NOMAS_PUBLIC_BASE
 */
function publicBaseUrl() {
  const production = String(
    process.env.NOMAS_PRODUCTION_CANONICAL_DOMAIN || '',
  ).trim();
  const raw = String(
    process.env.NOMAS_PUBLIC_BASE ||
      (production
        ? production.startsWith('http')
          ? production
          : `https://${production}`
        : STAGING_CANONICAL_ORIGIN),
  ).trim();
  return raw.replace(/\/+$/, '');
}

function stagingCanonicalOrigin() {
  return STAGING_CANONICAL_ORIGIN;
}

function productionCanonicalDomainConfigured() {
  return Boolean(String(process.env.NOMAS_PRODUCTION_CANONICAL_DOMAIN || '').trim());
}

function ownerPublicPhone(store, ownerUserId) {
  if (!store?.users || !ownerUserId) return '';
  const user = store.users.get(String(ownerUserId));
  const phone = String(user?.phone || '').trim();
  if (!phone) return '';
  return phone.replace(/[^\d+]/g, '');
}

/** Central canonical public URL — PH-02 (single generator). */
function canonicalEntityUrl(slug) {
  const s = normalizeSlug(slug);
  return `${publicBaseUrl()}/s/${s}`;
}

function canonicalPublicUrl(slug) {
  return canonicalEntityUrl(slug);
}

function publicEntity(e, { includePrivate = false } = {}) {
  if (!e) return null;
  const out = {
    id: e.id,
    entityId: e.id,
    displayName: e.displayName,
    publicSlug: e.publicSlug,
    entityType: e.entityType,
    description: e.description || '',
    logoUrl: e.logoUrl || '',
    coverUrl: e.coverUrl || '',
    logoAssetId: e.logoAssetId || '',
    coverAssetId: e.coverAssetId || '',
    city: e.city || '',
    publicLocation: e.publicLocation || null,
    contactPolicy: e.contactPolicy || 'in_app',
    publicationStatus: e.publicationStatus || 'draft',
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    version: e.version || 1,
    canonicalUrl: canonicalPublicUrl(e.publicSlug),
  };
  if (includePrivate) {
    out.ownerUserId = e.ownerUserId;
  }
  return out;
}

/**
 * PH-02 — visitor-safe DTO. Never includes ownerUserId / asset internals / version.
 * publicPhone only when contactPolicy intentionally publishes phone/whatsapp.
 */
function toPublicVisitorDto(e, { store } = {}) {
  if (!e) return null;
  const contactPolicy = e.contactPolicy || 'in_app';
  const loc = e.publicLocation || null;
  const out = {
    entityId: e.id,
    displayName: e.displayName,
    publicSlug: e.publicSlug,
    entityType: e.entityType,
    description: e.description || '',
    logoUrl: e.logoUrl || '',
    coverUrl: e.coverUrl || '',
    city: e.city || '',
    publicLocation: loc
      ? {
          label: loc.label || '',
          ...(loc.lat != null ? { lat: loc.lat } : {}),
          ...(loc.lng != null ? { lng: loc.lng } : {}),
        }
      : null,
    contactPolicy,
    contactAvailable: contactPolicy !== 'hidden',
    publicationStatus: e.publicationStatus || 'draft',
    canonicalUrl: canonicalPublicUrl(e.publicSlug),
    updatedAt: e.updatedAt,
  };
  if (
    store &&
    (contactPolicy === 'phone' || contactPolicy === 'whatsapp')
  ) {
    const phone = ownerPublicPhone(store, e.ownerUserId);
    if (phone) out.publicPhone = phone;
  }
  return out;
}

function validateDisplayName(name) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, message: 'اسم الجهة مطلوب' };
  if (n.length > DISPLAY_NAME_MAX) {
    return { ok: false, message: `اسم الجهة أطول من ${DISPLAY_NAME_MAX} حرفاً` };
  }
  return { ok: true, value: n };
}

function validateSlug(slug) {
  const s = normalizeSlug(slug);
  if (s.length < SLUG_MIN || s.length > SLUG_MAX) {
    return {
      ok: false,
      message: `المعرّف العام يجب أن يكون بين ${SLUG_MIN} و ${SLUG_MAX} حرفاً`,
      code: 'INVALID_SLUG',
    };
  }
  if (RESERVED_SLUGS.has(s)) {
    return {
      ok: false,
      message: 'هذا المعرّف العام محجوز',
      code: 'RESERVED_SLUG',
    };
  }
  return { ok: true, value: s };
}

/** Serialize professionalEntities Map → plain object (store.json shape). */
function serializeProfessionalEntities(store) {
  ensurePeStore(store);
  return Object.fromEntries(store.professionalEntities);
}

/** Load professionalEntities from plain object into a fresh Map. */
function loadProfessionalEntities(data) {
  if (!data || typeof data !== 'object') return new Map();
  return new Map(Object.entries(data));
}

function createProfessionalEntityApi({
  store,
  saveStore,
  id,
  auth,
  requireSessionUser,
}) {
  function registerAppRoutes(app) {
    ensurePeStore(store);
    ensureImageAssets(store);

    /** GET /professional-entities/me */
    app.get(
      '/professional-entities/me',
      auth,
      requireSessionUser,
      (req, res) => {
        const entity = findByOwner(store, req.authUserId);
        if (!entity) {
          return res.status(404).json({
            message: 'لا توجد جهة مهنية لهذا الحساب',
            code: 'ENTITY_NOT_FOUND',
          });
        }
        return res.json({ entity: publicEntity(entity, { includePrivate: true }) });
      },
    );

    /**
     * GET /professional-entities/me/preview — owner preview as visitor DTO
     * (draft allowed for owner; does not change publicationStatus)
     */
    app.get(
      '/professional-entities/me/preview',
      auth,
      requireSessionUser,
      (req, res) => {
        const entity = findByOwner(store, req.authUserId);
        if (!entity) {
          return res.status(404).json({
            message: 'لا توجد جهة مهنية لهذا الحساب',
            code: 'ENTITY_NOT_FOUND',
          });
        }
        res.set('Cache-Control', 'no-store');
        return res.json({
          entity: toPublicVisitorDto(entity, { store }),
          ownerPreview: true,
        });
      },
    );

    /**
     * GET /professional-entities/public/:slug — unauthenticated visitor read
     * draft + unknown → same 404 (no existence leak)
     * paused → ENTITY_PAUSED
     * active → Public DTO
     */
    app.get('/professional-entities/public/:slug', (req, res) => {
      const slugCheck = validateSlug(req.params.slug);
      if (!slugCheck.ok) {
        return res.status(400).json({
          message: slugCheck.message,
          code: slugCheck.code || 'INVALID_SLUG',
        });
      }
      const entity = findBySlug(store, slugCheck.value);
      const status = entity?.publicationStatus || 'draft';
      if (!entity || status === 'draft') {
        res.set('Cache-Control', 'no-store');
        return res.status(404).json({
          message: 'المعرض غير موجود',
          code: 'ENTITY_PUBLIC_NOT_FOUND',
        });
      }
      if (status === 'paused') {
        res.set('Cache-Control', 'no-store');
        return res.status(403).json({
          message: 'هذا المعرض غير متاح حاليًا',
          code: 'ENTITY_PAUSED',
        });
      }
      // active — short TTL; clients should refetch on reopen
      res.set('Cache-Control', 'private, max-age=60');
      res.set('ETag', `W/"pe-${entity.id}-${entity.updatedAt || ''}-${entity.version || 1}"`);
      return res.json({ entity: toPublicVisitorDto(entity, { store }) });
    });

    /**
     * GET /professional-entities/public/:slug/contact
     * Auth required. Resolves owner phone server-side; never returns ownerUserId.
     * Channels respect contactPolicy.
     */
    app.get(
      '/professional-entities/public/:slug/contact',
      auth,
      requireSessionUser,
      (req, res) => {
        const slugCheck = validateSlug(req.params.slug);
        if (!slugCheck.ok) {
          return res.status(400).json({
            message: slugCheck.message,
            code: slugCheck.code || 'INVALID_SLUG',
          });
        }
        const entity = findBySlug(store, slugCheck.value);
        const status = entity?.publicationStatus || 'draft';
        const isOwner =
          entity && String(entity.ownerUserId) === String(req.authUserId);
        if (!entity || (status === 'draft' && !isOwner)) {
          return res.status(404).json({
            message: 'المعرض غير موجود',
            code: 'ENTITY_PUBLIC_NOT_FOUND',
          });
        }
        if (status === 'paused' && !isOwner) {
          return res.status(403).json({
            message: 'هذا المعرض غير متاح حاليًا',
            code: 'ENTITY_PAUSED',
          });
        }
        const contactPolicy = entity.contactPolicy || 'in_app';
        if (contactPolicy === 'hidden') {
          return res.status(403).json({
            message: 'لا تتوفر وسيلة تواصل عامة لهذه الجهة',
            code: 'CONTACT_HIDDEN',
          });
        }
        const phone = ownerPublicPhone(store, entity.ownerUserId);
        const channels = [];
        if (phone) {
          if (contactPolicy === 'phone' || contactPolicy === 'in_app') {
            channels.push('phone', 'sms');
          }
          if (contactPolicy === 'whatsapp' || contactPolicy === 'in_app') {
            channels.push('whatsapp');
          }
        }
        res.set('Cache-Control', 'no-store');
        return res.json({
          displayName: entity.displayName || '',
          contactPolicy,
          phone: phone || '',
          channels: [...new Set(channels)],
          contactAvailable: channels.length > 0,
        });
      },
    );

    /** GET /professional-entities/:id — owner or internal read */
    app.get(
      '/professional-entities/:id',
      auth,
      requireSessionUser,
      (req, res) => {
        ensurePeStore(store);
        const entity = store.professionalEntities.get(String(req.params.id));
        if (!entity) {
          return res.status(404).json({
            message: 'الجهة غير موجودة',
            code: 'ENTITY_NOT_FOUND',
          });
        }
        const isOwner = String(entity.ownerUserId) === String(req.authUserId);
        if (!isOwner) {
          return res.status(403).json({
            message: 'غير مصرح بقراءة هذه الجهة',
            code: 'ENTITY_FORBIDDEN',
          });
        }
        return res.json({ entity: publicEntity(entity, { includePrivate: true }) });
      },
    );

    /** POST /professional-entities — create first entity only (v1) */
    app.post(
      '/professional-entities',
      auth,
      requireSessionUser,
      (req, res) => {
        const ownerUserId = String(req.authUserId);
        const existing = findByOwner(store, ownerUserId);
        if (existing) {
          return res.status(409).json({
            message: 'يمكنك امتلاك جهة مهنية واحدة فقط في الإصدار الحالي',
            code: 'ENTITY_LIMIT_REACHED',
          });
        }

        const nameCheck = validateDisplayName(req.body?.displayName);
        if (!nameCheck.ok) {
          return res.status(400).json({ message: nameCheck.message, code: 'INVALID_DISPLAY_NAME' });
        }

        let entityType = String(req.body?.entityType || 'mixed').trim().toLowerCase();
        if (!ENTITY_TYPES.has(entityType)) {
          return res.status(400).json({
            message: 'نوع الجهة غير صالح',
            code: 'INVALID_ENTITY_TYPE',
          });
        }

        const slugRaw =
          req.body?.publicSlug != null && String(req.body.publicSlug).trim()
            ? req.body.publicSlug
            : slugFromDisplayName(nameCheck.value);
        const slugCheck = validateSlug(slugRaw);
        if (!slugCheck.ok) {
          return res.status(400).json({
            message: slugCheck.message,
            code: slugCheck.code || 'INVALID_SLUG',
          });
        }
        if (findBySlug(store, slugCheck.value)) {
          return res.status(409).json({
            message: 'المعرّف العام مستخدم مسبقاً',
            code: 'SLUG_CONFLICT',
          });
        }

        let description = String(req.body?.description || '').trim();
        if (description.length > DESCRIPTION_MAX) {
          description = description.slice(0, DESCRIPTION_MAX);
        }

        const logoCheck = assertOwnedMediaUrl(store, ownerUserId, req.body?.logoUrl, {
          field: 'logo',
        });
        if (!logoCheck.ok) {
          return res.status(400).json({
            message: logoCheck.message,
            code: logoCheck.code,
          });
        }
        const coverCheck = assertOwnedMediaUrl(store, ownerUserId, req.body?.coverUrl, {
          field: 'cover',
        });
        if (!coverCheck.ok) {
          return res.status(400).json({
            message: coverCheck.message,
            code: coverCheck.code,
          });
        }

        const pubCheck = validatePublicationStatus(req.body?.publicationStatus);
        if (!pubCheck.ok) {
          return res.status(400).json({
            message: pubCheck.message,
            code: pubCheck.code,
          });
        }

        const contactCheck = validateContactPolicy(req.body?.contactPolicy);
        if (!contactCheck.ok) {
          return res.status(400).json({
            message: contactCheck.message,
            code: contactCheck.code,
          });
        }

        const locCheck = validatePublicLocation(req.body?.publicLocation);
        if (!locCheck.ok) {
          return res.status(400).json({
            message: locCheck.message,
            code: locCheck.code,
          });
        }

        const city = String(req.body?.city || '').trim().slice(0, 80);
        const now = new Date().toISOString();
        const entityId = id();
        const entity = {
          id: entityId,
          ownerUserId,
          displayName: nameCheck.value,
          publicSlug: slugCheck.value,
          entityType,
          description,
          logoUrl: logoCheck.value,
          coverUrl: coverCheck.value,
          logoAssetId: logoCheck.assetId || '',
          coverAssetId: coverCheck.assetId || '',
          city,
          publicLocation: locCheck.value,
          contactPolicy: contactCheck.value,
          publicationStatus: pubCheck.value,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        store.professionalEntities.set(entityId, entity);
        saveStore();
        return res.status(201).json({
          entity: publicEntity(entity, { includePrivate: true }),
        });
      },
    );

    /** PATCH /professional-entities/me — owner update (slug immutable in PH-01) */
    app.patch(
      '/professional-entities/me',
      auth,
      requireSessionUser,
      (req, res) => {
        const entity = findByOwner(store, req.authUserId);
        if (!entity) {
          return res.status(404).json({
            message: 'لا توجد جهة مهنية لهذا الحساب',
            code: 'ENTITY_NOT_FOUND',
          });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        if (
          Object.prototype.hasOwnProperty.call(body, 'ownerUserId') ||
          Object.prototype.hasOwnProperty.call(body, 'id') ||
          Object.prototype.hasOwnProperty.call(body, 'entityId')
        ) {
          return res.status(400).json({
            message: 'لا يمكن تعديل مالك الجهة أو المعرّف',
            code: 'IMMUTABLE_FIELD',
          });
        }
        if (Object.prototype.hasOwnProperty.call(body, 'publicSlug')) {
          return res.status(400).json({
            message: 'المعرّف العام غير قابل للتعديل في هذه المرحلة',
            code: 'SLUG_IMMUTABLE',
          });
        }

        if (body.version != null && Number(body.version) !== Number(entity.version || 1)) {
          return res.status(409).json({
            message: 'تم تعديل الجهة من جهاز آخر — أعد التحميل ثم حاول مجدداً',
            code: 'VERSION_CONFLICT',
            currentVersion: entity.version || 1,
          });
        }

        if (Object.prototype.hasOwnProperty.call(body, 'displayName')) {
          const nameCheck = validateDisplayName(body.displayName);
          if (!nameCheck.ok) {
            return res.status(400).json({
              message: nameCheck.message,
              code: 'INVALID_DISPLAY_NAME',
            });
          }
          entity.displayName = nameCheck.value;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'description')) {
          let description = String(body.description || '').trim();
          if (description.length > DESCRIPTION_MAX) {
            description = description.slice(0, DESCRIPTION_MAX);
          }
          entity.description = description;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'entityType')) {
          const entityType = String(body.entityType || '').trim().toLowerCase();
          if (!ENTITY_TYPES.has(entityType)) {
            return res.status(400).json({
              message: 'نوع الجهة غير صالح',
              code: 'INVALID_ENTITY_TYPE',
            });
          }
          entity.entityType = entityType;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'logoUrl')) {
          const logoCheck = assertOwnedMediaUrl(
            store,
            req.authUserId,
            body.logoUrl,
            { field: 'logo', currentUrl: entity.logoUrl },
          );
          if (!logoCheck.ok) {
            return res.status(400).json({
              message: logoCheck.message,
              code: logoCheck.code,
            });
          }
          entity.logoUrl = logoCheck.value;
          entity.logoAssetId = logoCheck.assetId || '';
        }
        if (Object.prototype.hasOwnProperty.call(body, 'coverUrl')) {
          const coverCheck = assertOwnedMediaUrl(
            store,
            req.authUserId,
            body.coverUrl,
            { field: 'cover', currentUrl: entity.coverUrl },
          );
          if (!coverCheck.ok) {
            return res.status(400).json({
              message: coverCheck.message,
              code: coverCheck.code,
            });
          }
          entity.coverUrl = coverCheck.value;
          entity.coverAssetId = coverCheck.assetId || '';
        }
        if (Object.prototype.hasOwnProperty.call(body, 'city')) {
          entity.city = String(body.city || '').trim().slice(0, 80);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'contactPolicy')) {
          const contactCheck = validateContactPolicy(body.contactPolicy, {
            required: true,
          });
          if (!contactCheck.ok) {
            return res.status(400).json({
              message: contactCheck.message,
              code: contactCheck.code,
            });
          }
          entity.contactPolicy = contactCheck.value;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'publicationStatus')) {
          const pubCheck = validatePublicationStatus(body.publicationStatus, {
            defaultValue: '',
          });
          if (!pubCheck.ok || !pubCheck.value) {
            return res.status(400).json({
              message: 'حالة النشر غير صالحة',
              code: 'INVALID_PUBLICATION_STATUS',
            });
          }
          entity.publicationStatus = pubCheck.value;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'publicLocation')) {
          const locCheck = validatePublicLocation(body.publicLocation);
          if (!locCheck.ok) {
            return res.status(400).json({
              message: locCheck.message,
              code: locCheck.code,
            });
          }
          entity.publicLocation = locCheck.value;
        }

        entity.updatedAt = new Date().toISOString();
        entity.version = Number(entity.version || 1) + 1;
        store.professionalEntities.set(entity.id, entity);
        saveStore();
        return res.json({ entity: publicEntity(entity, { includePrivate: true }) });
      },
    );
  }

  return {
    registerAppRoutes,
    ENTITY_TYPES: [...ENTITY_TYPES],
    CONTACT_POLICIES: [...CONTACT_POLICIES],
    _internal: {
      normalizeSlug,
      validateSlug,
      validateDisplayName,
      findByOwner,
      findBySlug,
      publicEntity,
      ensurePeStore,
      assertOwnedMediaUrl,
      validatePublicLocation,
      validateContactPolicy,
      serializeProfessionalEntities,
      loadProfessionalEntities,
    },
  };
}

module.exports = {
  createProfessionalEntityApi,
  ENTITY_TYPES: [...ENTITY_TYPES],
  CONTACT_POLICIES: [...CONTACT_POLICIES],
  PUBLICATION_STATUSES: [...PUBLICATION_STATUSES],
  normalizeSlug,
  validateSlug,
  validateDisplayName,
  findByOwner,
  findBySlug,
  publicEntity,
  toPublicVisitorDto,
  canonicalPublicUrl,
  canonicalEntityUrl,
  publicBaseUrl,
  stagingCanonicalOrigin,
  productionCanonicalDomainConfigured,
  STAGING_CANONICAL_ORIGIN,
  ensurePeStore,
  ensureImageAssets,
  extractCloudflareImageId,
  assertOwnedMediaUrl,
  validatePublicLocation,
  validateContactPolicy,
  validatePublicationStatus,
  serializeProfessionalEntities,
  loadProfessionalEntities,
};
