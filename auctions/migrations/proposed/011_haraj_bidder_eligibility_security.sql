-- =============================================================================
-- NOMAS HARAJ — Migration 011 (G10.1 REVIEWED — STAGING APPLY ONLY)
-- G10 Bidder Eligibility / Bid Security
-- Depends on: 010_haraj_post_close
-- DO NOT RUN ON PRODUCTION.
-- DO NOT place this file in auctions/migrations/ — that directory auto-applies on boot.
-- Money: NUMERIC(14,2) — same as auctions.current_price / bids.amount. No FLOAT/REAL/DOUBLE.
-- Exposure snapshots are AUDIT/IDEMPOTENCY only. Authoritative exposure = auctions+bids.
-- =============================================================================
-- Bid Security is NOT purchase price, wallet, escrow, stored value, or seller settlement.
-- Do NOT reuse haraj_settlements (G11+/sale proceeds) for bid participation security.
-- =============================================================================

CREATE TABLE IF NOT EXISTS haraj_bidder_profiles (
  user_id TEXT PRIMARY KEY,
  eligibility_status TEXT NOT NULL DEFAULT 'not_verified' CHECK (eligibility_status IN (
    'not_verified', 'pending', 'verified', 'suspended', 'revoked'
  )),
  bid_limit NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (bid_limit >= 0),
  currency TEXT NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
  suspended_reason TEXT,
  revoked_reason TEXT,
  verified_at TIMESTAMPTZ,
  verified_by_admin_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_haraj_bidder_profiles_status
  ON haraj_bidder_profiles (eligibility_status);

CREATE TABLE IF NOT EXISTS haraj_bid_securities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bidder_user_id TEXT NOT NULL REFERENCES haraj_bidder_profiles(user_id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'required' CHECK (status IN (
    'required', 'pending', 'authorized', 'active', 'released', 'expired', 'failed', 'cancelled'
  )),
  scope_type TEXT NOT NULL CHECK (scope_type IN (
    'global', 'haraj', 'session', 'room', 'lot', 'policy_tier'
  )),
  scope_id TEXT,
  authorized_limit NUMERIC(14, 2) NOT NULL CHECK (authorized_limit > 0),
  currency TEXT NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
  provider TEXT NOT NULL DEFAULT 'staging_test',
  provider_mode TEXT NOT NULL DEFAULT 'test_sandbox' CHECK (provider_mode IN (
    'test_sandbox', 'psp_sandbox'
  )),
  provider_state TEXT NOT NULL DEFAULT 'none' CHECK (provider_state IN (
    'none',
    'authorization_requested',
    'provider_pending',
    'provider_authorized',
    'provider_failed',
    'provider_expired',
    'provider_released'
  )),
  provider_ref TEXT,
  provider_idempotency_key TEXT,
  expires_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_by_admin_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE haraj_bid_securities IS
  'Participation authorization only. NOT a wallet, escrow, or sale-proceeds custody.';

CREATE UNIQUE INDEX IF NOT EXISTS haraj_bid_securities_one_active_uidx
  ON haraj_bid_securities (bidder_user_id, scope_type, COALESCE(scope_id, ''))
  WHERE status IN ('authorized', 'active');

CREATE UNIQUE INDEX IF NOT EXISTS haraj_bid_securities_provider_ref_uidx
  ON haraj_bid_securities (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS haraj_bid_securities_provider_idem_uidx
  ON haraj_bid_securities (provider, provider_idempotency_key)
  WHERE provider_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_haraj_bid_securities_bidder
  ON haraj_bid_securities (bidder_user_id, status);

CREATE INDEX IF NOT EXISTS idx_haraj_bid_securities_expires
  ON haraj_bid_securities (expires_at)
  WHERE status IN ('authorized', 'active') AND expires_at IS NOT NULL;

-- Derived exposure is AUTHORITATIVE from auctions+bids.
-- Snapshots are append-only idempotency/audit; never the sole exposure truth.
CREATE TABLE IF NOT EXISTS haraj_bidder_exposure_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bidder_user_id TEXT NOT NULL REFERENCES haraj_bidder_profiles(user_id) ON DELETE RESTRICT,
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE RESTRICT,
  bid_id UUID REFERENCES bids(id) ON DELETE SET NULL,
  bid_amount NUMERIC(14, 2) NOT NULL CHECK (bid_amount > 0),
  prior_exposure NUMERIC(14, 2) NOT NULL CHECK (prior_exposure >= 0),
  resulting_exposure NUMERIC(14, 2) NOT NULL CHECK (resulting_exposure >= 0),
  bid_limit NUMERIC(14, 2) NOT NULL CHECK (bid_limit >= 0),
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (auction_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_haraj_exposure_snapshots_bidder
  ON haraj_bidder_exposure_snapshots (bidder_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS haraj_bidder_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bidder_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id TEXT,
  actor_role TEXT,
  auction_id UUID REFERENCES auctions(id) ON DELETE RESTRICT,
  correlation_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE haraj_bidder_audit_events IS
  'Append-only G10 audit. UPDATE/DELETE are rejected by trigger.';

CREATE INDEX IF NOT EXISTS idx_haraj_bidder_audit
  ON haraj_bidder_audit_events (bidder_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION haraj_bidder_audit_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'haraj_bidder_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS haraj_bidder_audit_no_mutate ON haraj_bidder_audit_events;
CREATE TRIGGER haraj_bidder_audit_no_mutate
  BEFORE UPDATE OR DELETE ON haraj_bidder_audit_events
  FOR EACH ROW EXECUTE PROCEDURE haraj_bidder_audit_immutable();

-- Concurrency strategy (application, same transaction as placeBid):
--   SELECT pg_advisory_xact_lock(hashtext('nomas:bidder-exposure:' || bidder_user_id));
-- then existing acquireAuctionLock(auction_id) inside placeBid.
-- Bidder lock first — serializes multi-room bids by the same user.

-- INSERT INTO auction_schema_migrations (id) VALUES ('011_haraj_bidder_eligibility_security');
