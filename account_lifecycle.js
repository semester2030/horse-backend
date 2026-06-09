/**
 * حذف حساب المستخدم — Apple Guideline 5.1.1(v)
 */

function revokeUserTokens(store, userId) {
  const uid = String(userId);
  for (const [tok, entry] of store.accessTokens.entries()) {
    if (entry && String(entry.userId) === uid) store.accessTokens.delete(tok);
  }
  for (const [rt, entry] of store.refreshTokens.entries()) {
    if (entry && String(entry.userId) === uid) store.refreshTokens.delete(rt);
  }
}

function deleteUserAccount(store, userId) {
  const uid = String(userId);
  if (!store.users.has(uid)) return { ok: false, message: 'المستخدم غير موجود' };

  for (const [hid, h] of store.horses.entries()) {
    if (String(h.userId || h.ownerId || h.sellerId || '') === uid) {
      store.horses.delete(hid);
    }
  }

  for (const [vid, v] of store.videos.entries()) {
    if (String(v.userId || v.ownerId || '') === uid) {
      store.videos.delete(vid);
      if (store.videoComments[vid]) delete store.videoComments[vid];
    }
  }

  for (const [sid, s] of store.services.entries()) {
    if (String(s.userId || s.providerId || s.ownerId || '') === uid) {
      store.services.delete(sid);
    }
  }

  for (const [cid, c] of store.catalogItems.entries()) {
    if (String(c.sellerId || c.userId || '') === uid) {
      store.catalogItems.delete(cid);
    }
  }

  store.favorites.delete(uid);
  store.carts.delete(uid);

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

  revokeUserTokens(store, uid);
  store.users.delete(uid);
  return { ok: true };
}

function registerAccountLifecycleRoutes(app, ctx) {
  const { store, saveStore, auth, requireSessionUser } = ctx;

  app.delete('/users/me', auth, requireSessionUser, (req, res) => {
    const confirm = String(req.body?.confirm || req.query?.confirm || '').trim();
    if (confirm !== 'DELETE' && confirm !== 'حذف') {
      return res.status(400).json({
        message: 'أرسل confirm: "DELETE" أو "حذف" لتأكيد حذف الحساب نهائياً',
      });
    }
    const result = deleteUserAccount(store, req.authUserId);
    if (!result.ok) return res.status(404).json({ message: result.message });
    saveStore();
    res.json({ ok: true, message: 'تم حذف حسابك وبياناتك المرتبطة' });
  });
}

module.exports = {
  deleteUserAccount,
  revokeUserTokens,
  registerAccountLifecycleRoutes,
};
