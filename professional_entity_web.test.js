/**
 * PH-02 Closure — lightweight web fallback + well-known files
 */
const assert = require('assert');
const express = require('express');
const http = require('http');
const {
  registerProfessionalEntityWebRoutes,
  escapeHtml,
} = require('./professional_entity_web');
const { ensurePeStore } = require('./professional_entity');

function request(server, path) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    http
      .get({ hostname: '127.0.0.1', port: addr.port, path }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      })
      .on('error', reject);
  });
}

async function run() {
  // XSS escape
  assert.strictEqual(
    escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  );
  console.log('PASS PH02-WEB XSS escapeHtml');

  const store = {
    professionalEntities: new Map(),
    imageAssets: new Map(),
    users: new Map([
      ['u1', { id: 'u1', phone: '+966500000001', name: 'مالك' }],
    ]),
  };
  ensurePeStore(store);
  store.professionalEntities.set('e-active', {
    id: 'e-active',
    ownerUserId: 'u1',
    displayName: 'معرض الاختبار',
    publicSlug: 'web-active-1',
    entityType: 'camel_showroom',
    description: '<img src=x onerror=alert(1)> وصف',
    city: 'الرياض',
    logoUrl: '',
    coverUrl: '',
    contactPolicy: 'phone',
    publicationStatus: 'active',
    updatedAt: new Date().toISOString(),
    version: 1,
  });
  store.professionalEntities.set('e-draft', {
    id: 'e-draft',
    ownerUserId: 'u1',
    displayName: 'مسودة',
    publicSlug: 'web-draft-1',
    entityType: 'store',
    publicationStatus: 'draft',
    contactPolicy: 'in_app',
  });
  store.professionalEntities.set('e-paused', {
    id: 'e-paused',
    ownerUserId: 'u1',
    displayName: 'متوقف',
    publicSlug: 'web-paused-1',
    entityType: 'store',
    publicationStatus: 'paused',
    contactPolicy: 'in_app',
  });

  const app = express();
  registerProfessionalEntityWebRoutes(app, { store });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    let r = await request(server, '/s/web-active-1');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type']?.includes('text/html'));
    assert.ok(r.body.includes('معرض الاختبار'));
    assert.ok(!r.body.includes('<img src=x onerror=alert(1)>'));
    assert.ok(r.body.includes('&lt;img'));
    assert.ok(!r.body.includes('ownerUserId'));
    assert.ok(r.body.includes('فتح في نوماس'));
    console.log('PASS PH02-WEB active 200 + escaped description');

    r = await request(server, '/s/unknown-slug-zzz');
    assert.strictEqual(r.status, 404);
    assert.ok(r.body.includes('ENTITY_PUBLIC_NOT_FOUND'));
    console.log('PASS PH02-WEB unknown 404');

    r = await request(server, '/s/web-draft-1');
    assert.strictEqual(r.status, 404);
    console.log('PASS PH02-WEB draft not public');

    r = await request(server, '/s/web-paused-1');
    assert.strictEqual(r.status, 403);
    assert.ok(r.body.includes('ENTITY_PAUSED'));
    console.log('PASS PH02-WEB paused unavailable');

    r = await request(server, '/.well-known/apple-app-site-association');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type']?.includes('application/json'));
    const aasa = JSON.parse(r.body);
    assert.ok(aasa.applinks.details[0].appID.includes('A97F7227YM.sa.nomas.app'));
    assert.deepStrictEqual(aasa.applinks.details[0].paths, ['/s/*']);
    console.log('PASS PH02-WEB AASA');

    r = await request(server, '/.well-known/assetlinks.json');
    assert.strictEqual(r.status, 200);
    const al = JSON.parse(r.body);
    assert.strictEqual(al[0].target.package_name, 'com.horse.app');
    assert.ok(
      al[0].target.sha256_cert_fingerprints.some((f) =>
        f.startsWith('80:62:F2:D8'),
      ),
    );
    console.log('PASS PH02-WEB assetlinks debug fingerprint');
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log('ALL professional_entity_web.test.js PASS');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
