/**
 * Ensure every mappable service has a ServicePlace (self-heal after deploys / missed sync).
 */
'use strict';

const { ensureServicePlaces } = require('./query_engine');

function expectedPlaceId(service) {
  if (!service || typeof service !== 'object') return null;
  const id = service.id != null ? String(service.id) : '';
  if (!id) return null;
  const t = String(service.type || service.serviceType || '').toLowerCase();
  if (t === 'stable' || t === 'boarding' || t === 'إيواء') {
    return `place_boarding_${id}`;
  }
  const map = {
    training: 'training',
    trainer: 'training',
    veterinary: 'veterinary',
    vet: 'veterinary',
    feed: 'feed',
    equipment: 'equipment',
    supplies: 'equipment',
  };
  const cat = map[t];
  if (!cat) return null;
  return `place_${cat}_${id}`;
}

/**
 * @param {object} store
 * @param {(service: object) => { ok?: boolean }} syncAnyService
 */
function healMissingServicePlaces(store, syncAnyService) {
  ensureServicePlaces(store);
  if (!store.services || typeof syncAnyService !== 'function') {
    return { healed: 0, checked: 0 };
  }
  let healed = 0;
  let checked = 0;
  for (const service of store.services.values()) {
    const placeId = expectedPlaceId(service);
    if (!placeId) continue;
    checked += 1;
    if (store.servicePlaces.has(placeId)) continue;
    try {
      const r = syncAnyService(service);
      if (r && r.ok) healed += 1;
    } catch (_) {
      /* best-effort */
    }
  }
  return { healed, checked };
}

module.exports = {
  expectedPlaceId,
  healMissingServicePlaces,
};
