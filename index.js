/**
 * باك اند تطبيق العاديات - عرض وبيع الخيل
 * يعمل على المنفذ 4000
 * واجهات API متوافقة مع تطبيق Flutter (lib/core/services/backend/*)
 * توثيق API: http://localhost:4000/api-docs
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');

let swaggerDocument;
try {
  swaggerDocument = JSON.parse(fs.readFileSync('./swagger.json', 'utf8'));
} catch (e) {
  swaggerDocument = {
    openapi: '3.0.0',
    info: { title: 'Aladiyat API', version: '1.0.0', description: 'Backend API' },
    servers: [{ url: 'http://localhost:4000', description: 'Development' }],
    paths: {
      '/': { get: { summary: 'Health', responses: { 200: { description: 'OK' } } } },
      '/auth/login': { post: { summary: 'Login', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' } } } } } }, responses: { 200: { description: 'Token' } } } },
      '/auth/register': { post: { summary: 'Register', responses: { 201: { description: 'Created' } } } },
      '/horses': { get: { summary: 'List horses', responses: { 200: { description: 'List' } } } },
      '/users': { get: { summary: 'List users', responses: { 200: { description: 'List' } } } },
    },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  };
}

const app = express();
const PORT = process.env.PORT || 4000;

// مسار حفظ البيانات (يبقى الحساب بعد إعادة تشغيل الباك اند)
const DATA_DIR = './data';
const DATA_FILE = DATA_DIR + '/store.json';

// تخزين في الذاكرة + حفظ في ملف
const store = {
  users: new Map(),
  horses: new Map(),
  favorites: new Map(),
  bookings: new Map(),
  services: new Map(),
  videos: new Map(),
  videoComments: {}, // videoId -> [ { id, userId, text, createdAt } ]
  refreshTokens: new Map(),
};

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.users && typeof data.users === 'object') {
      store.users = new Map(Object.entries(data.users));
    }
    if (data.horses && typeof data.horses === 'object') {
      store.horses = new Map(Object.entries(data.horses));
    }
    if (data.favorites && typeof data.favorites === 'object') {
      store.favorites = new Map(Object.entries(data.favorites));
    }
    if (data.bookings && typeof data.bookings === 'object') {
      store.bookings = new Map(Object.entries(data.bookings));
    }
    if (data.services && typeof data.services === 'object') {
      store.services = new Map(Object.entries(data.services));
    }
    if (data.videos && typeof data.videos === 'object') {
      store.videos = new Map(Object.entries(data.videos));
    }
    if (data.videoComments && typeof data.videoComments === 'object') {
      store.videoComments = data.videoComments;
    }
    console.log('تم تحميل البيانات: ' + store.users.size + ' مستخدم، ' + store.horses.size + ' خيل');
  } catch (e) {
    console.log('لم يتم تحميل بيانات سابقة:', e.message);
  }
}

function saveStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = {
      users: Object.fromEntries(store.users),
      horses: Object.fromEntries(store.horses),
      favorites: Object.fromEntries(store.favorites),
      bookings: Object.fromEntries(store.bookings),
      services: Object.fromEntries(store.services),
      videos: Object.fromEntries(store.videos),
      videoComments: store.videoComments,
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('خطأ عند حفظ البيانات:', e.message);
  }
}

loadStore();

// توليد معرف فريد
const id = () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
// توكن بسيط (للاستبدال لاحقاً بـ JWT إن رغبت)
const token = () => `tk_${id()}`;

app.use(cors());
app.use(express.json());

// ملفات ثابتة (لوحة الإدارة)
app.use(express.static(path.join(__dirname, 'public')));

// تسجيل كل طلب وارد (للتشخيص: هل الطلب يصل من الآيفون؟)
app.use((req, res, next) => {
  const clientIp = req.ip || req.connection?.remoteAddress || '?';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} من ${clientIp}`);
  next();
});

// ========== Swagger API Docs (مثل الصور التي أرسلتها) ==========
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  explorer: true,
  customSiteTitle: 'باك اند العاديات - API',
}));

// ========== Health ==========
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'باك اند العاديات - يعمل', port: PORT });
});
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// ========== Auth ==========
app.post('/auth/register', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'البريد وكلمة المرور مطلوبان' });
  }
  const existing = [...store.users.values()].find(u => u.email === email);
  if (existing) {
    return res.status(400).json({ message: 'البريد مستخدم مسبقاً' });
  }
  const userId = id();
  store.users.set(userId, {
    id: userId,
    email,
    password,
    createdAt: new Date().toISOString(),
  });
  const idToken = token();
  const refreshToken = token();
  store.refreshTokens.set(refreshToken, { userId, email });
  saveStore();
  res.status(201).json({
    idToken,
    refreshToken,
    localId: userId,
    userId,
    email,
    expiresIn: 3600,
  });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'البريد وكلمة المرور مطلوبان' });
  }
  const user = [...store.users.values()].find(u => u.email === email);
  if (!user || user.password !== password) {
    return res.status(401).json({ message: 'البريد أو كلمة المرور غير صحيحة' });
  }
  const userId = user.id || user._id;
  const idToken = token();
  const refreshToken = token();
  store.refreshTokens.set(refreshToken, { userId, email });
  res.json({
    idToken,
    refreshToken,
    localId: userId,
    userId,
    email: user.email,
    expiresIn: 3600,
  });
});

app.post('/auth/forgot-password', (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ message: 'البريد الإلكتروني مطلوب' });
  }
  const user = [...store.users.values()].find(u => u.email === email);
  if (!user) {
    return res.status(404).json({ message: 'البريد الإلكتروني غير مسجل' });
  }
  res.json({ ok: true, message: 'تم إرسال رابط إعادة تعيين كلمة المرور' });
});

app.post('/auth/refresh', (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ message: 'refreshToken مطلوب' });
  }
  const data = store.refreshTokens.get(refreshToken);
  if (!data) {
    return res.status(401).json({ message: 'توكن غير صالح' });
  }
  const idToken = token();
  res.json({
    accessToken: idToken,
    idToken,
    refreshToken,
    expiresIn: 3600,
    expires_in: 3600,
  });
});

// ========== Middleware: التحقق من التوكن ==========
const auth = (req, res, next) => {
  const h = req.headers.authorization;
  const t = h && h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) {
    return res.status(401).json({ message: 'المصادقة مطلوبة' });
  }
  req.token = t;
  next();
};

// ========== Middleware: صلاحيات الإدارة (كلمة سر الإدارة) ==========
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin123';
const requireAdmin = (req, res, next) => {
  const key = req.headers['x-admin-key'] || req.query.adminKey || '';
  if (key !== ADMIN_SECRET) {
    return res.status(403).json({ message: 'صلاحية الإدارة مطلوبة' });
  }
  next();
};

// ========== Users ==========
app.get('/users', auth, (req, res) => {
  const list = [...store.users.values()].map(u => {
    const { password, ...rest } = u;
    return rest;
  });
  res.json(list);
});

app.get('/users/:id', auth, (req, res) => {
  const u = store.users.get(req.params.id);
  if (!u) return res.status(404).json({ message: 'المستخدم غير موجود' });
  const { password, ...rest } = u;
  res.json(rest);
});

app.put('/users/:id', auth, (req, res) => {
  const { id } = req.params;
  const body = { ...req.body, id, updatedAt: new Date().toISOString() };
  const existing = store.users.get(id);
  if (existing) {
    body.password = existing.password;
    store.users.set(id, body);
  } else {
    store.users.set(id, { ...body, password: '' });
  }
  saveStore();
  res.json(body);
});

app.patch('/users/:id', auth, (req, res) => {
  const { id } = req.params;
  const existing = store.users.get(id);
  if (!existing) return res.status(404).json({ message: 'المستخدم غير موجود' });
  const updated = { ...existing, ...req.body, id, updatedAt: new Date().toISOString() };
  store.users.set(id, updated);
  const { password, ...rest } = updated;
  saveStore();
  res.json(rest);
});

// ========== Horses ==========
// GET /horses بدون auth حتى يعمل "دخول تجريبي" وعرض الخيل للجميع
app.get('/horses', (req, res) => {
  const { type, gender, city, minPrice, maxPrice, sortBy, limit, species } = req.query;
  let list = [...store.horses.values()];
  // فئة المنصة: horse | camel | falcon — البيانات القديمة تُعامل كـ horse
  if (species) {
    list = list.filter((h) => (h.species || 'horse') === species);
  }
  if (type) list = list.filter(h => h.type === type);
  if (gender) list = list.filter(h => h.gender === gender);
  if (city) list = list.filter(h => h.city === city);
  const num = (v) => (v == null ? null : Number(v));
  if (num(minPrice) != null) list = list.filter(h => Number(h.price) >= num(minPrice));
  if (num(maxPrice) != null) list = list.filter(h => Number(h.price) <= num(maxPrice));
  if (sortBy === 'price_asc') list.sort((a, b) => Number(a.price) - Number(b.price));
  if (sortBy === 'price_desc') list.sort((a, b) => Number(b.price) - Number(a.price));
  if (limit) list = list.slice(0, Number(limit));
  res.json(list);
});

app.get('/horses/:id', auth, (req, res) => {
  const h = store.horses.get(req.params.id);
  if (!h) return res.status(404).json({ message: 'الخيل غير موجود' });
  res.json(h);
});

app.post('/horses', auth, (req, res) => {
  const horseId = id();
  const horse = { id: horseId, ...req.body, createdAt: new Date().toISOString() };
  store.horses.set(horseId, horse);
  saveStore();
  res.status(201).json(horse);
});

app.patch('/horses/:id', auth, (req, res) => {
  const { id } = req.params;
  const existing = store.horses.get(id);
  if (!existing) return res.status(404).json({ message: 'الخيل غير موجود' });
  const updated = { ...existing, ...req.body, id, updatedAt: new Date().toISOString() };
  if (req.body.stats && typeof req.body.stats === 'object') {
    updated.stats = { ...(existing.stats || {}), ...req.body.stats };
  }
  store.horses.set(id, updated);
  saveStore();
  res.json(updated);
});

// ========== Favorites ==========
app.get('/favorites/:userId', auth, (req, res) => {
  const fav = store.favorites.get(req.params.userId) || { horseIds: [] };
  res.json({ horseIds: fav.horseIds || [], horse_ids: fav.horseIds || [] });
});

app.patch('/favorites/:userId', auth, (req, res) => {
  const { userId } = req.params;
  const horseIds = req.body.horseIds || req.body.horse_ids || [];
  store.favorites.set(userId, { userId, horseIds, updatedAt: new Date().toISOString() });
  res.json({ horseIds });
});

app.post('/favorites/:userId/items', auth, (req, res) => {
  const { userId } = req.params;
  const { horseId } = req.body || {};
  const fav = store.favorites.get(userId) || { horseIds: [] };
  const horseIds = [...(fav.horseIds || [])];
  if (horseId && !horseIds.includes(horseId)) horseIds.push(horseId);
  store.favorites.set(userId, { userId, horseIds, updatedAt: new Date().toISOString() });
  res.status(201).json({ horseIds });
});

app.delete('/favorites/:userId/items/:horseId', auth, (req, res) => {
  const { userId, horseId } = req.params;
  const fav = store.favorites.get(userId) || { horseIds: [] };
  const horseIds = (fav.horseIds || []).filter(id => id !== horseId);
  store.favorites.set(userId, { userId, horseIds, updatedAt: new Date().toISOString() });
  res.json({ horseIds });
});

// ========== Bookings ==========
app.get('/bookings', auth, (req, res) => {
  const { providerId, status } = req.query;
  let list = [...store.bookings.values()];
  if (providerId) list = list.filter(b => b.providerId === providerId);
  if (status) list = list.filter(b => b.status === status);
  res.json(list);
});

app.post('/bookings', auth, (req, res) => {
  const bookingId = id();
  const booking = { id: bookingId, ...req.body, createdAt: new Date().toISOString() };
  store.bookings.set(bookingId, booking);
  res.status(201).json(booking);
});

app.patch('/bookings/:id', auth, (req, res) => {
  const { id } = req.params;
  const existing = store.bookings.get(id);
  if (!existing) return res.status(404).json({ message: 'الحجز غير موجود' });
  const updated = { ...existing, ...req.body, id, updatedAt: new Date().toISOString() };
  store.bookings.set(id, updated);
  res.json(updated);
});

// ========== Services ==========
app.get('/services', auth, (req, res) => {
  const { type, providerId } = req.query;
  let list = [...store.services.values()];
  if (type) list = list.filter(s => s.type === type);
  if (providerId) list = list.filter(s => s.providerId === providerId);
  res.json(list);
});

app.post('/services', auth, (req, res) => {
  const serviceId = id();
  const service = { id: serviceId, ...req.body, createdAt: new Date().toISOString() };
  store.services.set(serviceId, service);
  res.status(201).json(service);
});

app.patch('/services/:id', auth, (req, res) => {
  const { id } = req.params;
  const existing = store.services.get(id);
  if (!existing) return res.status(404).json({ message: 'الخدمة غير موجودة' });
  const updated = { ...existing, ...req.body, id, updatedAt: new Date().toISOString() };
  store.services.set(id, updated);
  res.json(updated);
});

app.delete('/services/:id', auth, (req, res) => {
  const { id } = req.params;
  if (!store.services.has(id)) return res.status(404).json({ message: 'الخدمة غير موجودة' });
  store.services.delete(id);
  res.status(200).send();
});

// ========== Videos ==========
app.get('/videos', auth, (req, res) => {
  const { type, q, sort, serviceCategory, targetSpecies } = req.query;
  let list = [...store.videos.values()];
  if (type) list = list.filter((v) => v.type === type);

  const qq = q != null ? String(q).trim() : '';
  if (qq) {
    const lower = qq.toLowerCase();
    list = list.filter((v) => {
      const title = String(v.title ?? v.name ?? v.serviceName ?? '').toLowerCase();
      const desc = String(v.description ?? '').toLowerCase();
      return title.includes(lower) || desc.includes(lower);
    });
  }

  const cat = serviceCategory != null ? String(serviceCategory) : '';
  if (cat && cat !== 'all') {
    list = list.filter(
      (v) => v.serviceCategory === cat || v.serviceType === cat,
    );
  }

  const ts = targetSpecies != null ? String(targetSpecies) : '';
  if (ts && ts !== 'all') {
    list = list.filter((v) => {
      const x = v.targetSpecies ?? v.applicableSpecies;
      if (x == null || x === '') return true;
      if (Array.isArray(x)) return x.includes(ts) || x.includes('all');
      return String(x) === ts || String(x) === 'all';
    });
  }

  list = list.map((v) => ({
    ...v,
    likes: v.likes ?? 0,
    views: v.views ?? 0,
    favorites: v.favorites ?? 0,
    comments: v.comments ?? (store.videoComments[v.id] || []).length,
  }));

  const sortKey = sort != null ? String(sort) : 'newest';
  const t = (x) => {
    const d = x.createdAt ? new Date(x.createdAt).getTime() : 0;
    return Number.isFinite(d) ? d : 0;
  };
  if (sortKey === 'oldest') {
    list.sort((a, b) => t(a) - t(b));
  } else if (sortKey === 'views_desc') {
    list.sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  } else if (sortKey === 'likes_desc') {
    list.sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
  } else {
    list.sort((a, b) => t(b) - t(a));
  }

  res.json(list);
});

app.post('/videos', auth, (req, res) => {
  const videoId = req.body.cloudflareVideoId || id();
  const video = {
    id: videoId,
    ...req.body,
    createdAt: new Date().toISOString(),
    likes: req.body.likes ?? 0,
    likedBy: req.body.likedBy ?? [],
    favorites: req.body.favorites ?? 0,
    favoritedBy: req.body.favoritedBy ?? [],
    views: req.body.views ?? 0,
    comments: req.body.comments ?? 0,
  };
  store.videos.set(videoId, video);
  saveStore();
  res.status(201).json(video);
});

app.patch('/videos/:id', auth, (req, res) => {
  const { id } = req.params;
  const existing = store.videos.get(id);
  if (!existing) return res.status(404).json({ message: 'الفيديو غير موجود' });
  const updated = { ...existing, ...req.body, id };
  store.videos.set(id, updated);
  res.json(updated);
});

app.patch('/videos/:id/likes', auth, (req, res) => {
  const { id } = req.params;
  const { userId, isLiked } = req.body || {};
  const video = store.videos.get(id);
  if (!video) return res.status(404).json({ message: 'الفيديو غير موجود' });
  const likedBy = Array.isArray(video.likedBy) ? video.likedBy : [];
  const hadLiked = likedBy.includes(userId);
  if (isLiked && !hadLiked) {
    likedBy.push(userId);
    video.likes = (video.likes || 0) + 1;
  } else if (!isLiked && hadLiked) {
    video.likedBy = likedBy.filter((u) => u !== userId);
    video.likes = Math.max(0, (video.likes || 0) - 1);
    store.videos.set(id, video);
    saveStore();
    return res.json({ ok: true });
  }
  video.likedBy = likedBy;
  store.videos.set(id, video);
  saveStore();
  res.json({ ok: true });
});

app.patch('/videos/:id/favorites', auth, (req, res) => {
  const { id } = req.params;
  const { userId, isFavorite } = req.body || {};
  const video = store.videos.get(id);
  if (!video) return res.status(404).json({ message: 'الفيديو غير موجود' });
  const favoritedBy = Array.isArray(video.favoritedBy) ? video.favoritedBy : [];
  const hadFav = favoritedBy.includes(userId);
  if (isFavorite && !hadFav) {
    favoritedBy.push(userId);
    video.favorites = (video.favorites || 0) + 1;
  } else if (!isFavorite && hadFav) {
    video.favoritedBy = favoritedBy.filter((u) => u !== userId);
    video.favorites = Math.max(0, (video.favorites || 0) - 1);
    store.videos.set(id, video);
    saveStore();
    return res.json({ ok: true });
  }
  video.favoritedBy = favoritedBy;
  store.videos.set(id, video);
  saveStore();
  res.json({ ok: true });
});

app.patch('/videos/:id/views', auth, (req, res) => {
  const { id } = req.params;
  const video = store.videos.get(id);
  if (!video) return res.status(404).json({ message: 'الفيديو غير موجود' });
  video.views = (video.views || 0) + 1;
  store.videos.set(id, video);
  saveStore();
  res.json({ ok: true });
});

app.get('/videos/:id/like-status', auth, (req, res) => {
  const { id } = req.params;
  const userId = req.query.userId;
  const video = store.videos.get(id);
  if (!video) return res.status(404).json({ message: 'الفيديو غير موجود' });
  const likedBy = Array.isArray(video.likedBy) ? video.likedBy : [];
  res.json({ isLiked: userId ? likedBy.includes(userId) : false });
});

app.get('/videos/:id/favorite-status', auth, (req, res) => {
  const { id } = req.params;
  const userId = req.query.userId;
  const video = store.videos.get(id);
  if (!video) return res.status(404).json({ message: 'الفيديو غير موجود' });
  const favoritedBy = Array.isArray(video.favoritedBy) ? video.favoritedBy : [];
  res.json({ isFavorite: userId ? favoritedBy.includes(userId) : false });
});

app.post('/videos/:id/comments', auth, (req, res) => {
  const videoId = req.params.id;
  const { userId, text } = req.body || {};
  const video = store.videos.get(videoId);
  if (!video) return res.status(404).json({ message: 'الفيديو غير موجود' });
  if (!store.videoComments[videoId]) store.videoComments[videoId] = [];
  const comment = {
    id: id(),
    userId: userId || '',
    text: text || '',
    createdAt: new Date().toISOString(),
  };
  store.videoComments[videoId].push(comment);
  video.comments = (video.comments || 0) + 1;
  store.videos.set(videoId, video);
  saveStore();
  res.status(201).json(comment);
});

app.get('/videos/:id/comments', auth, (req, res) => {
  const videoId = req.params.id;
  const list = store.videoComments[videoId] || [];
  res.json(list);
});

app.patch('/videos/:id/shares', auth, (req, res) => res.json({ ok: true }));

// ========== إدارة - لوحة التحكم وتصدير البيانات ==========
// لوحة إدارة تفاعلية: افتح في المتصفح http://localhost:4000/admin
app.get('/admin', (req, res) => {
  res.redirect('/admin.html');
});

// GET /admin/data  → يرجع كل البيانات (يتطلب X-Admin-Key)
app.get('/admin/data', requireAdmin, (req, res) => {
  const data = {
    users: Object.fromEntries(store.users),
    horses: Object.fromEntries(store.horses),
    favorites: Object.fromEntries(store.favorites),
    bookings: Object.fromEntries(store.bookings),
    services: Object.fromEntries(store.services),
    videos: Object.fromEntries(store.videos),
    videoComments: store.videoComments,
  };
  res.json(data);
});

// ========== إدارة: حذف وتعديل (صلاحيات مطلقة) ==========
// المستخدمون
app.delete('/admin/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!store.users.has(id)) return res.status(404).json({ message: 'المستخدم غير موجود' });
  store.users.delete(id);
  saveStore();
  res.json({ ok: true, message: 'تم حذف المستخدم' });
});
app.patch('/admin/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const existing = store.users.get(id);
  if (!existing) return res.status(404).json({ message: 'المستخدم غير موجود' });
  const updated = { ...existing, ...req.body, id, updatedAt: new Date().toISOString() };
  store.users.set(id, updated);
  saveStore();
  const { password, ...rest } = updated;
  res.json(rest);
});

// الخيل
app.delete('/admin/horses/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!store.horses.has(id)) return res.status(404).json({ message: 'الخيل غير موجود' });
  store.horses.delete(id);
  saveStore();
  res.json({ ok: true, message: 'تم حذف الخيل' });
});
app.patch('/admin/horses/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const existing = store.horses.get(id);
  if (!existing) return res.status(404).json({ message: 'الخيل غير موجود' });
  const updated = { ...existing, ...req.body, id, updatedAt: new Date().toISOString() };
  if (req.body.stats && typeof req.body.stats === 'object') {
    updated.stats = { ...(existing.stats || {}), ...req.body.stats };
  }
  store.horses.set(id, updated);
  saveStore();
  res.json(updated);
});

// الفيديوهات
app.delete('/admin/videos/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!store.videos.has(id)) return res.status(404).json({ message: 'الفيديو غير موجود' });
  store.videos.delete(id);
  if (store.videoComments[id]) delete store.videoComments[id];
  saveStore();
  res.json({ ok: true, message: 'تم حذف الفيديو' });
});
app.patch('/admin/videos/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const existing = store.videos.get(id);
  if (!existing) return res.status(404).json({ message: 'الفيديو غير موجود' });
  const updated = { ...existing, ...req.body, id, updatedAt: new Date().toISOString() };
  store.videos.set(id, updated);
  saveStore();
  res.json(updated);
});

// تعليق فيديو واحد
app.delete('/admin/videos/:videoId/comments/:commentId', requireAdmin, (req, res) => {
  const { videoId, commentId } = req.params;
  const list = store.videoComments[videoId];
  if (!Array.isArray(list)) return res.status(404).json({ message: 'التعليق غير موجود' });
  const idx = list.findIndex(c => c.id === commentId);
  if (idx === -1) return res.status(404).json({ message: 'التعليق غير موجود' });
  list.splice(idx, 1);
  const video = store.videos.get(videoId);
  if (video) {
    video.comments = Math.max(0, (video.comments || 0) - 1);
    store.videos.set(videoId, video);
  }
  saveStore();
  res.json({ ok: true, message: 'تم حذف التعليق' });
});

// الحجوزات والخدمات (حذف إن وُجد)
app.delete('/admin/bookings/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!store.bookings.has(id)) return res.status(404).json({ message: 'الحجز غير موجود' });
  store.bookings.delete(id);
  saveStore();
  res.json({ ok: true, message: 'تم حذف الحجز' });
});
app.delete('/admin/services/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!store.services.has(id)) return res.status(404).json({ message: 'الخدمة غير موجودة' });
  store.services.delete(id);
  saveStore();
  res.json({ ok: true, message: 'تم حذف الخدمة' });
});

// ========== تشغيل الخادم ==========
// استماع على 0.0.0.0 ليقبل اتصالات من الجهاز الفعلي (iPhone/Android) على نفس الشبكة
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`باك اند العاديات يعمل على http://localhost:${PORT}`);
  console.log(`للجهاز الفعلي على نفس الواي فاي: http://horse-backend.local:${PORT} (mDNS)`);
  console.log(`توثيق API (Swagger): http://localhost:${PORT}/api-docs`);
  // إعلان mDNS حتى يصل الآيفون عبر horse-backend.local بدون إدخال IP
  try {
    const bonjour = require('bonjour')();
    bonjour.publish({ name: 'horse-backend', type: 'http', port: PORT });
  } catch (e) {
    console.log('تحذير: mDNS غير متوفر:', e.message);
  }
});
