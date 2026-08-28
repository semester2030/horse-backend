'use strict';

/**
 * Owner-editable /videos field contract (STAGE 2).
 * Media UID/HLS switch is STAGE 3 via dedicated replace-media only.
 */

const OWNERSHIP_FIELD_KEYS = Object.freeze([
  'userId',
  'ownerId',
  'sellerId',
  'providerId',
]);

/** Never mutable via ordinary owner PATCH. */
const IMMUTABLE_PATCH_KEYS = Object.freeze([
  ...OWNERSHIP_FIELD_KEYS,
  'id',
  'createdAt',
  'likes',
  'likedBy',
  'favorites',
  'favoritedBy',
  'views',
  'comments',
  'badges',
  'cloudflareVideoId',
  'hlsUrl',
  'playback',
  'playbackUrl',
  'dashUrl',
  'streamUid',
  'previousCloudflareVideoId',
  'pendingCleanupCloudflareVideoId',
  'pendingCleanupCloudflareVideoIds',
  'mediaCleanupAllowCurrentUid',
  'mediaReplacedAt',
]);

/** Allowlisted business fields for owner PATCH. */
const EDITABLE_PATCH_KEYS = Object.freeze([
  'title',
  'description',
  'price',
  'type',
  'species',
  'breed',
  'coatColor',
  'camelColor',
  'camelAgeGrade',
  'herdCount',
  'age',
  'ageMonths',
  'gender',
  'city',
  'location',
  'address',
  'sheepSubCategory',
  'purpose',
  'saleMode',
  'pricingBasis',
  'pricedUnitCount',
  'tags',
  'thumbnailUrl',
  'hidden',
  'status',
  'updatedAt',
]);

function videoOwnerId(video) {
  if (!video || typeof video !== 'object') return '';
  return String(video.userId || '').trim();
}

function isVideoOwner(sessionUserId, video) {
  const session = String(sessionUserId || '').trim();
  const owner = videoOwnerId(video);
  return Boolean(session && owner && session === owner);
}

function assertVideoOwner(sessionUserId, video) {
  const session = String(sessionUserId || '').trim();
  if (!session) {
    return {
      ok: false,
      status: 401,
      message: 'المصادقة مطلوبة',
      code: 'VIDEO_AUTH_REQUIRED',
    };
  }
  const owner = videoOwnerId(video);
  if (!owner) {
    return {
      ok: false,
      status: 403,
      message: 'غير مصرح بتعديل هذا الفيديو — سجل الملكية غير مكتمل',
      code: 'VIDEO_OWNERSHIP_MISSING',
    };
  }
  if (session !== owner) {
    return {
      ok: false,
      status: 403,
      message: 'غير مصرح بتعديل هذا الفيديو',
      code: 'VIDEO_FORBIDDEN',
    };
  }
  return { ok: true };
}

function stripClientOwnershipFields(body) {
  if (!body || typeof body !== 'object') return {};
  const out = { ...body };
  for (const key of OWNERSHIP_FIELD_KEYS) {
    delete out[key];
  }
  return out;
}

function resolveCreateVideoUserId(sessionUserId, _body) {
  return String(sessionUserId || '').trim();
}

/**
 * Pick only allowlisted editable keys; drop immutable/media keys.
 * @returns {{ ok: true, patch: object } | { ok: false, status: number, message: string, code: string }}
 */
function pickOwnerEditablePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      message: 'جسم التعديل غير صالح',
      code: 'VIDEO_PATCH_INVALID',
    };
  }
  const patch = {};
  for (const key of Object.keys(body)) {
    if (IMMUTABLE_PATCH_KEYS.includes(key)) {
      continue;
    }
    if (!EDITABLE_PATCH_KEYS.includes(key)) {
      continue;
    }
    patch[key] = body[key];
  }
  return { ok: true, patch };
}

function validatePrice(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return 'السعر غير صالح';
  }
  if (n > 1e12) {
    return 'السعر أكبر من الحد المسموح';
  }
  return null;
}

/**
 * Soft-delete marker used by owner DELETE.
 */
function applySoftDelete(existing) {
  const cleanup = require('./video_media_cleanup');
  return cleanup.applySoftDeleteWithCleanup(existing);
}

function applyUnpublish(existing) {
  return {
    ...existing,
    hidden: true,
    updatedAt: new Date().toISOString(),
  };
}

function applyRepublish(existing) {
  if (String(existing.status || '') === 'removed') {
    return {
      ok: false,
      status: 400,
      message: 'لا يمكن إعادة نشر إعلان محذوف',
      code: 'VIDEO_REPUBLISH_DELETED',
    };
  }
  return {
    ok: true,
    video: {
      ...existing,
      hidden: false,
      status: existing.status === 'removed' ? 'active' : existing.status || 'active',
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Viewer list filter: public sees non-hidden non-removed;
 * owner still sees own hidden (for republish) but not soft-deleted.
 */
function includeVideoForViewer(video, viewerUserId) {
  const status = String(video.status || '');
  const isRemoved = status === 'removed';
  const ownerId = videoOwnerId(video);
  const isOwn =
    viewerUserId && ownerId && String(viewerUserId) === String(ownerId);

  if (isRemoved) return false;
  if (isOwn) return true;
  if (video.hidden === true) return false;
  return true;
}

function httpsPlaybackUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (!/^https:\/\//i.test(s)) return '';
  return s;
}

/**
 * Validate replace-media body before switch.
 * @returns {{ ok: true, media: object } | { ok: false, status: number, message: string, code: string }}
 */
function validateReplaceMediaPayload(body, streamDetails) {
  const uid = String(
    body?.cloudflareVideoId || body?.uid || streamDetails?.uid || '',
  ).trim();
  if (!uid) {
    return {
      ok: false,
      status: 400,
      message: 'معرّف الفيديو الجديد مطلوب',
      code: 'VIDEO_REPLACE_UID_REQUIRED',
    };
  }
  const hlsFromBody = httpsPlaybackUrl(body?.hlsUrl);
  const hlsFromStream = httpsPlaybackUrl(
    streamDetails?.playback?.hls || streamDetails?.playback?.hlsUrl,
  );
  const hlsUrl = hlsFromBody || hlsFromStream;
  if (!hlsUrl) {
    return {
      ok: false,
      status: 400,
      message: 'الفيديو الجديد غير جاهز للتشغيل (HLS مفقود)',
      code: 'VIDEO_REPLACE_NOT_READY',
    };
  }
  const thumbnailUrl =
    String(body?.thumbnailUrl || '').trim() ||
    String(streamDetails?.thumbnail || streamDetails?.preview || '').trim() ||
    null;
  return {
    ok: true,
    media: {
      cloudflareVideoId: uid,
      hlsUrl,
      thumbnailUrl,
    },
  };
}

function applyMediaSwitch(existing, media) {
  const cleanup = require('./video_media_cleanup');
  return cleanup.applyMediaSwitchWithCleanupQueue(existing, media);
}

module.exports = {
  OWNERSHIP_FIELD_KEYS,
  IMMUTABLE_PATCH_KEYS,
  EDITABLE_PATCH_KEYS,
  videoOwnerId,
  isVideoOwner,
  assertVideoOwner,
  stripClientOwnershipFields,
  resolveCreateVideoUserId,
  pickOwnerEditablePatch,
  validatePrice,
  applySoftDelete,
  applyUnpublish,
  applyRepublish,
  includeVideoForViewer,
  httpsPlaybackUrl,
  validateReplaceMediaPayload,
  applyMediaSwitch,
};
