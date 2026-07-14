/**
 * باك اند تطبيق العاديات - عرض وبيع الخيل
 * يعمل على المنفذ 4000
 * واجهات API متوافقة مع تطبيق Flutter (lib/core/services/backend/*)
 * توثيق API: http://localhost:4000/api-docs
 */

const SHEEP_FEATURES_ENABLED = false;
const SHEEP_PAUSED_MESSAGE =
  'خدمات الأغنام متوقفة مؤقتاً في المرحلة الأولى. نركز حالياً على الخيل والإبل والصقور.';

function isSheepSpecies(value) {
  return String(value || '')
    .trim()
    .toLowerCase() === 'sheep';
}

function rejectSheepPaused(res) {
  if (SHEEP_FEATURES_ENABLED) return false;
  res.status(403).json({ message: SHEEP_PAUSED_MESSAGE });
  return true;
}

function stripSheepListings(list) {
  if (SHEEP_FEATURES_ENABLED) return list;
  return list.filter((item) => !isSheepSpecies(item.species || item.type));
}

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const roles = require('./account_roles');
const { validateSheepListing } = require('./sheep_listing');
const { registerAccountLifecycleRoutes } = require('./account_lifecycle');
const {
  registerContentModerationRoutes,
  isTargetHiddenForUser,
  isUserBlocked,
  ensureModerationStore,
} = require('./content_moderation');
const bookingOccupancy = require('./booking_occupancy');
const marketplaceCommerce = require('./marketplace_commerce');
const opsNotify = require('./ops_notify');

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

// مسار حفظ البيانات — محلياً: ./data | على Render: قرص دائم /var/data (انظر render.yaml)
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const LEGACY_DATA_FILE = path.join(__dirname, 'data', 'store.json');
const PERSISTENT_DATA_DIR = '/var/data';

function isPersistentProductionStorage() {
  return path.resolve(DATA_DIR) === path.resolve(PERSISTENT_DATA_DIR);
}

function storagePersistenceStatus() {
  const inProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const persistent = isPersistentProductionStorage();
  return {
    dataDir: DATA_DIR,
    dataFile: DATA_FILE,
    dataFileExists: fs.existsSync(DATA_FILE),
    persistent,
    inProduction,
    warning: inProduction && !persistent
      ? 'البيانات تُحفظ في مسار مؤقت — كل نشر جديد يمسح المستخدمين والفيديوهات. فعّل DATA_DIR=/var/data وقرصاً دائماً على Render (خطة Starter).'
      : null,
  };
}
const VERIFICATION_DIR = path.join(DATA_DIR, 'verification');
const ADMIN_JWT_SECRET =
  process.env.ADMIN_JWT_SECRET || process.env.ADMIN_SECRET || 'nomas-admin-jwt-change-me';
const { createAdminRouter, registerAppVerificationRoutes } = require('./admin/routes');
const { seedSuperAdmin } = require('./admin/auth');
const heritageTB = require('./heritage_tags_badges');
const { createExpertsApi } = require('./experts');

function ensureDataMigrated() {
  if (fs.existsSync(DATA_FILE)) return;
  if (path.resolve(DATA_FILE) === path.resolve(LEGACY_DATA_FILE)) return;
  if (!fs.existsSync(LEGACY_DATA_FILE)) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(LEGACY_DATA_FILE, DATA_FILE);
    console.log(`[store] نسخ البيانات: ${LEGACY_DATA_FILE} → ${DATA_FILE}`);
  } catch (e) {
    console.warn('[store] تعذر نسخ البيانات القديمة:', e.message);
  }
}

// تخزين في الذاكرة + حفظ في ملف
const store = {
  users: new Map(),
  horses: new Map(),
  favorites: new Map(),
  bookings: new Map(),
  services: new Map(),
  /** منتجات الكتالوج — category: feed | supplies | equipment */
  catalogItems: new Map(),
  /** userId → { items: [{ catalogItemId, quantity, snapshot }] } */
  carts: new Map(),
  /** طلبات تجارة الأدوات (منفصلة عن bookings) */
  orders: new Map(),
  videos: new Map(),
  videoComments: {}, // videoId -> [ { id, userId, text, createdAt } ]
  /** @type {{ id: string, fromUserId: string, toUserId: string, text: string, createdAt: string, read?: boolean }[]} */
  messages: [],
  /** @type {{ id: string, reporterId: string, targetType: string, targetId: string, reason: string, status: string, createdAt: string }[]} */
  contentReports: [],
  refreshTokens: new Map(),
  /** @type {Map<string, { userId: string }>} idToken (Bearer) → مستخدم الجلسة */
  accessTokens: new Map(),
  /** فريق الإدارة */
  adminUsers: new Map(),
  /** سجل تدقيق */
  auditEvents: [],
  /** مقاييس API */
  apiMetrics: { routes: {}, recent: [] },
  /** خبراء معتمدون */
  experts: new Map(),
  /** طلبات رأي خبير */
  expertRequests: new Map(),
  /** تقييمات الخبراء — مفتاح: ratingId */
  expertRatings: new Map(),
  /** اهتمامات تواصل أعلاف/معدات — id → lead */
  contactLeads: new Map(),
};

/** رموز OTP وإعداد الحساب (ذاكرة — تُعاد إرسالها عند الحاجة) */
const otpCodes = new Map();
const setupTokens = new Map();
const OTP_TTL_MS = 5 * 60 * 1000;

const smsOtp = require('./sms');
const otpDev = require('./otp_dev');

/** إظهار الرمز على الشاشة — للتطوير فقط. يُعطَّل تلقائياً عند تفعيل SMS. */
function shouldExposeOtpCode() {
  return smsOtp.exposeDevCodeOnScreen();
}
const SETUP_TTL_MS = 30 * 60 * 1000;

function applyStoreSnapshot(data, sourceLabel) {
  if (!data || typeof data !== 'object') {
    throw new Error('ملف البيانات غير صالح');
  }
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
  if (data.catalogItems && typeof data.catalogItems === 'object') {
    store.catalogItems = new Map(Object.entries(data.catalogItems));
  }
  if (data.carts && typeof data.carts === 'object') {
    store.carts = new Map(Object.entries(data.carts));
  }
  if (data.orders && typeof data.orders === 'object') {
    store.orders = new Map(Object.entries(data.orders));
  }
  if (data.videos && typeof data.videos === 'object') {
    store.videos = new Map(Object.entries(data.videos));
  }
  if (data.videoComments && typeof data.videoComments === 'object') {
    store.videoComments = data.videoComments;
  }
  if (Array.isArray(data.messages)) {
    store.messages = data.messages;
  } else {
    store.messages = [];
  }
  if (Array.isArray(data.contentReports)) {
    store.contentReports = data.contentReports;
  } else {
    store.contentReports = [];
  }
  if (data.accessTokens && typeof data.accessTokens === 'object') {
    store.accessTokens = new Map(
      Object.entries(data.accessTokens).map(([k, v]) => [
        k,
        typeof v === 'object' && v && v.userId ? { userId: String(v.userId) } : { userId: '' },
      ]),
    );
  } else {
    store.accessTokens = new Map();
  }
  if (data.adminUsers && typeof data.adminUsers === 'object') {
    store.adminUsers = new Map(Object.entries(data.adminUsers));
  } else {
    store.adminUsers = new Map();
  }
  if (Array.isArray(data.auditEvents)) {
    store.auditEvents = data.auditEvents;
  } else {
    store.auditEvents = [];
  }
  if (data.apiMetrics && typeof data.apiMetrics === 'object') {
    store.apiMetrics = data.apiMetrics;
  }
  if (data.experts && typeof data.experts === 'object') {
    store.experts = new Map(Object.entries(data.experts));
  } else {
    store.experts = new Map();
  }
  if (data.expertRequests && typeof data.expertRequests === 'object') {
    store.expertRequests = new Map(Object.entries(data.expertRequests));
  } else {
    store.expertRequests = new Map();
  }
  if (data.expertRatings && typeof data.expertRatings === 'object') {
    store.expertRatings = new Map(Object.entries(data.expertRatings));
  } else {
    store.expertRatings = new Map();
  }
  if (data.contactLeads && typeof data.contactLeads === 'object') {
    store.contactLeads = new Map(Object.entries(data.contactLeads));
  } else if (!store.contactLeads) {
    store.contactLeads = new Map();
  }
  ensureModerationStore(store);
  const catalogN = store.catalogItems.size;
  const videoN = store.videos.size;
  console.log(
    `[store] محمّل من ${sourceLabel}: ${store.users.size} مستخدم، ${store.horses.size} خيل، ${catalogN} كتالوج، ${videoN} فيديو`,
  );
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    applyStoreSnapshot(JSON.parse(raw), DATA_FILE);
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
      catalogItems: Object.fromEntries(store.catalogItems),
      carts: Object.fromEntries(store.carts),
      orders: Object.fromEntries(store.orders),
      videos: Object.fromEntries(store.videos),
      videoComments: store.videoComments,
      messages: store.messages,
      accessTokens: Object.fromEntries(store.accessTokens),
      adminUsers: Object.fromEntries(store.adminUsers),
      auditEvents: store.auditEvents,
      apiMetrics: store.apiMetrics,
      contentReports: store.contentReports,
      experts: Object.fromEntries(store.experts),
      expertRequests: Object.fromEntries(store.expertRequests),
      expertRatings: Object.fromEntries(store.expertRatings),
      contactLeads: Object.fromEntries(store.contactLeads || []),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('خطأ عند حفظ البيانات:', e.message);
  }
}

ensureDataMigrated();
ensureModerationStore(store);
if (!fs.existsSync(VERIFICATION_DIR)) {
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
}
loadStore();
const persistence = storagePersistenceStatus();
if (persistence.warning) {
  console.error(`[store] تحذير: ${persistence.warning}`);
}

// توليد معرف فريد
const id = () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

function notifyEvent(userId, title, body, meta) {
  return opsNotify.notifyUser(
    { store, id },
    { userId, title, body, meta },
  );
}

function runLazyExpiry() {
  let dirty = false;
  if (bookingOccupancy.expireStalePendingBookings(store.bookings) > 0) {
    dirty = true;
  }
  if (
    store.expertRequests &&
    bookingOccupancy.expireStaleExpertRequests(store.expertRequests) > 0
  ) {
    dirty = true;
  }
  return dirty;
}

const adminCtx = {
  store,
  saveStore,
  id,
  roles,
  verificationDir: VERIFICATION_DIR,
  adminJwtSecret: ADMIN_JWT_SECRET,
  marketplaceCommerce,
  bookingOccupancy,
  notifyEvent,
};
seedSuperAdmin(adminCtx);

function otpSixDigits() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function findUserByPhone(phone) {
  const p = roles.normalizePhone(phone);
  if (!p) return null;
  return [...store.users.values()].find((u) => roles.normalizePhone(u.phone) === p) || null;
}

function issueAuthForUser(user) {
  const u = roles.migrateLegacyUser({ ...user });
  if (!u.id) u.id = id();
  store.users.set(u.id, u);
  const userId = u.id;
  const idToken = token();
  const refreshToken = token();
  store.refreshTokens.set(refreshToken, {
    userId,
    phone: u.phone || '',
    email: u.email || '',
  });
  store.accessTokens.set(idToken, { userId });
  saveStore();
  return {
    idToken,
    refreshToken,
    localId: userId,
    userId,
    email: u.email || '',
    phone: u.phone || '',
    accountRole: u.accountRole,
    allowedSpecies: u.allowedSpecies || [],
    capabilities: u.capabilities || [],
    needsOnboarding: !u.accountRole || !roles.isValidAccountRole(u.accountRole),
    expiresIn: 3600,
    user: roles.publicUser(u),
  };
}
// توكن بسيط (للاستبدال لاحقاً بـ JWT إن رغبت)
const token = () => `tk_${id()}`;

app.use(cors());
app.use(express.json());

// مقاييس زمن استجابة API
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/admin/v2') && req.path === '/health') return;
    const ms = Date.now() - start;
    const key = `${req.method} ${req.route?.path || req.path}`;
    if (!store.apiMetrics.routes[key]) {
      store.apiMetrics.routes[key] = { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
    }
    const r = store.apiMetrics.routes[key];
    r.count++;
    r.totalMs += ms;
    r.maxMs = Math.max(r.maxMs, ms);
    if (res.statusCode >= 400) r.errors++;
    if (!Array.isArray(store.apiMetrics.recent)) store.apiMetrics.recent = [];
    store.apiMetrics.recent.unshift({
      at: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms,
    });
    if (store.apiMetrics.recent.length > 500) store.apiMetrics.recent.length = 500;
  });
  next();
});

// ملفات ثابتة (لوحة الإدارة القديمة + الجديدة)
app.use(express.static(path.join(__dirname, 'public')));
const adminConsoleDir = path.join(__dirname, 'public', 'admin-console');
if (fs.existsSync(adminConsoleDir)) {
  app.use('/console', express.static(adminConsoleDir));
  app.get('/console/*', (req, res) => {
    res.sendFile(path.join(adminConsoleDir, 'index.html'));
  });
}

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
/**
 * جزء subdomain الخاص بـ Stream يظهر في كل روابط التشغيل العامة (customer-XXXX.cloudflarestream.com).
 * ضعه على Render كـ CLOUDFLARE_STREAM_CUSTOMER_HASH أو CLOUDFLARE_CUSTOMER_HASH — انسخه من رابط HLS في لوحة Stream.
 */
app.get('/media/public/stream-customer-hash', (req, res) => {
  const h =
    (process.env.CLOUDFLARE_STREAM_CUSTOMER_HASH ||
      process.env.CLOUDFLARE_CUSTOMER_HASH ||
      '').trim();
  if (!h) {
    return res.status(404).json({
      message:
        'CLOUDFLARE_STREAM_CUSTOMER_HASH غير مُعرّف على الخادم — من لوحة Cloudflare Stream انسخ الجزء بعد customer- من أي رابط تشغيل.',
    });
  }
  res.json({ customerHash: h });
});

app.get('/health', (req, res) => {
  const persistenceInfo = storagePersistenceStatus();
  res.json({
    ok: true,
    storage: {
      ...persistenceInfo,
      users: store.users.size,
      horses: store.horses.size,
      catalogItems: store.catalogItems.size,
      videos: store.videos.size,
    },
    sms: smsOtp.status(),
    otpDev: otpDev.status(),
  });
});

// ========== Middleware: التحقق من التوكن (يجب تعريفه قبل المسارات التي تستخدمه) ==========
const auth = (req, res, next) => {
  const h = req.headers.authorization;
  const t = h && h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) {
    return res.status(401).json({ message: 'المصادقة مطلوبة' });
  }
  req.token = t;
  next();
};

/** يثبت هوية حامل التوكن (يجب أن يكون idToken صادراً عن تسجيل الدخول / التجديد) */
function requireSessionUser(req, res, next) {
  const entry = store.accessTokens.get(req.token);
  if (!entry || !entry.userId) {
    return res.status(401).json({
      message: 'توكن الجلسة غير معروف — أعد تسجيل الدخول لاستخدام الرسائل أو تحديث الحجوزات',
    });
  }
  req.authUserId = String(entry.userId);
  const raw = store.users.get(req.authUserId);
  if (!raw) {
    return res.status(401).json({ message: 'المستخدم غير موجود — أعد تسجيل الدخول' });
  }
  req.authUser = roles.migrateLegacyUser({ ...raw });
  store.users.set(req.authUserId, req.authUser);
  next();
}

// لوحة الإدارة v2 API
app.use('/admin/v2', createAdminRouter(adminCtx));
registerAppVerificationRoutes(app, adminCtx, auth, requireSessionUser);
registerAccountLifecycleRoutes(app, { store, saveStore, auth, requireSessionUser });
registerContentModerationRoutes(app, { store, saveStore, id, auth, requireSessionUser });

const expertsApi = createExpertsApi({
  store,
  saveStore,
  id,
  auth,
  requireSessionUser,
  notifyEvent,
  bookingOccupancy,
});
expertsApi.registerAppRoutes(app);

function viewerFromToken(req) {
  const entry = store.accessTokens.get(req.token);
  if (!entry?.userId) return null;
  return store.users.get(String(entry.userId)) || null;
}

function filterListingsForViewer(list, viewer) {
  let out = list.filter((h) => !h.hidden && h.status !== 'removed');
  if (!viewer) return out;
  return out.filter((h) => {
    const ownerId = h.userId || h.ownerId || h.sellerId;
    if (isUserBlocked(viewer, ownerId)) return false;
    if (isTargetHiddenForUser(viewer, 'listing', h.id)) return false;
    return true;
  });
}

function filterVideosForViewer(list, viewer) {
  let out = list.filter((v) => !v.hidden && v.status !== 'removed');
  if (!viewer) return out;
  return out.filter((v) => {
    const ownerId = v.userId || v.ownerId;
    if (isUserBlocked(viewer, ownerId)) return false;
    if (isTargetHiddenForUser(viewer, 'video', v.id)) return false;
    return true;
  });
}

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
  const accountRole = roles.isValidAccountRole(req.body?.accountRole)
    ? req.body.accountRole
    : roles.ACCOUNT_ROLES.buyer;
  const userId = id();
  const user = roles.buildUserFromOnboarding({
    phone: '',
    accountRole,
    name: req.body?.name || '',
    city: req.body?.city || '',
    allowedSpecies: req.body?.allowedSpecies,
    businessType: req.body?.businessType,
  });
  user.id = userId;
  user.email = email;
  user.password = password;
  store.users.set(userId, roles.migrateLegacyUser(user));
  res.status(201).json(issueAuthForUser(store.users.get(userId)));
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
  const migrated = roles.migrateLegacyUser({ ...user });
  store.users.set(migrated.id, migrated);
  res.json(issueAuthForUser(migrated));
});

const countries = require('./countries');

// ========== Auth: جوال + OTP ==========
app.get('/auth/countries', (_req, res) => {
  res.json({
    defaultCountry: countries.DEFAULT_COUNTRY,
    countries: countries.listCountries(),
  });
});

app.post('/auth/otp/send', async (req, res) => {
  const countryCode = String(req.body?.countryCode || countries.DEFAULT_COUNTRY).toUpperCase();
  const phone = roles.normalizePhone(req.body?.phone, countryCode);
  if (!phone) {
    const c = countries.getCountry(countryCode);
    return res.status(400).json({
      message: `رقم الجوال غير صالح (${c.placeholder})`,
    });
  }
  const devBypassCode = otpDev.codeForPhone(phone);
  const code = devBypassCode || otpSixDigits();
  otpCodes.set(phone, { code, expiresAt: Date.now() + OTP_TTL_MS });

  if (devBypassCode) {
    console.log(`[OTP/DEV] ${phone} => رمز مطوّر (بدون SMS)`);
    const payload = {
      ok: true,
      smsSent: false,
      devBypass: true,
      message: 'تم تجهيز رمز التحقق — أدخل الرمز المخصص لحساب المطوّر',
    };
    if (otpDev.shouldExposeDevCodeInResponse()) {
      payload.devCode = devBypassCode;
      payload.showDevCodeOnScreen = true;
    }
    return res.json(payload);
  }

  try {
    let smsSent = false;
    if (smsOtp.isConfigured()) {
      const messageId = await smsOtp.sendOtpSms(phone, code);
      smsSent = true;
      console.log(`[OTP/SMS] طلب إرسال إلى ${phone} MessageId=${messageId || '?'}`);
    } else if (!shouldExposeOtpCode()) {
      const smsStatus = smsOtp.status();
      return res.status(503).json({
        message:
          smsStatus.hint ||
          'خدمة الرسائل غير مفعّلة. أضف Taqnyat (TAQNYAT_BEARER_TOKEN + TAQNYAT_SENDER) على Render.',
      });
    }

    const payload = {
      ok: true,
      smsSent,
      message: smsSent
        ? 'تم إرسال رمز التحقق برسالة نصية إلى جوالك'
        : 'تم إرسال رمز التحقق',
    };
    if (shouldExposeOtpCode()) {
      payload.devCode = code;
      payload.showDevCodeOnScreen = true;
      console.log(`[OTP/DEV] ${phone} => ${code}`);
    }
    res.json(payload);
  } catch (e) {
    console.error('[OTP/SMS] فشل الإرسال:', e.message || e);
    otpCodes.delete(phone);
    res.status(503).json({
      message: e.message || 'تعذّر إرسال الرسالة النصية. تحقق من Taqnyat (الوثائق، اسم المرسل NOMAS، الرصيد).',
    });
  }
});

app.post('/auth/otp/verify', (req, res) => {
  const countryCode = String(req.body?.countryCode || countries.DEFAULT_COUNTRY).toUpperCase();
  const phone = roles.normalizePhone(req.body?.phone, countryCode);
  const code = String(req.body?.code || '').trim();
  if (!phone || code.length < 4) {
    return res.status(400).json({ message: 'رقم الجوال ورمز التحقق مطلوبان' });
  }
  const entry = otpCodes.get(phone);
  if (!entry || entry.expiresAt < Date.now() || entry.code !== code) {
    return res.status(401).json({ message: 'رمز التحقق غير صحيح أو منتهي' });
  }
  otpCodes.delete(phone);
  const existing = findUserByPhone(phone);
  if (existing) {
    const migrated = roles.migrateLegacyUser({ ...existing });
    if (!migrated.phone) {
      migrated.phone = phone;
      store.users.set(migrated.id, migrated);
    }
    return res.json(issueAuthForUser(migrated));
  }
  const setupToken = token();
  setupTokens.set(setupToken, {
    phone,
    countryCode,
    expiresAt: Date.now() + SETUP_TTL_MS,
  });
  res.json({
    isNewUser: true,
    setupToken,
    phone,
    countryCode,
    message: 'اختر نوع الحساب لإكمال التسجيل',
  });
});

app.post('/auth/onboarding/complete', (req, res) => {
  const setupToken = String(req.body?.setupToken || '').trim();
  const accountRole = String(req.body?.accountRole || '').trim();
  if (!setupToken || !roles.isValidAccountRole(accountRole)) {
    return res.status(400).json({ message: 'نوع الحساب مطلوب' });
  }
  const pending = setupTokens.get(setupToken);
  if (!pending || pending.expiresAt < Date.now()) {
    return res.status(401).json({ message: 'انتهت جلسة التسجيل — أعد إرسال الرمز' });
  }
  setupTokens.delete(setupToken);
  if (findUserByPhone(pending.phone)) {
    return res.status(400).json({ message: 'رقم الجوال مسجل مسبقاً' });
  }
  const userId = id();
  const user = roles.buildUserFromOnboarding({
    phone: pending.phone,
    countryCode: pending.countryCode || countries.DEFAULT_COUNTRY,
    accountRole,
    name: req.body?.name,
    city: req.body?.city,
    allowedSpecies: req.body?.allowedSpecies,
    businessType: req.body?.businessType,
  });
  user.id = userId;
  user.phone = pending.phone;
  store.users.set(userId, roles.migrateLegacyUser(user));
  res.status(201).json(issueAuthForUser(store.users.get(userId)));
});

app.get('/auth/me', auth, requireSessionUser, (req, res) => {
  res.json({ user: roles.publicUser(req.authUser) });
});

app.get('/auth/account-roles', (req, res) => {
  res.json({
    roles: Object.entries(roles.ROLE_LABELS_AR).map(([id, labelAr]) => ({ id, labelAr })),
  });
});

/** تعيين نوع الحساب لمرة واحدة (مستخدم قديم مسجّل دخوله) */
app.post('/auth/account-role/set', auth, requireSessionUser, (req, res) => {
  const accountRole = String(req.body?.accountRole || '').trim();
  if (!roles.isValidAccountRole(accountRole)) {
    return res.status(400).json({ message: 'نوع الحساب غير صالح' });
  }
  const existing = req.authUser;
  if (existing.accountRoleSetAt) {
    return res.status(403).json({ message: 'تم تعيين نوع الحساب مسبقاً — تواصل مع الدعم للتغيير' });
  }
  const updated = roles.buildUserFromOnboarding({
    phone: existing.phone,
    accountRole,
    name: req.body?.name || existing.name,
    city: req.body?.city || existing.city,
    allowedSpecies: req.body?.allowedSpecies || existing.allowedSpecies,
    businessType: req.body?.businessType,
  });
  updated.id = existing.id;
  updated.email = existing.email;
  updated.password = existing.password;
  updated.phone = existing.phone || updated.phone;
  updated.accountRoleSetAt = new Date().toISOString();
  const migrated = roles.migrateLegacyUser(updated);
  store.users.set(migrated.id, migrated);
  saveStore();
  res.json(issueAuthForUser(migrated));
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
  store.accessTokens.set(idToken, { userId: data.userId });
  saveStore();
  res.json({
    accessToken: idToken,
    idToken,
    refreshToken,
    expiresIn: 3600,
    expires_in: 3600,
  });
});

function sessionUserIdFromToken(t) {
  const entry = store.accessTokens.get(t);
  return entry && entry.userId ? String(entry.userId) : null;
}

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

app.patch('/users/:id', auth, requireSessionUser, (req, res) => {
  const { id } = req.params;
  if (String(id) !== req.authUserId) {
    return res.status(403).json({ message: 'لا يمكنك تعديل حساب آخر' });
  }
  const existing = store.users.get(id);
  if (!existing) return res.status(404).json({ message: 'المستخدم غير موجود' });
  const body = { ...req.body };
  delete body.accountRole;
  delete body.capabilities;
  delete body.password;
  const updated = roles.migrateLegacyUser({
    ...existing,
    ...body,
    id,
    updatedAt: new Date().toISOString(),
  });
  store.users.set(id, updated);
  const { password, ...rest } = updated;
  saveStore();
  res.json(rest);
});

// ========== Horses ==========
// GET /horses بدون auth حتى يعمل "دخول تجريبي" وعرض الخيل للجميع
app.get('/horses', (req, res) => {
  const { type, gender, city, minPrice, maxPrice, sortBy, limit, species, ownerId, tag, badge } = req.query;
  let list = [...store.horses.values()];
  // فئة المنصة: horse | camel | falcon — البيانات القديمة تُعامل كـ horse
  if (species) {
    list = list.filter((h) => (h.species || 'horse') === species);
  }
  if (ownerId) {
    const oid = String(ownerId);
    list = list.filter(
      (h) => String(h.ownerId || h.userId || '') === oid,
    );
  }
  if (type) list = list.filter(h => h.type === type);
  if (gender) list = list.filter(h => h.gender === gender);
  if (city) list = list.filter(h => h.city === city);
  if (tag) list = list.filter((h) => heritageTB.itemHasTag(h, tag));
  if (badge) list = list.filter((h) => heritageTB.itemHasBadge(h, badge));
  const num = (v) => (v == null ? null : Number(v));
  if (num(minPrice) != null) list = list.filter(h => Number(h.price) >= num(minPrice));
  if (num(maxPrice) != null) list = list.filter(h => Number(h.price) <= num(maxPrice));
  if (sortBy === 'price_asc') list.sort((a, b) => Number(a.price) - Number(b.price));
  if (sortBy === 'price_desc') list.sort((a, b) => Number(b.price) - Number(a.price));
  if (limit) list = list.slice(0, Number(limit));
  list = stripSheepListings(list);
  list = filterListingsForViewer(list, viewerFromToken(req));
  const viewerId = sessionUserIdFromToken(
    (req.headers.authorization || '').startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null,
  );
  list = list.filter((h) => {
    if (bookingOccupancy.isListingPubliclyVisible(h)) return true;
    const owner = String(h.sellerId || h.userId || h.ownerId || '');
    return viewerId && owner === viewerId;
  });
  res.json(list.map((h) => heritageTB.scrubItemTags(h)));
});

app.get('/horses/:id', (req, res) => {
  const h = store.horses.get(req.params.id);
  if (!h) return res.status(404).json({ message: 'الخيل غير موجود' });
  res.json(heritageTB.scrubItemTags(h));
});

app.post('/horses', auth, requireSessionUser, (req, res) => {
  const species =
    req.body?.species ||
    req.body?.listingSpecies ||
    req.body?.applicableSpecies?.[0] ||
    'horse';
  const err = roles.assertListingCreate(req.authUser, species);
  if (err) return res.status(403).json({ message: err });
  if (isSheepSpecies(species) && rejectSheepPaused(res)) return;
  if (species === 'sheep') {
    const sheepErr = validateSheepListing(req.body);
    if (sheepErr) return res.status(400).json({ message: sheepErr });
  }
  const body = heritageTB.applyClientListingFields(req.body || {}, {});
  const horseId = id();
  const horse = {
    id: horseId,
    ...body,
    tags: heritageTB.sanitizeTags(body.tags, species),
    badges: [],
    species,
    listingStatus: bookingOccupancy.listingStatusOf(body) || 'available',
    userId: req.authUserId,
    sellerId: req.authUserId,
    createdAt: new Date().toISOString(),
  };
  store.horses.set(horseId, horse);
  saveStore();
  res.status(201).json(heritageTB.scrubItemTags(horse));
});

app.patch('/horses/:id', auth, requireSessionUser, (req, res) => {
  const { id } = req.params;
  const existing = store.horses.get(id);
  if (!existing) return res.status(404).json({ message: 'الخيل غير موجود' });
  const ownerId = String(existing.sellerId || existing.userId || '');
  if (ownerId !== req.authUserId) {
    return res.status(403).json({ message: 'غير مصرح بتعديل هذا الإعلان' });
  }
  const mergedSpecies =
    req.body?.species || req.body?.listingSpecies || existing.species || 'horse';
  if (isSheepSpecies(mergedSpecies) && rejectSheepPaused(res)) return;
  if (mergedSpecies === 'sheep') {
    const sheepErr = validateSheepListing({ ...existing, ...req.body });
    if (sheepErr) return res.status(400).json({ message: sheepErr });
  }
  const body = heritageTB.applyClientListingFields(req.body || {}, existing);
  const nextListingStatus = body.listingStatus || body.status;
  if (
    nextListingStatus != null &&
    String(nextListingStatus) !== bookingOccupancy.listingStatusOf(existing)
  ) {
    const from = bookingOccupancy.listingStatusOf(existing);
    const to = String(nextListingStatus).trim().toLowerCase();
    if (!bookingOccupancy.canListingStatusTransition(from, to)) {
      return res.status(400).json({
        message: `انتقال حالة الإعلان غير مسموح من ${from} إلى ${to}`,
      });
    }
    body.listingStatus = to;
  }
  const updated = {
    ...existing,
    ...body,
    id,
    sellerId: existing.sellerId || existing.userId,
    userId: existing.userId || existing.sellerId,
    badges: Array.isArray(existing.badges) ? existing.badges : [],
    listingStatus:
      body.listingStatus || bookingOccupancy.listingStatusOf(existing),
    updatedAt: new Date().toISOString(),
  };
  updated.tags = heritageTB.sanitizeTags(updated.tags, mergedSpecies);
  if (req.body.stats && typeof req.body.stats === 'object') {
    updated.stats = { ...(existing.stats || {}), ...req.body.stats };
  }
  store.horses.set(id, updated);
  saveStore();
  res.json(heritageTB.scrubItemTags(updated));
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
app.get('/bookings', auth, requireSessionUser, (req, res) => {
  if (runLazyExpiry()) saveStore();
  const { providerId, customerId, status } = req.query;
  const sid = req.authUserId;
  if (!providerId && !customerId) {
    return res.status(400).json({
      message: 'providerId أو customerId مطلوب',
    });
  }
  if (providerId && String(providerId) !== String(sid)) {
    return res.status(403).json({ message: 'غير مصرح بعرض حجوزات مزود آخر' });
  }
  if (customerId && String(customerId) !== String(sid)) {
    return res.status(403).json({ message: 'غير مصرح بعرض حجوزات عميل آخر' });
  }
  let list = [...store.bookings.values()];
  if (providerId) {
    list = list.filter((b) => String(b.providerId || '') === String(providerId));
  }
  if (customerId) {
    list = list.filter((b) => String(b.userId || '') === String(customerId));
  }
  if (status) list = list.filter((b) => b.status === status);
  res.json(list);
});

app.post('/bookings', auth, requireSessionUser, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const kind = String(body.type || body.serviceType || '')
    .trim()
    .toLowerCase();

  let payload = { ...body };
  const serviceId = String(body.serviceId || '').trim();

  if (kind === 'stable') {
    if (!serviceId) {
      return res.status(400).json({ message: 'serviceId مطلوب لحجز الإيواء' });
    }
    const service = store.services.get(serviceId);
    if (!service) {
      return res.status(404).json({ message: 'خدمة الإيواء غير موجودة' });
    }
    payload = bookingOccupancy.normalizeStableBookingPayload(body, service);
    if (!payload.startDate || !payload.endDate) {
      return res.status(400).json({ message: 'تاريخ البداية والنهاية مطلوبان' });
    }
    const startKey = bookingOccupancy.toDayKey(payload.startDate);
    const endKey = bookingOccupancy.toDayKey(payload.endDate);
    if (!startKey || !endKey) {
      return res.status(400).json({ message: 'تواريخ الإيواء غير صالحة' });
    }
    if (endKey < startKey) {
      return res.status(400).json({
        message: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية أو يساويه',
      });
    }

    const occupancy = bookingOccupancy.evaluateStableOccupancy({
      service,
      bookings: [...store.bookings.values()],
      startDate: payload.startDate,
      endDate: payload.endDate,
      spacesRequested: payload.spacesRequested,
    });
    if (!occupancy.ok) {
      return res.status(409).json({
        code: 'OCCUPANCY_FULL',
        message: occupancy.message || 'الفترة غير متاحة',
        totalSpaces: occupancy.totalSpaces,
        minAvailable: occupancy.minAvailable,
        peakUsed: occupancy.peakUsed,
        days: occupancy.days,
      });
    }
  } else if (kind === 'transportation' || kind === 'transport') {
    if (!serviceId) {
      return res.status(400).json({ message: 'serviceId مطلوب لحجز النقل' });
    }
    const service = store.services.get(serviceId);
    if (!service) {
      return res.status(404).json({ message: 'خدمة النقل غير موجودة' });
    }
    payload = bookingOccupancy.normalizeTransportationBookingPayload(body);
    payload.serviceId = serviceId;
    payload.providerId = payload.providerId || service.providerId;
    const origin = payload.details?.origin;
    const destination = payload.details?.destination;
    if (
      origin == null ||
      destination == null ||
      origin.latitude == null ||
      origin.longitude == null ||
      destination.latitude == null ||
      destination.longitude == null
    ) {
      return res.status(400).json({
        message: 'نقطة البداية والوجهة (إحداثيات) مطلوبتان لحجز النقل',
      });
    }
    const bookingDate =
      payload.bookingDate ||
      payload.details?.bookingDate ||
      payload.startDate ||
      new Date().toISOString();
    payload.bookingDate = bookingDate;
    const cap = bookingOccupancy.evaluateTransportCapacity({
      service,
      bookings: [...store.bookings.values()],
      unitsRequested: bookingOccupancy.unitsRequestedOf(payload),
      bookingDate,
    });
    if (!cap.ok) {
      return res.status(409).json({
        code: 'TRANSPORT_CAPACITY',
        message: cap.message || 'سعة النقل غير كافية',
        capacity: cap.capacity,
        available: cap.available,
        used: cap.used,
      });
    }
  } else if (kind === 'veterinary' || kind === 'vet') {
    if (!serviceId) {
      return res.status(400).json({ message: 'serviceId مطلوب للحجز البيطري' });
    }
    const service = store.services.get(serviceId);
    if (!service) {
      return res.status(404).json({ message: 'العيادة غير موجودة' });
    }
    payload.type = 'veterinary';
    payload.serviceType = 'veterinary';
    payload.serviceId = serviceId;
    payload.providerId = payload.providerId || service.providerId;
    const bookingDate =
      payload.bookingDate ||
      payload.details?.bookingDate ||
      payload.startDate;
    if (!bookingDate) {
      return res.status(400).json({ message: 'تاريخ الموعد مطلوب' });
    }
    payload.bookingDate = bookingDate;
    const details =
      payload.details && typeof payload.details === 'object'
        ? { ...payload.details }
        : {};
    const appointmentTime =
      payload.appointmentTime || details.appointmentTime || details.timeSlot || '';
    if (appointmentTime) {
      payload.appointmentTime = appointmentTime;
      details.appointmentTime = appointmentTime;
    }
    payload.details = details;
    const vetCheck = bookingOccupancy.evaluateVetAvailability({
      service,
      bookings: [...store.bookings.values()],
      bookingDate,
      appointmentTime,
    });
    if (!vetCheck.ok) {
      return res.status(409).json({
        code: vetCheck.code || 'VET_UNAVAILABLE',
        message: vetCheck.message || 'الموعد غير متاح',
      });
    }
  }

  const bookingId = id();
  const now = new Date().toISOString();
  const booking = {
    id: bookingId,
    ...payload,
    userId: req.authUserId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  store.bookings.set(bookingId, booking);
  if (booking.providerId) {
    notifyEvent(
      booking.providerId,
      'حجز جديد',
      `${booking.serviceName || booking.type || 'خدمة'} — بانتظار القبول`,
      { type: 'booking', bookingId, status: 'pending' },
    );
  }
  saveStore();
  res.status(201).json(booking);
});

app.patch('/bookings/:id', auth, requireSessionUser, (req, res) => {
  const { id } = req.params;
  const existing = store.bookings.get(id);
  if (!existing) return res.status(404).json({ message: 'الحجز غير موجود' });

  const sid = req.authUserId;
  const isProvider = String(existing.providerId || '') === sid;
  const isCustomer = String(existing.userId || '') === sid;
  if (!isProvider && !isCustomer) {
    return res.status(403).json({ message: 'غير مصرح بتعديل هذا الحجز' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const nextStatus =
    body.status != null ? String(body.status) : null;
  const prevStatus = String(existing.status || 'pending');

  if (nextStatus && nextStatus !== prevStatus) {
    if (isCustomer && !isProvider) {
      if (nextStatus !== 'cancelled') {
        return res.status(403).json({
          message: 'يمكن للعميل إلغاء الحجز فقط (حالة cancelled)',
        });
      }
      if (!bookingOccupancy.canCustomerCancelBooking(prevStatus)) {
        return res.status(400).json({
          message: 'لا يمكن إلغاء الحجز في هذه المرحلة',
        });
      }
    } else if (isProvider) {
      if (!bookingOccupancy.canProviderBookingTransition(prevStatus, nextStatus)) {
        return res.status(400).json({
          message: `انتقال غير مسموح من ${prevStatus} إلى ${nextStatus}`,
        });
      }
    }
  }

  const updated = {
    ...existing,
    id,
    userId: existing.userId,
    providerId: existing.providerId,
    serviceId: existing.serviceId,
    type: existing.type,
    serviceType: existing.serviceType || existing.type,
    updatedAt: new Date().toISOString(),
  };

  if (nextStatus) updated.status = nextStatus;

  if (isProvider || isCustomer) {
    if (body.notes != null) updated.notes = body.notes;
  }

  // تعديل تواريخ/مساحات الإيواء — مزوّد فقط + إعادة فحص
  const touchesStableSchedule =
    body.startDate != null ||
    body.endDate != null ||
    body.spacesRequested != null ||
    (body.details &&
      (body.details.startDate != null ||
        body.details.endDate != null ||
        body.details.spacesRequested != null));

  if (touchesStableSchedule) {
    if (!isProvider) {
      return res.status(403).json({ message: 'تعديل التواريخ للمزوّد فقط' });
    }
    if (!bookingOccupancy.isStableBooking(updated)) {
      return res.status(400).json({ message: 'تعديل الفترة متاح لإيواء فقط' });
    }
    const service = store.services.get(String(updated.serviceId || ''));
    if (!service) {
      return res.status(404).json({ message: 'خدمة الإيواء غير موجودة' });
    }
    const merged = bookingOccupancy.normalizeStableBookingPayload(
      { ...updated, ...body },
      service,
    );
    const occupancy = bookingOccupancy.evaluateStableOccupancy({
      service,
      bookings: [...store.bookings.values()],
      startDate: merged.startDate,
      endDate: merged.endDate,
      spacesRequested: merged.spacesRequested,
      excludeBookingId: id,
    });
    if (!occupancy.ok) {
      return res.status(409).json({
        code: 'OCCUPANCY_FULL',
        message: occupancy.message || 'الفترة غير متاحة',
        days: occupancy.days,
      });
    }
    Object.assign(updated, {
      startDate: merged.startDate,
      endDate: merged.endDate,
      spacesRequested: merged.spacesRequested,
      bookingDate: merged.bookingDate,
      details: merged.details,
    });
  }

  store.bookings.set(id, updated);

  if (nextStatus && nextStatus !== prevStatus) {
    if (isProvider && existing.userId) {
      notifyEvent(
        existing.userId,
        'تحديث حجزك',
        `الحالة: ${nextStatus}`,
        { type: 'booking', bookingId: id, status: nextStatus },
      );
    }
    if (isCustomer && nextStatus === 'cancelled' && existing.providerId) {
      notifyEvent(
        existing.providerId,
        'إلغاء حجز',
        'ألقى العميل حجزه',
        { type: 'booking', bookingId: id, status: 'cancelled' },
      );
    }
  }

  saveStore();
  res.json(updated);
});

// ========== Services ==========
// GET /services بدون auth — تصفح الزائر قبل التسجيل
app.get('/services', (req, res) => {
  const { type, providerId, species } = req.query;
  let list = [...store.services.values()];
  if (type) list = list.filter(s => s.type === type);
  if (providerId) list = list.filter(s => s.providerId === providerId);
  const sp = species != null ? String(species).trim().toLowerCase() : '';
  if (sp && sp !== 'all') {
    list = list.filter((s) => {
      const apps = s.applicableSpecies;
      if (apps == null || (Array.isArray(apps) && apps.length === 0)) return true;
      if (Array.isArray(apps)) return apps.includes(sp) || apps.includes('all');
      return String(apps) === sp || String(apps) === 'all';
    });
  }
  res.json(list);
});

/** توفر إيواء حسب الفترة — لا يكرر منطق الحجز؛ يستخدم booking_occupancy فقط */
app.get('/services/:id/availability', (req, res) => {
  const service = store.services.get(req.params.id);
  if (!service) {
    return res.status(404).json({ message: 'الخدمة غير موجودة' });
  }
  const kind = String(service.type || service.serviceType || '')
    .trim()
    .toLowerCase();
  if (kind !== 'stable') {
    return res.status(400).json({ message: 'التوفر اليومي متاح لخدمات الإيواء فقط' });
  }
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  if (!from || !to) {
    return res.status(400).json({ message: 'from و to مطلوبان (YYYY-MM-DD أو ISO)' });
  }
  if (!bookingOccupancy.toDayKey(from) || !bookingOccupancy.toDayKey(to)) {
    return res.status(400).json({ message: 'تواريخ غير صالحة' });
  }
  const payload = bookingOccupancy.buildAvailabilityPayload({
    service,
    bookings: [...store.bookings.values()],
    from,
    to,
  });
  res.json(payload);
});

app.post('/services', auth, requireSessionUser, (req, res) => {
  const serviceType = String(req.body?.type || req.body?.serviceType || '').trim();
  const err = roles.assertServiceCreate(req.authUser, serviceType);
  if (err) return res.status(403).json({ message: err });
  const verifyErr = roles.assertMerchantVerified(req.authUser);
  if (verifyErr) return res.status(403).json({ message: verifyErr });
  const serviceId = id();
  const service = {
    id: serviceId,
    ...req.body,
    type: serviceType || req.body?.type,
    providerId: req.authUserId,
    createdAt: new Date().toISOString(),
  };
  store.services.set(serviceId, service);
  saveStore();
  res.status(201).json(service);
});

app.patch('/services/:id', auth, requireSessionUser, (req, res) => {
  const { id } = req.params;
  const existing = store.services.get(id);
  if (!existing) return res.status(404).json({ message: 'الخدمة غير موجودة' });
  if (String(existing.providerId || '') !== req.authUserId) {
    return res.status(403).json({ message: 'غير مصرح بتعديل هذه الخدمة' });
  }
  const updated = {
    ...existing,
    ...req.body,
    id,
    providerId: existing.providerId,
    updatedAt: new Date().toISOString(),
  };
  store.services.set(id, updated);
  saveStore();
  res.json(updated);
});

app.delete('/services/:id', auth, requireSessionUser, (req, res) => {
  const { id } = req.params;
  const existing = store.services.get(id);
  if (!existing) return res.status(404).json({ message: 'الخدمة غير موجودة' });
  if (String(existing.providerId || '') !== req.authUserId) {
    return res.status(403).json({ message: 'غير مصرح بحذف هذه الخدمة' });
  }
  store.services.delete(id);
  saveStore();
  res.status(200).send();
});

// ========== Catalog (أعلاف + أدوات) ==========
function parseSpeciesList(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const s = String(raw).trim().toLowerCase();
  if (!s || s === 'all') return ['horse', 'camel', 'falcon'];
  return [s];
}

function catalogMatchesSpecies(item, species) {
  if (!species || species === 'all') return true;
  const list = parseSpeciesList(item.applicableSpecies);
  if (list.length === 0) return true;
  return list.includes(species) || list.includes('all');
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function catalogLocation(item) {
  const loc = item.location || {};
  const lat = parseFloat(loc.lat);
  const lng = parseFloat(loc.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, city: loc.city || '' };
  const seller = store.users.get(String(item.sellerId || ''));
  if (seller && seller.location) {
    const sl = seller.location;
    const slat = parseFloat(sl.lat);
    const slng = parseFloat(sl.lng);
    if (Number.isFinite(slat) && Number.isFinite(slng)) {
      return { lat: slat, lng: slng, city: sl.city || seller.city || '' };
    }
  }
  return null;
}

function enrichCatalogItem(item, clientLat, clientLng) {
  const out = { ...item };
  const loc = catalogLocation(item);
  if (loc) {
    out.location = { ...out.location, lat: loc.lat, lng: loc.lng, city: loc.city || out.location?.city };
    if (clientLat != null && clientLng != null) {
      out.distanceKm = Math.round(haversineKm(clientLat, clientLng, loc.lat, loc.lng) * 10) / 10;
    }
  }
  return out;
}

app.get('/catalog/items', auth, (req, res) => {
  const category = req.query.category != null ? String(req.query.category).trim() : '';
  const species = req.query.species != null ? String(req.query.species).trim().toLowerCase() : '';
  const subCategory = req.query.subCategory != null ? String(req.query.subCategory).trim() : '';
  const sellerId = req.query.sellerId != null ? String(req.query.sellerId).trim() : '';
  const clientLat = parseFloat(req.query.lat);
  const clientLng = parseFloat(req.query.lng);
  const hasClientLoc = Number.isFinite(clientLat) && Number.isFinite(clientLng);
  const sort = String(req.query.sort || '');
  // بائع يدير منتجاته: يعيد النشطة والموقوفة؛ المتصفح يرى النشطة فقط.
  const sessionEntry = store.accessTokens.get(req.token);
  const sessionUserId = sessionEntry?.userId ? String(sessionEntry.userId) : null;
  const sellerManagingOwn =
    Boolean(sellerId) && Boolean(sessionUserId) && String(sellerId) === sessionUserId;

  let list = [...store.catalogItems.values()];
  if (!sellerManagingOwn) {
    list = list.filter((i) => (i.status || 'active') === 'active');
  }
  if (category) list = list.filter((i) => String(i.category || '') === category);
  if (species && species !== 'all') list = list.filter((i) => catalogMatchesSpecies(i, species));
  if (subCategory) {
    list = list.filter((i) => String(i.subCategory || '').includes(subCategory));
  }
  if (sellerId) list = list.filter((i) => String(i.sellerId || '') === sellerId);

  list = list.map((i) =>
    enrichCatalogItem(i, hasClientLoc ? clientLat : null, hasClientLoc ? clientLng : null),
  );

  if (hasClientLoc && (sort === 'distance' || !sort)) {
    list.sort((a, b) => (a.distanceKm ?? 99999) - (b.distanceKm ?? 99999));
  } else {
    list.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }
  res.json(list);
});

app.get('/catalog/items/:id', auth, (req, res) => {
  const item = store.catalogItems.get(req.params.id);
  if (!item) return res.status(404).json({ message: 'المنتج غير موجود' });
  const clientLat = parseFloat(req.query.lat);
  const clientLng = parseFloat(req.query.lng);
  const hasClientLoc = Number.isFinite(clientLat) && Number.isFinite(clientLng);
  res.json(
    enrichCatalogItem(item, hasClientLoc ? clientLat : null, hasClientLoc ? clientLng : null),
  );
});

app.post('/catalog/items', auth, requireSessionUser, (req, res) => {
  const body = req.body || {};
  const category = String(body.category || '').trim();
  if (category !== 'feed' && category !== 'supplies' && category !== 'equipment') {
    return res.status(400).json({ message: 'category يجب أن يكون feed أو supplies أو equipment' });
  }
  const roleErr = roles.assertCatalogCreate(req.authUser, category);
  if (roleErr) return res.status(403).json({ message: roleErr });
  const verifyErr = roles.assertMerchantVerified(req.authUser);
  if (verifyErr) return res.status(403).json({ message: verifyErr });
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ message: 'اسم المنتج مطلوب' });
  }
  const itemId = id();
  const item = {
    id: itemId,
    sellerId: req.authUserId,
    sellerRole: req.authUser.accountRole,
    category,
    applicableSpecies: parseSpeciesList(body.applicableSpecies).length
      ? parseSpeciesList(body.applicableSpecies)
      : ['horse'],
    subCategory: String(body.subCategory || '').trim(),
    name: String(body.name).trim(),
    description: String(body.description || '').trim(),
    images: Array.isArray(body.images) ? body.images.map(String) : [],
    price: Number(body.price) || 0,
    currency: String(body.currency || 'SAR'),
    unit: String(body.unit || '').trim(),
    location: body.location && typeof body.location === 'object' ? body.location : {},
    contactPhone: body.contactPhone ? String(body.contactPhone) : '',
    contactWhatsapp: body.contactWhatsapp ? String(body.contactWhatsapp) : '',
    condition: body.condition ? String(body.condition) : 'new',
    inStock: body.inStock !== false,
    stockQuantity:
      category === 'supplies'
        ? marketplaceCommerce.normalizeStockQuantity(
            body.stockQuantity != null ? body.stockQuantity : 100,
          )
        : marketplaceCommerce.normalizeStockQuantity(body.stockQuantity),
    shopType:
      req.authUser.accountRole === roles.ACCOUNT_ROLES.vet_clinic && category === 'supplies'
        ? 'vet'
        : category,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  marketplaceCommerce.syncInStockFlag(item);
  store.catalogItems.set(itemId, item);
  saveStore();
  res.status(201).json(item);
});

app.patch('/catalog/items/:id', auth, requireSessionUser, (req, res) => {
  const { id } = req.params;
  const existing = store.catalogItems.get(id);
  if (!existing) return res.status(404).json({ message: 'المنتج غير موجود' });
  if (String(existing.sellerId || '') !== req.authUserId) {
    return res.status(403).json({ message: 'غير مصرح بتعديل هذا المنتج' });
  }
  const body = req.body || {};
  const updated = {
    ...existing,
    id,
    sellerId: existing.sellerId,
    category: existing.category,
    updatedAt: new Date().toISOString(),
  };
  if (body.name != null) updated.name = String(body.name).trim();
  if (body.description != null) updated.description = String(body.description).trim();
  if (body.subCategory != null) updated.subCategory = String(body.subCategory).trim();
  if (body.price != null) updated.price = Number(body.price) || 0;
  if (body.unit != null) updated.unit = String(body.unit).trim();
  if (body.currency != null) updated.currency = String(body.currency);
  if (body.images != null && Array.isArray(body.images)) {
    updated.images = body.images.map(String);
  }
  if (body.location != null && typeof body.location === 'object') {
    updated.location = body.location;
  }
  if (body.contactPhone != null) updated.contactPhone = String(body.contactPhone);
  if (body.contactWhatsapp != null) updated.contactWhatsapp = String(body.contactWhatsapp);
  if (body.condition != null) updated.condition = String(body.condition);
  if (body.status != null) {
    const st = String(body.status).trim();
    if (st === 'active' || st === 'inactive') updated.status = st;
  }
  if (body.stockQuantity !== undefined) {
    updated.stockQuantity = marketplaceCommerce.normalizeStockQuantity(body.stockQuantity);
  }
  if (body.inStock !== undefined && body.stockQuantity === undefined) {
    updated.inStock = body.inStock !== false;
    if (updated.inStock === false && updated.stockQuantity != null) {
      updated.stockQuantity = 0;
    }
  }
  if (body.applicableSpecies != null) {
    updated.applicableSpecies = parseSpeciesList(body.applicableSpecies);
  }
  marketplaceCommerce.syncInStockFlag(updated);
  store.catalogItems.set(id, updated);
  saveStore();
  res.json(updated);
});

app.delete('/catalog/items/:id', auth, requireSessionUser, (req, res) => {
  const { id } = req.params;
  const existing = store.catalogItems.get(id);
  if (!existing) return res.status(404).json({ message: 'المنتج غير موجود' });
  if (String(existing.sellerId || '') !== req.authUserId) {
    return res.status(403).json({ message: 'غير مصرح بحذف هذا المنتج' });
  }
  store.catalogItems.delete(id);
  saveStore();
  res.status(200).json({ ok: true });
});

// ========== Cart ==========
function getOrCreateCart(userId) {
  let cart = store.carts.get(userId);
  if (!cart) {
    cart = { userId, items: [], updatedAt: new Date().toISOString() };
    store.carts.set(userId, cart);
  }
  return cart;
}

app.get('/cart', auth, requireSessionUser, (req, res) => {
  const cart = getOrCreateCart(req.authUserId);
  res.json(cart);
});

app.post('/cart/items', auth, requireSessionUser, (req, res) => {
  const { catalogItemId, quantity } = req.body || {};
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const product = store.catalogItems.get(String(catalogItemId || ''));
  if (!product || product.category !== 'supplies') {
    return res.status(400).json({ message: 'المنتج غير موجود أو ليس من قسم الأدوات' });
  }
  if ((product.status || 'active') !== 'active' || product.inStock === false) {
    return res.status(400).json({ message: 'المنتج غير متوفر' });
  }
  const cart = getOrCreateCart(req.authUserId);
  const idx = cart.items.findIndex((l) => l.catalogItemId === product.id);
  const currentQty = idx >= 0 ? cart.items[idx].quantity || 0 : 0;
  const nextQty = currentQty + qty;
  const avail = marketplaceCommerce.availableStock(product, {
    forUserId: req.authUserId,
  });
  if (avail < nextQty) {
    const availLabel = avail === Number.POSITIVE_INFINITY ? null : avail;
    return res.status(409).json({
      message:
        avail <= 0
          ? 'المنتج نفذ من المخزون'
          : `الكمية المتاحة ${availLabel} فقط`,
      available: availLabel,
      code: 'OUT_OF_STOCK',
    });
  }
  const imageUrl =
    Array.isArray(product.images) && product.images.length > 0 ? product.images[0] : '';
  const snapshot = {
    name: product.name,
    price: Number(product.price) || 0,
    imageUrl,
    sellerId: product.sellerId,
    unit: product.unit || '',
    subCategory: product.subCategory || '',
  };
  if (idx >= 0) {
    cart.items[idx].quantity = nextQty;
    cart.items[idx].snapshot = snapshot;
  } else {
    cart.items.push({ catalogItemId: product.id, quantity: qty, snapshot });
  }
  marketplaceCommerce.setCartHold(product, req.authUserId, nextQty);
  store.catalogItems.set(product.id, product);
  cart.updatedAt = new Date().toISOString();
  store.carts.set(req.authUserId, cart);
  saveStore();
  res.json(cart);
});

app.patch('/cart/items/:catalogItemId', auth, requireSessionUser, (req, res) => {
  const cart = getOrCreateCart(req.authUserId);
  const lineId = req.params.catalogItemId;
  const qty = parseInt(req.body?.quantity, 10);
  const idx = cart.items.findIndex((l) => l.catalogItemId === lineId);
  if (idx < 0) return res.status(404).json({ message: 'العنصر غير موجود في السلة' });
  const product = store.catalogItems.get(lineId);
  if (!Number.isFinite(qty) || qty < 1) {
    cart.items.splice(idx, 1);
    if (product) {
      marketplaceCommerce.clearCartHold(product, req.authUserId);
      store.catalogItems.set(product.id, product);
    }
  } else {
    if (product) {
      const avail = marketplaceCommerce.availableStock(product, {
        forUserId: req.authUserId,
      });
      if (avail < qty) {
        const availLabel = avail === Number.POSITIVE_INFINITY ? null : avail;
        return res.status(409).json({
          message:
            avail <= 0
              ? 'المنتج نفذ من المخزون'
              : `الكمية المتاحة ${availLabel} فقط`,
          available: availLabel,
          code: 'OUT_OF_STOCK',
        });
      }
      const imageUrl =
        Array.isArray(product.images) && product.images.length > 0 ? product.images[0] : '';
      cart.items[idx].snapshot = {
        name: product.name,
        price: Number(product.price) || 0,
        imageUrl,
        sellerId: product.sellerId,
        unit: product.unit || '',
        subCategory: product.subCategory || '',
      };
      marketplaceCommerce.setCartHold(product, req.authUserId, qty);
      store.catalogItems.set(product.id, product);
    }
    cart.items[idx].quantity = qty;
  }
  cart.updatedAt = new Date().toISOString();
  store.carts.set(req.authUserId, cart);
  saveStore();
  res.json(cart);
});

app.delete('/cart/items/:catalogItemId', auth, requireSessionUser, (req, res) => {
  const cart = getOrCreateCart(req.authUserId);
  const lineId = req.params.catalogItemId;
  const product = store.catalogItems.get(lineId);
  if (product) {
    marketplaceCommerce.clearCartHold(product, req.authUserId);
    store.catalogItems.set(product.id, product);
  }
  cart.items = cart.items.filter((l) => l.catalogItemId !== lineId);
  cart.updatedAt = new Date().toISOString();
  store.carts.set(req.authUserId, cart);
  saveStore();
  res.json(cart);
});

app.delete('/cart', auth, requireSessionUser, (req, res) => {
  const cart = getOrCreateCart(req.authUserId);
  for (const line of cart.items || []) {
    const product = store.catalogItems.get(String(line.catalogItemId || ''));
    if (product) {
      marketplaceCommerce.clearCartHold(product, req.authUserId);
      store.catalogItems.set(product.id, product);
    }
  }
  store.carts.set(req.authUserId, {
    userId: req.authUserId,
    items: [],
    updatedAt: new Date().toISOString(),
  });
  saveStore();
  res.json(store.carts.get(req.authUserId));
});

// ========== Orders (أدوات — تجارة) ==========
app.get('/orders', auth, requireSessionUser, (req, res) => {
  const { providerId, customerId, status } = req.query;
  let list = [...store.orders.values()];
  const sid = req.authUserId;
  if (providerId) {
    if (String(providerId) !== sid) return res.status(403).json({ message: 'غير مصرح' });
    list = list.filter((o) => String(o.sellerId || '') === sid);
  } else if (customerId) {
    if (String(customerId) !== sid) return res.status(403).json({ message: 'غير مصرح' });
    list = list.filter((o) => String(o.userId || '') === sid);
  } else {
    list = list.filter(
      (o) => String(o.userId || '') === sid || String(o.sellerId || '') === sid,
    );
  }
  if (status) list = list.filter((o) => o.status === status);
  list.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  res.json(list);
});

app.get('/orders/:id', auth, requireSessionUser, (req, res) => {
  const order = store.orders.get(req.params.id);
  if (!order) return res.status(404).json({ message: 'الطلب غير موجود' });
  const sid = req.authUserId;
  if (String(order.userId || '') !== sid && String(order.sellerId || '') !== sid) {
    return res.status(403).json({ message: 'غير مصرح' });
  }
  res.json(order);
});

app.post('/orders/checkout', auth, requireSessionUser, (req, res) => {
  const cart = getOrCreateCart(req.authUserId);
  if (!cart.items || cart.items.length === 0) {
    return res.status(400).json({ message: 'السلة فارغة' });
  }
  const shippingAddress = req.body?.shippingAddress || {};
  const paymentMethod = String(req.body?.paymentMethod || 'cash');
  if (paymentMethod === 'card') {
    return res.status(400).json({
      message: 'الدفع بالبطاقة غير متاح حالياً — استخدم الدفع عند الاستلام',
    });
  }
  const buyer = store.users.get(req.authUserId) || {};
  const customerName = String(buyer.name || buyer.displayName || buyer.email || 'عميل');
  const customerPhone = String(buyer.phone || '');

  const catalogMap = new Map();
  for (const line of cart.items) {
    const pid = String(line.catalogItemId || '');
    if (!catalogMap.has(pid)) {
      const p = store.catalogItems.get(pid);
      if (p) catalogMap.set(pid, p);
    }
  }

  const validated = marketplaceCommerce.validateCartLines(cart.items, catalogMap, {
    forUserId: req.authUserId,
  });
  if (!validated.ok) {
    return res.status(409).json({
      message: validated.issues[0]?.message || 'تعذر إتمام الطلب — تحقق من السلة',
      issues: validated.issues,
      code: 'CART_INVALID',
    });
  }

  for (const line of validated.lines) {
    marketplaceCommerce.clearCartHold(line.product, req.authUserId);
    marketplaceCommerce.decrementStock(line.product, line.quantity);
    store.catalogItems.set(line.product.id, line.product);
  }

  const bySeller = new Map();
  for (const line of validated.lines) {
    const seller = String(line.sellerId || '');
    if (!seller) continue;
    if (!bySeller.has(seller)) bySeller.set(seller, []);
    bySeller.get(seller).push(line);
  }

  const created = [];
  for (const [sellerId, lines] of bySeller.entries()) {
    let total = 0;
    const orderLines = lines.map((l) => {
      total += l.unitPrice * l.quantity;
      return {
        catalogItemId: l.catalogItemId,
        quantity: l.quantity,
        title: l.title,
        unitPrice: l.unitPrice,
        imageUrl: l.imageUrl,
      };
    });
    const orderId = id();
    const order = {
      id: orderId,
      userId: req.authUserId,
      sellerId,
      customerName,
      customerPhone,
      lines: orderLines,
      total: Math.round(total * 100) / 100,
      currency: 'SAR',
      status: 'paid',
      paymentMethod: 'cash',
      paymentStatus: 'completed',
      stockDeducted: true,
      shippingAddress,
      trackingNumber: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.orders.set(orderId, order);
    created.push(order);
    notifyEvent(
      sellerId,
      'طلب متجر جديد',
      `${orderLines.length} صنف · ${order.total} ر.س`,
      { type: 'order', orderId, status: 'paid' },
    );
  }

  if (created.length === 0) {
    for (const line of validated.lines) {
      marketplaceCommerce.restoreStock(line.product, line.quantity);
      store.catalogItems.set(line.product.id, line.product);
    }
    return res.status(400).json({ message: 'تعذر إنشاء الطلب — بائع غير محدد' });
  }

  store.carts.set(req.authUserId, {
    userId: req.authUserId,
    items: [],
    updatedAt: new Date().toISOString(),
  });
  saveStore();
  res.status(201).json({ orders: created });
});

app.patch('/orders/:id', auth, requireSessionUser, (req, res) => {
  const { id } = req.params;
  const existing = store.orders.get(id);
  if (!existing) return res.status(404).json({ message: 'الطلب غير موجود' });
  const sid = req.authUserId;
  const isSeller = String(existing.sellerId || '') === sid;
  const isCustomer = String(existing.userId || '') === sid;
  if (!isSeller && !isCustomer) {
    return res.status(403).json({ message: 'غير مصرح' });
  }
  const body = req.body || {};
  const nextStatus = body.status != null ? String(body.status) : null;

  if (!nextStatus) {
    if (isSeller && body.trackingNumber != null) {
      const patched = {
        ...existing,
        trackingNumber: String(body.trackingNumber),
        updatedAt: new Date().toISOString(),
      };
      store.orders.set(id, patched);
      saveStore();
      return res.json(patched);
    }
    return res.status(400).json({ message: 'status مطلوب' });
  }

  const role = isSeller ? 'seller' : 'customer';
  const result = marketplaceCommerce.applyOrderStatusChange({
    order: existing,
    nextStatus,
    catalogItems: store.catalogItems,
    role,
    trackingNumber: isSeller ? body.trackingNumber : undefined,
  });
  if (!result.ok) {
    return res.status(400).json({ message: result.message });
  }

  store.orders.set(id, result.order);
  if (result.changed) {
    const peer = isSeller ? existing.userId : existing.sellerId;
    if (peer) {
      notifyEvent(
        peer,
        'تحديث طلب المتجر',
        `الحالة: ${result.order.status}`,
        { type: 'order', orderId: id, status: result.order.status },
      );
    }
  }
  saveStore();
  res.json(result.order);
});

// ========== Videos ==========
const VIDEO_SA_LAT_MIN = 16.0;
const VIDEO_SA_LAT_MAX = 32.5;
const VIDEO_SA_LNG_MIN = 34.5;
const VIDEO_SA_LNG_MAX = 56.0;
const VIDEO_MAX_ACCURACY_M = 150;
const VIDEO_MAX_CAPTURE_AGE_MS = 30 * 60 * 1000;

function parseVideoLocationRaw(body) {
  const loc = body?.location;
  if (!loc || typeof loc !== 'object') return null;
  const lat = parseFloat(loc.lat ?? loc.latitude);
  const lng = parseFloat(loc.lng ?? loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    city: String(loc.city || body.city || '').trim(),
    address: String(loc.address || '').trim(),
    accuracyM: parseFloat(loc.accuracyM),
    capturedAt: loc.capturedAt || null,
    source: String(loc.source || 'gps_confirmed').trim(),
  };
}

function validateVideoLocation(body) {
  const parsed = parseVideoLocationRaw(body);
  if (!parsed) {
    return 'الموقع إلزامي — فعّل GPS وحدّد موقع التصوير على الخريطة';
  }
  if (
    parsed.lat < VIDEO_SA_LAT_MIN ||
    parsed.lat > VIDEO_SA_LAT_MAX ||
    parsed.lng < VIDEO_SA_LNG_MIN ||
    parsed.lng > VIDEO_SA_LNG_MAX
  ) {
    return 'الإحداثيات خارج نطاق المملكة';
  }
  if (Number.isFinite(parsed.accuracyM) && parsed.accuracyM > VIDEO_MAX_ACCURACY_M) {
    return `دقة GPS ضعيفة (${Math.round(parsed.accuracyM)}م) — انتقل لمكان مفتوح وحاول مجدداً`;
  }
  if (parsed.capturedAt) {
    const ts = new Date(parsed.capturedAt).getTime();
    if (Number.isFinite(ts) && Date.now() - ts > VIDEO_MAX_CAPTURE_AGE_MS) {
      return 'انتهت صلاحية موقع التصوير — حدّد الموقع مجدداً';
    }
  }
  return null;
}

function normalizeVideoLocation(body) {
  const parsed = parseVideoLocationRaw(body);
  if (!parsed) return null;
  const trust =
    Number.isFinite(parsed.accuracyM) && parsed.accuracyM <= 50
      ? 'verified'
      : 'approximate';
  return {
    lat: parsed.lat,
    lng: parsed.lng,
    city: parsed.city || String(body.city || '').trim(),
    address: parsed.address,
    accuracyM: Number.isFinite(parsed.accuracyM)
      ? Math.round(parsed.accuracyM)
      : null,
    capturedAt: parsed.capturedAt || new Date().toISOString(),
    source: parsed.source || 'gps_confirmed',
    locationTrust: trust,
  };
}

function videoProviderCoords(video) {
  const loc = video.location;
  if (loc && typeof loc === 'object') {
    const lat = parseFloat(loc.lat ?? loc.latitude);
    const lng = parseFloat(loc.lng ?? loc.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  const u = store.users.get(video.userId);
  if (u && u.location && typeof u.location === 'object') {
    const lat = parseFloat(u.location.lat);
    const lng = parseFloat(u.location.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return null;
}

function enrichVideoDistance(video, clientLat, clientLng) {
  const out = { ...video };
  const coords = videoProviderCoords(video);
  if (
    coords &&
    Number.isFinite(clientLat) &&
    Number.isFinite(clientLng)
  ) {
    out.distanceKm =
      Math.round(
        haversineKm(clientLat, clientLng, coords.lat, coords.lng) * 10,
      ) / 10;
  }
  return out;
}

// GET /videos بدون auth — تصفح الزائر قبل التسجيل
app.get('/videos', (req, res) => {
  const { type, q, sort, serviceCategory, targetSpecies, subCategory, tag, badge } = req.query;
  let list = [...store.videos.values()];
  if (type) list = list.filter((v) => v.type === type);

  if (!SHEEP_FEATURES_ENABLED) {
    list = list.filter((v) => {
      if (v.type === 'sheep') return false;
      const ts = String(v.targetSpecies || '').trim().toLowerCase();
      if (ts === 'sheep') return false;
      if (Array.isArray(v.applicableSpecies)) {
        return !v.applicableSpecies.includes('sheep');
      }
      return true;
    });
    if (type === 'sheep') list = [];
  }

  const heritageTypes = ['horse', 'camel', 'falcon', 'sheep'];
  if (type && heritageTypes.includes(String(type))) {
    list = list.filter((v) => {
      if (v.type !== type) return false;
      const sp = String(v.species || '').trim();
      if (sp && sp !== type) return false;
      return true;
    });
  }

  if (type === 'service') {
    list = list.filter((v) => v.type === 'service');
  }

  const sheepSub = req.query.sheepSubCategory != null
    ? String(req.query.sheepSubCategory).trim().toLowerCase()
    : '';
  if (sheepSub) {
    list = list.filter((v) => {
      const sub = String(v.sheepSubCategory || '').trim().toLowerCase();
      const purpose = String(v.purpose || '').trim().toLowerCase();
      if (sub === sheepSub) return true;
      if (sheepSub === 'mandi' && purpose === 'mandi') return true;
      return false;
    });
  }

  const breedQ = req.query.breed != null ? String(req.query.breed).trim() : '';
  if (breedQ) {
    list = list.filter(
      (v) => String(v.breed || v.type || '').trim() === breedQ,
    );
  }

  const ageMonthsQ = parseInt(req.query.ageMonths, 10);
  if (Number.isFinite(ageMonthsQ)) {
    list = list.filter((v) => parseInt(v.ageMonths, 10) === ageMonthsQ);
  }

  const camelColorQ =
    req.query.camelColor != null ? String(req.query.camelColor).trim() : '';
  if (camelColorQ) {
    list = list.filter((v) => {
      const c = String(v.camelColor || v.breed || '').trim();
      return c === camelColorQ;
    });
  }

  const camelAgeGradeQ =
    req.query.camelAgeGrade != null ? String(req.query.camelAgeGrade).trim() : '';
  if (camelAgeGradeQ) {
    list = list.filter(
      (v) => String(v.camelAgeGrade || v.age || '').trim() === camelAgeGradeQ,
    );
  }

  const herdCountQ = parseInt(req.query.herdCount, 10);
  if (Number.isFinite(herdCountQ)) {
    list = list.filter((v) => parseInt(v.herdCount, 10) === herdCountQ);
  }

  const coatColorQ =
    req.query.coatColor != null ? String(req.query.coatColor).trim() : '';
  if (coatColorQ) {
    list = list.filter((v) => String(v.coatColor || '').trim() === coatColorQ);
  }

  const ageYearsQ = req.query.age != null ? String(req.query.age).trim() : '';
  if (ageYearsQ && !Number.isFinite(ageMonthsQ)) {
    list = list.filter((v) => String(v.age || '').trim() === ageYearsQ);
  }

  const genderQ = req.query.gender != null ? String(req.query.gender).trim() : '';
  if (genderQ) {
    list = list.filter((v) => String(v.gender || '').trim() === genderQ);
  }

  const cityQ = req.query.city != null ? String(req.query.city).trim() : '';
  if (cityQ) {
    list = list.filter((v) => String(v.city || '').trim() === cityQ);
  }

  const qq = q != null ? String(q).trim() : '';
  if (qq) {
    const lower = qq.toLowerCase();
    list = list.filter((v) => {
      const title = String(v.title ?? v.name ?? v.serviceName ?? '').toLowerCase();
      const desc = String(v.description ?? '').toLowerCase();
      const sub = String(v.subCategory ?? '').toLowerCase();
      return title.includes(lower) || desc.includes(lower) || sub.includes(lower);
    });
  }

  const cat = serviceCategory != null ? String(serviceCategory) : '';
  if (cat && cat !== 'all') {
    list = list.filter(
      (v) => v.serviceCategory === cat || v.serviceType === cat,
    );
  }

  const excludeCat =
    req.query.excludeServiceCategory != null
      ? String(req.query.excludeServiceCategory).trim()
      : '';
  if (excludeCat) {
    list = list.filter(
      (v) =>
        String(v.serviceCategory || v.serviceType || '') !== excludeCat,
    );
  }

  const subCat = subCategory != null ? String(subCategory).trim() : '';
  if (subCat && subCat !== 'all') {
    list = list.filter((v) => String(v.subCategory ?? '') === subCat);
  }

  const ts = targetSpecies != null ? String(targetSpecies) : '';
  if (ts && ts !== 'all') {
    list = list.filter((v) => {
      const x = v.targetSpecies ?? v.applicableSpecies;
      if (x == null || x === '') return false;
      if (Array.isArray(x)) return x.includes(ts) || x.includes('all');
      return String(x) === ts || String(x) === 'all';
    });
  }

  const clientLat = parseFloat(req.query.lat);
  const clientLng = parseFloat(req.query.lng);
  const hasClient =
    Number.isFinite(clientLat) && Number.isFinite(clientLng);

  list = list.map((v) => {
    let out = {
      ...v,
      likes: v.likes ?? 0,
      views: v.views ?? 0,
      favorites: v.favorites ?? 0,
      comments: v.comments ?? (store.videoComments[v.id] || []).length,
    };
    if (hasClient) out = enrichVideoDistance(out, clientLat, clientLng);
    return out;
  });

  const sortKey = sort != null ? String(sort) : 'newest';
  const t = (x) => {
    const d = x.createdAt ? new Date(x.createdAt).getTime() : 0;
    return Number.isFinite(d) ? d : 0;
  };
  if (sortKey === 'distance' && hasClient) {
    list.sort((a, b) => {
      const da = a.distanceKm;
      const db = b.distanceKm;
      if (da == null && db == null) return t(b) - t(a);
      if (da == null) return 1;
      if (db == null) return -1;
      return da - db;
    });
  } else if (sortKey === 'oldest') {
    list.sort((a, b) => t(a) - t(b));
  } else if (sortKey === 'views_desc') {
    list.sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  } else if (sortKey === 'likes_desc') {
    list.sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
  } else {
    list.sort((a, b) => t(b) - t(a));
  }

  list = filterVideosForViewer(list, viewerFromToken(req));
  if (tag) list = list.filter((v) => heritageTB.itemHasTag(v, tag));
  if (badge) list = list.filter((v) => heritageTB.itemHasBadge(v, badge));
  res.json(list.map((v) => heritageTB.scrubItemTags(v)));
});

app.post('/videos', auth, requireSessionUser, (req, res) => {
  const serviceType = String(
    req.body?.serviceType || req.body?.serviceCategory || '',
  ).trim();
  if (req.body?.type === 'service' && serviceType) {
    const err = roles.assertVideoCreate(req.authUser, serviceType);
    if (err) return res.status(403).json({ message: err });
    const verifyErr = roles.assertMerchantVerified(req.authUser);
    if (verifyErr) return res.status(403).json({ message: verifyErr });
  }

  const locErr = validateVideoLocation(req.body);
  if (locErr) return res.status(400).json({ message: locErr });
  const normalizedLocation = normalizeVideoLocation(req.body);

  const bodyType = String(req.body?.type || '').trim();
  if (isSheepSpecies(bodyType) && rejectSheepPaused(res)) return;
  const heritageTypes = ['horse', 'camel', 'falcon', 'sheep'];
  if (heritageTypes.includes(bodyType)) {
    const sp = String(req.body?.species || bodyType).trim();
    if (sp !== bodyType) {
      return res.status(400).json({
        message: `نوع الفيديو (${bodyType}) لا يطابق التصنيف (${sp})`,
      });
    }
  }
  if (bodyType === 'service') {
    const st = String(
      req.body?.serviceType || req.body?.serviceCategory || '',
    ).trim();
    if (!st) {
      return res.status(400).json({ message: 'نوع الخدمة مطلوب لفيديو الخدمات' });
    }
    const ts = String(req.body?.targetSpecies || '').trim().toLowerCase();
    if (isSheepSpecies(ts) && rejectSheepPaused(res)) return;
  }

  const body = heritageTB.applyClientListingFields(req.body || {}, {});
  const tagSpecies = heritageTypes.includes(bodyType)
    ? bodyType
    : String(req.body?.targetSpecies || 'horse');
  const videoId = req.body.cloudflareVideoId || id();
  const video = {
    id: videoId,
    ...body,
    location: normalizedLocation,
    city: normalizedLocation?.city || req.body.city || '',
    ...(heritageTypes.includes(bodyType) ? { species: bodyType } : {}),
    tags: heritageTB.sanitizeTags(body.tags, tagSpecies),
    badges: [],
    userId: req.body.userId || req.authUserId,
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
  res.status(201).json(heritageTB.scrubItemTags(video));
});

app.patch('/videos/:id', auth, (req, res) => {
  const { id } = req.params;
  const existing = store.videos.get(id);
  if (!existing) return res.status(404).json({ message: 'الفيديو غير موجود' });
  const body = heritageTB.applyClientListingFields(req.body || {}, existing);
  const tagSpecies =
    req.body?.species ||
    req.body?.targetSpecies ||
    existing.species ||
    existing.type ||
    'horse';
  const updated = {
    ...existing,
    ...body,
    id,
    badges: Array.isArray(existing.badges) ? existing.badges : [],
  };
  updated.tags = heritageTB.sanitizeTags(updated.tags, tagSpecies);
  store.videos.set(id, updated);
  saveStore();
  res.json(heritageTB.scrubItemTags(updated));
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

// ========== لوحة التحكم (ملخص للمستخدم الحالي) ==========
app.get('/dashboard/summary', auth, requireSessionUser, (req, res) => {
  const userId = String(req.query.userId || '').trim();
  if (!userId) {
    return res.status(400).json({ message: 'userId مطلوب' });
  }
  if (userId !== req.authUserId) {
    return res.status(403).json({ message: 'لا يمكن جلب ملخص مستخدم آخر' });
  }
  const horsesListed = [...store.horses.values()].filter(
    (h) => String(h.ownerId || h.userId || '') === userId,
  ).length;
  const servicesListed = [...store.services.values()].filter(
    (s) => String(s.providerId || '') === userId,
  ).length;
  const catalogItemsListed = [...store.catalogItems.values()].filter(
    (c) => String(c.sellerId || '') === userId && (c.status || 'active') === 'active',
  ).length;
  const asSellerOrders = [...store.orders.values()].filter(
    (o) => String(o.sellerId || '') === userId,
  );
  const pendingSellerOrders = asSellerOrders.filter(
    (o) => ['paid', 'preparing'].includes(String(o.status || '')),
  ).length;
  const completedOrderRevenue = asSellerOrders
    .filter((o) => String(o.status || '') === 'delivered')
    .reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  const videosListed = [...store.videos.values()].filter(
    (v) => String(v.userId || '') === userId,
  ).length;
  const allBookings = [...store.bookings.values()];
  const asProvider = allBookings.filter((b) => String(b.providerId || '') === userId);
  const asCustomer = allBookings.filter((b) => String(b.userId || '') === userId);
  const pendingProviderBookings = asProvider.filter((b) => (b.status || 'pending') === 'pending').length;
  const fav = store.favorites.get(userId) || { horseIds: [] };
  const favoriteHorsesCount = (fav.horseIds || []).length;
  res.json({
    userId,
    horsesListed,
    servicesListed,
    catalogItemsListed,
    videosListed,
    bookingsAsProvider: asProvider.length,
    bookingsAsCustomer: asCustomer.length,
    pendingProviderBookings,
    ordersAsSeller: asSellerOrders.length,
    pendingSellerOrders,
    completedOrderRevenue,
    favoriteHorsesCount,
  });
});

// ========== CRM — طلبات قيد الانتظار لمقدم الخدمة ==========
app.post('/crm/contact-leads', auth, requireSessionUser, (req, res) => {
  const catalogItemId = String(req.body?.catalogItemId || '').trim();
  const channel = String(req.body?.channel || 'phone').trim().toLowerCase();
  if (!catalogItemId) {
    return res.status(400).json({ message: 'catalogItemId مطلوب' });
  }
  const item = store.catalogItems.get(catalogItemId);
  if (!item) return res.status(404).json({ message: 'المنتج غير موجود' });
  const cat = String(item.category || '');
  if (cat !== 'feed' && cat !== 'equipment') {
    return res.status(400).json({
      message: 'تسجيل الاهتمام متاح لأعلاف والمعدات فقط',
    });
  }
  const sellerId = String(item.sellerId || '');
  if (!sellerId) {
    return res.status(400).json({ message: 'البائع غير محدد' });
  }
  if (sellerId === req.authUserId) {
    return res.status(400).json({ message: 'لا يمكن تسجيل اهتمام على منتجك' });
  }
  const buyer = store.users.get(req.authUserId) || {};
  const leadId = id();
  const lead = {
    id: leadId,
    source: 'contact',
    type: cat === 'feed' ? 'feed_contact' : 'equipment_contact',
    catalogItemId,
    serviceName: item.name || '',
    category: cat,
    channel: channel === 'whatsapp' ? 'whatsapp' : 'phone',
    sellerId,
    userId: req.authUserId,
    customerName: String(buyer.name || buyer.displayName || buyer.email || 'عميل'),
    customerPhone: String(buyer.phone || ''),
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  if (!store.contactLeads) store.contactLeads = new Map();
  store.contactLeads.set(leadId, lead);
  notifyEvent(
    sellerId,
    cat === 'feed' ? 'اهتمام بمنتج أعلاف' : 'اهتمام بمعدة',
    `${lead.customerName} تواصل عبر ${lead.channel} — ${lead.serviceName}`,
    { type: 'contact_lead', leadId, catalogItemId },
  );
  saveStore();
  res.status(201).json(lead);
});

app.get('/crm/leads', auth, requireSessionUser, (req, res) => {
  if (runLazyExpiry()) saveStore();
  const userId = String(req.query.userId || '').trim();
  if (!userId) {
    return res.status(400).json({ message: 'userId مطلوب' });
  }
  if (userId !== req.authUserId) {
    return res.status(403).json({ message: 'لا يمكن جلب طلبات مقدم خدمة آخر' });
  }
  const bookingLeads = [...store.bookings.values()]
    .filter(
      (b) =>
        String(b.providerId || '') === userId &&
        String(b.status || 'pending') === 'pending',
    )
    .map((b) => {
      const details =
        b.details && typeof b.details === 'object' ? b.details : {};
      const origin =
        details.origin && typeof details.origin === 'object'
          ? details.origin
          : null;
      const destination =
        details.destination && typeof details.destination === 'object'
          ? details.destination
          : null;
      return {
        id: b.id,
        source: 'booking',
        type: b.type || b.serviceType,
        serviceId: b.serviceId,
        serviceName: b.serviceName || details.serviceName,
        customerName: b.customerName || details.customerName,
        customerPhone: b.customerPhone || details.customerPhone,
        totalPrice: b.totalPrice,
        bookingDate: b.bookingDate,
        startDate: b.startDate || details.startDate,
        endDate: b.endDate || details.endDate,
        spacesRequested: b.spacesRequested || details.spacesRequested || 1,
        paymentMethod: b.paymentMethod || details.paymentMethod,
        city: b.city || details.city,
        address: b.address || details.address || b.fullAddress,
        notes: b.notes || details.notes,
        originAddress: origin?.address || null,
        destinationAddress: destination?.address || null,
        origin,
        destination,
        horseType: details.horseType,
        numberOfHorses: details.numberOfHorses,
        headCount: details.headCount,
        birdCount: details.birdCount,
        unitsRequested: details.unitsRequested,
        species: details.species,
        camelAgeGrade: details.camelAgeGrade,
        camelTransportMode: details.camelTransportMode,
        falconCarrierType: details.falconCarrierType,
        createdAt: b.createdAt,
        userId: b.userId,
        status: b.status || 'pending',
      };
    });

  const orderLeads = [...store.orders.values()]
    .filter(
      (o) =>
        String(o.sellerId || '') === userId &&
        ['paid', 'preparing'].includes(String(o.status || '')),
    )
    .map((o) => ({
      id: o.id,
      source: 'order',
      type: 'supplies_order',
      serviceName: `طلب أدوات (${(o.lines || []).length} صنف)`,
      customerName: o.customerName || '',
      customerPhone: o.customerPhone || '',
      totalPrice: o.total,
      createdAt: o.createdAt,
      userId: o.userId,
      status: o.status,
    }));

  const contactLeads = [...(store.contactLeads || new Map()).values()]
    .filter(
      (l) =>
        String(l.sellerId || '') === userId &&
        String(l.status || 'open') === 'open',
    )
    .map((l) => ({
      id: l.id,
      source: 'contact',
      type: l.type,
      serviceName: l.serviceName,
      catalogItemId: l.catalogItemId,
      channel: l.channel,
      customerName: l.customerName || '',
      customerPhone: l.customerPhone || '',
      createdAt: l.createdAt,
      userId: l.userId,
      status: l.status || 'open',
    }));

  const leads = [...bookingLeads, ...orderLeads, ...contactLeads].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  res.json(leads);
});

// ========== الرسائل (هوية المرسل من التوكن فقط) ==========
app.get('/messages', auth, requireSessionUser, (req, res) => {
  const userId = req.authUserId;
  const list = (store.messages || [])
    .filter((m) => m.fromUserId === userId || m.toUserId === userId)
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  res.json(list);
});

app.post('/messages', auth, requireSessionUser, (req, res) => {
  const fromUserId = req.authUserId;
  const { toUserId, text, fromUserId: spoofFrom } = req.body || {};
  if (spoofFrom != null && String(spoofFrom) !== '' && String(spoofFrom) !== fromUserId) {
    return res.status(403).json({ message: 'لا يمكن الإرسال باسم مستخدم آخر' });
  }
  const to = toUserId != null ? String(toUserId).trim() : '';
  const bodyText = text != null ? String(text).trim() : '';
  if (!to || !bodyText) {
    return res.status(400).json({ message: 'toUserId والنص مطلوبان' });
  }
  if (to === fromUserId) {
    return res.status(400).json({ message: 'لا يمكن إرسال رسالة إلى نفسك' });
  }
  if (!store.users.has(to)) {
    return res.status(400).json({ message: 'المستقبل غير موجود' });
  }
  const maxLen = 8000;
  if (bodyText.length > maxLen) {
    return res.status(400).json({ message: `النص يتجاوز الحد (${maxLen} حرفاً)` });
  }
  const msg = {
    id: id(),
    fromUserId,
    toUserId: to,
    text: bodyText,
    createdAt: new Date().toISOString(),
    read: false,
  };
  if (!Array.isArray(store.messages)) store.messages = [];
  store.messages.push(msg);
  saveStore();
  res.status(201).json(msg);
});

// ========== إدارة - لوحة التحكم وتصدير البيانات ==========
// لوحة الإدارة — التوجيه للوحة الاحترافية الجديدة
app.get('/admin', (req, res) => {
  if (fs.existsSync(adminConsoleDir)) {
    return res.redirect('/console/');
  }
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
    catalogItems: Object.fromEntries(store.catalogItems),
    carts: Object.fromEntries(store.carts),
    orders: Object.fromEntries(store.orders),
    videos: Object.fromEntries(store.videos),
    videoComments: store.videoComments,
    messages: store.messages || [],
    contentReports: store.contentReports || [],
    accessTokens: Object.fromEntries(store.accessTokens),
    adminUsers: Object.fromEntries(store.adminUsers),
    auditEvents: store.auditEvents || [],
    apiMetrics: store.apiMetrics,
  };
  res.json(data);
});

/** استعادة store.json كاملاً — بعد تفعيل القرص الدائم على Render */
app.post('/admin/restore-store', requireAdmin, (req, res) => {
  try {
    applyStoreSnapshot(req.body, 'admin/restore-store');
    saveStore();
    res.json({
      ok: true,
      message: 'تمت استعادة البيانات',
      counts: {
        users: store.users.size,
        horses: store.horses.size,
        videos: store.videos.size,
        services: store.services.size,
      },
      storage: storagePersistenceStatus(),
    });
  } catch (e) {
    res.status(400).json({ message: e.message || 'فشلت الاستعادة' });
  }
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

// ========== Cloudflare (أسرار على الخادم فقط — التطبيق لا يحمل API Token) ==========
const cfAccountId = () => process.env.CLOUDFLARE_ACCOUNT_ID || '';
const cfApiToken = () => process.env.CLOUDFLARE_API_TOKEN || '';

async function cfFetchJson(url, options = {}) {
  const token = cfApiToken();
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN غير مضبوط');
  const r = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`استجابة غير JSON من Cloudflare (${r.status})`);
  }
  if (!r.ok || data.success === false) {
    const msg = data.errors?.map((e) => e.message).join('; ') || data.message || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

/** جلسة رفع Stream — يعيد uploadURL لمرة واحدة (لا يُعرَّض التوكن للتطبيق) */
app.post('/media/stream/direct-upload', auth, async (req, res) => {
  const accountId = cfAccountId();
  if (!accountId || !cfApiToken()) {
    return res.status(503).json({
      message: 'الخادم لم يُكوَّن لـ Cloudflare Stream. اضبط CLOUDFLARE_ACCOUNT_ID و CLOUDFLARE_API_TOKEN على Render.',
    });
  }
  try {
    const data = await cfFetchJson(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/direct_upload`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxDurationSeconds: 3600,
          requireSignedURLs: false,
          allowedOrigins: ['*'],
        }),
      },
    );
    const result = data.result;
    if (!result?.uploadURL || !result?.uid) {
      return res.status(502).json({ message: 'استجابة Cloudflare غير متوقعة' });
    }
    return res.json({
      uploadURL: result.uploadURL,
      uid: result.uid,
    });
  } catch (e) {
    console.error('[media/stream/direct-upload]', e.message);
    return res.status(502).json({ message: e.message || 'فشل إنشاء جلسة الرفع' });
  }
});

/** جلسة رفع Cloudflare Images (V2 — جسم multipart) */
app.post('/media/images/direct-upload', auth, async (req, res) => {
  const accountId = cfAccountId();
  const token = cfApiToken();
  if (!accountId || !token) {
    return res.status(503).json({
      message: 'الخادم لم يُكوَّن لـ Cloudflare Images. اضبط المتغيرات على الخادم.',
    });
  }
  try {
    // استخدم FormData المدمج مع fetch (Node 18+) — حزمة `form-data` + fetch تعطي غالباً
    // "Bad request: incomplete multipart stream" من Cloudflare (كما في سجلات Render).
    const fd = new FormData();
    fd.append('requireSignedURLs', 'false');
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v2/direct_upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: fd,
      },
    );
    const data = await r.json();
    if (!r.ok || data.success === false) {
      const msg = data.errors?.map((e) => e.message).join('; ') || data.message || `HTTP ${r.status}`;
      throw new Error(msg);
    }
    const result = data.result;
    if (!result?.uploadURL || !result?.id) {
      return res.status(502).json({ message: 'استجابة Cloudflare Images غير متوقعة' });
    }
    return res.json({
      uploadURL: result.uploadURL,
      id: result.id,
    });
  } catch (e) {
    console.error('[media/images/direct-upload]', e.message);
    return res.status(502).json({ message: e.message || 'فشل إنشاء جلسة رفع الصورة' });
  }
});

/** تفاصيل فيديو Stream — بالوكيل حتى لا يحتاج التطبيق التوكن */
app.get('/media/stream/:videoId', auth, async (req, res) => {
  const accountId = cfAccountId();
  const { videoId } = req.params;
  if (!accountId || !cfApiToken()) {
    return res.status(503).json({ message: 'تكوين Cloudflare غير مكتمل على الخادم' });
  }
  try {
    const data = await cfFetchJson(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${videoId}`,
      { method: 'GET' },
    );
    return res.json(data.result || data);
  } catch (e) {
    console.error('[media/stream/:videoId]', e.message);
    return res.status(502).json({ message: e.message || 'فشل جلب الفيديو' });
  }
});

// ========== تشغيل الخادم ==========
// استماع على 0.0.0.0 ليقبل اتصالات من الجهاز الفعلي (iPhone/Android) على نفس الشبكة
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`باك اند العاديات يعمل على http://localhost:${PORT}`);
  console.log(`للجهاز الفعلي على نفس الواي فاي: http://horse-backend.local:${PORT} (mDNS)`);
  console.log(`توثيق API (Swagger): http://localhost:${PORT}/api-docs`);
  const sms = smsOtp.status();
  if (sms.configured) {
    console.log(`[SMS] مفعّل عبر ${sms.provider}${sms.sender ? ` sender=${sms.sender}` : ''}`);
  } else {
    console.warn('[SMS] غير مفعّل —', sms.hint || 'أضف Taqnyat على Render');
  }
  // إعلان mDNS حتى يصل الآيفون عبر horse-backend.local بدون إدخال IP
  try {
    const bonjour = require('bonjour')();
    bonjour.publish({ name: 'horse-backend', type: 'http', port: PORT });
  } catch (e) {
    console.log('تحذير: mDNS غير متوفر:', e.message);
  }
});
