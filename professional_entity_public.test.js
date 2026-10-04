/**
 * PH-02 — Public entity API / DTO tests
 */
const assert = require('assert');
const {
  createProfessionalEntityApi,
  toPublicVisitorDto,
  canonicalPublicUrl,
  findByOwner,
} = require('./professional_entity');

function makeHarness() {
  const store = {
    professionalEntities: new Map(),
    imageAssets: new Map(),
    users: new Map([
      ['u-owner', { id: 'u-owner', name: 'مالك' }],
      ['u-other', { id: 'u-other', name: 'آخر' }],
    ]),
    accessTokens: new Map([
      ['tok-owner', { userId: 'u-owner' }],
      ['tok-other', { userId: 'u-other' }],
    ]),
  };
  const saveStore = () => {};
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
    next();
  };
  createProfessionalEntityApi({ store, saveStore, id, auth, requireSessionUser }).registerAppRoutes(app);

  async function invoke(method, path, { token, body, params } = {}) {
    const route = routes.find((r) => r.method === method && r.path === path);
    assert.ok(route, `missing ${method} ${path}`);
    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body || {},
      params: params || {},
    };
    let statusCode = 200;
    let jsonBody = null;
    const res = {
      _headers: {},
      set(k, v) { this._headers[k] = v; return this; },
      status(code) { statusCode = code; return this; },
      json(payload) { jsonBody = payload; return this; },
    };
    const handlers = route.handlers;
    let i = 0;
    await new Promise((resolve) => {
      const next = () => {
        const h = handlers[i++];
        if (!h) return resolve();
        const out = h(req, res, next);
        if (out && typeof out.then === 'function') {
          out.then(() => { if (jsonBody != null) resolve(); });
        } else if (jsonBody != null) resolve();
      };
      next();
      setImmediate(() => { if (jsonBody != null) resolve(); });
    });
    while (jsonBody == null && i < handlers.length) {
      handlers[i++](req, res, () => {});
    }
    return { status: statusCode, body: jsonBody, headers: res._headers };
  }
  return { store, invoke };
}

async function run() {
  // DTO unit
  const dto = toPublicVisitorDto({
    id: 'e1',
    ownerUserId: 'SECRET',
    displayName: 'معرض',
    publicSlug: 'demo-show',
    entityType: 'store',
    description: '<script>alert(1)</script>',
    logoUrl: 'https://imagedelivery.net/a/b/public',
    publicationStatus: 'active',
    contactPolicy: 'in_app',
    version: 9,
    logoAssetId: 'secret-asset',
  });
  assert.strictEqual(dto.ownerUserId, undefined);
  assert.strictEqual(dto.version, undefined);
  assert.strictEqual(dto.logoAssetId, undefined);
  assert.ok(dto.canonicalUrl.endsWith('/s/demo-show'));
  assert.strictEqual(canonicalPublicUrl('Demo-Show'), canonicalPublicUrl('demo-show'));
  console.log('PASS PH02-TEST-005 public DTO excludes private fields');

  const h = makeHarness();
  // create draft
  let r = await h.invoke('POST', '/professional-entities', {
    token: 'tok-owner',
    body: {
      displayName: 'معرض عام',
      entityType: 'camel_showroom',
      publicSlug: 'public-live-1',
      publicationStatus: 'draft',
      description: 'وصف',
    },
  });
  assert.strictEqual(r.status, 201);

  // draft not public
  r = await h.invoke('GET', '/professional-entities/public/:slug', {
    params: { slug: 'public-live-1' },
  });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'ENTITY_PUBLIC_NOT_FOUND');
  console.log('PASS PH02-TEST-003 draft not public');

  // activate
  r = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { publicationStatus: 'active', version: 1 },
  });
  assert.strictEqual(r.status, 200);

  // active public
  r = await h.invoke('GET', '/professional-entities/public/:slug', {
    params: { slug: 'public-live-1' },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.entity.publicSlug, 'public-live-1');
  assert.strictEqual(r.body.entity.ownerUserId, undefined);
  assert.ok(r.body.entity.canonicalUrl.includes('/s/public-live-1'));
  console.log('PASS PH02-TEST-001 active public resolves');

  // unknown
  r = await h.invoke('GET', '/professional-entities/public/:slug', {
    params: { slug: 'does-not-exist-xyz' },
  });
  assert.strictEqual(r.status, 404);
  console.log('PASS PH02-TEST-002 unknown slug');

  // rename displayName — slug/url stable
  const urlBefore = r.body?.entity?.canonicalUrl; // from previous unknown - ignore
  const beforeEnt = findByOwner(h.store, 'u-owner');
  const slugBefore = beforeEnt.publicSlug;
  const canonBefore = canonicalPublicUrl(slugBefore);
  r = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { displayName: 'اسم جديد تماماً', version: 2 },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.entity.publicSlug, slugBefore);
  assert.strictEqual(r.body.entity.canonicalUrl, canonBefore);
  r = await h.invoke('GET', '/professional-entities/public/:slug', {
    params: { slug: slugBefore },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.entity.displayName, 'اسم جديد تماماً');
  assert.strictEqual(r.body.entity.canonicalUrl, canonBefore);
  console.log('PASS PH02-TEST-006 displayName change keeps URL');

  // paused
  r = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { publicationStatus: 'paused', version: 3 },
  });
  assert.strictEqual(r.status, 200);
  r = await h.invoke('GET', '/professional-entities/public/:slug', {
    params: { slug: slugBefore },
  });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, 'ENTITY_PAUSED');
  console.log('PASS PH02-TEST-004 paused policy');

  // owner preview still works for paused/draft
  r = await h.invoke('GET', '/professional-entities/me/preview', {
    token: 'tok-owner',
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ownerPreview, true);
  assert.strictEqual(r.body.entity.ownerUserId, undefined);
  console.log('PASS PH02-TEST-011 preview DTO (owner)');

  // contact hidden
  r = await h.invoke('PATCH', '/professional-entities/me', {
    token: 'tok-owner',
    body: { contactPolicy: 'hidden', publicationStatus: 'active', version: 4 },
  });
  assert.strictEqual(r.status, 200);
  r = await h.invoke('GET', '/professional-entities/public/:slug', {
    params: { slug: slugBefore },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.entity.contactAvailable, false);
  console.log('PASS PH02-TEST-018 contact policy in DTO');

  console.log('ALL professional_entity_public tests PASS');
}

run().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
