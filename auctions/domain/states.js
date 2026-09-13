'use strict';

const { AUCTION_STATUSES } = require('../config');

const TERMINAL = new Set(['sold', 'unsold', 'cancelled']);

const TRANSITIONS = {
  draft: new Set(['review', 'cancelled']),
  review: new Set(['scheduled', 'cancelled', 'frozen', 'draft']),
  scheduled: new Set(['live', 'cancelled', 'frozen']),
  live: new Set(['extended', 'ended', 'cancelled', 'frozen']),
  extended: new Set(['ended', 'cancelled', 'frozen']),
  ended: new Set(['sold', 'unsold']),
  sold: new Set(),
  unsold: new Set(),
  cancelled: new Set(),
  frozen: new Set(['cancelled']),
};

const FREEZABLE = new Set(['review', 'scheduled', 'live', 'extended']);

function canTransition(from, to) {
  const f = String(from || '').toLowerCase();
  const t = String(to || '').toLowerCase();
  if (!AUCTION_STATUSES.includes(f) || !AUCTION_STATUSES.includes(t)) return false;
  return TRANSITIONS[f]?.has(t) === true;
}

function canFreeze(from) {
  return FREEZABLE.has(String(from || '').toLowerCase());
}

function isBiddableStatus(status) {
  return status === 'live' || status === 'extended';
}

function isFrozen(status) {
  return String(status || '').toLowerCase() === 'frozen';
}

function isTerminal(status) {
  return TERMINAL.has(String(status || '').toLowerCase());
}

function effectiveEndAt(auction, now = new Date()) {
  const ext = auction.extended_until || auction.extendedUntil;
  if (ext) return new Date(ext);
  return new Date(auction.end_at || auction.endAt);
}

function serverNow() {
  return new Date();
}

module.exports = {
  TRANSITIONS,
  FREEZABLE,
  canTransition,
  canFreeze,
  isBiddableStatus,
  isFrozen,
  isTerminal,
  effectiveEndAt,
  serverNow,
};
