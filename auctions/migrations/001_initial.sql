-- NOMAS Auction V1 — PostgreSQL only (isolated from store.json)
-- Requires: CREATE EXTENSION IF NOT EXISTS btree_gist; (for host availability exclusion)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

CREATE TABLE IF NOT EXISTS auction_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  species TEXT NOT NULL CHECK (species IN ('horse', 'camel', 'falcon')),
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (listing_id, video_id)
);

CREATE TABLE IF NOT EXISTS auctions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID NOT NULL REFERENCES auction_lots(id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_by_role TEXT NOT NULL CHECK (created_by_role IN ('seller', 'host_proxy')),
  owner_consent_ref TEXT,
  species TEXT NOT NULL CHECK (species IN ('horse', 'camel', 'falcon')),
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'review', 'scheduled', 'live', 'extended', 'ended', 'sold', 'unsold', 'cancelled'
  )),
  starting_price NUMERIC(14, 2) NOT NULL CHECK (starting_price >= 0),
  minimum_increment NUMERIC(14, 2) NOT NULL CHECK (minimum_increment > 0),
  reserve_price NUMERIC(14, 2),
  current_price NUMERIC(14, 2) NOT NULL CHECK (current_price >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  extended_until TIMESTAMPTZ,
  anti_sniping_seconds INTEGER NOT NULL DEFAULT 120 CHECK (anti_sniping_seconds >= 0),
  winner_user_id TEXT,
  winning_bid_id UUID,
  settlement_note TEXT NOT NULL DEFAULT 'financial_settlement_out_of_band_v1',
  cancelled_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_at > start_at)
);

CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);
CREATE INDEX IF NOT EXISTS idx_auctions_start_at ON auctions(start_at);
CREATE INDEX IF NOT EXISTS idx_auctions_owner ON auctions(owner_user_id);

CREATE TABLE IF NOT EXISTS bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE RESTRICT,
  bidder_user_id TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  auction_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (auction_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_bids_auction_amount ON bids(auction_id, amount DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_bids_bidder ON bids(bidder_user_id);

CREATE TABLE IF NOT EXISTS auction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  actor_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auction_events_auction ON auction_events(auction_id, created_at ASC);

CREATE TABLE IF NOT EXISTS auction_hosts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'active', 'suspended')),
  display_name TEXT,
  specialties TEXT[] NOT NULL DEFAULT '{}',
  verified_at TIMESTAMPTZ,
  verified_by_admin_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS host_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id UUID NOT NULL REFERENCES auction_hosts(id) ON DELETE CASCADE,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  CHECK (end_at > start_at)
);

CREATE INDEX IF NOT EXISTS idx_host_availability_host ON host_availability(host_id, start_at);

CREATE TABLE IF NOT EXISTS host_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE RESTRICT,
  host_id UUID NOT NULL REFERENCES auction_hosts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'accepted', 'rejected', 'scheduled', 'cancelled')),
  requested_by_user_id TEXT NOT NULL,
  owner_consent_ref TEXT,
  scheduled_start_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_host_bookings_auction ON host_bookings(auction_id)
  WHERE status IN ('requested', 'accepted', 'scheduled');

CREATE TABLE IF NOT EXISTS audio_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE RESTRICT,
  host_id UUID REFERENCES auction_hosts(id),
  provider TEXT NOT NULL,
  provider_room_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'ended', 'failed')),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auction_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
