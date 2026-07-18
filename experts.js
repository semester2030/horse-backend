/**
 * شبكة الخبراء المعتمدين
 * — تقديم (هوية إلزامية + شهادات اختيارية)
 * — موافقة → موثوق فوراً
 * — تقييم العملاء (نجمة/عميل واحد قابل للتحديث) + تقييم الإدارة منفصل
 */

const BIO_SHORT_MAX = 220;
const BIO_LONG_MAX = 2000;
const CERT_MAX = 5;
const privileged = require('./privileged_access');

function ensureRatingsStore(store) {
  if (!store.expertRatings) store.expertRatings = new Map();
}

function normalizeSpecs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(String)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function ratingStats(store, expertId) {
  ensureRatingsStore(store);
  const rows = [...store.expertRatings.values()].filter(
    (r) => String(r.expertId) === String(expertId) && r.source === 'client',
  );
  if (!rows.length) {
    return { ratingAvg: 0, ratingCount: 0, recentRatings: [] };
  }
  const sum = rows.reduce((a, r) => a + Number(r.stars || 0), 0);
  const recent = [...rows]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
    .slice(0, 12)
    .map((r) => ({
      id: r.id,
      stars: r.stars,
      comment: r.comment || '',
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  return {
    ratingAvg: Math.round((sum / rows.length) * 10) / 10,
    ratingCount: rows.length,
    recentRatings: recent,
  };
}

function createExpertsApi({
  store,
  saveStore,
  id,
  auth,
  requireSessionUser,
  notifyEvent,
  bookingOccupancy,
}) {
  function listApproved(species) {
    ensureRatingsStore(store);
    let list = [...store.experts.values()].filter((e) => e.status === 'approved');
    if (species) {
      const sp = String(species).trim().toLowerCase();
      list = list.filter((e) => {
        const specs = Array.isArray(e.specialties) ? e.specialties : [];
        return specs.map(String).map((s) => s.toLowerCase()).includes(sp);
      });
    }
    list.sort((a, b) => {
      const ra = ratingStats(store, a.id).ratingAvg;
      const rb = ratingStats(store, b.id).ratingAvg;
      if (rb !== ra) return rb - ra;
      return (
        new Date(b.approvedAt || b.createdAt || 0) -
        new Date(a.approvedAt || a.createdAt || 0)
      );
    });
    return list;
  }

  function requesterLabel(userId) {
    const u = store.users?.get?.(String(userId));
    if (!u) return 'عميل';
    return (
      String(u.name || u.displayName || u.phone || '').trim() || 'عميل'
    );
  }

  function enrichRequest(r) {
    return {
      ...r,
      fromUserName: requesterLabel(r.fromUserId),
      sourceType: r.listingId ? 'listing' : r.videoId ? 'video' : 'unknown',
    };
  }

  function requestCounts(expertId) {
    const rows = [...store.expertRequests.values()].filter(
      (r) => String(r.expertId) === String(expertId),
    );
    const open = rows.filter((r) => r.status === 'open').length;
    const replied = rows.filter((r) => r.status === 'replied').length;
    return {
      requestsTotal: rows.length,
      requestsOpen: open,
      requestsReplied: replied,
    };
  }

  /** عرض عام — بدون صورة الهوية/الشهادات */
  function publicExpert(e, { includePrivate = false, includeCrm = false } = {}) {
    if (!e) return null;
    const stats = ratingStats(store, e.id);
    const base = {
      id: e.id,
      userId: e.userId,
      displayName: e.displayName,
      city: e.city || '',
      bio: e.bio || '',
      bioMode: e.bioMode === 'long' ? 'long' : 'short',
      achievements: e.achievements || '',
      specialties: Array.isArray(e.specialties) ? e.specialties : [],
      status: e.status,
      avatarUrl: e.avatarUrl || '',
      phone: e.phone || '',
      whatsapp: e.whatsapp || '',
      email: e.email || '',
      /** بعد الموافقة الإدارية مباشرة */
      verified: e.status === 'approved' && e.verified !== false,
      trustBadge: e.status === 'approved' ? 'verified' : null,
      acceptingRequests: e.acceptingRequests !== false,
      approvedAt: e.approvedAt || null,
      createdAt: e.createdAt,
      ratingAvg: stats.ratingAvg,
      ratingCount: stats.ratingCount,
      recentRatings: stats.recentRatings,
      adminRating: e.adminRating != null ? Number(e.adminRating) : null,
      adminRatingNote: e.adminRatingNote || '',
      hasIdCard: Boolean(e.idCardUrl),
      certificatesCount: Array.isArray(e.certificateUrls)
        ? e.certificateUrls.length
        : 0,
    };
    if (includePrivate) {
      base.idCardUrl = e.idCardUrl || '';
      base.certificateUrls = Array.isArray(e.certificateUrls)
        ? e.certificateUrls
        : [];
    }
    if (includeCrm) {
      Object.assign(base, requestCounts(e.id));
    }
    return base;
  }

  return {
    listApproved,
    publicExpert,
    ratingStats,

    registerAppRoutes(app) {
      app.get('/experts', (req, res) => {
        res.json(listApproved(req.query.species).map((e) => publicExpert(e)));
      });

      app.get('/experts/me/application', auth, requireSessionUser, (req, res) => {
        const e = [...store.experts.values()].find(
          (x) => String(x.userId) === String(req.authUserId),
        );
        if (!e) return res.json(null);
        res.json(
          publicExpert(e, {
            includePrivate: true,
            includeCrm: e.status === 'approved',
          }),
        );
      });

      /** تحديث الصفحة العامة + إعدادات الاستقبال — للخبير المعتمد فقط */
      app.patch('/experts/me', auth, requireSessionUser, (req, res) => {
        const e = [...store.experts.values()].find(
          (x) => String(x.userId) === String(req.authUserId),
        );
        if (!e || e.status !== 'approved') {
          return res.status(403).json({
            message: 'لوحة الخبير متاحة بعد الاعتماد الإداري فقط',
          });
        }

        const body = req.body || {};
        if (body.displayName != null) {
          const n = String(body.displayName).trim();
          if (!n) {
            return res.status(400).json({ message: 'الاسم المعروض مطلوب' });
          }
          e.displayName = n;
        }
        if (body.city != null) e.city = String(body.city).trim();
        if (body.specialties != null) {
          const specs = normalizeSpecs(body.specialties);
          if (!specs.length) {
            return res.status(400).json({ message: 'تخصص واحد على الأقل مطلوب' });
          }
          e.specialties = specs;
        }
        if (body.bioMode != null) {
          e.bioMode =
            String(body.bioMode).trim() === 'long' ? 'long' : 'short';
        }
        if (body.bio != null) {
          const bioMode = e.bioMode === 'long' ? 'long' : 'short';
          const bioMax = bioMode === 'long' ? BIO_LONG_MAX : BIO_SHORT_MAX;
          let bio = String(body.bio).trim();
          if (!bio) {
            return res.status(400).json({ message: 'النبذة مطلوبة' });
          }
          if (bio.length > bioMax) bio = bio.slice(0, bioMax);
          e.bio = bio;
        }
        if (body.achievements != null) {
          e.achievements = String(body.achievements).trim();
        }
        if (body.phone != null) e.phone = String(body.phone).trim();
        if (body.whatsapp != null) e.whatsapp = String(body.whatsapp).trim();
        if (body.email != null) e.email = String(body.email).trim();
        if (body.avatarUrl != null) {
          e.avatarUrl = String(body.avatarUrl).trim();
        }
        if (body.acceptingRequests != null) {
          e.acceptingRequests = Boolean(body.acceptingRequests);
        }

        const phone = e.phone || '';
        const whatsapp = e.whatsapp || '';
        const email = e.email || '';
        if (!phone && !whatsapp && !email) {
          return res.status(400).json({
            message: 'أبقِ وسيلة تواصل واحدةًة على الأقل',
          });
        }

        // لا يُسمح بتعديل الهوية/الشهادات/الموثوق من هنا
        e.updatedAt = new Date().toISOString();
        store.experts.set(e.id, e);
        saveStore();
        res.json(publicExpert(e, { includePrivate: true, includeCrm: true }));
      });

      app.get('/experts/requests/mine', auth, requireSessionUser, (req, res) => {
        if (
          bookingOccupancy &&
          bookingOccupancy.expireStaleExpertRequests(store.expertRequests) > 0
        ) {
          saveStore();
        }
        const uid = String(req.authUserId);
        const asRequester = [...store.expertRequests.values()]
          .filter((r) => String(r.fromUserId) === uid)
          .map(enrichRequest)
          .sort(
            (a, b) =>
              new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
          );
        const myExpert = [...store.experts.values()].find(
          (e) => String(e.userId) === uid && e.status === 'approved',
        );
        const asExpert = myExpert
          ? [...store.expertRequests.values()]
              .filter((r) => String(r.expertId) === String(myExpert.id))
              .map(enrichRequest)
              .sort(
                (a, b) =>
                  new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
              )
          : [];
        res.json({
          asRequester,
          asExpert,
          expert: myExpert
            ? publicExpert(myExpert, { includeCrm: true })
            : null,
        });
      });

      app.post('/experts/apply', auth, requireSessionUser, (req, res) => {
        const userId = req.authUserId;
        const existing = [...store.experts.values()].find(
          (e) => String(e.userId) === String(userId) && e.status !== 'rejected',
        );
        if (existing && existing.status === 'approved') {
          return res.status(400).json({ message: 'أنت خبير معتمد بالفعل' });
        }
        if (existing && existing.status === 'pending') {
          return res.status(400).json({ message: 'طلبك قيد المراجعة' });
        }

        const specialties = normalizeSpecs(req.body?.specialties);
        if (!specialties.length) {
          return res
            .status(400)
            .json({ message: 'اختر تخصصاً واحداً على الأقل (خيل/إبل/صقر…)' });
        }

        const displayName = String(
          req.body?.displayName || req.authUser?.name || '',
        ).trim();
        if (!displayName) {
          return res.status(400).json({ message: 'الاسم المعروض مطلوب' });
        }

        const idCardUrl = String(req.body?.idCardUrl || '').trim();
        if (!idCardUrl) {
          return res.status(400).json({
            message: 'صورة بطاقة الهوية إلزامية لمراجعة الإدارة',
          });
        }

        const bioMode = String(req.body?.bioMode || 'short').trim() === 'long'
          ? 'long'
          : 'short';
        let bio = String(req.body?.bio || '').trim();
        const bioMax = bioMode === 'long' ? BIO_LONG_MAX : BIO_SHORT_MAX;
        if (!bio) {
          return res.status(400).json({ message: 'اكتب نبذة عن خبرتك' });
        }
        if (bio.length > bioMax) {
          bio = bio.slice(0, bioMax);
        }

        const certificates = Array.isArray(req.body?.certificateUrls)
          ? req.body.certificateUrls
              .map(String)
              .map((u) => u.trim())
              .filter(Boolean)
              .slice(0, CERT_MAX)
          : [];

        const phone = String(req.body?.phone || '').trim();
        const whatsapp = String(req.body?.whatsapp || '').trim();
        const email = String(req.body?.email || '').trim();
        if (!phone && !whatsapp && !email) {
          return res.status(400).json({
            message: 'أضف وسيلة تواصل واحدةً واحدةً على الأقل (جوال / واتساب / بريد)',
          });
        }

        const expertId = existing?.id || id();
        const autoApprove = privileged.isPrivilegedUser(req.authUser);
        const expert = {
          id: expertId,
          userId,
          displayName,
          city: String(req.body?.city || '').trim(),
          bio,
          bioMode,
          achievements: String(req.body?.achievements || '').trim(),
          specialties,
          avatarUrl: String(req.body?.avatarUrl || '').trim(),
          phone,
          whatsapp,
          email,
          idCardUrl,
          certificateUrls: certificates,
          status: autoApprove ? 'approved' : 'pending',
          verified: autoApprove,
          trustBadge: autoApprove ? 'verified' : null,
          acceptingRequests: true,
          adminRating: null,
          adminRatingNote: '',
          approvedAt: autoApprove
            ? new Date().toISOString()
            : existing?.approvedAt || null,
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        store.experts.set(expertId, expert);
        saveStore();
        res.status(201).json(publicExpert(expert, { includePrivate: true }));
      });

      app.post('/experts/requests', auth, requireSessionUser, (req, res) => {
        const expertId = String(req.body?.expertId || '').trim();
        const expert = store.experts.get(expertId);
        if (!expert || expert.status !== 'approved') {
          return res.status(404).json({ message: 'الخبير غير متاح' });
        }
        if (expert.acceptingRequests === false) {
          return res.status(400).json({
            message: 'هذا الخبير لا يستقبل طلبات رأي حالياً',
          });
        }
        const listingId = String(req.body?.listingId || '').trim();
        const videoId = String(req.body?.videoId || '').trim();
        if (!listingId && !videoId) {
          return res.status(400).json({ message: 'اربط الطلب بإعلان أو فيديو' });
        }
        const message = String(req.body?.message || '').trim();
        if (!message) {
          return res.status(400).json({ message: 'اكتب سؤالك للخبير' });
        }

        const requestId = id();
        const row = {
          id: requestId,
          expertId,
          expertUserId: expert.userId,
          fromUserId: req.authUserId,
          listingId: listingId || null,
          videoId: videoId || null,
          species: String(req.body?.species || '').trim() || null,
          message,
          status: 'open',
          reply: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        store.expertRequests.set(requestId, row);
        if (typeof notifyEvent === 'function' && expert.userId) {
          notifyEvent(
            expert.userId,
            'طلب رأي خبير جديد',
            message.slice(0, 120),
            { type: 'expert_request', requestId, status: 'open' },
          );
        }
        saveStore();
        res.status(201).json(row);
      });

      app.patch(
        '/experts/requests/:id/reply',
        auth,
        requireSessionUser,
        (req, res) => {
          const row = store.expertRequests.get(req.params.id);
          if (!row) return res.status(404).json({ message: 'الطلب غير موجود' });
          const myExpert = [...store.experts.values()].find(
            (e) =>
              String(e.userId) === String(req.authUserId) &&
              e.status === 'approved' &&
              String(e.id) === String(row.expertId),
          );
          if (!myExpert) {
            return res
              .status(403)
              .json({ message: 'فقط الخبير المعتمد يمكنه الرد' });
          }
          if (String(row.status) !== 'open') {
            return res.status(400).json({ message: 'الطلب مغلق ولا يقبل رداً' });
          }
          const reply = String(req.body?.reply || '').trim();
          if (!reply) {
            return res.status(400).json({ message: 'نص الرد مطلوب' });
          }
          row.reply = reply;
          row.status = 'replied';
          row.updatedAt = new Date().toISOString();
          store.expertRequests.set(row.id, row);
          if (typeof notifyEvent === 'function' && row.fromUserId) {
            notifyEvent(
              row.fromUserId,
              'رد من الخبير',
              reply.slice(0, 160),
              { type: 'expert_request', requestId: row.id, status: 'replied' },
            );
          }
          saveStore();
          res.json(row);
        },
      );

      app.patch(
        '/experts/requests/:id/reject',
        auth,
        requireSessionUser,
        (req, res) => {
          const row = store.expertRequests.get(req.params.id);
          if (!row) return res.status(404).json({ message: 'الطلب غير موجود' });
          const myExpert = [...store.experts.values()].find(
            (e) =>
              String(e.userId) === String(req.authUserId) &&
              e.status === 'approved' &&
              String(e.id) === String(row.expertId),
          );
          if (!myExpert) {
            return res
              .status(403)
              .json({ message: 'فقط الخبير المعتمد يمكنه الرفض' });
          }
          if (String(row.status) !== 'open') {
            return res.status(400).json({ message: 'الطلب مغلق' });
          }
          row.status = 'rejected';
          row.reply = String(req.body?.reason || '').trim() || null;
          row.updatedAt = new Date().toISOString();
          store.expertRequests.set(row.id, row);
          if (typeof notifyEvent === 'function' && row.fromUserId) {
            notifyEvent(
              row.fromUserId,
              'اعتذر الخبير عن الطلب',
              row.reply || '',
              { type: 'expert_request', requestId: row.id, status: 'rejected' },
            );
          }
          saveStore();
          res.json(row);
        },
      );

      /**
       * تقييم عميل واحد لكل خبير (يُحدَّث إن أعاد التقييم).
       * نجوم 1–5 + تعليق اختياري.
       */
      app.post(
        '/experts/:id/ratings',
        auth,
        requireSessionUser,
        (req, res) => {
          ensureRatingsStore(store);
          const expert = store.experts.get(req.params.id);
          if (!expert || expert.status !== 'approved') {
            return res.status(404).json({ message: 'الخبير غير موجود' });
          }
          if (String(expert.userId) === String(req.authUserId)) {
            return res.status(400).json({ message: 'لا يمكنك تقييم نفسك' });
          }
          const stars = Number(req.body?.stars);
          if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
            return res.status(400).json({ message: 'التقييم من 1 إلى 5 نجوم' });
          }
          const comment = String(req.body?.comment || '').trim().slice(0, 500);
          const existing = [...store.expertRatings.values()].find(
            (r) =>
              String(r.expertId) === String(expert.id) &&
              String(r.fromUserId) === String(req.authUserId) &&
              r.source === 'client',
          );
          const now = new Date().toISOString();
          if (existing) {
            existing.stars = Math.round(stars);
            existing.comment = comment;
            existing.updatedAt = now;
            store.expertRatings.set(existing.id, existing);
            saveStore();
            return res.json({
              rating: existing,
              expert: publicExpert(expert),
            });
          }
          const ratingId = id();
          const row = {
            id: ratingId,
            expertId: expert.id,
            fromUserId: req.authUserId,
            source: 'client',
            stars: Math.round(stars),
            comment,
            createdAt: now,
            updatedAt: now,
          };
          store.expertRatings.set(ratingId, row);
          saveStore();
          res.status(201).json({
            rating: row,
            expert: publicExpert(expert),
          });
        },
      );

      app.get('/experts/:id/my-rating', auth, requireSessionUser, (req, res) => {
        ensureRatingsStore(store);
        const row = [...store.expertRatings.values()].find(
          (r) =>
            String(r.expertId) === String(req.params.id) &&
            String(r.fromUserId) === String(req.authUserId) &&
            r.source === 'client',
        );
        res.json(row || null);
      });

      app.get('/experts/:id', (req, res) => {
        const e = store.experts.get(req.params.id);
        if (!e || e.status !== 'approved') {
          return res.status(404).json({ message: 'الخبير غير موجود' });
        }
        res.json(publicExpert(e));
      });
    },
  };
}

module.exports = { createExpertsApi, BIO_SHORT_MAX, BIO_LONG_MAX };
