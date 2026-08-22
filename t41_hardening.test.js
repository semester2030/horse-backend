'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const acceptLock = require('./accept_lock');
const {
  resolveOfferTtlMs,
  getTransportConfig,
  DEFAULT_OFFER_TTL_MS,
} = require('./transport_config');
const negotiation = require('./negotiation_engine');
const { createWsHub, createRoomSequencer } = require('./ws_hub');

describe('AcceptLockProvider (T4.1)', () => {
  afterEach(() => {
    acceptLock.resetAcceptLockProvider();
  });

  it('InMemoryAcceptLockProvider acquires and releases', () => {
    const p = acceptLock.createInMemoryAcceptLockProvider();
    assert.equal(p.name, 'InMemoryAcceptLockProvider');
    assert.equal(p.tryAcquire('o1'), true);
    assert.equal(p.tryAcquire('o1'), false);
    assert.equal(p.tryAcquire('o2'), true);
    p.release('o1');
    assert.equal(p.tryAcquire('o1'), true);
  });

  it('supports provider swap without changing accept logic', () => {
    const calls = [];
    const spy = {
      name: 'SpyLock',
      tryAcquire(key) {
        calls.push(['acq', key]);
        return true;
      },
      release(key) {
        calls.push(['rel', key]);
      },
    };
    acceptLock.setAcceptLockProvider(spy);

    const store = {
      transportRequests: new Map([
        [
          'req1',
          {
            id: 'req1',
            customerId: 'c1',
            animalType: 'horse',
            animalCount: 1,
            pickup: { latitude: 1, longitude: 1 },
            destination: { latitude: 2, longitude: 2 },
            status: 'provider_search',
            requestedPickupAt: '2026-07-21T10:00:00.000Z',
          },
        ],
      ]),
      negotiations: new Map(),
      offers: new Map(),
      negotiationEvents: [],
      bookings: new Map(),
      services: new Map([
        [
          'svc1',
          {
            id: 'svc1',
            type: 'transportation',
            providerId: 'p1',
            capacityPerVehicle: 4,
            numberOfVehicles: 1,
          },
        ],
      ]),
      users: new Map(),
    };
    const opened = negotiation.openNegotiation({
      store,
      request: store.transportRequests.get('req1'),
      userId: 'c1',
      idFn: () => 'n1',
    });
    const offerRes = negotiation.createOffer({
      store,
      request: store.transportRequests.get('req1'),
      negotiation: opened.negotiation,
      actorUserId: 'p1',
      actorRole: 'provider',
      body: { amount: 100, serviceId: 'svc1' },
      idFn: () => 'off1',
    });
    const accept = negotiation.acceptOffer({
      store,
      offerId: offerRes.offer.id,
      userId: 'c1',
      idFn: () => 'b1',
    });
    assert.equal(accept.ok, true);
    assert.deepEqual(calls, [
      ['acq', offerRes.offer.id],
      ['rel', offerRes.offer.id],
    ]);
  });

  it('documents future Redis and Database providers', () => {
    assert.equal(
      acceptLock.RedisAcceptLockProvider_SPEC().status,
      'not_implemented',
    );
    assert.equal(
      acceptLock.DatabaseAcceptLockProvider_SPEC().status,
      'not_implemented',
    );
  });

  it('single-process compatibility: concurrent second acquire fails', () => {
    const p = acceptLock.createInMemoryAcceptLockProvider();
    assert.equal(p.tryAcquire('k'), true);
    assert.equal(p.tryAcquire('k'), false);
    p.release('k');
    assert.equal(p.tryAcquire('k'), true);
  });
});

describe('Offer TTL config (T4.1)', () => {
  it('defaults to 15 minutes', () => {
    assert.equal(resolveOfferTtlMs({}), DEFAULT_OFFER_TTL_MS);
    assert.equal(getTransportConfig({}).offerTtlMs, DEFAULT_OFFER_TTL_MS);
  });

  it('respects OFFER_TTL_MS env override', () => {
    assert.equal(resolveOfferTtlMs({ OFFER_TTL_MS: '120000' }), 120000);
    assert.equal(
      resolveOfferTtlMs({ TRANSPORT_OFFER_TTL_MS: '180000' }),
      180000,
    );
  });

  it('clamps overrides to min/max', () => {
    assert.equal(resolveOfferTtlMs({}, 1000), 60_000);
    assert.equal(resolveOfferTtlMs({}, 99 * 60 * 60 * 1000), 24 * 60 * 60 * 1000);
  });

  it('createOffer uses configured TTL for expiresAt', () => {
    const prev = process.env.OFFER_TTL_MS;
    process.env.OFFER_TTL_MS = '120000';
    try {
      const store = {
        transportRequests: new Map(),
        negotiations: new Map(),
        offers: new Map(),
        negotiationEvents: [],
        bookings: new Map(),
        services: new Map([
          [
            'svc1',
            {
              id: 'svc1',
              type: 'transportation',
              providerId: 'p1',
              capacityPerVehicle: 4,
              numberOfVehicles: 1,
            },
          ],
        ]),
        users: new Map(),
      };
      const request = {
        id: 'req1',
        customerId: 'c1',
        animalType: 'camel',
        animalCount: 1,
        pickup: { latitude: 1, longitude: 1 },
        destination: { latitude: 2, longitude: 2 },
        status: 'provider_search',
        requestedPickupAt: '2026-07-21T10:00:00.000Z',
      };
      store.transportRequests.set(request.id, request);
      const opened = negotiation.openNegotiation({
        store,
        request,
        userId: 'c1',
        idFn: () => 'n1',
      });
      const nowMs = Date.parse('2026-07-20T12:00:00.000Z');
      const offerRes = negotiation.createOffer({
        store,
        request,
        negotiation: opened.negotiation,
        actorUserId: 'p1',
        actorRole: 'provider',
        body: { amount: 200, serviceId: 'svc1' },
        idFn: () => 'off1',
        nowMs,
      });
      assert.equal(offerRes.ok, true);
      assert.equal(
        Date.parse(offerRes.offer.expiresAt) - nowMs,
        120000,
      );
    } finally {
      if (prev == null) delete process.env.OFFER_TTL_MS;
      else process.env.OFFER_TTL_MS = prev;
    }
  });

  it('expired offer cannot be accepted', () => {
    const store = {
      transportRequests: new Map(),
      negotiations: new Map(),
      offers: new Map(),
      negotiationEvents: [],
      bookings: new Map(),
      services: new Map([
        [
          'svc1',
          {
            id: 'svc1',
            type: 'transportation',
            providerId: 'p1',
            capacityPerVehicle: 4,
            numberOfVehicles: 1,
          },
        ],
      ]),
      users: new Map(),
    };
    const request = {
      id: 'req1',
      customerId: 'c1',
      animalType: 'horse',
      animalCount: 1,
      pickup: { latitude: 1, longitude: 1 },
      destination: { latitude: 2, longitude: 2 },
      status: 'provider_search',
      requestedPickupAt: '2026-07-21T10:00:00.000Z',
    };
    store.transportRequests.set(request.id, request);
    const opened = negotiation.openNegotiation({
      store,
      request,
      userId: 'c1',
      idFn: () => 'n1',
    });
    const t0 = Date.parse('2026-07-20T12:00:00.000Z');
    const offerRes = negotiation.createOffer({
      store,
      request,
      negotiation: opened.negotiation,
      actorUserId: 'p1',
      actorRole: 'provider',
      body: { amount: 200, serviceId: 'svc1', ttlMs: 60_000 },
      idFn: () => 'off1',
      nowMs: t0,
    });
    const accept = negotiation.acceptOffer({
      store,
      offerId: offerRes.offer.id,
      userId: 'c1',
      idFn: () => 'b1',
      nowMs: t0 + 61_000,
    });
    assert.equal(accept.ok, false);
    assert.equal(accept.status, 409);
  });
});

describe('WebSocket sequence + replay (T4.1)', () => {
  it('assigns monotonic seq and replays missed events without duplicates', () => {
    const seq = createRoomSequencer(100);
    const room = 'request:r1';
    const e1 = seq.assignAndStore(room, { type: 'offer.created', requestId: 'r1' });
    const e2 = seq.assignAndStore(room, { type: 'offer.counter', requestId: 'r1' });
    const e3 = seq.assignAndStore(room, { type: 'offer.accepted', requestId: 'r1' });
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.equal(e3.seq, 3);

    const missed = seq.replayAfter(room, 1);
    assert.equal(missed.length, 2);
    assert.deepEqual(
      missed.map((e) => e.seq),
      [2, 3],
    );
    assert.equal(seq.replayAfter(room, 3).length, 0);
    assert.equal(seq.replayAfter(room, 0).length, 3);
  });

  it('preserves logical order Offer→Counter→Accept→Reject→Withdraw→Expire', () => {
    const hub = createWsHub({
      resolveUserFromToken: () => ({ id: 'u1' }),
      config: getTransportConfig({ WS_REPLAY_WINDOW: '50' }),
    });
    const types = [
      'offer.created',
      'offer.counter',
      'offer.accepted',
      'offer.rejected',
      'offer.withdrawn',
      'offer.expired',
    ];
    const received = [];
    for (const type of types) {
      received.push(
        hub.publishNegotiation({
          type,
          requestId: 'req-order',
          customerId: 'c1',
          providerId: 'p1',
        }),
      );
    }
    assert.deepEqual(
      received.map((e) => e.seq),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(
      received.map((e) => e.type),
      types,
    );
    const replay = hub.replayAfter('request:req-order', 2);
    assert.deepEqual(
      replay.map((e) => e.type),
      types.slice(2),
    );
  });

  it('publishNegotiation returns same seq for fan-out identity', () => {
    const hub = createWsHub({
      resolveUserFromToken: () => ({ id: 'u1' }),
    });
    const a = hub.publishNegotiation({
      type: 'offer.created',
      requestId: 'reqX',
      customerId: 'c',
      providerId: 'p',
    });
    const b = hub.publishNegotiation({
      type: 'offer.counter',
      requestId: 'reqX',
      customerId: 'c',
      providerId: 'p',
    });
    assert.equal(a.seq + 1, b.seq);
    assert.equal(hub.currentSeq('request:reqX'), 2);
  });
});
