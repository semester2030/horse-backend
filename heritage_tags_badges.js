/**
 * شارات تميز حسب النوع — مفاتيح مسبوقة بـ species لمنع التداخل مطلقاً.
 * tags ← المعلن | badges ثقة ← الإدارة فقط (verified/featured/elite)
 */

const BADGE_KEYS = Object.freeze(['verified', 'featured', 'elite']);

const BADGE_LABELS_AR = Object.freeze({
  verified: 'موثّق',
  featured: 'مميّز',
  elite: 'نخبة',
});

const TAGS_BY_SPECIES = Object.freeze({
  camel: Object.freeze([
    'camel_manqiyat',
    'camel_fardi',
    'camel_fardiyat',
    'camel_mazayen',
    'camel_racing',
    'camel_production',
  ]),
  horse: Object.freeze([
    'horse_beauty',
    'horse_racing',
    'horse_endurance',
    'horse_production',
    'horse_training',
    'horse_arabian',
  ]),
  falcon: Object.freeze([
    'falcon_hur',
    'falcon_shahin',
    'falcon_jir',
    'falcon_wakri',
    'falcon_hunting',
    'falcon_mazayen',
  ]),
  sheep: Object.freeze([
    'sheep_harri',
    'sheep_naimi',
    'sheep_production',
  ]),
});

const MAX_TAGS = 3;

function speciesKey(raw) {
  const s = String(raw || 'horse').trim().toLowerCase();
  if (TAGS_BY_SPECIES[s]) return s;
  return 'horse';
}

function prefixFor(species) {
  return `${speciesKey(species)}_`;
}

function tagBelongsToSpecies(tag, species) {
  const k = String(tag || '').trim();
  if (!k) return false;
  const sp = speciesKey(species);
  if (!k.startsWith(`${sp}_`)) return false;
  const allowed = TAGS_BY_SPECIES[sp] || [];
  return allowed.includes(k);
}

function sanitizeTags(raw, species) {
  const sp = speciesKey(species);
  const allowed = new Set(TAGS_BY_SPECIES[sp] || TAGS_BY_SPECIES.horse);
  const prefix = `${sp}_`;
  const out = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    const k = String(item || '').trim();
    if (!k || !allowed.has(k) || !k.startsWith(prefix) || out.includes(k)) continue;
    out.push(k);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function sanitizeBadges(raw) {
  const out = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    const k = String(item || '').trim();
    if (!BADGE_KEYS.includes(k) || out.includes(k)) continue;
    out.push(k);
  }
  return out;
}

/** ينزع badges من جسم العميل ويثبّت tags المسموحة لنفس النوع فقط */
function applyClientListingFields(body, existing = {}) {
  const species =
    body?.species ||
    body?.listingSpecies ||
    body?.type ||
    existing.species ||
    'horse';
  const next = { ...body };
  delete next.badges;
  if (Object.prototype.hasOwnProperty.call(body || {}, 'tags')) {
    next.tags = sanitizeTags(body.tags, species);
  } else if (Array.isArray(existing.tags)) {
    // إعادة تصفية الوسوم القديمة إن تغيّر النوع
    next.tags = sanitizeTags(existing.tags, species);
  } else if (!existing.tags) {
    next.tags = [];
  }
  return next;
}

function itemHasTag(item, tag) {
  if (!tag) return true;
  const t = String(tag).trim();
  const itemSpecies = item?.species || item?.type || 'horse';
  // لا تطابق وسم نوع على عنصر من نوع آخر أبداً
  if (!tagBelongsToSpecies(t, itemSpecies)) return false;
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  return tags.map(String).includes(t);
}

function itemHasBadge(item, badge) {
  if (!badge) return true;
  const b = String(badge).trim();
  const badges = Array.isArray(item?.badges) ? item.badges : [];
  return badges.map(String).includes(b);
}

/** يسقط من عنصر ما أي tags لا تخص نوعه (تنظيف قراءة) */
function scrubItemTags(item) {
  if (!item || typeof item !== 'object') return item;
  const sp = item.species || item.type || 'horse';
  const cleaned = sanitizeTags(item.tags, sp);
  return { ...item, tags: cleaned };
}

module.exports = {
  BADGE_KEYS,
  BADGE_LABELS_AR,
  TAGS_BY_SPECIES,
  MAX_TAGS,
  sanitizeTags,
  sanitizeBadges,
  applyClientListingFields,
  itemHasTag,
  itemHasBadge,
  speciesKey,
  tagBelongsToSpecies,
  prefixFor,
  scrubItemTags,
};
