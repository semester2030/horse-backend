/**
 * أدوار الحسابات وصلاحيات API — مصدر واحد للحقيقة
 */

const ACCOUNT_ROLES = {
  buyer: 'buyer',
  heritage_advertiser: 'heritage_advertiser',
  feed_merchant: 'feed_merchant',
  supplies_merchant: 'supplies_merchant',
  equipment_dealer: 'equipment_dealer',
  vet_clinic: 'vet_clinic',
  transport_provider: 'transport_provider',
};

const ALL_SPECIES = ['horse', 'camel', 'falcon'];

const ROLE_LABELS_AR = {
  buyer: 'مشتري',
  heritage_advertiser: 'معلن موروث',
  feed_merchant: 'بائع أعلاف',
  supplies_merchant: 'محل أدوات',
  equipment_dealer: 'تاجر معدات ثقيلة',
  vet_clinic: 'بيطرة / منشأة صحية',
  transport_provider: 'نقل',
};

function capabilitiesForRole(role) {
  switch (role) {
    case ACCOUNT_ROLES.buyer:
      return ['browse', 'cart:checkout', 'booking:create'];
    case ACCOUNT_ROLES.heritage_advertiser:
      return [
        'listing:create',
        'video:service:create',
        'service:transportation:create',
        'service:stable:create',
        'crm:leads:read',
        'dashboard:read',
      ];
    case ACCOUNT_ROLES.feed_merchant:
      return [
        'catalog:feed:write',
        'video:feed:create',
        'crm:leads:read',
        'dashboard:read',
      ];
    case ACCOUNT_ROLES.supplies_merchant:
      return [
        'catalog:supplies:write',
        'video:supplies:create',
        'cart:fulfill',
        'crm:orders:read',
        'dashboard:read',
      ];
    case ACCOUNT_ROLES.equipment_dealer:
      return [
        'catalog:equipment:write',
        'video:equipment:create',
        'crm:leads:read',
        'dashboard:read',
      ];
    case ACCOUNT_ROLES.vet_clinic:
      return [
        'service:veterinary:create',
        'service:stable:create',
        'catalog:supplies:write',
        'video:veterinary:create',
        'video:stable:create',
        'crm:bookings:read',
        'dashboard:read',
      ];
    case ACCOUNT_ROLES.transport_provider:
      return [
        'service:transportation:create',
        'video:transportation:create',
        'crm:bookings:read',
        'dashboard:read',
      ];
    default:
      return [];
  }
}

function defaultSpeciesForRole(role) {
  switch (role) {
    case ACCOUNT_ROLES.feed_merchant:
      return ['horse', 'camel'];
    case ACCOUNT_ROLES.equipment_dealer:
      return ['camel', 'horse'];
    case ACCOUNT_ROLES.supplies_merchant:
      return ['horse'];
    case ACCOUNT_ROLES.heritage_advertiser:
      return ['horse'];
    default:
      return [];
  }
}

/** ترحيل userType القديم من التطبيق */
function migrateLegacyUser(user) {
  if (!user || typeof user !== 'object') return user;
  if (user.accountRole && ACCOUNT_ROLES[user.accountRole]) {
    if (!user.capabilities || !user.capabilities.length) {
      user.capabilities = capabilitiesForRole(user.accountRole);
    }
    return user;
  }
  const legacy = String(user.userType || user.role || '').trim();
  let accountRole = ACCOUNT_ROLES.buyer;
  if (legacy === 'horseOwner') accountRole = ACCOUNT_ROLES.heritage_advertiser;
  else if (legacy === 'serviceProvider') accountRole = ACCOUNT_ROLES.heritage_advertiser;
  else if (legacy === 'stableOwner') accountRole = ACCOUNT_ROLES.vet_clinic;
  else if (legacy === 'individual') accountRole = ACCOUNT_ROLES.buyer;

  user.accountRole = accountRole;
  user.userType = legacy || accountRole;
  user.capabilities = capabilitiesForRole(accountRole);
  if (!user.allowedSpecies || !user.allowedSpecies.length) {
    user.allowedSpecies =
      user.advertiserSpecies && user.advertiserSpecies.length
        ? user.advertiserSpecies
        : defaultSpeciesForRole(accountRole);
  }
  return user;
}

function hasCapability(user, cap) {
  const u = migrateLegacyUser({ ...user });
  const list = u.capabilities || capabilitiesForRole(u.accountRole);
  return list.includes(cap);
}

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('966')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 9 && digits.startsWith('5')) {
    return '+966' + digits;
  }
  if (digits.length >= 10 && digits.length <= 15) {
    return '+' + digits;
  }
  return null;
}

function speciesAllowed(user, species) {
  const sp = String(species || '').trim().toLowerCase();
  if (!sp || sp === 'all') return true;
  const u = migrateLegacyUser({ ...user });
  const allowed = u.allowedSpecies || [];
  if (!allowed.length) return true;
  return allowed.includes(sp) || allowed.includes('all');
}

function assertCatalogCreate(user, category) {
  const cat = String(category || '').trim();
  const role = migrateLegacyUser({ ...user }).accountRole;

  if (cat === 'feed') {
    if (role !== ACCOUNT_ROLES.feed_merchant) {
      return 'إضافة الأعلاف محجوزة لحساب بائع الأعلاف';
    }
    return null;
  }
  if (cat === 'supplies') {
    if (role !== ACCOUNT_ROLES.supplies_merchant && role !== ACCOUNT_ROLES.vet_clinic) {
      return 'إضافة الأدوات محجوزة لمحلات الأدوات أو العيادات';
    }
    return null;
  }
  if (cat === 'equipment') {
    if (role !== ACCOUNT_ROLES.equipment_dealer) {
      return 'إضافة المعدات الثقيلة محجوزة لتجار المعدات (معارض/مصانع)';
    }
    return null;
  }
  return 'فئة المنتج غير مدعومة';
}

function assertServiceCreate(user, serviceType) {
  const t = String(serviceType || '').trim();
  const role = migrateLegacyUser({ ...user }).accountRole;

  if (t === 'transportation') {
    if (role !== ACCOUNT_ROLES.transport_provider && role !== ACCOUNT_ROLES.heritage_advertiser) {
      return 'خدمة النقل محجوزة لحساب النقل أو المعلن الموروث';
    }
    return null;
  }
  if (t === 'veterinary') {
    if (role !== ACCOUNT_ROLES.vet_clinic) {
      return 'خدمة البيطرة محجوزة للعيادات والمنشآت الصحية';
    }
    return null;
  }
  if (t === 'stable') {
    if (role !== ACCOUNT_ROLES.vet_clinic && role !== ACCOUNT_ROLES.heritage_advertiser) {
      return 'خدمة الإسطبل محجوزة للعيادات أو المعلن الموروث';
    }
    return null;
  }
  return 'نوع الخدمة غير مسموح لحسابك';
}

function assertVideoCreate(user, serviceType) {
  const t = String(serviceType || '').trim();
  if (!t || t === 'horse' || t === 'camel' || t === 'falcon') {
    return 'فيديو الإعلانات الحيوانية من شاشة الخريطة/الإعلانات';
  }
  const role = migrateLegacyUser({ ...user }).accountRole;

  if (t === 'feed') {
    if (role !== ACCOUNT_ROLES.feed_merchant) return 'فيديو الأعلاف لبائع الأعلاف فقط';
    return null;
  }
  if (t === 'supplies') {
    if (role !== ACCOUNT_ROLES.supplies_merchant) return 'فيديو الأدوات لمحل الأدوات فقط';
    return null;
  }
  if (t === 'equipment') {
    if (role !== ACCOUNT_ROLES.equipment_dealer) return 'فيديو المعدات لتاجر المعدات الثقيلة فقط';
    return null;
  }
  if (t === 'transportation') {
    if (role !== ACCOUNT_ROLES.transport_provider && role !== ACCOUNT_ROLES.heritage_advertiser) {
      return 'فيديو النقل غير متاح لحسابك';
    }
    return null;
  }
  if (t === 'veterinary' || t === 'stable') {
    if (role !== ACCOUNT_ROLES.vet_clinic && role !== ACCOUNT_ROLES.heritage_advertiser) {
      return 'فيديو الخدمة غير متاح لحسابك';
    }
    if (t === 'veterinary' && role === ACCOUNT_ROLES.heritage_advertiser) return null;
    if (t === 'stable' && role === ACCOUNT_ROLES.heritage_advertiser) return null;
    if (role === ACCOUNT_ROLES.vet_clinic) return null;
    return 'فيديو الخدمة غير متاح لحسابك';
  }
  if (role === ACCOUNT_ROLES.heritage_advertiser) {
    return null;
  }
  return 'نوع فيديو الخدمة غير مسموح لحسابك';
}

function assertListingCreate(user, species) {
  const role = migrateLegacyUser({ ...user }).accountRole;
  if (role !== ACCOUNT_ROLES.heritage_advertiser) {
    return 'إعلان بيع الخيل/الإبل/الصقور محجوز للمعلن الموروث';
  }
  if (!speciesAllowed(user, species)) {
    return 'لا يمكنك الإعلان في هذا المجال — راجع مجالات حسابك';
  }
  return null;
}

function publicUser(user) {
  if (!user) return null;
  const u = migrateLegacyUser({ ...user });
  const { password, ...rest } = u;
  return rest;
}

function buildUserFromOnboarding({ phone, accountRole, name, city, allowedSpecies, businessType }) {
  const userId = null; // assigned by caller
  const role = ACCOUNT_ROLES[accountRole] ? accountRole : ACCOUNT_ROLES.buyer;
  return {
    phone,
    accountRole: role,
    userType: legacyUserTypeFromRole(role),
    name: String(name || '').trim(),
    city: String(city || '').trim(),
    businessType: businessType ? String(businessType) : '',
    allowedSpecies:
      allowedSpecies && allowedSpecies.length
        ? allowedSpecies
        : defaultSpeciesForRole(role),
    capabilities: capabilitiesForRole(role),
    advertiserSpecies:
      role === ACCOUNT_ROLES.heritage_advertiser
        ? allowedSpecies && allowedSpecies.length
          ? allowedSpecies
          : defaultSpeciesForRole(role)
        : [],
    shopType:
      role === ACCOUNT_ROLES.vet_clinic
        ? 'vet'
        : role === ACCOUNT_ROLES.supplies_merchant
          ? 'supplies'
          : role === ACCOUNT_ROLES.feed_merchant
            ? 'feed'
            : role === ACCOUNT_ROLES.equipment_dealer
              ? 'equipment'
              : '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function legacyUserTypeFromRole(role) {
  switch (role) {
    case ACCOUNT_ROLES.heritage_advertiser:
      return 'horseOwner';
    case ACCOUNT_ROLES.feed_merchant:
    case ACCOUNT_ROLES.supplies_merchant:
    case ACCOUNT_ROLES.equipment_dealer:
    case ACCOUNT_ROLES.vet_clinic:
    case ACCOUNT_ROLES.transport_provider:
      return 'serviceProvider';
    default:
      return 'individual';
  }
}

function isValidAccountRole(role) {
  return Boolean(role && ACCOUNT_ROLES[role]);
}

module.exports = {
  ACCOUNT_ROLES,
  ALL_SPECIES,
  ROLE_LABELS_AR,
  capabilitiesForRole,
  defaultSpeciesForRole,
  migrateLegacyUser,
  hasCapability,
  normalizePhone,
  speciesAllowed,
  assertCatalogCreate,
  assertServiceCreate,
  assertVideoCreate,
  assertListingCreate,
  publicUser,
  buildUserFromOnboarding,
  legacyUserTypeFromRole,
  isValidAccountRole,
};
