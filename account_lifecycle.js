/**
 * حذف حساب المستخدم — Apple Guideline 5.1.1(v)
 *
 * يحذف هوية المستخدم ومحتواه المملوك، ويُجهّل السجلات التشغيلية
 * التي قد تُحتفظ بها لأسباب قانونية/محاسبية قصيرة الأمد.
 */

function anonymizedId(userId) {
  return `deleted_${String(userId).slice(0, 8)}`;
}

function scrubAddressFields(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const low = k.toLowerCase();
    if (
      low.includes('address') ||
      low.includes('phone') ||
      low.includes('name') ||
      low.includes('email') ||
      low.includes('lat') ||
      low.includes('lng') ||
      low.includes('coord')
    ) {
      if (typeof obj[k] === 'string') obj[k] = '[redacted]';
      else if (typeof obj[k] === 'number') obj[k] = 0;
    }
  }
}

function revokeUserTokens(store, userId) {
  const uid = String(userId);
  for (const [tok, entry] of store.accessTokens.entries()) {
    if (entry && String(entry.userId) === uid) store.accessTokens.delete(tok);
  }
  for (const [rt, entry] of store.refreshTokens.entries()) {
    if (entry && String(entry.userId) === uid) store.refreshTokens.delete(rt);
  }
}

function anonymizeParty(rec, uid, fields) {
  if (!rec || typeof rec !== 'object') return false;
  let touched = false;
  const anon = anonymizedId(uid);
  for (const f of fields) {
    if (String(rec[f] || '') === uid) {
      rec[f] = anon;
      touched = true;
    }
  }
  if (touched) scrubAddressFields(rec);
  return touched;
}

function deleteUserAccount(store, userId, extras = {}) {
  const uid = String(userId);
  if (!store.users.has(uid)) return { ok: false, message: 'المستخدم غير موجود' };

  const retained = [];

  for (const [hid, h] of store.horses.entries()) {
    if (String(h.userId || h.ownerId || h.sellerId || '') === uid) {
      store.horses.delete(hid);
    }
  }

  for (const [vid, v] of store.videos.entries()) {
    if (String(v.userId || v.ownerId || '') === uid) {
      store.videos.delete(vid);
      if (store.videoComments && store.videoComments[vid]) delete store.videoComments[vid];
    } else {
      if (Array.isArray(v.likedBy)) {
        v.likedBy = v.likedBy.filter((id) => String(id) !== uid);
      }
      if (Array.isArray(v.favoritedBy)) {
        v.favoritedBy = v.favoritedBy.filter((id) => String(id) !== uid);
      }
    }
  }

  if (store.videoComments && typeof store.videoComments === 'object') {
    for (const vid of Object.keys(store.videoComments)) {
      const list = store.videoComments[vid];
      if (!Array.isArray(list)) continue;
      store.videoComments[vid] = list.filter((c) => String(c.userId || '') !== uid);
    }
  }

  for (const [sid, s] of store.services.entries()) {
    if (String(s.userId || s.providerId || s.ownerId || '') === uid) {
      store.services.delete(sid);
    }
  }

  if (store.servicePlaces instanceof Map) {
    for (const [pid, p] of store.servicePlaces.entries()) {
      if (String(p.providerId || p.userId || '') === uid) {
        store.servicePlaces.delete(pid);
      }
    }
  }

  for (const [cid, c] of store.catalogItems.entries()) {
    if (String(c.sellerId || c.userId || '') === uid) {
      store.catalogItems.delete(cid);
    } else if (c.stockHolds && typeof c.stockHolds === 'object' && c.stockHolds[uid]) {
      delete c.stockHolds[uid];
    }
  }

  store.favorites.delete(uid);
  store.carts.delete(uid);

  if (store.bookings instanceof Map) {
    for (const [bid, b] of store.bookings.entries()) {
      if (anonymizeParty(b, uid, ['userId', 'providerId', 'customerId'])) {
        retained.push(`booking:${bid}`);
      }
    }
  }

  if (store.orders instanceof Map) {
    for (const [oid, o] of store.orders.entries()) {
      if (anonymizeParty(o, uid, ['userId', 'buyerId', 'sellerId', 'customerId'])) {
        o.customerName = '[redacted]';
        o.customerPhone = '[redacted]';
        if (o.shippingAddress) o.shippingAddress = '[redacted]';
        retained.push(`order:${oid}`);
      }
    }
  }

  if (store.transportRequests instanceof Map) {
    for (const [tid, t] of store.transportRequests.entries()) {
      if (anonymizeParty(t, uid, ['customerId', 'providerId', 'userId'])) {
        retained.push(`transportRequest:${tid}`);
      }
    }
  }

  if (store.negotiations instanceof Map) {
    for (const [nid, n] of store.negotiations.entries()) {
      anonymizeParty(n, uid, ['customerId', 'providerId']);
    }
  }

  if (store.offers instanceof Map) {
    for (const [oid, o] of store.offers.entries()) {
      anonymizeParty(o, uid, ['customerId', 'providerId', 'actorId']);
    }
  }

  if (Array.isArray(store.negotiationEvents)) {
    for (const ev of store.negotiationEvents) {
      anonymizeParty(ev, uid, ['actorId', 'customerId', 'providerId']);
    }
  }

  if (store.trips instanceof Map) {
    for (const [tid, t] of store.trips.entries()) {
      if (anonymizeParty(t, uid, ['customerId', 'providerId'])) {
        retained.push(`trip:${tid}`);
      }
    }
  }

  if (Array.isArray(store.tripEvents)) {
    for (const ev of store.tripEvents) anonymizeParty(ev, uid, ['actorId']);
  }

  if (store.drivers instanceof Map) {
    for (const [did, d] of store.drivers.entries()) {
      if (String(d.providerId || '') === uid) store.drivers.delete(did);
    }
  }

  if (store.vehicles instanceof Map) {
    for (const [vid, v] of store.vehicles.entries()) {
      if (String(v.providerId || '') === uid) store.vehicles.delete(vid);
    }
  }

  if (store.trackingSessions instanceof Map) {
    for (const [sid, s] of store.trackingSessions.entries()) {
      anonymizeParty(s, uid, ['customerId', 'providerId', 'driverId']);
    }
  }

  if (Array.isArray(store.trackingHistory)) {
    store.trackingHistory = store.trackingHistory.filter(
      (h) =>
        String(h.customerId || '') !== uid &&
        String(h.providerId || '') !== uid,
    );
  }

  if (Array.isArray(store.trackingEvents)) {
    for (const ev of store.trackingEvents) anonymizeParty(ev, uid, ['actorId', 'customerId', 'providerId']);
  }

  if (store.evidenceRecords instanceof Map) {
    for (const [eid, e] of store.evidenceRecords.entries()) {
      if (anonymizeParty(e, uid, ['customerId', 'providerId', 'signatureCapturedBy'])) {
        retained.push(`evidence:${eid}`);
      }
    }
  }

  if (Array.isArray(store.evidenceEvents)) {
    for (const ev of store.evidenceEvents) anonymizeParty(ev, uid, ['actorId']);
  }

  if (store.experts instanceof Map) {
    for (const [eid, e] of store.experts.entries()) {
      if (String(e.userId || '') === uid) store.experts.delete(eid);
    }
  }

  if (store.expertRequests instanceof Map) {
    for (const [rid, r] of store.expertRequests.entries()) {
      if (String(r.fromUserId || '') === uid || String(r.expertUserId || '') === uid) {
        store.expertRequests.delete(rid);
      }
    }
  }

  if (store.expertRatings instanceof Map) {
    for (const [rid, r] of store.expertRatings.entries()) {
      if (String(r.fromUserId || '') === uid || String(r.expertUserId || '') === uid) {
        store.expertRatings.delete(rid);
      }
    }
  }

  if (store.contactLeads instanceof Map) {
    for (const [lid, l] of store.contactLeads.entries()) {
      if (String(l.userId || '') === uid || String(l.sellerId || '') === uid) {
        store.contactLeads.delete(lid);
      }
    }
  }

  if (store.idempotencyKeys instanceof Map) {
    for (const key of [...store.idempotencyKeys.keys()]) {
      if (String(key).startsWith(`${uid}::`) || String(store.idempotencyKeys.get(key)?.userId) === uid) {
        store.idempotencyKeys.delete(key);
      }
    }
  }

  if (Array.isArray(store.auditEvents)) {
    for (const ev of store.auditEvents) {
      if (String(ev.actorUserId || '') === uid) ev.actorUserId = anonymizedId(uid);
    }
  }

  if (Array.isArray(store.messages)) {
    store.messages = store.messages.filter(
      (m) =>
        String(m.fromUserId || '') !== uid && String(m.toUserId || '') !== uid,
    );
  }

  if (Array.isArray(store.contentReports)) {
    store.contentReports = store.contentReports.filter(
      (r) => String(r.reporterId || '') !== uid && String(r.targetOwnerId || '') !== uid,
    );
  }

  if (extras.otpCodes instanceof Map) {
    const user = store.users.get(uid);
    const phone = user && user.phone ? String(user.phone) : '';
    if (phone) extras.otpCodes.delete(phone);
  }
  if (extras.setupTokens instanceof Map) {
    for (const [tok, entry] of [...extras.setupTokens.entries()]) {
      if (entry && String(entry.phone || '') === String(store.users.get(uid)?.phone || '')) {
        extras.setupTokens.delete(tok);
      }
    }
  }

  revokeUserTokens(store, uid);
  store.users.delete(uid);

  return {
    ok: true,
    retainedAnonymized: retained,
    retentionNote:
      'Transactional records (orders/bookings/trips/evidence) anonymized for short-term ops/legal trail; PII scrubbed.',
  };
}

function registerAccountLifecycleRoutes(app, ctx) {
  const { store, saveStore, auth, requireSessionUser, otpCodes, setupTokens } = ctx;

  app.delete('/users/me', auth, requireSessionUser, (req, res) => {
    const confirm = String(req.body?.confirm || req.query?.confirm || '').trim();
    if (confirm !== 'DELETE' && confirm !== 'حذف') {
      return res.status(400).json({
        message: 'أرسل confirm: "DELETE" أو "حذف" لتأكيد حذف الحساب نهائياً',
      });
    }
    const result = deleteUserAccount(store, req.authUserId, { otpCodes, setupTokens });
    if (!result.ok) return res.status(404).json({ message: result.message });
    saveStore();
    res.json({
      ok: true,
      message: 'تم حذف حسابك وبياناتك الشخصية المرتبطة',
      retentionNote: result.retentionNote,
    });
  });
}

module.exports = {
  deleteUserAccount,
  revokeUserTokens,
  registerAccountLifecycleRoutes,
};
