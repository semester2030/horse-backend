'use strict';

/**
 * G17 — Deterministic observability / failure engineering.
 * Observes the system. Does not become Auction/G10–G16 authority.
 * No AI. No vendor. No new business tables.
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

const AI_STATUS = Object.freeze({
  scope: 'DEFERRED — OWNER DECISION',
  implemented: false,
  provider: false,
  logAnalysis: false,
  anomalyDetection: false,
  incidentSummaries: false,
});

const LIVEKIT = Object.freeze({
  implemented: false,
  tested: false,
  classification: 'DEFERRED READINESS ITEM',
});

const SLOW_MS = Object.freeze({
  label: 'OPERATIONAL BASELINE — NOT CONTRACTUAL SLA',
  http: 2000,
  bid: 1500,
  ready: 800,
});

const SENSITIVE_KEY = /authorization|password|passwd|otp|token|secret|cookie|set-cookie|api[_-]?key|private[_-]?key|database_url|connectionstring|bearer|psp|kyc|evidence|bidsecurity|bid_security|providerref|provider_ref|phone|email/i;
const SENTINEL_RE = /G17_(SECRET_SENTINEL_TOKEN|PASSWORD_SENTINEL|PRIVATE_EVIDENCE_SENTINEL)/;
const SAFE_CORR = /^[A-Za-z0-9._:-]{8,80}$/;

const TAXONOMY = Object.freeze({
  BUSINESS_REJECTION: 'BUSINESS_REJECTION',
  AUTHENTICATION: 'AUTHENTICATION',
  AUTHORIZATION: 'AUTHORIZATION',
  CONFLICT: 'CONFLICT',
  DEPENDENCY_FAILURE: 'DEPENDENCY_FAILURE',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

const BUSINESS_CODES = new Set([
  'HARAJ_EXPOSURE_LIMIT',
  'HARAJ_BID_LIMIT',
  'HARAJ_ELIGIBILITY_BLOCKED',
  'HARAJ_SECURITY_INVALID',
  'HARAJ_BIDDER_SUSPENDED',
  'OWNER_SELF_BID',
  'AUCTION_NOT_LIVE',
  'AUCTION_LIFECYCLE_FORBIDDEN',
  'DISPUTE_INVALID',
  'BID_IDEMPOTENT_REPLAY',
]);

const STALE_CODES = new Set([
  'CASE_STALE_STATE',
  'CASE_STATE_CONFLICT',
  'AFTER_HARAJ_STALE_STATE',
  'INSPECTION_STALE_STATE',
]);

function appEnv() {
  const explicit = String(process.env.APP_ENV || process.env.NOMAS_ENV || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return 'production';
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return 'test';
  return 'development';
}

function isProductionEnv() {
  return appEnv() === 'production';
}

function isStagingEnv() {
  return appEnv() === 'staging';
}

function deployedVersion() {
  return process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null;
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function redactValue(value, key, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (SENTINEL_RE.test(value) || (key && SENSITIVE_KEY.test(key))) return '[REDACTED]';
    if (value.length > 400) return `${value.slice(0, 80)}…[truncated ${value.length}]`;
    return value.replace(/\r?\n/g, '\\n');
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 20).map((v, i) => redactValue(v, key || String(i), seen));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactValue(v, k, seen);
    }
    return out;
  }
  return value;
}

function redact(record) {
  try {
    return redactValue(record, null);
  } catch {
    return { event: 'log.redact_failed', level: 'error' };
  }
}

const metrics = {
  http_requests_total: 0,
  http_4xx_total: 0,
  http_5xx_total: 0,
  http_latency_ms_sum: 0,
  db_errors_total: 0,
  txn_rollbacks_total: 0,
  ws_connects_total: 0,
  ws_disconnects_total: 0,
  room_joins_total: 0,
  bid_attempts_total: 0,
  bid_accepted_total: 0,
  bid_replay_total: 0,
  bid_business_rejection_total: 0,
  scheduler_runs_total: 0,
  scheduler_skipped_total: 0,
  scheduler_failures_total: 0,
  case_resolve_conflict_total: 0,
  after_haraj_conflict_total: 0,
};

const METRIC_DOCS = Object.freeze({
  http_requests_total: { type: 'counter', unit: '1', meaning: 'HTTP requests excluding health/ready', labels: 'none', cardinality: '1' },
  http_5xx_total: { type: 'counter', unit: '1', meaning: 'Internal/system failures — not 4xx business', labels: 'none', cardinality: '1' },
  bid_accepted_total: { type: 'counter', unit: '1', meaning: 'Authoritative accepted bids (not revenue)', labels: 'none', cardinality: '1' },
  bid_business_rejection_total: { type: 'counter', unit: '1', meaning: 'Expected 4xx bid rejections', labels: 'none', cardinality: '1' },
  txn_rollbacks_total: { type: 'counter', unit: '1', meaning: 'Critical transaction rollbacks', labels: 'none', cardinality: '1' },
  scheduler_runs_total: { type: 'counter', unit: '1', meaning: 'Scheduler ticks that evaluated policies', labels: 'none', cardinality: '1' },
});

const logRing = [];
const MAX_LOGS = 200;

function pushRing(rec) {
  logRing.unshift(rec);
  if (logRing.length > MAX_LOGS) logRing.length = MAX_LOGS;
}

function logStructured(level, event, fields = {}) {
  const rec = redact({
    ts: new Date().toISOString(),
    level,
    service: 'horse-backend',
    environment: appEnv(),
    event,
    version: deployedVersion(),
    ...fields,
  });
  try {
    pushRing(rec);
    const line = JSON.stringify(rec);
    if (level === 'error') console.error(line);
    else console.log(line);
  } catch {
    /* logger must not break business */
  }
  return rec;
}

function classify(err, status) {
  const code = err && err.code;
  const s = Number(status || err?.status || 500);
  if (s === 401) return TAXONOMY.AUTHENTICATION;
  if (s === 403) return TAXONOMY.AUTHORIZATION;
  if (STALE_CODES.has(code)) return TAXONOMY.CONFLICT;
  if (BUSINESS_CODES.has(code)) return TAXONOMY.BUSINESS_REJECTION;
  if (s === 409) return TAXONOMY.CONFLICT;
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT' || code === 'G17_INJECTED_TIMEOUT') return TAXONOMY.TIMEOUT;
  if (code === 'G17_INJECTED_MEDIA' || code === 'G17_INJECTED_NOTIFY' || code === 'AUCTIONS_DATABASE_URL missing') {
    return TAXONOMY.DEPENDENCY_FAILURE;
  }
  if (code === 'G17_INJECTED_DB' || code === '57P01' || code === '08006' || code === 'ECONNREFUSED') {
    return TAXONOMY.DATABASE_FAILURE;
  }
  if (s === 503) return TAXONOMY.DEPENDENCY_FAILURE;
  if (s >= 400 && s < 500) return TAXONOMY.BUSINESS_REJECTION;
  return TAXONOMY.INTERNAL_ERROR;
}

function safeErrorBody(err, req) {
  const status = err?.status || 500;
  const taxonomy = classify(err, status);
  const body = {
    message: status >= 500 ? 'Internal error' : String(err?.message || 'Error'),
    code: status >= 500 ? (err?.code && String(err.code).startsWith('G17_') ? err.code : 'INTERNAL_ERROR') : err?.code,
    taxonomy,
    requestId: req?.correlationId || null,
  };
  if (status < 500 && err?.details && typeof err.details === 'object') {
    body.details = redact(err.details);
  }
  return body;
}

function resolveCorrelationId(req) {
  const incoming = String(req.get?.('x-request-id') || req.get?.('x-correlation-id') || '').trim();
  if (SAFE_CORR.test(incoming)) return incoming;
  return newId('req');
}

function requestContext() {
  return als.getStore() || {};
}

function observabilityMiddleware(req, res, next) {
  bindRequest(req, res);
  als.run({ req, correlationId: req.correlationId }, () => next());
}

function bindRequest(req, res) {
  req.correlationId = resolveCorrelationId(req);
  res.setHeader('x-request-id', req.correlationId);
  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const path = req.path || req.url;
    if (path === '/health' || path === '/ready' || path === '/auctions/ready') return;
    metrics.http_requests_total += 1;
    metrics.http_latency_ms_sum += durationMs;
    if (res.statusCode >= 500) metrics.http_5xx_total += 1;
    else if (res.statusCode >= 400) metrics.http_4xx_total += 1;
    logStructured(res.statusCode >= 500 ? 'error' : 'info', 'http.request', {
      requestId: req.correlationId,
      method: req.method,
      route: req.route?.path || path,
      statusCode: res.statusCode,
      durationMs,
      taxonomy: res.statusCode >= 400 ? classify({ code: res.locals?.errorCode, status: res.statusCode }, res.statusCode) : undefined,
      auctionId: req.params?.id || req.params?.auctionId || undefined,
      roomId: req.params?.roomSessionId || undefined,
      caseId: req.params?.id && String(path).includes('cases') ? req.params.id : undefined,
      actorRole: req.adminUser ? 'admin' : req.authUserId ? 'user' : 'anon',
      slow: durationMs >= SLOW_MS.http,
    });
  });
}

let runtimeInject = null;

function assertProductionInjectForbidden() {
  if (isProductionEnv() && process.env.HARAJ_G17_INJECT_ENABLE === 'true') {
    const err = new Error('HARAJ_G17_INJECT_ENABLE is forbidden in production');
    err.code = 'G17_INJECT_FORBIDDEN_IN_PRODUCTION';
    throw err;
  }
}

function injectEnabled() {
  if (isProductionEnv()) return false;
  const renderName = String(process.env.RENDER_SERVICE_NAME || '').toLowerCase();
  const onRenderStaging = renderName.includes('staging') && !renderName.includes('production');
  if (process.env.HARAJ_G17_INJECT_ENABLE === 'true' && (isStagingEnv() || appEnv() === 'test')) return true;
  return isStagingEnv() || onRenderStaging;
}

function currentInject(req) {
  if (!injectEnabled()) return null;
  const r = req || requestContext().req;
  const header = r && r.get && r.get('x-nomas-g17-inject');
  if (header) return String(header);
  return runtimeInject?.mode || null;
}

function setRuntimeInject(mode, meta = {}) {
  if (!injectEnabled()) {
    const err = new Error('Failure injection disabled');
    err.status = 403;
    err.code = 'G17_INJECT_DISABLED';
    throw err;
  }
  runtimeInject = mode ? { mode: String(mode), at: new Date().toISOString(), ...meta } : null;
  logStructured('warn', 'g17.inject.set', { mode: runtimeInject?.mode || null, roomId: meta.roomId });
  return runtimeInject;
}

function applyInject(req, phase) {
  const mode = currentInject(req);
  if (!mode) return;
  const ctx = requestContext();
  const r = req || ctx.req;
  logStructured('warn', 'g17.inject.applied', {
    mode,
    phase,
    requestId: r?.correlationId || ctx.correlationId || null,
    roomId: runtimeInject?.roomId || r?.query?.category || r?.params?.roomSessionId || null,
  });
  if (mode === 'db_unavailable' && (phase === 'db' || phase === 'ready')) {
    const err = new Error('Injected database unavailability');
    err.status = 503;
    err.code = 'G17_INJECTED_DB';
    throw err;
  }
  if (mode === 'txn_fail_before_commit' && phase === 'before_commit') {
    const err = new Error('Injected transaction rollback');
    err.status = 500;
    err.code = 'G17_INJECTED_ROLLBACK';
    throw err;
  }
  if (mode === 'timeout' && phase === 'handler') {
    const err = new Error('Injected timeout');
    err.status = 504;
    err.code = 'G17_INJECTED_TIMEOUT';
    throw err;
  }
  if (mode === 'internal_error' && phase === 'handler') {
    const err = new Error('Injected internal exception');
    err.status = 500;
    err.code = 'G17_INJECTED_INTERNAL';
    throw err;
  }
  if (mode === 'notify_fail' && phase === 'notify') {
    const err = new Error('Injected notification failure');
    err.status = 500;
    err.code = 'G17_INJECTED_NOTIFY';
    throw err;
  }
  if (mode === 'media_fail' && phase === 'media') {
    const err = new Error('Injected media dependency failure');
    err.status = 503;
    err.code = 'G17_INJECTED_MEDIA';
    throw err;
  }
}

function recordRollback() {
  metrics.txn_rollbacks_total += 1;
}

function recordDbError() {
  metrics.db_errors_total += 1;
}

function recordCaseConflict() {
  metrics.case_resolve_conflict_total += 1;
  logStructured('info', 'g16.case.conflict', { taxonomy: TAXONOMY.CONFLICT, code: 'CASE_STALE_STATE' });
}

function recordAfterHarajConflict() {
  metrics.after_haraj_conflict_total += 1;
  logStructured('info', 'g12.offer.conflict', { taxonomy: TAXONOMY.CONFLICT, code: 'AFTER_HARAJ_STALE_STATE' });
}

function observeBidOutcome({ replay, accepted, businessRejected, code }) {
  metrics.bid_attempts_total += 1;
  if (replay) metrics.bid_replay_total += 1;
  else if (accepted) metrics.bid_accepted_total += 1;
  if (businessRejected) metrics.bid_business_rejection_total += 1;
  logStructured(businessRejected ? 'info' : accepted ? 'info' : 'error', 'auction.bid', {
    replay: Boolean(replay),
    accepted: Boolean(accepted),
    businessRejected: Boolean(businessRejected),
    code: code || null,
    taxonomy: businessRejected ? TAXONOMY.BUSINESS_REJECTION : accepted ? undefined : TAXONOMY.INTERNAL_ERROR,
  });
}

function recordSchedulerFailure() {
  metrics.scheduler_failures_total += 1;
}

function observeScheduler(result) {
  if (result?.skipped) metrics.scheduler_skipped_total += 1;
  else metrics.scheduler_runs_total += 1;
  logStructured('info', 'scheduler.run', {
    jobRunId: result?.jobRunId,
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
    policies: result?.results?.length || 0,
    created: (result?.results || []).reduce((n, r) => n + (r.created || 0), 0),
    existing: (result?.results || []).reduce((n, r) => n + (r.existing || 0), 0),
  });
}

function observeWs(event, extra = {}) {
  if (event === 'connect') metrics.ws_connects_total += 1;
  if (event === 'disconnect') metrics.ws_disconnects_total += 1;
  if (event === 'join') metrics.room_joins_total += 1;
  logStructured('info', `ws.${event}`, extra);
}

function getReadiness({ auctionsReady, dbConfigured, schemaVersion, migrationsReady } = {}) {
  const reasons = [];
  if (runtimeInject?.mode === 'db_unavailable') reasons.push('INJECTED_DB_UNAVAILABLE');
  if (dbConfigured === false) reasons.push('DB_NOT_CONFIGURED');
  if (migrationsReady === false) reasons.push('MIGRATIONS_NOT_READY');
  if (auctionsReady === false) reasons.push('AUCTIONS_NOT_READY');
  return {
    alive: true,
    ready: reasons.length === 0,
    reasons,
    schemaVersion: schemaVersion || null,
    version: deployedVersion(),
    environment: appEnv(),
    livekit: LIVEKIT,
    injectEnabled: injectEnabled() && !isProductionEnv(),
    injectActive: runtimeInject?.mode || null,
    timezone: 'Asia/Riyadh',
    timestamp: new Date().toISOString(),
  };
}

async function runInvariants(client) {
  const checks = [];
  const q = async (id, sql) => {
    const { rows } = await client.query(sql);
    const violations = Number(rows[0]?.c || 0);
    checks.push({ id, violations, status: violations === 0 ? 'ok' : 'incident' });
  };
  await q('INV_ONE_ACTIVE_LOT_PER_LIVE_ROOM',
    `SELECT COUNT(*)::int AS c FROM (
       SELECT rs.id FROM haraj_room_sessions rs
       JOIN haraj_queue_entries q ON q.room_session_id = rs.id AND q.status = 'active'
       WHERE rs.status IN ('live','paused')
       GROUP BY rs.id HAVING COUNT(*) > 1
     ) x`);
  await q('INV_AUCTIONEER_NOT_IN_TWO_LIVE_ROOMS',
    `SELECT COUNT(*)::int AS c FROM (
       SELECT auctioneer_user_id FROM haraj_room_sessions
       WHERE status IN ('live','pre_live') AND auctioneer_user_id IS NOT NULL
       GROUP BY auctioneer_user_id HAVING COUNT(*) > 1
     ) x`);
  await q('INV_ONE_ACCEPTED_AFTER_OFFER',
    `SELECT COUNT(*)::int AS c FROM (
       SELECT auction_id FROM auction_events
       WHERE event_type = 'haraj.after.offer.accepted'
       GROUP BY auction_id HAVING COUNT(*) > 1
     ) x`);
  await q('INV_DISPUTE_STATUS_CANONICAL',
    `SELECT COUNT(*)::int AS c FROM auction_disputes
     WHERE status NOT IN ('open','reviewing','resolved','rejected')`);
  return {
    readOnly: true,
    autoRepair: false,
    checks,
    incidents: checks.filter((c) => c.status === 'incident'),
  };
}

function snapshot() {
  return {
    metrics: { ...metrics },
    metricDocs: METRIC_DOCS,
    readinessHint: runtimeInject?.mode || null,
    recent: logRing.slice(0, 40),
    ai: AI_STATUS,
    livekit: LIVEKIT,
    slowThresholds: SLOW_MS,
    retention: 'OWNER/OPERATIONS DECISION REQUIRED — in-memory ring 200 events, process lifetime only',
  };
}

function recentLogs() {
  return logRing.slice(0, 80);
}

function resetForTests() {
  runtimeInject = null;
  logRing.length = 0;
  for (const k of Object.keys(metrics)) metrics[k] = 0;
}

module.exports = {
  AI_STATUS,
  LIVEKIT,
  TAXONOMY,
  SLOW_MS,
  METRIC_DOCS,
  appEnv,
  isProductionEnv,
  isStagingEnv,
  deployedVersion,
  newId,
  redact,
  logStructured,
  classify,
  safeErrorBody,
  resolveCorrelationId,
  requestContext,
  observabilityMiddleware,
  bindRequest,
  assertProductionInjectForbidden,
  injectEnabled,
  currentInject,
  setRuntimeInject,
  applyInject,
  recordRollback,
  recordDbError,
  recordCaseConflict,
  recordAfterHarajConflict,
  observeBidOutcome,
  recordSchedulerFailure,
  observeScheduler,
  observeWs,
  getReadiness,
  runInvariants,
  snapshot,
  recentLogs,
  resetForTests,
};
