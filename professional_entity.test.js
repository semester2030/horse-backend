/**
 * PH-01 — Professional Entity tests (closure suite)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createProfessionalEntityApi,
  normalizeSlug,
  validateSlug,
  findByOwner,
  serializeProfessionalEntities,
  loadProfessionalEntities,
  assertOwnedMediaUrl,
  validatePublicLocation,
  validateContactPolicy,
  validatePublicationStatus,
} = require('./professional_entity');
const { deleteUserAccount } = require('./account_lifecycle');

function makeHarness() {
  const store = {
    professionalEntities: new Map(),
    imageAssets: new Map([
      ['img-owner-1', { ownerUserId: 'u-owner', kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' }],
      ['img-other-1', { ownerUserId: 'u-other', kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' }],
    ]),
    users: new Map([
      ['u-owner', { id: 'u-owner', name: 'مالك' }],
      ['u-other', { id: 'u-other', name: 'آخر' }],
    ]),
    accessTokens: new Map([
      ['tok-owner', { userId: 'u-owner' }],
      ['tok-other', { userId: 'u-other' }],
    ]),
    horses: new Map(),
    videos: new Map(),
    favorites: new Map(),
    bookings: new Map(),
    services: new Map(),
    catalogItems: new Map(),
    carts: new Map(),
    orders: new Map(),
    messages: [],
  };
  let saved = 0;
  const saveStore = () => {
    saved += 1;
  };
  let seq = 0;
  const id = () => `pe-${++seq}`;

  const routes = [];
  const app = {
    get: (path, ...handlers) => routes.push({ method: 'GET', path, handlers }),
    post: (path, ...handlers) => routes.push({ method: 'POST', path, handlers }),
    patch: (path, ...handlers) => routes.push({ method: 'PATCH', path, handlers }),
  };

  const auth = (req, _res, next) => {
    const h = String(req.headers?.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return _res.status(401).json({ message: 'unauthorized' });
    req.token = token;
    next();
  };
  const requireSessionUser = (req, _res, next) => {
    const entry = store.accessTokens.get(req.token);
    if (!entry?.userId) return _res.status(401).json({ message: 'session' });
    req.authUserId = entry.userId;
    req.authUser = store.users.get(entry.userId);
    next();
  };

  createProfessionalEntityApi({
    store,
    saveStore,
    id,
    auth,
    requireSessionUser,
  }).registerAppRoutes(app);

  function findRoute(method, path) {
    return routes.find((r) => r.method === method && r.path === path);
  }

  async function invoke(method, path, { token, body, params } = {}) {
    const route = findRoute(method, path);
    assert.ok(route, `route missing ${method} ${path}`);
    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body || {},
      params: params || {},
    };
    let statusCode = 200;
    let jsonBody = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        jsonBody = payload;
        return this;
      },
    };
    const handlers = route.handlers;
    let i = 0;
    await new Promise((resolve) => {
      const next = (err) => {
        if (err) {
          statusCode = 500;
          jsonBody = { message: String(err) };
          resolve();
          return;
        }
        const h = handlers[i++];
        if (!h) {
          resolve();
          return;
        }
        const out = h(req, res, next);
        if (out && typeof out.then === 'function') {
          out.then(() => {
            if (jsonBody != null || statusCode !== 200) resolve();
          });
        } else if (jsonBody != null || i >= handlers.length) {
          if (jsonBody != null) resolve();
        }
      };
      next();
      setImmediate(() => {
        if (jsonBody != null) resolve();
      });
    });
    while (jsonBody == null && i < handlers.length) {
      const h = handlers[i++];
      h(req, res, () => {});
    }
    return { status: statusCode, body: jsonBody, saved };
  }

  return { store, invoke, saved: () => saved };
}

async function run() {
  assert.strictEqual(normalizeSlug(' My Store '), 'my-store');
  assert.strictEqual(validateSlug('ab').ok, false);
  assert.strictEqual(validateSlug('admin').ok, false);

  const h = makeHarness();
  const ownedLogo = 'https://imagedelivery.net/acct/img-owner-1/public';
  const otherLogo = 'https://imagedelivery.net/acct/img-other-1/public';
  const externalLogo = 'https://evil.example/x.png';

  // PH01-TEST-001 create
  let r1 = await h.invoke('POST', '/professional-entities', {
    token: 'tok-owner',
    body: {
      displayName: 'معرض العتيبي',
      entityType: 'camel_showroom',
      description: 'وصف',
      publicSlug: 'otaibi-camels',
      ownerUserId: 'forged-should-ignore',
      logoUrl: ownedLogo,
      contactPolicy: 'in_app',
      publicationStatus: 'draft',
      publicLocation: { label: 'الرياض', lat: 24.7, lng: 46.7 },
    },
  });
  assert.strictEqual(r1.status, 201, JSON.stringify(r1.body));
  assert.ok(r1.body.entity);
  assert.strictEqual(r1.body.entity.ownerUserId, 'u-owner');
  assert.strictEqual(r1.body.entity.publicSlug, 'otaibi-camels');
  assert.strictEqual(r1.body.entity.logoUrl, ownedLogo);
  assert.strictEqual(r1.body.entity.logoAssetId, 'img-owner-1');
  assert.ok(r1.saved >= 1);
  console.log('PASS PH01-TEST-001 create');

  // PH01-TEST-002 read me
  let r2 = await h.invoke('GET', '/professional-entities/me', { token: 'tok-owner' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.entity.displayName, 'معرض العتيبي');
  console.log('PASS PH01-TEST-002 read me');

  // PH01-TEST-003 update
  let r3 = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { displayName: 'معرض العتيبي المحدّث', description: 'وصف جديد', version: 1 },
  });
  assert.strictEqual(r3.status, 200, JSON.stringify(r3.body));
  assert.strictEqual(r3.body.entity.displayName, 'معرض العتيبي المحدّث');
  assert.strictEqual(r3.body.entity.version, 2);
  console.log('PASS PH01-TEST-003 update');

  // PH01-TEST-004 second entity blocked
  let r4 = await h.invoke('POST', '/professional-entities', {
    token: 'tok-owner',
    body: { displayName: 'جهة ثانية', entityType: 'store', publicSlug: 'second-store' },
  });
  assert.strictEqual(r4.status, 409);
  assert.strictEqual(r4.body.code, 'ENTITY_LIMIT_REACHED');
  console.log('PASS PH01-TEST-004 second entity rejected');

  // PH01-TEST-005 other user cannot edit
  let r5 = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-other',
    body: { displayName: 'اختراق' },
  });
  assert.strictEqual(r5.status, 404);
  console.log('PASS PH01-TEST-005 other user no entity / cannot edit');

  // PH01-TEST-006 forge owner + slug immutable
  let r6 = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { publicSlug: 'hacked-slug', ownerUserId: 'u-other' },
  });
  assert.ok([400].includes(r6.status));
  assert.ok(
    r6.body.code === 'IMMUTABLE_FIELD' || r6.body.code === 'SLUG_IMMUTABLE',
  );
  console.log('PASS PH01-TEST-006 immutable owner/slug');

  // PH01-TEST-007 duplicate slug
  let r7 = await h.invoke('POST', '/professional-entities', {
    token: 'tok-other',
    body: {
      displayName: 'جهة أخرى',
      entityType: 'store',
      publicSlug: 'otaibi-camels',
    },
  });
  assert.strictEqual(r7.status, 409);
  assert.strictEqual(r7.body.code, 'SLUG_CONFLICT');
  console.log('PASS PH01-TEST-007 duplicate slug');

  // PH01-TEST-008 invalid input
  let r8 = await h.invoke('POST', '/professional-entities', {
    token: 'tok-other',
    body: { displayName: '', entityType: 'nope', publicSlug: 'x' },
  });
  assert.strictEqual(r8.status, 400);
  console.log('PASS PH01-TEST-008 invalid input');

  // PH01-TEST-010 — Create → serialize (save) → clear → load → same entityId/data
  const before = findByOwner(h.store, 'u-owner');
  assert.ok(before);
  const entityIdBefore = before.id;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph01-pe-'));
  const file = path.join(tmpDir, 'store.json');
  const snapshot = {
    professionalEntities: serializeProfessionalEntities(h.store),
  };
  fs.writeFileSync(file, JSON.stringify(snapshot), 'utf8');
  // simulate process restart: wipe memory
  h.store.professionalEntities = new Map();
  assert.strictEqual(h.store.professionalEntities.size, 0);
  const loadedRaw = JSON.parse(fs.readFileSync(file, 'utf8'));
  h.store.professionalEntities = loadProfessionalEntities(loadedRaw.professionalEntities);
  const after = findByOwner(h.store, 'u-owner');
  assert.ok(after, 'entity missing after restart/load');
  assert.strictEqual(after.id, entityIdBefore);
  assert.strictEqual(after.displayName, 'معرض العتيبي المحدّث');
  assert.strictEqual(after.publicSlug, 'otaibi-camels');
  assert.strictEqual(after.logoUrl, ownedLogo);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('PASS PH01-TEST-010 create→save→restart/load persistence');

  // PH01-TEST-011 version conflict
  let r11 = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { description: 'stale', version: 1 },
  });
  assert.strictEqual(r11.status, 409);
  assert.strictEqual(r11.body.code, 'VERSION_CONFLICT');
  console.log('PASS PH01-TEST-011 version conflict');

  // PH01-TEST-012 logo ownership / type validation
  let r12a = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { logoUrl: 'http://insecure.example/x.png', version: 2 },
  });
  assert.strictEqual(r12a.status, 400);
  assert.strictEqual(r12a.body.code, 'INVALID_LOGO_URL');

  let r12b = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { logoUrl: externalLogo, version: 2 },
  });
  assert.strictEqual(r12b.status, 400);
  assert.strictEqual(r12b.body.code, 'INVALID_LOGO_URL');

  let r12c = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { logoUrl: otherLogo, version: 2 },
  });
  assert.strictEqual(r12c.status, 400);
  assert.strictEqual(r12c.body.code, 'LOGO_ASSET_UNAUTHORIZED');

  let r12d = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: {
      logoUrl: 'https://imagedelivery.net/acct/img-unknown-99/public',
      version: 2,
    },
  });
  assert.strictEqual(r12d.status, 400);
  assert.strictEqual(r12d.body.code, 'LOGO_ASSET_UNKNOWN');

  // keep existing owned logo OK
  let r12e = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { logoUrl: ownedLogo, version: 2 },
  });
  assert.strictEqual(r12e.status, 200, JSON.stringify(r12e.body));
  console.log('PASS PH01-TEST-012 logo ownership/type validation');

  // Validation helpers + field rejection
  assert.strictEqual(validateContactPolicy('banana').ok, false);
  assert.strictEqual(validatePublicationStatus('live').ok, false);
  assert.strictEqual(validatePublicLocation({ lat: 999 }).ok, false);
  assert.strictEqual(validatePublicLocation({ label: 'x', lat: 24, lng: 46 }).ok, true);
  let rVal = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { contactPolicy: 'not-a-policy', version: 3 },
  });
  assert.strictEqual(rVal.status, 400);
  assert.strictEqual(rVal.body.code, 'INVALID_CONTACT_POLICY');
  let rVal2 = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { publicationStatus: 'published', version: 3 },
  });
  assert.strictEqual(rVal2.status, 400);
  assert.strictEqual(rVal2.body.code, 'INVALID_PUBLICATION_STATUS');
  let rVal3 = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { publicLocation: { lat: 'nope' }, version: 3 },
  });
  assert.strictEqual(rVal3.status, 400);
  assert.strictEqual(rVal3.body.code, 'INVALID_PUBLIC_LOCATION');
  console.log('PASS PH01-TEST-016 field validation (contact/publication/location)');

  // Account delete cleans ProfessionalEntity
  const delStore = {
    users: new Map([['u-owner', { id: 'u-owner', name: 'x' }]]),
    horses: new Map(),
    videos: new Map(),
    favorites: new Map(),
    bookings: new Map(),
    services: new Map(),
    catalogItems: new Map(),
    carts: new Map(),
    orders: new Map(),
    messages: [],
    professionalEntities: new Map([
      [
        entityIdBefore,
        {
          id: entityIdBefore,
          ownerUserId: 'u-owner',
          displayName: 'x',
          publicSlug: 'otaibi-camels',
        },
      ],
    ]),
    imageAssets: new Map([
      ['img-owner-1', { ownerUserId: 'u-owner', kind: 'image' }],
    ]),
    accessTokens: new Map([['tok-owner', { userId: 'u-owner' }]]),
    refreshTokens: new Map(),
  };
  const del = deleteUserAccount(delStore, 'u-owner');
  assert.ok(del.ok !== false);
  assert.strictEqual(delStore.professionalEntities.size, 0);
  assert.strictEqual(delStore.imageAssets.size, 0);
  console.log('PASS PH01-TEST-017 account delete cleans ProfessionalEntity + imageAssets');

  // assertOwnedMediaUrl unit
  const ownCheck = assertOwnedMediaUrl(
    { imageAssets: new Map([['a1', { ownerUserId: 'u1', kind: 'image' }]]) },
    'u1',
    'https://imagedelivery.net/h/a1/public',
    { field: 'logo' },
  );
  assert.strictEqual(ownCheck.ok, true);

  console.log('ALL professional_entity backend tests PASS');
}

run().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
