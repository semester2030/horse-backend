/**
 * مسارات لوحة الإدارة v2
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const roles = require('../account_roles');
const { logAudit, filterAudit } = require('./audit');
const {
  hashPassword,
  verifyPassword,
  signToken,
  publicAdmin,
  createAdminAuthMiddleware,
} = require('./auth');
const {
  ADMIN_ROLES,
  ADMIN_ROLE_LABELS_AR,
  ALL_PERMISSIONS,
  permissionsForRole,
  requirePerm,
} = require('./permissions');
const {
  paginate,
  matchQuery,
  filterByDate,
  neighborhoodFromItem,
  cityFromItem,
  estimateMediaSize,
  formatBytes,
} = require('./query_helpers');

const MERCHANT_ROLES = [
  roles.ACCOUNT_ROLES.feed_merchant,
  roles.ACCOUNT_ROLES.supplies_merchant,
  roles.ACCOUNT_ROLES.equipment_dealer,
  roles.ACCOUNT_ROLES.vet_clinic,
  roles.ACCOUNT_ROLES.transport_provider,
];

function createAdminRouter(ctx) {
  const router = express.Router();
  const requireAdminAuth = createAdminAuthMiddleware(ctx);

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(ctx.verificationDir, req.authUserId || 'unknown');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.bin';
        cb(null, `${ctx.id()}${ext}`);
      },
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
  });

  const adminUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(ctx.verificationDir, req.params.id || 'docs');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        cb(null, `${ctx.id()}${path.extname(file.originalname) || '.pdf'}`);
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024 },
  });

  // ——— Auth ———
  router.post('/auth/login', (req, res) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    const password = String(req.body?.password || '');
    const admin = [...ctx.store.adminUsers.values()].find(
      (a) => a.email === email && a.active,
    );
    if (!admin || !verifyPassword(password, admin.passwordSalt, admin.passwordHash)) {
      return res.status(401).json({ message: 'البريد أو كلمة المرور غير صحيحة' });
    }
    admin.lastLoginAt = new Date().toISOString();
    ctx.store.adminUsers.set(admin.id, admin);
    ctx.saveStore();
    const token = signToken({ sub: admin.id, role: admin.role }, ctx.adminJwtSecret);
    logAudit(ctx, {
      actorId: admin.id,
      actorName: admin.name,
      action: 'admin.login',
      entityType: 'admin',
      entityId: admin.id,
    });
    res.json({ token, admin: publicAdmin(admin) });
  });

  router.get('/auth/me', requireAdminAuth, (req, res) => {
    res.json({ admin: publicAdmin(req.adminUser) });
  });

  router.get('/auth/permissions', requireAdminAuth, (req, res) => {
    res.json({
      roles: Object.entries(ADMIN_ROLE_LABELS_AR).map(([id, labelAr]) => ({
        id,
        labelAr,
        permissions: permissionsForRole(id),
      })),
      allPermissions: ALL_PERMISSIONS,
    });
  });

  // ——— Dashboard ———
  router.get('/dashboard/summary', requireAdminAuth, requirePerm('dashboard:read'), (req, res) => {
    const users = [...ctx.store.users.values()];
    const pendingVerification = users.filter(
      (u) => (u.verificationStatus || 'none') === 'pending',
    ).length;
    const videos = [...ctx.store.videos.values()];
    const orders = [...ctx.store.orders.values()];
    const bookings = [...ctx.store.bookings.values()];
    const catalog = [...ctx.store.catalogItems.values()];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const t0 = today.getTime();

    res.json({
      users: { total: users.length, pendingVerification },
      listings: { horses: ctx.store.horses.size },
      catalog: { total: catalog.length, feed: catalog.filter((c) => c.category === 'feed').length, supplies: catalog.filter((c) => c.category === 'supplies').length, equipment: catalog.filter((c) => c.category === 'equipment').length },
      videos: { total: videos.length, viewsToday: videos.reduce((s, v) => s + (v.views || 0), 0) },
      orders: { total: orders.length, pending: orders.filter((o) => o.status === 'pending').length },
      bookings: { total: bookings.length },
      messages: (ctx.store.messages || []).length,
      apiMetrics: ctx.store.apiMetrics || {},
    });
  });

  router.get('/dashboard/charts', requireAdminAuth, requirePerm('dashboard:read'), (req, res) => {
    const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 14));
    const byDay = {};
    const now = Date.now();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      byDay[key] = { date: key, users: 0, orders: 0, bookings: 0, videos: 0 };
    }

    for (const u of ctx.store.users.values()) {
      const k = (u.createdAt || '').slice(0, 10);
      if (byDay[k]) byDay[k].users++;
    }
    for (const o of ctx.store.orders.values()) {
      const k = (o.createdAt || '').slice(0, 10);
      if (byDay[k]) byDay[k].orders++;
    }
    for (const b of ctx.store.bookings.values()) {
      const k = (b.createdAt || '').slice(0, 10);
      if (byDay[k]) byDay[k].bookings++;
    }
    for (const v of ctx.store.videos.values()) {
      const k = (v.createdAt || '').slice(0, 10);
      if (byDay[k]) byDay[k].videos++;
    }

    const roleDist = {};
    for (const u of ctx.store.users.values()) {
      const r = u.accountRole || 'buyer';
      roleDist[r] = (roleDist[r] || 0) + 1;
    }

    res.json({
      timeline: Object.values(byDay),
      usersByRole: Object.entries(roleDist).map(([role, count]) => ({
        role,
        labelAr: roles.ROLE_LABELS_AR[role] || role,
        count,
      })),
    });
  });

  // ——— Users ———
  router.get('/users', requireAdminAuth, requirePerm('users:read'), (req, res) => {
    let list = [...ctx.store.users.values()].map((u) => {
      const { password, passwordHash, passwordSalt, ...rest } = u;
      return roles.migrateLegacyUser(rest);
    });

    if (req.query.role) {
      list = list.filter((u) => u.accountRole === req.query.role);
    }
    if (req.query.verificationStatus) {
      list = list.filter((u) => (u.verificationStatus || 'none') === req.query.verificationStatus);
    }
    if (req.query.city) {
      const c = String(req.query.city).toLowerCase();
      list = list.filter((u) => String(u.city || '').toLowerCase().includes(c));
    }
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      list = list.filter(
        (u) =>
          matchQuery(u.name, q) ||
          matchQuery(u.email, q) ||
          matchQuery(u.phone, q) ||
          matchQuery(u.id, q),
      );
    }
    list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const result = paginate(list, req.query.page, req.query.limit);
    res.json(result);
  });

  router.get('/users/:id', requireAdminAuth, requirePerm('users:read'), (req, res) => {
    const u = ctx.store.users.get(req.params.id);
    if (!u) return res.status(404).json({ message: 'المستخدم غير موجود' });
    const { password, ...rest } = u;
    const user = roles.migrateLegacyUser(rest);
    const userOrders = [...ctx.store.orders.values()].filter(
      (o) => o.buyerId === user.id || o.sellerId === user.id,
    );
    const userBookings = [...ctx.store.bookings.values()].filter(
      (b) => b.userId === user.id || b.providerId === user.id,
    );
    const userVideos = [...ctx.store.videos.values()].filter(
      (v) => v.userId === user.id,
    );
    const userCatalog = [...ctx.store.catalogItems.values()].filter(
      (c) => c.sellerId === user.id,
    );
    const userListings = [...ctx.store.horses.values()].filter(
      (h) => h.ownerId === user.id || h.userId === user.id,
    );
    res.json({
      user,
      stats: {
        orders: userOrders.length,
        bookings: userBookings.length,
        videos: userVideos.length,
        catalog: userCatalog.length,
        listings: userListings.length,
      },
      orders: userOrders.slice(0, 20),
      bookings: userBookings.slice(0, 20),
    });
  });

  router.get('/verifications', requireAdminAuth, requirePerm('users:verify'), (req, res) => {
    const status = req.query.status || 'pending';
    let list = [...ctx.store.users.values()].filter(
      (u) => (u.verificationStatus || 'none') === status,
    );
    if (req.query.role) {
      list = list.filter((u) => u.accountRole === req.query.role);
    }
    list = list.map((u) => {
      const { password, ...rest } = u;
      return roles.migrateLegacyUser(rest);
    });
    list.sort((a, b) => new Date(a.verificationSubmittedAt || a.createdAt) - new Date(b.verificationSubmittedAt || b.createdAt));
    res.json(paginate(list, req.query.page, req.query.limit));
  });

  router.post('/users/:id/verify', requireAdminAuth, requirePerm('users:verify'), (req, res) => {
    const u = ctx.store.users.get(req.params.id);
    if (!u) return res.status(404).json({ message: 'المستخدم غير موجود' });
    const action = String(req.body?.action || '').trim();
    const note = String(req.body?.note || '').trim();

    if (action === 'approve') {
      u.verificationStatus = 'approved';
      u.verifiedAt = new Date().toISOString();
      u.verifiedBy = req.adminUserId;
      u.verificationNote = note || 'تم القبول';
    } else if (action === 'reject') {
      u.verificationStatus = 'rejected';
      u.verificationNote = note || 'مرفوض';
      u.verifiedBy = req.adminUserId;
    } else if (action === 'suspend') {
      u.verificationStatus = 'suspended';
      u.verificationNote = note;
    } else if (action === 'request_docs') {
      u.verificationStatus = 'pending';
      u.verificationNote = note || 'مطلوب مستندات إضافية';
    } else {
      return res.status(400).json({ message: 'action: approve | reject | suspend | request_docs' });
    }
    u.updatedAt = new Date().toISOString();
    ctx.store.users.set(u.id, u);
    ctx.saveStore();
    logAudit(ctx, {
      actorId: req.adminUserId,
      actorName: req.adminUser.name,
      action: `user.verify.${action}`,
      entityType: 'user',
      entityId: u.id,
      note,
    });
    const { password, ...rest } = u;
    res.json(rest);
  });

  router.get('/users/:id/documents/:docId', (req, res, next) => {
    const qToken = req.query.t;
    if (qToken) {
      const { verifyToken } = require('./auth');
      const payload = verifyToken(String(qToken), ctx.adminJwtSecret);
      if (!payload?.sub) return res.status(401).json({ message: 'توكن غير صالح' });
      req.adminUser = ctx.store.adminUsers.get(String(payload.sub));
      if (!req.adminUser?.active) return res.status(401).json({ message: 'غير مصرح' });
      return next();
    }
    requireAdminAuth(req, res, () => requirePerm('users:verify')(req, res, next));
  }, (req, res) => {
    const u = ctx.store.users.get(req.params.id);
    if (!u) return res.status(404).json({ message: 'المستخدم غير موجود' });
    const doc = (u.verificationDocuments || []).find((d) => d.id === req.params.docId);
    if (!doc || !doc.path) return res.status(404).json({ message: 'المستند غير موجود' });
    if (!fs.existsSync(doc.path)) return res.status(404).json({ message: 'الملف غير موجود على الخادم' });
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename || 'document'}"`);
    fs.createReadStream(doc.path).pipe(res);
  });

  router.patch('/users/:id', requireAdminAuth, requirePerm('users:write'), (req, res) => {
    const u = ctx.store.users.get(req.params.id);
    if (!u) return res.status(404).json({ message: 'المستخدم غير موجود' });
    const allowed = ['name', 'city', 'phone', 'riskFlags', 'moderationNote'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) u[k] = req.body[k];
    }
    if (req.body.accountRole && roles.isValidAccountRole(req.body.accountRole)) {
      u.accountRole = req.body.accountRole;
      u.capabilities = roles.capabilitiesForRole(req.body.accountRole);
    }
    u.updatedAt = new Date().toISOString();
    ctx.store.users.set(u.id, roles.migrateLegacyUser(u));
    ctx.saveStore();
    logAudit(ctx, {
      actorId: req.adminUserId,
      actorName: req.adminUser.name,
      action: 'user.update',
      entityType: 'user',
      entityId: u.id,
    });
    const { password, ...rest } = u;
    res.json(rest);
  });

  router.delete('/users/:id', requireAdminAuth, requirePerm('users:write'), (req, res) => {
    const { id } = req.params;
    if (!ctx.store.users.has(id)) return res.status(404).json({ message: 'غير موجود' });
    ctx.store.users.delete(id);
    ctx.saveStore();
    logAudit(ctx, {
      actorId: req.adminUserId,
      actorName: req.adminUser.name,
      action: 'user.delete',
      entityType: 'user',
      entityId: id,
    });
    res.json({ ok: true });
  });

  // ——— Catalog ———
  router.get('/catalog', requireAdminAuth, requirePerm('catalog:read'), (req, res) => {
    let list = [...ctx.store.catalogItems.values()];
    if (req.query.category) list = list.filter((c) => c.category === req.query.category);
    if (req.query.city) {
      const c = String(req.query.city).toLowerCase();
      list = list.filter((x) => String(x.city || '').toLowerCase().includes(c));
    }
    if (req.query.status) list = list.filter((x) => (x.status || 'active') === req.query.status);
    if (req.query.sellerId) list = list.filter((x) => x.sellerId === req.query.sellerId);
    if (req.query.minPrice) list = list.filter((x) => Number(x.price) >= Number(req.query.minPrice));
    if (req.query.maxPrice) list = list.filter((x) => Number(x.price) <= Number(req.query.maxPrice));
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      list = list.filter((x) => matchQuery(x.name, q) || matchQuery(x.description, q));
    }
    list = list.map((item) => ({
      ...item,
      mediaSizeLabel: formatBytes(estimateMediaSize(item)),
      imageCount: (item.images || []).length,
    }));
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(paginate(list, req.query.page, req.query.limit));
  });

  router.patch('/catalog/:id/moderate', requireAdminAuth, requirePerm('catalog:moderate'), (req, res) => {
    const item = ctx.store.catalogItems.get(req.params.id);
    if (!item) return res.status(404).json({ message: 'المنتج غير موجود' });
    if (req.body.status) item.status = req.body.status;
    if (req.body.inStock !== undefined) item.inStock = req.body.inStock;
    if (req.body.moderationNote) item.moderationNote = req.body.moderationNote;
    item.updatedAt = new Date().toISOString();
    ctx.store.catalogItems.set(item.id, item);
    ctx.saveStore();
    logAudit(ctx, {
      actorId: req.adminUserId,
      actorName: req.adminUser.name,
      action: 'catalog.moderate',
      entityType: 'catalog',
      entityId: item.id,
      note: req.body.moderationNote,
    });
    res.json(item);
  });

  router.delete('/catalog/:id', requireAdminAuth, requirePerm('catalog:moderate'), (req, res) => {
    ctx.store.catalogItems.delete(req.params.id);
    ctx.saveStore();
    logAudit(ctx, {
      actorId: req.adminUserId,
      actorName: req.adminUser.name,
      action: 'catalog.delete',
      entityType: 'catalog',
      entityId: req.params.id,
    });
    res.json({ ok: true });
  });

  // ——— Listings (horses) ———
  router.get('/listings', requireAdminAuth, requirePerm('content:read'), (req, res) => {
    let list = [...ctx.store.horses.values()];
    if (req.query.species) list = list.filter((h) => (h.species || 'horse') === req.query.species);
    if (req.query.city) {
      const c = String(req.query.city).toLowerCase();
      list = list.filter((h) => String(cityFromItem(h)).toLowerCase().includes(c));
    }
    if (req.query.neighborhood) {
      const n = String(req.query.neighborhood).toLowerCase();
      list = list.filter((h) => String(neighborhoodFromItem(h)).toLowerCase().includes(n));
    }
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      list = list.filter((h) => matchQuery(h.name, q) || matchQuery(h.title, q));
    }
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(paginate(list, req.query.page, req.query.limit));
  });

  router.patch('/listings/:id/moderate', requireAdminAuth, requirePerm('content:moderate'), (req, res) => {
    const h = ctx.store.horses.get(req.params.id);
    if (!h) return res.status(404).json({ message: 'الإعلان غير موجود' });
    if (req.body.status) h.status = req.body.status;
    if (req.body.hidden !== undefined) h.hidden = req.body.hidden;
    h.updatedAt = new Date().toISOString();
    ctx.store.horses.set(h.id, h);
    ctx.saveStore();
    logAudit(ctx, {
      actorId: req.adminUserId,
      actorName: req.adminUser.name,
      action: 'listing.moderate',
      entityType: 'listing',
      entityId: h.id,
    });
    res.json(h);
  });

  router.delete('/listings/:id', requireAdminAuth, requirePerm('content:moderate'), (req, res) => {
    ctx.store.horses.delete(req.params.id);
    ctx.saveStore();
    res.json({ ok: true });
  });

  // ——— Videos ———
  router.get('/videos', requireAdminAuth, requirePerm('videos:read'), (req, res) => {
    let list = [...ctx.store.videos.values()];
    if (req.query.type) list = list.filter((v) => v.type === req.query.type);
    if (req.query.serviceType) {
      list = list.filter(
        (v) =>
          v.serviceType === req.query.serviceType ||
          v.serviceCategory === req.query.serviceType,
      );
    }
    if (req.query.city) {
      const c = String(req.query.city).toLowerCase();
      list = list.filter((v) => String(cityFromItem(v)).toLowerCase().includes(c));
    }
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      list = list.filter((v) => matchQuery(v.title, q) || matchQuery(v.description, q));
    }
    list = list.map((v) => {
      const comments = ctx.store.videoComments[v.id] || [];
      return {
        ...v,
        commentCount: comments.length,
        sizeBytes: estimateMediaSize(v),
        sizeLabel: formatBytes(estimateMediaSize(v)),
        durationSec: v.durationSec || v.duration || null,
      };
    });
    list.sort((a, b) => (b.views || 0) - (a.views || 0));
    res.json(paginate(list, req.query.page, req.query.limit));
  });

  router.patch('/videos/:id/moderate', requireAdminAuth, requirePerm('videos:moderate'), (req, res) => {
    const v = ctx.store.videos.get(req.params.id);
    if (!v) return res.status(404).json({ message: 'الفيديو غير موجود' });
    if (req.body.hidden !== undefined) v.hidden = req.body.hidden;
    if (req.body.status) v.status = req.body.status;
    if (req.body.moderationNote) v.moderationNote = req.body.moderationNote;
    v.updatedAt = new Date().toISOString();
    ctx.store.videos.set(v.id, v);
    ctx.saveStore();
    logAudit(ctx, {
      actorId: req.adminUserId,
      actorName: req.adminUser.name,
      action: 'video.moderate',
      entityType: 'video',
      entityId: v.id,
    });
    res.json(v);
  });

  router.delete('/videos/:id', requireAdminAuth, requirePerm('videos:moderate'), (req, res) => {
    const id = req.params.id;
    ctx.store.videos.delete(id);
    delete ctx.store.videoComments[id];
    ctx.saveStore();
    logAudit(ctx, {
      actorId: req.adminUserId,
      actorName: req.adminUser.name,
      action: 'video.delete',
      entityType: 'video',
      entityId: id,
    });
    res.json({ ok: true });
  });

  router.get('/videos/:id/comments', requireAdminAuth, requirePerm('videos:read'), (req, res) => {
    const list = ctx.store.videoComments[req.params.id] || [];
    res.json({ items: list });
  });

  router.delete('/videos/:videoId/comments/:commentId', requireAdminAuth, requirePerm('videos:moderate'), (req, res) => {
    const { videoId, commentId } = req.params;
    const list = ctx.store.videoComments[videoId];
    if (!Array.isArray(list)) return res.status(404).json({ message: 'غير موجود' });
    const idx = list.findIndex((c) => c.id === commentId);
    if (idx === -1) return res.status(404).json({ message: 'غير موجود' });
    list.splice(idx, 1);
    const video = ctx.store.videos.get(videoId);
    if (video) {
      video.comments = Math.max(0, (video.comments || 0) - 1);
      ctx.store.videos.set(videoId, video);
    }
    ctx.saveStore();
    res.json({ ok: true });
  });

  // ——— Orders & Bookings ———
  router.get('/orders', requireAdminAuth, requirePerm('orders:read'), (req, res) => {
    let list = [...ctx.store.orders.values()];
    if (req.query.status) list = list.filter((o) => o.status === req.query.status);
    list = filterByDate(list, 'createdAt', req.query.from, req.query.to);
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(paginate(list, req.query.page, req.query.limit));
  });

  router.patch('/orders/:id', requireAdminAuth, requirePerm('orders:write'), (req, res) => {
    const o = ctx.store.orders.get(req.params.id);
    if (!o) return res.status(404).json({ message: 'الطلب غير موجود' });
    if (req.body.status) o.status = req.body.status;
    if (req.body.adminNote) o.adminNote = req.body.adminNote;
    o.updatedAt = new Date().toISOString();
    ctx.store.orders.set(o.id, o);
    ctx.saveStore();
    res.json(o);
  });

  router.get('/bookings', requireAdminAuth, requirePerm('bookings:read'), (req, res) => {
    let list = [...ctx.store.bookings.values()];
    if (req.query.status) list = list.filter((b) => b.status === req.query.status);
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(paginate(list, req.query.page, req.query.limit));
  });

  router.patch('/bookings/:id', requireAdminAuth, requirePerm('bookings:write'), (req, res) => {
    const b = ctx.store.bookings.get(req.params.id);
    if (!b) return res.status(404).json({ message: 'الحجز غير موجود' });
    if (req.body.status) b.status = req.body.status;
    b.updatedAt = new Date().toISOString();
    ctx.store.bookings.set(b.id, b);
    ctx.saveStore();
    res.json(b);
  });

  // ——— Analytics ———
  router.get('/analytics/neighborhoods', requireAdminAuth, requirePerm('analytics:read'), (req, res) => {
    const counts = {};
    const add = (item) => {
      const city = cityFromItem(item) || 'غير محدد';
      const hood = neighborhoodFromItem(item) || 'غير محدد';
      const key = `${city}::${hood}`;
      counts[key] = counts[key] || { city, neighborhood: hood, listings: 0, videos: 0, orders: 0 };
    };
    for (const h of ctx.store.horses.values()) {
      add(h);
      const city = cityFromItem(h) || 'غير محدد';
      const hood = neighborhoodFromItem(h) || 'غير محدد';
      counts[`${city}::${hood}`].listings++;
    }
    for (const v of ctx.store.videos.values()) {
      const city = cityFromItem(v) || 'غير محدد';
      const hood = neighborhoodFromItem(v) || 'غير محدد';
      const key = `${city}::${hood}`;
      if (!counts[key]) counts[key] = { city, neighborhood: hood, listings: 0, videos: 0, orders: 0 };
      counts[key].videos++;
    }
    const sorted = Object.values(counts).sort(
      (a, b) => b.listings + b.videos - (a.listings + a.videos),
    );
    res.json({
      top: sorted.slice(0, 15),
      bottom: sorted.filter((x) => x.listings + x.videos > 0).slice(-15).reverse(),
      all: sorted,
    });
  });

  router.get('/analytics/overview', requireAdminAuth, requirePerm('analytics:read'), (req, res) => {
    const catalog = [...ctx.store.catalogItems.values()];
    const byCategory = { feed: 0, supplies: 0, equipment: 0 };
    let totalViews = 0;
    for (const v of ctx.store.videos.values()) {
      totalViews += v.views || 0;
    }
    for (const c of catalog) {
      if (byCategory[c.category] != null) byCategory[c.category]++;
    }
    res.json({
      catalogByCategory: byCategory,
      totalVideoViews: totalViews,
      avgOrderValue:
        [...ctx.store.orders.values()].reduce((s, o) => s + (Number(o.total) || 0), 0) /
          Math.max(1, ctx.store.orders.size) || 0,
    });
  });

  // ——— Audit ———
  router.get('/audit', requireAdminAuth, requirePerm('audit:read'), (req, res) => {
    const list = filterAudit(ctx.store.auditEvents, req.query);
    res.json(paginate(list, req.query.page, req.query.limit));
  });

  // ——— API Metrics ———
  router.get('/metrics/api', requireAdminAuth, requirePerm('metrics:read'), (req, res) => {
    res.json(ctx.store.apiMetrics || { routes: {}, recent: [] });
  });

  // ——— Team ———
  router.get('/team', requireAdminAuth, requirePerm('team:read'), (req, res) => {
    const list = [...ctx.store.adminUsers.values()].map(publicAdmin);
    res.json({ items: list });
  });

  router.post('/team', requireAdminAuth, requirePerm('team:write'), (req, res) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    const role = req.body?.role || ADMIN_ROLES.support;
    if (!email || password.length < 8) {
      return res.status(400).json({ message: 'البريد وكلمة مرور (8+ أحرف) مطلوبان' });
    }
    if ([...ctx.store.adminUsers.values()].some((a) => a.email === email)) {
      return res.status(400).json({ message: 'البريد مستخدم' });
    }
    const { salt, hash } = hashPassword(password);
    const adminId = ctx.id();
    const admin = {
      id: adminId,
      email,
      name: name || email,
      role,
      permissions: permissionsForRole(role),
      passwordSalt: salt,
      passwordHash: hash,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    ctx.store.adminUsers.set(adminId, admin);
    ctx.saveStore();
    logAudit(ctx, {
      actorId: req.adminUserId,
      actorName: req.adminUser.name,
      action: 'team.create',
      entityType: 'admin',
      entityId: adminId,
    });
    res.status(201).json(publicAdmin(admin));
  });

  router.patch('/team/:id', requireAdminAuth, requirePerm('team:write'), (req, res) => {
    const admin = ctx.store.adminUsers.get(req.params.id);
    if (!admin) return res.status(404).json({ message: 'غير موجود' });
    if (req.body.name) admin.name = req.body.name;
    if (req.body.role) {
      admin.role = req.body.role;
      admin.permissions = permissionsForRole(req.body.role);
    }
    if (req.body.active !== undefined) admin.active = Boolean(req.body.active);
    if (req.body.password && String(req.body.password).length >= 8) {
      const { salt, hash } = hashPassword(req.body.password);
      admin.passwordSalt = salt;
      admin.passwordHash = hash;
    }
    admin.updatedAt = new Date().toISOString();
    ctx.store.adminUsers.set(admin.id, admin);
    ctx.saveStore();
    res.json(publicAdmin(admin));
  });

  // ——— Reports export (CSV as JSON rows) ———
  router.get('/reports/:type', requireAdminAuth, requirePerm('reports:export'), (req, res) => {
    const type = req.params.type;
    let rows = [];
    if (type === 'users') {
      rows = [...ctx.store.users.values()].map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        accountRole: u.accountRole,
        city: u.city,
        verificationStatus: u.verificationStatus,
        createdAt: u.createdAt,
      }));
    } else if (type === 'orders') {
      rows = [...ctx.store.orders.values()];
    } else if (type === 'catalog') {
      rows = [...ctx.store.catalogItems.values()];
    } else if (type === 'videos') {
      rows = [...ctx.store.videos.values()];
    } else {
      return res.status(400).json({ message: 'نوع التقرير غير مدعوم' });
    }
    res.json({ type, exportedAt: new Date().toISOString(), count: rows.length, rows });
  });

  // ——— Legacy aggregate (compat) ———
  router.get('/data/all', requireAdminAuth, requirePerm('dashboard:read'), (req, res) => {
    res.json({
      users: Object.fromEntries(ctx.store.users),
      horses: Object.fromEntries(ctx.store.horses),
      catalogItems: Object.fromEntries(ctx.store.catalogItems),
      orders: Object.fromEntries(ctx.store.orders),
      bookings: Object.fromEntries(ctx.store.bookings),
      services: Object.fromEntries(ctx.store.services),
      videos: Object.fromEntries(ctx.store.videos),
      videoComments: ctx.store.videoComments,
    });
  });

  return router;
}

/** مسار رفع مستندات التحقق من التطبيق */
function registerAppVerificationRoutes(app, ctx, auth, requireSessionUser) {
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(ctx.verificationDir, req.authUserId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        cb(null, `${ctx.id()}${path.extname(file.originalname) || '.jpg'}`);
      },
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
  });

  app.post(
    '/verification/documents',
    auth,
    requireSessionUser,
    upload.single('file'),
    (req, res) => {
      if (!req.file) {
        return res.status(400).json({ message: 'الملف مطلوب' });
      }
      const u = ctx.store.users.get(req.authUserId);
      if (!u) return res.status(404).json({ message: 'المستخدم غير موجود' });
      if (!MERCHANT_ROLES.includes(u.accountRole)) {
        return res.status(400).json({ message: 'هذا الحساب لا يتطلب مستندات تحقق' });
      }
      const doc = {
        id: ctx.id(),
        type: String(req.body?.type || 'commercial_register'),
        filename: req.file.originalname,
        path: req.file.path,
        sizeBytes: req.file.size,
        mimeType: req.file.mimetype,
        uploadedAt: new Date().toISOString(),
      };
      if (!Array.isArray(u.verificationDocuments)) u.verificationDocuments = [];
      u.verificationDocuments.push(doc);
      u.verificationStatus = 'pending';
      u.verificationSubmittedAt = new Date().toISOString();
      u.updatedAt = new Date().toISOString();
      ctx.store.users.set(u.id, u);
      ctx.saveStore();
      res.status(201).json({ ok: true, document: { id: doc.id, type: doc.type, filename: doc.filename, sizeBytes: doc.sizeBytes } });
    },
  );
}

module.exports = { createAdminRouter, registerAppVerificationRoutes, MERCHANT_ROLES };
