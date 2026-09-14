/// Sanitize / validate additive `detailMedia` for listings (horses, catalog, services).
/// Backward compatible: missing/empty detailMedia is allowed.
'use strict';

const ALLOWED_TYPES = new Set(['image', 'video']);
const ALLOWED_ROLES = new Set([
  'SPOTLIGHT_PRIMARY',
  'DETAIL_IMAGE',
  'DETAIL_VIDEO',
]);

function isHttpsUrl(s) {
  try {
    const u = new URL(String(s));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * @param {unknown} raw
 * @param {{ maxItems?: number }} [opts]
 * @returns {{ ok: true, detailMedia: object[], images: string[], videoId: string, videoUrl: string }
 *   | { ok: false, message: string }}
 */
function sanitizeDetailMedia(raw, opts = {}) {
  const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : 15;
  if (raw == null) {
    return { ok: true, detailMedia: null, images: null, videoId: null, videoUrl: null };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'detailMedia يجب أن يكون مصفوفة' };
  }
  if (raw.length > maxItems) {
    return {
      ok: false,
      message: `detailMedia يتجاوز الحد الأقصى (${maxItems})`,
    };
  }

  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!e || typeof e !== 'object') {
      return { ok: false, message: `detailMedia[${i}] غير صالح` };
    }
    const url = String(e.url || '').trim();
    if (!url || !isHttpsUrl(url)) {
      return { ok: false, message: `detailMedia[${i}].url غير صالح` };
    }
    let type = String(e.type || '').trim().toLowerCase();
    let role = String(e.role || '').trim().toUpperCase();
    if (!type && role === 'DETAIL_VIDEO') type = 'video';
    if (!type && role === 'DETAIL_IMAGE') type = 'image';
    if (!type) type = 'image';
    if (!ALLOWED_TYPES.has(type)) {
      return { ok: false, message: `detailMedia[${i}].type غير مدعوم` };
    }
    if (!role) {
      role = type === 'video' ? 'DETAIL_VIDEO' : 'DETAIL_IMAGE';
    }
    if (!ALLOWED_ROLES.has(role)) {
      return { ok: false, message: `detailMedia[${i}].role غير مدعوم` };
    }
    if (role === 'SPOTLIGHT_PRIMARY') {
      // Accepted on wire but excluded from Details gallery clientside; store as-is.
    }
    if (type === 'video' && role === 'DETAIL_IMAGE') {
      return { ok: false, message: `detailMedia[${i}] role/type غير متوافقين` };
    }
    if (type === 'image' && role === 'DETAIL_VIDEO') {
      return { ok: false, message: `detailMedia[${i}] role/type غير متوافقين` };
    }

    const id = String(e.id || '').trim() || url;
    const order = Number.isFinite(Number(e.order)) ? Number(e.order) : i;
    const item = {
      id,
      url,
      type,
      role,
      order,
    };
    if (e.thumbnail != null && String(e.thumbnail).trim()) {
      const th = String(e.thumbnail).trim();
      if (!isHttpsUrl(th)) {
        return { ok: false, message: `detailMedia[${i}].thumbnail غير صالح` };
      }
      item.thumbnail = th;
    }
    if (e.aspectRatio != null && e.aspectRatio !== '') {
      const ar = Number(e.aspectRatio);
      if (!Number.isFinite(ar) || ar <= 0) {
        return { ok: false, message: `detailMedia[${i}].aspectRatio غير صالح` };
      }
      item.aspectRatio = ar;
    }
    out.push(item);
  }

  out.sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
  out.forEach((it, idx) => {
    it.order = idx;
  });

  const images = [];
  let videoId = '';
  let videoUrl = '';
  for (const it of out) {
    if (it.role === 'SPOTLIGHT_PRIMARY') continue;
    if (it.type === 'image') images.push(it.url);
    else if (it.type === 'video' && !videoUrl) {
      videoId = it.id;
      videoUrl = it.url;
    }
  }

  return {
    ok: true,
    detailMedia: out,
    images,
    videoId,
    videoUrl,
  };
}

/**
 * Apply sanitized detailMedia onto a listing body (additive).
 * Does not wipe legacy fields when detailMedia absent.
 */
function applyDetailMediaToBody(body, opts = {}) {
  if (!body || typeof body !== 'object') return { ok: true, body };
  if (!Object.prototype.hasOwnProperty.call(body, 'detailMedia')) {
    return { ok: true, body };
  }
  const result = sanitizeDetailMedia(body.detailMedia, opts);
  if (!result.ok) return result;
  if (result.detailMedia == null) {
    const next = { ...body };
    delete next.detailMedia;
    return { ok: true, body: next };
  }
  const next = {
    ...body,
    detailMedia: result.detailMedia,
    images: result.images,
    videoId: result.videoId || body.videoId || '',
    videoUrl: result.videoUrl || body.videoUrl || '',
  };
  return { ok: true, body: next };
}

module.exports = {
  sanitizeDetailMedia,
  applyDetailMediaToBody,
  ALLOWED_TYPES,
  ALLOWED_ROLES,
};
