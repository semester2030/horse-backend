/**
 * Security regression checks for store-release remediation.
 * Run: node security_store_release.test.js
 */
const assert = require('assert');
const path = require('path');

process.chdir(path.join(__dirname));

// privileged: no defaults
const privileged = require('./privileged_access');
assert.strictEqual(privileged.privilegedPhoneSet().size, 0, 'no default privileged phones');

// otp rate limit
const rl = require('./otp_rate_limit');
const fakeReq = { headers: {}, ip: '1.2.3.4', socket: { remoteAddress: '1.2.3.4' } };
for (let i = 0; i < 5; i++) {
  assert.strictEqual(rl.checkOtpSend(fakeReq, '+966500000001').ok, true);
}
const blocked = rl.checkOtpSend(fakeReq, '+966500000001');
assert.strictEqual(blocked.ok, false);
assert.strictEqual(blocked.status, 429);

// account deletion anonymizes orders
const { deleteUserAccount } = require('./account_lifecycle');
const store = {
  users: new Map([['u1', { id: 'u1', phone: '+966511111111', name: 'A' }]]),
  horses: new Map(),
  favorites: new Map([['u1', { horseIds: ['h1'] }]]),
  carts: new Map([['u1', { items: [] }]]),
  videos: new Map(),
  videoComments: {},
  services: new Map(),
  servicePlaces: new Map(),
  catalogItems: new Map(),
  bookings: new Map([['b1', { userId: 'u1', address: 'secret street' }]]),
  orders: new Map([
    ['o1', { userId: 'u1', customerName: 'A', customerPhone: '+9665', shippingAddress: 'x' }],
  ]),
  transportRequests: new Map(),
  negotiations: new Map(),
  offers: new Map(),
  negotiationEvents: [],
  trips: new Map(),
  tripEvents: [],
  drivers: new Map(),
  vehicles: new Map(),
  trackingSessions: new Map(),
  trackingHistory: [],
  trackingEvents: [],
  evidenceRecords: new Map(),
  evidenceEvents: [],
  experts: new Map(),
  expertRequests: new Map(),
  expertRatings: new Map(),
  contactLeads: new Map(),
  idempotencyKeys: new Map(),
  auditEvents: [{ actorUserId: 'u1', action: 'x' }],
  messages: [],
  contentReports: [],
  accessTokens: new Map([['t1', { userId: 'u1' }]]),
  refreshTokens: new Map(),
};

const result = deleteUserAccount(store, 'u1');
assert.strictEqual(result.ok, true);
assert.strictEqual(store.users.has('u1'), false);
assert.strictEqual(store.favorites.has('u1'), false);
assert.strictEqual(String(store.orders.get('o1').userId).startsWith('deleted_'), true);
assert.strictEqual(store.orders.get('o1').customerPhone, '[redacted]');
assert.strictEqual(store.accessTokens.has('t1'), false);
assert.strictEqual(store.auditEvents[0].actorUserId.startsWith('deleted_'), true);

console.log('security_store_release.test.js PASS');
