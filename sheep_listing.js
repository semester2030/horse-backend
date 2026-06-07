/**
 * تحقق إعلانات الغنم — سعر ثابت، مندي 1–3 أشهر
 */

const VALID_SUB = new Set(['mandi', 'general', 'ram', 'goat', 'breeding']);
const VALID_SALE = new Set(['individual', 'flock']);
const VALID_BASIS = new Set(['per_mother', 'per_head', 'whole_flock']);
const VALID_PURPOSE = new Set(['mandi', 'لحم', 'تربية', 'حليب', 'أخرى', 'meat', 'breeding']);

function validateSheepListing(body) {
  if (!body || typeof body !== 'object') {
    return 'بيانات الإعلان غير صالحة';
  }

  const sub = String(body.sheepSubCategory || 'general').trim().toLowerCase();
  if (!VALID_SUB.has(sub)) {
    return 'تصنيف الغنم غير صالح';
  }

  const saleMode = String(body.saleMode || 'individual').trim().toLowerCase();
  if (!VALID_SALE.has(saleMode)) {
    return 'نوع البيع (فردي/قطيع) غير صالح';
  }

  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) {
    return 'السعر مطلوب ويجب أن يكون أكبر من صفر';
  }

  const breed = String(body.type || body.breed || '').trim();
  if (!breed) {
    return 'السلالة / الصنف مطلوب';
  }

  if (sub === 'mandi') {
    const gender = String(body.gender || '').trim().toLowerCase();
    if (gender !== 'male') {
      return 'تيوس المندي — ذكور فقط';
    }
    const ageMonths = parseInt(body.ageMonths, 10);
    if (![1, 2, 3].includes(ageMonths)) {
      return 'عمر المندي من شهر إلى 3 أشهر فقط';
    }
    const basis = String(body.pricingBasis || 'per_head').trim().toLowerCase();
    if (basis === 'per_mother') {
      return 'المندي يُسعَّر للرأس وليس على الأم';
    }
    const count = parseInt(body.pricedUnitCount, 10) || 1;
    if (count < 1) {
      return 'عدد التيوس مطلوب';
    }
    return null;
  }

  const basis = String(body.pricingBasis || '').trim().toLowerCase();
  if (saleMode === 'flock') {
    if (!basis || !VALID_BASIS.has(basis)) {
      return 'حدد أساس تسعير القطيع';
    }
    const count = parseInt(body.pricedUnitCount, 10);
    if (!Number.isFinite(count) || count < 1) {
      return 'عدد الوحدات للتسعير مطلوب';
    }
    if (basis === 'per_mother' && body.offspringIncluded !== false) {
      // optional — default true on client
    }
  }

  const purpose = String(body.purpose || '').trim();
  if (purpose && !VALID_PURPOSE.has(purpose)) {
    return 'الغرض غير صالح';
  }

  return null;
}

module.exports = { validateSheepListing };
