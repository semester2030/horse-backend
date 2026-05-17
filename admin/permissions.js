/**
 * صلاحيات فريق الإدارة — RBAC
 */

const ADMIN_ROLES = {
  super_admin: 'super_admin',
  moderator: 'moderator',
  verifier: 'verifier',
  support: 'support',
  analyst: 'analyst',
};

const ADMIN_ROLE_LABELS_AR = {
  super_admin: 'مدير عام',
  moderator: 'مشرف محتوى',
  verifier: 'مسؤول تحقق',
  support: 'دعم عملاء',
  analyst: 'محلل بيانات',
};

const ALL_PERMISSIONS = [
  'dashboard:read',
  'users:read',
  'users:write',
  'users:verify',
  'content:read',
  'content:moderate',
  'catalog:read',
  'catalog:moderate',
  'videos:read',
  'videos:moderate',
  'orders:read',
  'orders:write',
  'bookings:read',
  'bookings:write',
  'analytics:read',
  'reports:export',
  'audit:read',
  'team:read',
  'team:write',
  'metrics:read',
  'settings:read',
];

const ROLE_PERMISSIONS = {
  [ADMIN_ROLES.super_admin]: ALL_PERMISSIONS,
  [ADMIN_ROLES.moderator]: [
    'dashboard:read',
    'users:read',
    'content:read',
    'content:moderate',
    'catalog:read',
    'catalog:moderate',
    'videos:read',
    'videos:moderate',
    'audit:read',
    'analytics:read',
  ],
  [ADMIN_ROLES.verifier]: [
    'dashboard:read',
    'users:read',
    'users:verify',
    'audit:read',
  ],
  [ADMIN_ROLES.support]: [
    'dashboard:read',
    'users:read',
    'orders:read',
    'orders:write',
    'bookings:read',
    'bookings:write',
    'content:read',
    'catalog:read',
    'videos:read',
  ],
  [ADMIN_ROLES.analyst]: [
    'dashboard:read',
    'analytics:read',
    'reports:export',
    'metrics:read',
    'users:read',
    'orders:read',
    'bookings:read',
    'content:read',
    'catalog:read',
    'videos:read',
  ],
};

function permissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || [];
}

function can(admin, permission) {
  if (!admin || !admin.active) return false;
  if (admin.role === ADMIN_ROLES.super_admin) return true;
  const perms = admin.permissions?.length
    ? admin.permissions
    : permissionsForRole(admin.role);
  return perms.includes(permission);
}

function requirePerm(permission) {
  return (req, res, next) => {
    if (!req.adminUser) {
      return res.status(401).json({ message: 'تسجيل دخول الإدارة مطلوب' });
    }
    if (!can(req.adminUser, permission)) {
      return res.status(403).json({ message: 'ليس لديك صلاحية لهذا الإجراء' });
    }
    next();
  };
}

module.exports = {
  ADMIN_ROLES,
  ADMIN_ROLE_LABELS_AR,
  ALL_PERMISSIONS,
  permissionsForRole,
  can,
  requirePerm,
};
