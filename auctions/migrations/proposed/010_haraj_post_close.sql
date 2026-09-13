-- =============================================================================
-- NOMAS HARAJ — Migration 010 (PROPOSED — NOT EXECUTED — REVIEW REQUIRED)
-- G2 Data Model: Post-close domain (provisional award → inspection → settlement → after-haraj)
-- Depends on: 009_haraj_core_orchestration
-- =============================================================================

CREATE TABLE IF NOT EXISTS haraj_provisional_awards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL UNIQUE REFERENCES auctions(id) ON DELETE RESTRICT,
  winning_bid_id UUID NOT NULL REFERENCES bids(id) ON DELETE RESTRICT,
  winner_user_id TEXT NOT NULL,
  final_amount NUMERIC(14, 2) NOT NULL CHECK (final_amount > 0),
  status TEXT NOT NULL DEFAULT 'provisional' CHECK (status IN (
    'provisional', 'inspection_pending', 'accepted', 'disputed', 'withdrawn', 'cancelled'
  )),
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_haraj_provisional_winner ON haraj_provisional_awards(winner_user_id);

CREATE TABLE IF NOT EXISTS haraj_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provisional_award_id UUID NOT NULL REFERENCES haraj_provisional_awards(id) ON DELETE RESTRICT,
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'scheduled', 'in_progress', 'passed', 'failed', 'waived', 'cancelled'
  )),
  buyer_user_id TEXT NOT NULL,
  seller_user_id TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_haraj_inspections_auction ON haraj_inspections(auction_id, status);

CREATE TABLE IF NOT EXISTS haraj_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provisional_award_id UUID NOT NULL UNIQUE REFERENCES haraj_provisional_awards(id) ON DELETE RESTRICT,
  inspection_id UUID REFERENCES haraj_inspections(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending_auth' CHECK (status IN (
    'pending_auth', 'authorized', 'captured', 'refunded', 'failed', 'cancelled'
  )),
  psp_provider TEXT,
  psp_payment_intent_id TEXT,
  psp_idempotency_key TEXT,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'SAR',
  authorized_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS haraj_settlements_psp_intent_uidx
  ON haraj_settlements (psp_provider, psp_payment_intent_id)
  WHERE psp_payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS haraj_after_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL UNIQUE REFERENCES auctions(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN (
    'available_at_approved_price', 'accept_offers', 're_auction', 'history_only', 'closed'
  )),
  approved_price NUMERIC(14, 2) CHECK (approved_price IS NULL OR approved_price > 0),
  offers_enabled BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'eligible' CHECK (status IN (
    'eligible', 'listed', 'sold_off_platform', 're_queued', 'closed'
  )),
  seller_chose_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extend existing disputes with optional haraj context (non-breaking)
ALTER TABLE auction_disputes
  ADD COLUMN IF NOT EXISTS provisional_award_id UUID REFERENCES haraj_provisional_awards(id) ON DELETE SET NULL;
ALTER TABLE auction_disputes
  ADD COLUMN IF NOT EXISTS inspection_id UUID REFERENCES haraj_inspections(id) ON DELETE SET NULL;

-- INSERT INTO auction_schema_migrations (id) VALUES ('010_haraj_post_close');
