/**
 * الدول المدعومة — افتراضي المملكة العربية السعودية
 */

const COUNTRIES = {
  SA: {
    code: 'SA',
    nameAr: 'المملكة العربية السعودية',
    nameEn: 'Saudi Arabia',
    dialCode: '966',
    flag: '🇸🇦',
    phoneMinDigits: 9,
    phoneMaxDigits: 9,
    localStartsWith: '5',
    placeholder: '5xxxxxxxx',
  },
  AE: {
    code: 'AE',
    nameAr: 'الإمارات',
    nameEn: 'UAE',
    dialCode: '971',
    flag: '🇦🇪',
    phoneMinDigits: 9,
    phoneMaxDigits: 9,
    localStartsWith: '5',
    placeholder: '5xxxxxxxx',
  },
  KW: {
    code: 'KW',
    nameAr: 'الكويت',
    nameEn: 'Kuwait',
    dialCode: '965',
    flag: '🇰🇼',
    phoneMinDigits: 8,
    phoneMaxDigits: 8,
    localStartsWith: '',
    placeholder: 'xxxxxxxx',
  },
  BH: {
    code: 'BH',
    nameAr: 'البحرين',
    nameEn: 'Bahrain',
    dialCode: '973',
    flag: '🇧🇭',
    phoneMinDigits: 8,
    phoneMaxDigits: 8,
    localStartsWith: '',
    placeholder: 'xxxxxxxx',
  },
  QA: {
    code: 'QA',
    nameAr: 'قطر',
    nameEn: 'Qatar',
    dialCode: '974',
    flag: '🇶🇦',
    phoneMinDigits: 8,
    phoneMaxDigits: 8,
    localStartsWith: '',
    placeholder: 'xxxxxxxx',
  },
  OM: {
    code: 'OM',
    nameAr: 'عُمان',
    nameEn: 'Oman',
    dialCode: '968',
    flag: '🇴🇲',
    phoneMinDigits: 8,
    phoneMaxDigits: 8,
    localStartsWith: '',
    placeholder: 'xxxxxxxx',
  },
};

const DEFAULT_COUNTRY = 'SA';

function listCountries() {
  return Object.values(COUNTRIES).map((c) => ({
    code: c.code,
    nameAr: c.nameAr,
    nameEn: c.nameEn,
    dialCode: c.dialCode,
    flag: c.flag,
    placeholder: c.placeholder,
  }));
}

function getCountry(code) {
  const c = COUNTRIES[String(code || DEFAULT_COUNTRY).toUpperCase()];
  return c || COUNTRIES[DEFAULT_COUNTRY];
}

/** يحوّل الرقم المحلي إلى E.164 حسب الدولة */
function normalizePhone(phone, countryCode = DEFAULT_COUNTRY) {
  const country = getCountry(countryCode);
  let digits = String(phone || '')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '');

  if (digits.startsWith(country.dialCode)) {
    digits = digits.slice(country.dialCode.length);
  }
  if (digits.startsWith('00')) {
    digits = digits.replace(/^00+/, '');
    if (digits.startsWith(country.dialCode)) {
      digits = digits.slice(country.dialCode.length);
    }
  }
  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (country.localStartsWith && !digits.startsWith(country.localStartsWith)) {
    if (digits.length === country.phoneMinDigits) {
      // قد يكون بدون صفر في البداية
    } else {
      return null;
    }
  }

  if (digits.length < country.phoneMinDigits || digits.length > country.phoneMaxDigits) {
    return null;
  }

  return `+${country.dialCode}${digits}`;
}

module.exports = {
  COUNTRIES,
  DEFAULT_COUNTRY,
  listCountries,
  getCountry,
  normalizePhone,
};
