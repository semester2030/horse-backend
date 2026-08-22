'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const availability = require('./availability_engine');
const matching = require('./matching_engine');
const tr = require('./transport_requests');

function emptyStore() {
  return {
    transportRequests: new Map(),
    services: new Map(),
    users: new Map(),
    bookings: new Map(),
    trips: new Map(),
  };
}

function horseRequest(overrides = {}) {
  return {
    id: 'r1',
    customerId: 'c1',
    animalType: 'horse',
    animalCount: 2,
    pickup: { latitude: 24.7, longitude: 46.6 },
    destination: { latitude: 24.8, longitude: 46.7 },
    requestTiming: 'immediate',
    requestedPickupAt: '2026-07-20T10:00:00.000Z',
    tripType: 'oneWay',
    providerPreference: 'any',
    ...overrides,
  };
}

function baseService(id, overrides = {}) {
  return {
    id,
    type: 'transportation',
    providerId: `p-${id}`,
    name: `Svc ${id}`,
    capacityPerVehicle: 4,
    numberOfVehicles: 1,
    location: { latitude: 24.71, longitude: 46.67 },
    applicableSpecies: ['horse', 'camel', 'falcon'],
    workingHours: '24',
    ...overrides,
  };
}

describe('availability_engine', () => {
  it('parses 24h and numeric working hours', () => {
    assert.equal(availability.parseWorkingHours('24').always, true);
    const w = availability.parseWorkingHours('8 صباحاً - 6 مساءً');
    assert.ok(w);
    assert.equal(w.startHour, 8);
    assert.equal(w.endHour, 18);
  });

  it('rejects vacation / maintenance / offline / busy', () => {
    const store = emptyStore();
    const req = horseRequest();
    for (const [field, status] of [
      [{ availabilityStatus: 'vacation' }, 'vacation'],
      [{ underMaintenance: true }, 'maintenance'],
      [{ offline: true }, 'offline'],
      [{ busy: true }, 'busy'],
    ]) {
      const service = baseService('s', field);
      const r = availability.evaluateAvailability({
        store,
        service,
        user: null,
        request: req,
      });
      assert.equal(r.eligible, false);
      assert.equal(r.status, status);
    }
  });

  it('rejects outside working hours', () => {
    const store = emptyStore();
    // 10:00 UTC = 13:00 KSA — outside 8–12 window
    const service = baseService('s', { workingHours: '8:00-12:00' });
    const r = availability.evaluateAvailability({
      store,
      service,
      user: null,
      request: horseRequest({
        requestedPickupAt: '2026-07-20T10:00:00.000Z',
      }),
    });
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes('outside_working_hours'));
  });

  it('rejects journey conflict via blocking booking', () => {
    const store = emptyStore();
    const service = baseService('s1');
    store.services.set('s1', service);
    store.bookings.set('b1', {
      id: 'b1',
      type: 'transportation',
      serviceId: 's1',
      providerId: 'p-s1',
      status: 'confirmed',
      bookingDate: '2026-07-20T00:00:00.000Z',
    });
    const r = availability.evaluateAvailability({
      store,
      service,
      user: null,
      request: horseRequest({
        requestedPickupAt: '2026-07-20T12:00:00.000Z',
      }),
    });
    assert.equal(r.eligible, false);
    assert.equal(r.status, 'busy');
  });

  it('rejects capacity overflow', () => {
    const store = emptyStore();
    const service = baseService('s1', {
      capacityPerVehicle: 1,
      numberOfVehicles: 1,
    });
    const r = availability.evaluateAvailability({
      store,
      service,
      user: null,
      request: horseRequest({ animalCount: 5 }),
    });
    assert.equal(r.eligible, false);
  });
});

describe('matching_engine', () => {
  it('matches camel/horse/falcon species only', () => {
    for (const animalType of ['camel', 'horse', 'falcon']) {
      const store = emptyStore();
      store.services.set('ok', baseService('ok', { applicableSpecies: [animalType] }));
      store.services.set('bad', baseService('bad', {
        applicableSpecies: animalType === 'horse' ? ['camel'] : ['horse'],
        location: { latitude: 24.72, longitude: 46.68 },
      }));
      const payload = matching.matchProvidersForRequest(
        store,
        horseRequest({ animalType, animalCount: 1 }),
      );
      assert.equal(payload.providers.length, 1);
      assert.equal(payload.providers[0].serviceId, 'ok');
      assert.equal(payload.matchingStatus, 'matched');
    }
  });

  it('filters company vs individual preference', () => {
    const store = emptyStore();
    store.services.set('ind', baseService('ind', { name: 'Solo' }));
    store.services.set('co', baseService('co', {
      companyName: 'Fleet Co',
      location: { latitude: 24.715, longitude: 46.675 },
    }));
    const onlyCo = matching.matchProvidersForRequest(
      store,
      horseRequest({ providerPreference: 'company', animalCount: 1 }),
    );
    assert.equal(onlyCo.providers.length, 1);
    assert.equal(onlyCo.providers[0].providerType, 'company');
    const onlyInd = matching.matchProvidersForRequest(
      store,
      horseRequest({ providerPreference: 'individual', animalCount: 1 }),
    );
    assert.equal(onlyInd.providers.length, 1);
    assert.equal(onlyInd.providers[0].providerType, 'individual');
  });

  it('rejects wrong species, suspended, missing coords, capacity', () => {
    const store = emptyStore();
    store.services.set('species', baseService('species', { applicableSpecies: ['camel'] }));
    store.services.set('susp', baseService('susp', {
      status: 'suspended',
      location: { latitude: 24.72, longitude: 46.68 },
    }));
    store.services.set('nocoords', baseService('nocoords', { location: undefined }));
    delete store.services.get('nocoords').location;
    store.services.set('tiny', baseService('tiny', {
      capacityPerVehicle: 1,
      numberOfVehicles: 1,
      location: { latitude: 24.73, longitude: 46.69 },
    }));
    const payload = matching.matchProvidersForRequest(
      store,
      horseRequest({ animalCount: 3 }),
    );
    assert.equal(payload.providers.length, 0);
    assert.equal(payload.matchingStatus, 'no_match');
    assert.ok(payload.rejectStats.species >= 1);
    assert.ok(payload.rejectStats.inactive >= 1);
    assert.ok(payload.rejectStats.location >= 1);
  });

  it('expands search radius when local empty', () => {
    const store = emptyStore();
    // ~111 km north of pickup (24.7, 46.6) ≈ 1 degree lat
    store.services.set('far', baseService('far', {
      location: { latitude: 25.7, longitude: 46.6 },
      capacityPerVehicle: 4,
    }));
    const payload = matching.matchProvidersForRequest(
      store,
      horseRequest({ animalCount: 1 }),
      { radiiKm: [25, 50, 100, 200] },
    );
    assert.equal(payload.providers.length, 1);
    assert.equal(payload.radiusExpanded, true);
    assert.ok(payload.searchRadiusKm >= 100);
  });

  it('ranks nearest then rating then verified', () => {
    const store = emptyStore();
    store.services.set('far', baseService('far', {
      location: { latitude: 24.9, longitude: 46.6 },
      rating: 5,
      verified: true,
    }));
    store.services.set('nearLow', baseService('nearLow', {
      location: { latitude: 24.705, longitude: 46.605 },
      rating: 3,
      verified: false,
    }));
    store.services.set('nearHigh', baseService('nearHigh', {
      location: { latitude: 24.706, longitude: 46.606 },
      rating: 4.8,
      verified: true,
    }));
    const payload = matching.matchProvidersForRequest(
      store,
      horseRequest({ animalCount: 1 }),
    );
    assert.ok(payload.providers.length >= 2);
    // nearest first
    assert.ok(
      payload.providers[0].distanceKm <= payload.providers[1].distanceKm,
    );
    // among close ones, higher rating / verified wins when distances ordered
    const ids = payload.providers.map((p) => p.serviceId);
    assert.ok(ids.indexOf('nearLow') < ids.indexOf('far'));
  });

  it('excludes busy/vacation from results', () => {
    const store = emptyStore();
    store.services.set('ok', baseService('ok'));
    store.services.set('vac', baseService('vac', {
      availabilityStatus: 'vacation',
      location: { latitude: 24.72, longitude: 46.68 },
    }));
    store.services.set('maint', baseService('maint', {
      underMaintenance: true,
      location: { latitude: 24.73, longitude: 46.69 },
    }));
    const payload = matching.matchProvidersForRequest(
      store,
      horseRequest({ animalCount: 1 }),
    );
    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0].serviceId, 'ok');
    assert.ok(payload.providers[0].matchingReason);
    assert.ok(payload.providers[0].distanceKm != null);
  });

  it('scheduled request uses requestedPickupAt for hours', () => {
    const store = emptyStore();
    // Window 8–18 KSA. 05:00 UTC = 08:00 KSA → inside
    store.services.set('s', baseService('s', { workingHours: '8:00-18:00' }));
    const ok = matching.matchProvidersForRequest(
      store,
      horseRequest({
        requestTiming: 'scheduled',
        requestedPickupAt: '2026-07-20T05:00:00.000Z',
        animalCount: 1,
      }),
    );
    assert.equal(ok.providers.length, 1);
    const bad = matching.matchProvidersForRequest(
      store,
      horseRequest({
        requestTiming: 'scheduled',
        requestedPickupAt: '2026-07-20T20:00:00.000Z',
        animalCount: 1,
      }),
    );
    assert.equal(bad.providers.length, 0);
  });

  it('transport_requests listProvidersForRequest delegates to matching', () => {
    const store = emptyStore();
    store.services.set('s1', baseService('s1'));
    const payload = tr.listProvidersForRequest(store, horseRequest({ animalCount: 1 }));
    assert.equal(payload.matchingVersion, 't3.1');
    assert.equal(payload.providers.length, 1);
  });
});
