/**
 * Evidence Engine (T5C) — Proof of Pickup / Delivery, OTP, signatures, photos.
 * Evidence belongs ONLY to Trip. References only — no binary blobs.
 * No Payments / Ratings / Disputes / AI.
 */
'use strict';

const crypto = require('crypto');

const EVIDENCE_STATUS = Object.freeze({
  pending: 'pending',
  pickup_verified: 'pickup_verified',
  delivery_verified: 'delivery_verified',
  completed: 'completed',
});

const TRANSITIONS = Object.freeze({
  [EVIDENCE_STATUS.pending]: [EVIDENCE_STATUS.pickup_verified],
  [EVIDENCE_STATUS.pickup_verified]: [EVIDENCE_STATUS.delivery_verified],
  [EVIDENCE_STATUS.delivery_verified]: [EVIDENCE_STATUS.completed],
  [EVIDENCE_STATUS.completed]: [],
});

const EVENT_TYPE = Object.freeze({
  EvidenceCreated: 'EvidenceCreated',
  PickupOTPGenerated: 'PickupOTPGenerated',
  PickupVerified: 'PickupVerified',
  DeliveryOTPGenerated: 'DeliveryOTPGenerated',
  DeliveryVerified: 'DeliveryVerified',
  PhotosUploaded: 'PhotosUploaded',
  AttachmentAdded: 'AttachmentAdded',
  SignatureCaptured: 'SignatureCaptured',
  EvidenceCompleted: 'EvidenceCompleted',
  EvidenceNoteAdded: 'EvidenceNoteAdded',
  AdminOverride: 'AdminOverride',
});

const OTP_KIND = Object.freeze({
  pickup: 'pickup',
  delivery: 'delivery',
});

const PHOTO_KIND = Object.freeze({
  pickup: 'pickup',
  delivery: 'delivery',
  damage: 'damage',
});

const OTP_TTL_MS = 15 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_LENGTH = 6;
const MAX_PHOTOS = 30;
const MAX_ATTACHMENTS = 20;

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function ensureStoreMaps(store) {
  if (!store.evidenceRecords) store.evidenceRecords = new Map();
  if (!store.evidenceEvents) store.evidenceEvents = [];
  if (!store.trips) store.trips = new Map();
}

function appendEvent(store, event) {
  ensureStoreMaps(store);
  const seq = (store._evidenceEventSeq || 0) + 1;
  store._evidenceEventSeq = seq;
  store.evidenceEvents.unshift({ ...event, seq });
  if (store.evidenceEvents.length > 8000) {
    store.evidenceEvents.length = 8000;
  }
}

function listTimeline(store, evidenceId) {
  ensureStoreMaps(store);
  return store.evidenceEvents
    .filter((e) => String(e.evidenceId) === String(evidenceId))
    .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
}

function findEvidenceByTripId(store, tripId) {
  ensureStoreMaps(store);
  for (const e of store.evidenceRecords.values()) {
    if (String(e.tripId) === String(tripId)) return e;
  }
  return null;
}

function hashOtp(code, salt) {
  return crypto
    .createHash('sha256')
    .update(`${salt}:${String(code).trim()}`)
    .digest('hex');
}

function generateOtpCode() {
  const n = crypto.randomInt(0, 10 ** OTP_LENGTH);
  return String(n).padStart(OTP_LENGTH, '0');
}

function emptySide() {
  return {
    otp: null,
    confirmed: false,
    confirmedAt: null,
    confirmedBy: null,
    signatureRef: null,
    signatureCapturedAt: null,
    signatureCapturedBy: null,
    photos: [],
    notes: [],
  };
}

/**
 * Create exactly one Evidence aggregate per Trip (idempotent).
 */
function createEvidenceForTrip({
  store,
  trip,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  if (!trip || !trip.id) {
    return { ok: false, status: 400, message: 'الرحلة مطلوبة' };
  }
  const existing = findEvidenceByTripId(store, trip.id);
  if (existing) {
    return { ok: true, reused: true, evidence: existing };
  }

  const evidenceId = idFn();
  const evidence = {
    id: evidenceId,
    tripId: String(trip.id),
    bookingId: trip.bookingId || null,
    customerId: String(trip.customerId || ''),
    providerId: String(trip.providerId || ''),
    status: EVIDENCE_STATUS.pending,
    pickup: emptySide(),
    delivery: emptySide(),
    attachments: [],
    operationalNotes: [],
    version: 1,
    createdAt: nowIso(nowMs),
    updatedAt: nowIso(nowMs),
    completedAt: null,
  };
  store.evidenceRecords.set(evidenceId, evidence);
  store.trips.set(trip.id, {
    ...trip,
    evidenceId,
    updatedAt: nowIso(nowMs),
  });

  appendEvent(store, {
    id: idFn(),
    type: EVENT_TYPE.EvidenceCreated,
    evidenceId,
    tripId: trip.id,
    actor: 'system',
    actorId: null,
    at: nowIso(nowMs),
    serverTime: true,
  });

  return { ok: true, reused: false, evidence };
}

function getSide(evidence, kind) {
  return kind === OTP_KIND.delivery ? evidence.delivery : evidence.pickup;
}

/**
 * Generate OTP for pickup or delivery. Returns plaintext once.
 */
function generateOtp({
  store,
  evidenceId,
  kind,
  actorUserId,
  actorRole,
  idFn,
  nowMs = Date.now(),
  ttlMs = OTP_TTL_MS,
}) {
  ensureStoreMaps(store);
  const evidence = store.evidenceRecords.get(String(evidenceId));
  if (!evidence) {
    return { ok: false, status: 404, message: 'سجل الأدلة غير موجود' };
  }
  if (evidence.status === EVIDENCE_STATUS.completed) {
    return { ok: false, status: 409, message: 'الأدلة مكتملة' };
  }

  const k = kind === OTP_KIND.delivery ? OTP_KIND.delivery : OTP_KIND.pickup;
  if (k === OTP_KIND.pickup && evidence.status !== EVIDENCE_STATUS.pending) {
    return {
      ok: false,
      status: 409,
      message: 'OTP الاستلام غير متاح في هذه الحالة',
    };
  }
  if (
    k === OTP_KIND.delivery &&
    evidence.status !== EVIDENCE_STATUS.pickup_verified
  ) {
    return {
      ok: false,
      status: 409,
      message: 'OTP التسليم يتطلب تحقق الاستلام أولاً',
    };
  }

  const side = getSide(evidence, k);
  if (side.confirmed) {
    return { ok: false, status: 409, message: 'تم التحقق مسبقاً' };
  }

  const code = generateOtpCode();
  const salt = crypto.randomBytes(16).toString('hex');
  const otp = {
    kind: k,
    hash: hashOtp(code, salt),
    salt,
    expiresAt: nowIso(nowMs + ttlMs),
    attempts: 0,
    maxAttempts: OTP_MAX_ATTEMPTS,
    used: false,
    generatedAt: nowIso(nowMs),
    generatedBy: actorUserId,
  };

  const updatedSide = { ...side, otp };
  const updated = {
    ...evidence,
    pickup: k === OTP_KIND.pickup ? updatedSide : evidence.pickup,
    delivery: k === OTP_KIND.delivery ? updatedSide : evidence.delivery,
    version: Number(evidence.version || 1) + 1,
    updatedAt: nowIso(nowMs),
  };
  store.evidenceRecords.set(evidence.id, updated);

  appendEvent(store, {
    id: idFn(),
    type:
      k === OTP_KIND.pickup
        ? EVENT_TYPE.PickupOTPGenerated
        : EVENT_TYPE.DeliveryOTPGenerated,
    evidenceId: evidence.id,
    tripId: evidence.tripId,
    actor: actorRole,
    actorId: actorUserId,
    kind: k,
    at: nowIso(nowMs),
    serverTime: true,
  });

  return {
    ok: true,
    evidence: updated,
    otp: {
      kind: k,
      code,
      expiresAt: otp.expiresAt,
      // plaintext returned once to caller (provider notifies customer out-of-band)
    },
  };
}

/**
 * Verify OTP (customer typically). Advances side + evidence status.
 */
function verifyOtp({
  store,
  evidenceId,
  kind,
  code,
  actorUserId,
  actorRole,
  idFn,
  nowMs = Date.now(),
  note,
}) {
  ensureStoreMaps(store);
  const evidence = store.evidenceRecords.get(String(evidenceId));
  if (!evidence) {
    return { ok: false, status: 404, message: 'سجل الأدلة غير موجود' };
  }

  const k = kind === OTP_KIND.delivery ? OTP_KIND.delivery : OTP_KIND.pickup;
  const side = getSide(evidence, k);
  if (side.confirmed) {
    return { ok: true, reused: true, evidence };
  }
  if (!side.otp || !side.otp.hash) {
    return { ok: false, status: 409, message: 'لا يوجد OTP نشط' };
  }
  if (side.otp.used) {
    return { ok: false, status: 409, message: 'تم استخدام OTP مسبقاً' };
  }
  const exp = Date.parse(side.otp.expiresAt);
  if (!Number.isFinite(exp) || exp <= nowMs) {
    return { ok: false, status: 410, message: 'انتهت صلاحية OTP', code: 'OTP_EXPIRED' };
  }
  if (Number(side.otp.attempts || 0) >= Number(side.otp.maxAttempts || OTP_MAX_ATTEMPTS)) {
    return {
      ok: false,
      status: 429,
      message: 'تجاوزت محاولات OTP',
      code: 'OTP_LOCKED',
    };
  }

  const candidate = hashOtp(code, side.otp.salt);
  if (candidate !== side.otp.hash) {
    const failedOtp = {
      ...side.otp,
      attempts: Number(side.otp.attempts || 0) + 1,
    };
    const failedSide = { ...side, otp: failedOtp };
    const failed = {
      ...evidence,
      pickup: k === OTP_KIND.pickup ? failedSide : evidence.pickup,
      delivery: k === OTP_KIND.delivery ? failedSide : evidence.delivery,
      updatedAt: nowIso(nowMs),
    };
    store.evidenceRecords.set(evidence.id, failed);
    return {
      ok: false,
      status: 401,
      message: 'رمز OTP غير صحيح',
      code: 'OTP_INVALID',
      attemptsRemaining:
        Number(failedOtp.maxAttempts) - Number(failedOtp.attempts),
    };
  }

  const verifiedSide = {
    ...side,
    confirmed: true,
    confirmedAt: nowIso(nowMs),
    confirmedBy: actorUserId,
    otp: { ...side.otp, used: true, attempts: Number(side.otp.attempts || 0) + 1 },
    notes: note
      ? [
          ...(side.notes || []),
          {
            at: nowIso(nowMs),
            by: actorUserId,
            text: String(note).trim().slice(0, 1000),
          },
        ]
      : side.notes || [],
  };

  let nextStatus = evidence.status;
  if (k === OTP_KIND.pickup && evidence.status === EVIDENCE_STATUS.pending) {
    nextStatus = EVIDENCE_STATUS.pickup_verified;
  } else if (
    k === OTP_KIND.delivery &&
    evidence.status === EVIDENCE_STATUS.pickup_verified
  ) {
    nextStatus = EVIDENCE_STATUS.delivery_verified;
  }

  const updated = {
    ...evidence,
    status: nextStatus,
    pickup: k === OTP_KIND.pickup ? verifiedSide : evidence.pickup,
    delivery: k === OTP_KIND.delivery ? verifiedSide : evidence.delivery,
    version: Number(evidence.version || 1) + 1,
    updatedAt: nowIso(nowMs),
  };
  store.evidenceRecords.set(evidence.id, updated);

  appendEvent(store, {
    id: idFn(),
    type:
      k === OTP_KIND.pickup
        ? EVENT_TYPE.PickupVerified
        : EVENT_TYPE.DeliveryVerified,
    evidenceId: evidence.id,
    tripId: evidence.tripId,
    actor: actorRole,
    actorId: actorUserId,
    kind: k,
    at: nowIso(nowMs),
    serverTime: true,
  });

  return { ok: true, reused: false, evidence: updated };
}

function validateStorageRef(ref) {
  const s = String(ref || '').trim();
  if (!s || s.length > 2000) return null;
  if (s.startsWith('data:')) return null; // no embedded binaries
  return s;
}

function addPhoto({
  store,
  evidenceId,
  kind,
  storageRef,
  mimeType,
  actorUserId,
  actorRole,
  idFn,
  nowMs = Date.now(),
  caption,
}) {
  ensureStoreMaps(store);
  const evidence = store.evidenceRecords.get(String(evidenceId));
  if (!evidence) {
    return { ok: false, status: 404, message: 'سجل الأدلة غير موجود' };
  }
  if (evidence.status === EVIDENCE_STATUS.completed) {
    return { ok: false, status: 409, message: 'الأدلة مكتملة' };
  }
  const ref = validateStorageRef(storageRef);
  if (!ref) {
    return {
      ok: false,
      status: 400,
      message: 'مرجع الملف مطلوب (بدون بيانات ثنائية)',
    };
  }

  const photoKind = Object.values(PHOTO_KIND).includes(kind)
    ? kind
    : PHOTO_KIND.delivery;
  // damage photos attach to delivery side by default
  const sideKey = photoKind === PHOTO_KIND.pickup ? 'pickup' : 'delivery';
  const side = evidence[sideKey];
  const allPhotos =
    (evidence.pickup.photos || []).length +
    (evidence.delivery.photos || []).length;
  if (allPhotos >= MAX_PHOTOS) {
    return { ok: false, status: 409, message: 'تجاوز حد الصور' };
  }

  const photo = {
    id: idFn(),
    kind: photoKind,
    storageRef: ref,
    mimeType: mimeType ? String(mimeType).slice(0, 100) : 'image/jpeg',
    caption: caption != null ? String(caption).trim().slice(0, 500) : null,
    uploadedBy: actorUserId,
    uploadedAt: nowIso(nowMs),
  };
  const updatedSide = {
    ...side,
    photos: [...(side.photos || []), photo],
  };
  const updated = {
    ...evidence,
    pickup: sideKey === 'pickup' ? updatedSide : evidence.pickup,
    delivery: sideKey === 'delivery' ? updatedSide : evidence.delivery,
    version: Number(evidence.version || 1) + 1,
    updatedAt: nowIso(nowMs),
  };
  store.evidenceRecords.set(evidence.id, updated);

  appendEvent(store, {
    id: idFn(),
    type: EVENT_TYPE.PhotosUploaded,
    evidenceId: evidence.id,
    tripId: evidence.tripId,
    actor: actorRole,
    actorId: actorUserId,
    photoId: photo.id,
    kind: photoKind,
    at: nowIso(nowMs),
    serverTime: true,
  });

  return { ok: true, evidence: updated, photo };
}

function addAttachment({
  store,
  evidenceId,
  storageRef,
  mimeType,
  fileName,
  actorUserId,
  actorRole,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  const evidence = store.evidenceRecords.get(String(evidenceId));
  if (!evidence) {
    return { ok: false, status: 404, message: 'سجل الأدلة غير موجود' };
  }
  if (evidence.status === EVIDENCE_STATUS.completed) {
    return { ok: false, status: 409, message: 'الأدلة مكتملة' };
  }
  const ref = validateStorageRef(storageRef);
  if (!ref) {
    return { ok: false, status: 400, message: 'مرجع المرفق مطلوب' };
  }
  if ((evidence.attachments || []).length >= MAX_ATTACHMENTS) {
    return { ok: false, status: 409, message: 'تجاوز حد المرفقات' };
  }

  const attachment = {
    id: idFn(),
    storageRef: ref,
    mimeType: mimeType ? String(mimeType).slice(0, 100) : 'application/octet-stream',
    fileName: fileName ? String(fileName).slice(0, 255) : null,
    uploadedBy: actorUserId,
    uploadedAt: nowIso(nowMs),
  };
  const updated = {
    ...evidence,
    attachments: [...(evidence.attachments || []), attachment],
    version: Number(evidence.version || 1) + 1,
    updatedAt: nowIso(nowMs),
  };
  store.evidenceRecords.set(evidence.id, updated);

  appendEvent(store, {
    id: idFn(),
    type: EVENT_TYPE.AttachmentAdded,
    evidenceId: evidence.id,
    tripId: evidence.tripId,
    actor: actorRole,
    actorId: actorUserId,
    attachmentId: attachment.id,
    at: nowIso(nowMs),
    serverTime: true,
  });

  return { ok: true, evidence: updated, attachment };
}

function captureSignature({
  store,
  evidenceId,
  kind,
  storageRef,
  actorUserId,
  actorRole,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  const evidence = store.evidenceRecords.get(String(evidenceId));
  if (!evidence) {
    return { ok: false, status: 404, message: 'سجل الأدلة غير موجود' };
  }
  if (evidence.status === EVIDENCE_STATUS.completed) {
    return { ok: false, status: 409, message: 'الأدلة مكتملة' };
  }
  const ref = validateStorageRef(storageRef);
  if (!ref) {
    return { ok: false, status: 400, message: 'مرجع التوقيع مطلوب' };
  }

  const k = kind === OTP_KIND.delivery ? OTP_KIND.delivery : OTP_KIND.pickup;
  const side = getSide(evidence, k);
  const updatedSide = {
    ...side,
    signatureRef: ref,
    signatureCapturedAt: nowIso(nowMs),
    signatureCapturedBy: actorUserId,
  };
  const updated = {
    ...evidence,
    pickup: k === OTP_KIND.pickup ? updatedSide : evidence.pickup,
    delivery: k === OTP_KIND.delivery ? updatedSide : evidence.delivery,
    version: Number(evidence.version || 1) + 1,
    updatedAt: nowIso(nowMs),
  };
  store.evidenceRecords.set(evidence.id, updated);

  appendEvent(store, {
    id: idFn(),
    type: EVENT_TYPE.SignatureCaptured,
    evidenceId: evidence.id,
    tripId: evidence.tripId,
    actor: actorRole,
    actorId: actorUserId,
    kind: k,
    at: nowIso(nowMs),
    serverTime: true,
  });

  return { ok: true, evidence: updated };
}

/**
 * Complete evidence after delivery verified.
 */
function completeEvidence({
  store,
  evidenceId,
  actorUserId,
  actorRole,
  idFn,
  nowMs = Date.now(),
  note,
  adminOverride = false,
  auditFn,
}) {
  ensureStoreMaps(store);
  const evidence = store.evidenceRecords.get(String(evidenceId));
  if (!evidence) {
    return { ok: false, status: 404, message: 'سجل الأدلة غير موجود' };
  }
  if (evidence.status === EVIDENCE_STATUS.completed) {
    return { ok: true, reused: true, evidence };
  }

  if (!adminOverride) {
    if (evidence.status !== EVIDENCE_STATUS.delivery_verified) {
      return {
        ok: false,
        status: 409,
        message: 'أكمل تحقق التسليم قبل إغلاق الأدلة',
        from: evidence.status,
        allowed: TRANSITIONS[evidence.status] || [],
      };
    }
    if (!(TRANSITIONS[evidence.status] || []).includes(EVIDENCE_STATUS.completed)) {
      return { ok: false, status: 409, message: 'انتقال غير قانوني' };
    }
  } else {
    if (!note || !String(note).trim()) {
      return {
        ok: false,
        status: 400,
        message: 'ملاحظة التدقيق مطلوبة للتجاوز',
      };
    }
  }

  const updated = {
    ...evidence,
    status: EVIDENCE_STATUS.completed,
    completedAt: nowIso(nowMs),
    version: Number(evidence.version || 1) + 1,
    updatedAt: nowIso(nowMs),
    operationalNotes: note
      ? [
          ...(evidence.operationalNotes || []),
          {
            at: nowIso(nowMs),
            by: actorUserId,
            role: actorRole,
            text: String(note).trim().slice(0, 1000),
            override: !!adminOverride,
          },
        ]
      : evidence.operationalNotes || [],
  };
  store.evidenceRecords.set(evidence.id, updated);

  appendEvent(store, {
    id: idFn(),
    type: adminOverride
      ? EVENT_TYPE.AdminOverride
      : EVENT_TYPE.EvidenceCompleted,
    evidenceId: evidence.id,
    tripId: evidence.tripId,
    actor: actorRole,
    actorId: actorUserId,
    fromStatus: evidence.status,
    toStatus: EVIDENCE_STATUS.completed,
    note: note ? String(note).trim().slice(0, 1000) : null,
    override: !!adminOverride,
    at: nowIso(nowMs),
    serverTime: true,
  });

  if (adminOverride && typeof auditFn === 'function') {
    auditFn({
      action: 'evidence.admin_override',
      entityType: 'evidence',
      entityId: evidence.id,
      note: String(note).trim(),
      meta: { from: evidence.status, to: EVIDENCE_STATUS.completed },
    });
  }

  return { ok: true, reused: false, evidence: updated };
}

function sanitizeEvidenceForViewer(evidence, { revealOtpMeta = false } = {}) {
  if (!evidence) return null;
  const scrubSide = (side) => {
    if (!side) return side;
    const otp = side.otp
      ? {
          kind: side.otp.kind,
          expiresAt: side.otp.expiresAt,
          used: !!side.otp.used,
          attempts: side.otp.attempts,
          maxAttempts: side.otp.maxAttempts,
          generatedAt: side.otp.generatedAt,
          // never expose hash/salt/code
        }
      : null;
    return {
      confirmed: side.confirmed,
      confirmedAt: side.confirmedAt,
      confirmedBy: side.confirmedBy,
      signatureRef: side.signatureRef,
      signatureCapturedAt: side.signatureCapturedAt,
      photos: side.photos || [],
      notes: side.notes || [],
      otp: revealOtpMeta ? otp : otp
        ? {
            kind: otp.kind,
            expiresAt: otp.expiresAt,
            used: otp.used,
            hasActive: !otp.used && !!side.otp,
          }
        : null,
    };
  };
  return {
    id: evidence.id,
    tripId: evidence.tripId,
    bookingId: evidence.bookingId,
    customerId: evidence.customerId,
    providerId: evidence.providerId,
    status: evidence.status,
    pickup: scrubSide(evidence.pickup),
    delivery: scrubSide(evidence.delivery),
    attachments: evidence.attachments || [],
    operationalNotes: evidence.operationalNotes || [],
    version: evidence.version,
    createdAt: evidence.createdAt,
    updatedAt: evidence.updatedAt,
    completedAt: evidence.completedAt,
  };
}

function getEvidenceView(store, evidenceId) {
  ensureStoreMaps(store);
  const evidence = store.evidenceRecords.get(String(evidenceId));
  if (!evidence) return null;
  return {
    evidence: sanitizeEvidenceForViewer(evidence, { revealOtpMeta: true }),
    timeline: listTimeline(store, evidence.id),
    statusOrder: Object.values(EVIDENCE_STATUS),
  };
}

function assertEvidenceRole(evidence, userId) {
  if (!evidence) return null;
  if (String(evidence.customerId) === String(userId)) return 'customer';
  if (String(evidence.providerId) === String(userId)) return 'provider';
  return null;
}

function isLegalTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = {
  EVIDENCE_STATUS,
  TRANSITIONS,
  EVENT_TYPE,
  OTP_KIND,
  PHOTO_KIND,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  ensureStoreMaps,
  createEvidenceForTrip,
  findEvidenceByTripId,
  generateOtp,
  verifyOtp,
  addPhoto,
  addAttachment,
  captureSignature,
  completeEvidence,
  getEvidenceView,
  listTimeline,
  sanitizeEvidenceForViewer,
  assertEvidenceRole,
  isLegalTransition,
  hashOtp,
  generateOtpCode,
};
