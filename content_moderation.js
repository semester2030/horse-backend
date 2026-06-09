/**
 * إبلاغ المحتوى + إخفاء/حظر — Apple Guideline 1.2 (UGC)
 */

function ensureModerationStore(store) {
  if (!Array.isArray(store.contentReports)) store.contentReports = [];
}

function userModerationPrefs(user) {
  if (!user.moderation) {
    user.moderation = { hiddenTargets: [], blockedUserIds: [] };
  }
  if (!Array.isArray(user.moderation.hiddenTargets)) {
    user.moderation.hiddenTargets = [];
  }
  if (!Array.isArray(user.moderation.blockedUserIds)) {
    user.moderation.blockedUserIds = [];
  }
  return user.moderation;
}

function isTargetHiddenForUser(user, targetType, targetId) {
  if (!user || !user.moderation) return false;
  const prefs = userModerationPrefs(user);
  return prefs.hiddenTargets.some(
    (t) => t.type === targetType && t.id === targetId,
  );
}

function isUserBlocked(user, otherUserId) {
  if (!user || !user.moderation) return false;
  return userModerationPrefs(user).blockedUserIds.includes(String(otherUserId));
}

function registerContentModerationRoutes(app, ctx) {
  const { store, saveStore, id, auth, requireSessionUser } = ctx;
  ensureModerationStore(store);

  app.post('/content-reports', auth, requireSessionUser, (req, res) => {
    const targetType = String(req.body?.targetType || '').trim();
    const targetId = String(req.body?.targetId || '').trim();
    const reason = String(req.body?.reason || 'other').trim();
    const details = String(req.body?.details || '').trim().slice(0, 2000);
    const targetOwnerId = String(req.body?.targetOwnerId || '').trim();

    if (!targetType || !targetId) {
      return res.status(400).json({ message: 'targetType و targetId مطلوبان' });
    }
    if (!['video', 'listing', 'user', 'comment'].includes(targetType)) {
      return res.status(400).json({ message: 'نوع الهدف غير مدعوم' });
    }

    const report = {
      id: id(),
      reporterId: req.authUserId,
      targetType,
      targetId,
      targetOwnerId: targetOwnerId || null,
      reason,
      details,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    store.contentReports.unshift(report);
    saveStore();
    res.status(201).json(report);
  });

  app.post('/users/me/moderation', auth, requireSessionUser, (req, res) => {
    const action = String(req.body?.action || '').trim();
    const user = store.users.get(req.authUserId);
    if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });

    const prefs = userModerationPrefs(user);

    if (action === 'hide') {
      const targetType = String(req.body?.targetType || '').trim();
      const targetId = String(req.body?.targetId || '').trim();
      if (!targetType || !targetId) {
        return res.status(400).json({ message: 'targetType و targetId مطلوبان' });
      }
      const exists = prefs.hiddenTargets.some(
        (t) => t.type === targetType && t.id === targetId,
      );
      if (!exists) {
        prefs.hiddenTargets.push({
          type: targetType,
          id: targetId,
          at: new Date().toISOString(),
        });
      }
      user.moderation = prefs;
      user.updatedAt = new Date().toISOString();
      store.users.set(req.authUserId, user);
      saveStore();
      return res.json({ ok: true, moderation: prefs });
    }

    if (action === 'block_user') {
      const targetUserId = String(req.body?.targetUserId || '').trim();
      if (!targetUserId) {
        return res.status(400).json({ message: 'targetUserId مطلوب' });
      }
      if (targetUserId === req.authUserId) {
        return res.status(400).json({ message: 'لا يمكن حظر نفسك' });
      }
      if (!prefs.blockedUserIds.includes(targetUserId)) {
        prefs.blockedUserIds.push(targetUserId);
      }
      user.moderation = prefs;
      user.updatedAt = new Date().toISOString();
      store.users.set(req.authUserId, user);
      saveStore();
      return res.json({ ok: true, moderation: prefs });
    }

    return res.status(400).json({ message: 'إجراء غير مدعوم' });
  });

  app.get('/users/me/moderation', auth, requireSessionUser, (req, res) => {
    const user = store.users.get(req.authUserId);
    if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });
    res.json(userModerationPrefs(user));
  });
}

function registerContentModerationAdminRoutes(router, ctx) {
  const { requireAdminAuth, requirePerm, paginate, logAudit } = ctx.helpers;
  const { store, saveStore } = ctx;

  router.get('/content-reports', requireAdminAuth, requirePerm('content:moderate'), (req, res) => {
    ensureModerationStore(store);
    let list = [...store.contentReports];
    if (req.query.status) {
      list = list.filter((r) => r.status === req.query.status);
    }
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(paginate(list, req.query.page, req.query.limit));
  });

  router.patch('/content-reports/:id', requireAdminAuth, requirePerm('content:moderate'), (req, res) => {
    ensureModerationStore(store);
    const report = store.contentReports.find((r) => r.id === req.params.id);
    if (!report) return res.status(404).json({ message: 'البلاغ غير موجود' });
    if (req.body.status) report.status = req.body.status;
    if (req.body.adminNote) report.adminNote = String(req.body.adminNote).slice(0, 500);
    report.resolvedAt = new Date().toISOString();
    report.resolvedBy = req.adminUserId;
    saveStore();
    logAudit(ctx, {
      actorId: req.adminUserId,
      actorName: req.adminUser.name,
      action: 'content_report.resolve',
      entityType: 'content_report',
      entityId: report.id,
    });
    res.json(report);
  });
}

module.exports = {
  registerContentModerationRoutes,
  registerContentModerationAdminRoutes,
  isTargetHiddenForUser,
  isUserBlocked,
  ensureModerationStore,
};
