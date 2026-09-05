'use strict';

/**
 * G4 — Auctioneer authorization.
 * Session identity is SSOT. Client role / auctioneerId are ignored.
 * Privileged phones do NOT become auctioneers automatically.
 */

const CAPABILITY = 'haraj:auctioneer';

function envList(name) {
  return String(process.env[name] || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isStagingAppEnv() {
  const app = String(process.env.APP_ENV || process.env.NOMAS_ENV || '')
    .trim()
    .toLowerCase();
  const node = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (app === 'production' || node === 'production') return false;
  if (app === 'staging') return true;
  const service = String(
    process.env.RENDER_SERVICE_NAME || process.env.RENDER_SERVICE_ID || '',
  );
  return /horse-backend-staging|srv-dabp5bek1f9s7391feq0/i.test(service);
}

function isAuctioneerBootstrapEmail(email) {
  return /@nomas\.auctioneer\.staging$/i.test(String(email || '').trim());
}

function grantAuctioneerCapability(user) {
  if (!user || typeof user !== 'object') return user;
  const caps = new Set(user.capabilities || []);
  caps.add(CAPABILITY);
  user.capabilities = [...caps];
  return user;
}

function applyStagingAuctioneerBootstrap(user) {
  if (!user || !isStagingAppEnv()) return user;
  if (isAuctioneerBootstrapEmail(user.email)) {
    return grantAuctioneerCapability(user);
  }
  return user;
}

function isHarajAuctioneer(user, userId) {
  const id = String(userId || user?.id || '').trim();
  if (!id) return false;
  if (envList('HARAJ_AUCTIONEER_USER_IDS').includes(id)) return true;
  const email = String(user?.email || '').trim();
  if (email && envList('HARAJ_AUCTIONEER_EMAILS').includes(email)) return true;
  const caps = Array.isArray(user?.capabilities) ? user.capabilities : [];
  return caps.includes(CAPABILITY);
}

function assertHarajAuctioneer(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const claimed = String(body.auctioneerId || body.auctioneer_id || '').trim();
  if (claimed && claimed !== String(req.authUserId || '')) {
    const err = new Error('Client-supplied auctioneer identity is not authoritative');
    err.code = 'AUCTIONEER_IDENTITY_FORBIDDEN';
    err.status = 403;
    throw err;
  }
  if (!isHarajAuctioneer(req.authUser, req.authUserId)) {
    const err = new Error('Auctioneer authorization required');
    err.code = 'AUCTIONEER_FORBIDDEN';
    err.status = 403;
    throw err;
  }
}

function requireHarajAuctioneer(req, res, next) {
  try {
    assertHarajAuctioneer(req);
    return next();
  } catch (err) {
    return res.status(err.status || 403).json({
      message: err.message,
      code: err.code || 'AUCTIONEER_FORBIDDEN',
    });
  }
}

module.exports = {
  CAPABILITY,
  isStagingAppEnv,
  isAuctioneerBootstrapEmail,
  grantAuctioneerCapability,
  applyStagingAuctioneerBootstrap,
  isHarajAuctioneer,
  assertHarajAuctioneer,
  requireHarajAuctioneer,
};
