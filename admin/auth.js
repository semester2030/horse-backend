/**
 * مصادقة فريق الإدارة — JWT بسيط + تجزئة كلمات المرور (crypto)
 */

const crypto = require('crypto');
const { permissionsForRole, ADMIN_ROLES } = require('./permissions');

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signToken(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({
      ...payload,
      exp: Date.now() + TOKEN_TTL_MS,
    }),
  );
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (sig !== expected) return null;
  try {
    const json = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (!json.exp || json.exp < Date.now()) return null;
    return json;
  } catch {
    return null;
  }
}

function publicAdmin(admin) {
  if (!admin) return null;
  const { passwordHash, passwordSalt, ...rest } = admin;
  return {
    ...rest,
    permissions:
      rest.permissions?.length > 0
        ? rest.permissions
        : permissionsForRole(rest.role),
  };
}

function seedSuperAdmin(ctx) {
  if (ctx.store.adminUsers.size > 0) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@nomas.sa').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || 'NomasAdmin2026!';
  const { salt, hash } = hashPassword(password);
  const adminId = ctx.id();
  const admin = {
    id: adminId,
    email,
    name: 'مدير النظام',
    role: ADMIN_ROLES.super_admin,
    permissions: permissionsForRole(ADMIN_ROLES.super_admin),
    passwordSalt: salt,
    passwordHash: hash,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  ctx.store.adminUsers.set(adminId, admin);
  ctx.saveStore();
  console.log(`[admin] تم إنشاء مدير افتراضي: ${email} — غيّر ADMIN_PASSWORD في الإنتاج`);
}

function createAdminAuthMiddleware(ctx) {
  return function requireAdminAuth(req, res, next) {
    const h = req.headers.authorization;
    const t = h && h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t) {
      return res.status(401).json({ message: 'توكن الإدارة مطلوب' });
    }
    const payload = verifyToken(t, ctx.adminJwtSecret);
    if (!payload || !payload.sub) {
      return res.status(401).json({ message: 'جلسة الإدارة منتهية — سجّل الدخول مجدداً' });
    }
    const admin = ctx.store.adminUsers.get(String(payload.sub));
    if (!admin || !admin.active) {
      return res.status(401).json({ message: 'حساب الإدارة غير نشط' });
    }
    req.adminUser = admin;
    req.adminUserId = admin.id;
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  publicAdmin,
  seedSuperAdmin,
  createAdminAuthMiddleware,
  TOKEN_TTL_MS,
};
