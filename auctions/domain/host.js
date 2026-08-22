'use strict';

const HOST_TRANSITIONS = {
  pending: ['verified', 'suspended'],
  verified: ['active', 'suspended'],
  active: ['suspended'],
  suspended: ['active', 'verified'],
};

const BOOKING_TRANSITIONS = {
  requested: ['scheduled', 'rejected', 'cancelled'],
  accepted: ['scheduled', 'cancelled'],
  scheduled: ['cancelled'],
  rejected: [],
  cancelled: [],
};

function canTransitionHost(from, to) {
  return (HOST_TRANSITIONS[from] || []).includes(to);
}

function canTransitionBooking(from, to) {
  return (BOOKING_TRANSITIONS[from] || []).includes(to);
}

function canHostAcceptBookings(host) {
  if (!host) return false;
  return host.status === 'active' && Boolean(host.verified_at);
}

function isHostVerified(host) {
  return Boolean(host?.verified_at) && ['verified', 'active'].includes(host?.status);
}

function hostIsActiveAndVerified(host) {
  return canHostAcceptBookings(host);
}

module.exports = {
  HOST_TRANSITIONS,
  BOOKING_TRANSITIONS,
  canTransitionHost,
  canTransitionBooking,
  canHostAcceptBookings,
  isHostVerified,
  hostIsActiveAndVerified,
};
