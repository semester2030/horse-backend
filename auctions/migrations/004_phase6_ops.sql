-- Phase 6 — Admin/Ops: frozen status, disputes, risk signals

ALTER TABLE auctions DROP CONSTRAINT IF EXISTS auctions_status_check;
ALTER TABLE auctions ADD CONSTRAINT auctions_status_check CHECK (status IN (
  'draft', 'review', 'scheduled', 'live', 'extended', 'ended', 'sold', 'unsold', 'cancelled', 'frozen'
));

ALTER TABLE auctions ADD COLUMN IF NOT EXISTS pre_frozen_status TEXT;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS frozen_reason TEXT;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS frozen_by_admin_id TEXT;

CREATE INDEX IF NOT EXISTS idx_auctions_frozen_at ON auctions(frozen_at) WHERE status = 'frozen';

CREATE TABLE IF NOT EXISTS auction_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE RESTRICT,
  bid_id UUID REFERENCES bids(id) ON DELETE SET NULL,
  reporter_user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('open', 'reviewing', 'resolved', 'rejected')),
  assigned_admin_id TEXT,
  resolution TEXT,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auction_disputes_auction ON auction_disputes(auction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auction_disputes_status ON auction_disputes(status);

CREATE TABLE IF NOT EXISTS auction_risk_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE RESTRICT,
  bid_id UUID REFERENCES bids(id) ON DELETE SET NULL,
  rule_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  summary TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  acknowledged_by_admin_id TEXT,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auction_risk_signals_auction ON auction_risk_signals(auction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auction_risk_signals_open ON auction_risk_signals(auction_id) WHERE acknowledged = false;
