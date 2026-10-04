/**
 * PH02-TEST-007/008/008R — QR encode → decode → exact staging HTTPS canonical
 * + route resolution to same slug/entity.
 *
 * Always uses STAGING HTTPS origin for codec proof (not local http:// override).
 */
const assert = require('assert');

// Isolate from polluted NOMAS_PUBLIC_BASE=http://127.0.0.1 used by local servers.
delete process.env.NOMAS_PUBLIC_BASE;
delete process.env.NOMAS_PRODUCTION_CANONICAL_DOMAIN;

const {
  canonicalEntityUrl,
  stagingCanonicalOrigin,
  normalizeSlug,
  findBySlug,
  ensurePeStore,
  toPublicVisitorDto,
} = require('./professional_entity');

async function run() {
  let QRCode;
  let jsQR;
  let PNG;
  try {
    QRCode = require('qrcode');
    jsQR = require('jsqr');
    PNG = require('pngjs').PNG;
  } catch (e) {
    console.error(
      'MISSING_DEPS: run npm install qrcode jsqr pngjs --no-save in backend/',
    );
    throw e;
  }

  const slug = 'otaibi-camels';
  const staging = stagingCanonicalOrigin();
  assert.ok(staging.startsWith('https://'));
  const canonical = canonicalEntityUrl(slug);
  assert.strictEqual(canonical, `${staging}/s/${slug}`);
  assert.ok(canonical.startsWith('https://'));
  assert.ok(!canonical.includes('token'));
  assert.ok(!canonical.includes('ownerUserId'));
  assert.ok(!canonical.includes('?'));
  console.log('PASS PH02-TEST-007 QR encode payload =', canonical);

  const pngBuffer = await QRCode.toBuffer(canonical, {
    type: 'png',
    errorCorrectionLevel: 'M',
    width: 300,
    margin: 2,
  });
  const png = PNG.sync.read(pngBuffer);
  const decoded = jsQR(
    new Uint8ClampedArray(png.data),
    png.width,
    png.height,
  );
  assert.ok(decoded, 'QR decode failed');
  assert.strictEqual(decoded.data, canonical);
  assert.ok(decoded.data.startsWith('https://'));
  assert.ok(!decoded.data.includes('token'));
  assert.ok(!decoded.data.includes('userId'));
  console.log('PASS PH02-TEST-008 QR decode exact canonical match');

  // Resolution: decoded URL → slug → entity
  const uri = new URL(decoded.data);
  const parts = uri.pathname.split('/').filter(Boolean);
  assert.strictEqual(parts[0], 's');
  const resolvedSlug = normalizeSlug(parts[1]);
  assert.strictEqual(resolvedSlug, slug);

  const store = {
    professionalEntities: new Map(),
    imageAssets: new Map(),
    users: new Map(),
  };
  ensurePeStore(store);
  store.professionalEntities.set('pe1', {
    id: 'pe1',
    ownerUserId: 'u1',
    displayName: 'معرض العتيبي',
    publicSlug: slug,
    entityType: 'camel_showroom',
    publicationStatus: 'active',
    contactPolicy: 'in_app',
    description: '',
    city: '',
    logoUrl: '',
    coverUrl: '',
    updatedAt: new Date().toISOString(),
    version: 1,
  });
  const entity = findBySlug(store, resolvedSlug);
  assert.ok(entity);
  assert.strictEqual(entity.id, 'pe1');
  assert.strictEqual(entity.publicSlug, slug);
  const dto = toPublicVisitorDto(entity, { store });
  assert.strictEqual(dto.entityId, 'pe1');
  assert.strictEqual(dto.publicSlug, slug);
  assert.strictEqual(dto.ownerUserId, undefined);
  console.log('PASS PH02-TEST-008R QR decoded URL resolves to same entity');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
