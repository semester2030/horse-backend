-- Phase 4 — Host profile, calendar slot types, booking linkage

ALTER TABLE auction_hosts ADD COLUMN IF NOT EXISTS profile_image_url TEXT;
ALTER TABLE auction_hosts ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE auction_hosts ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE auction_hosts ADD COLUMN IF NOT EXISTS experience TEXT;
ALTER TABLE auction_hosts ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE auction_hosts ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE auction_hosts ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
ALTER TABLE auction_hosts ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auction_hosts ADD COLUMN IF NOT EXISTS rating_sum NUMERIC(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE host_availability ADD COLUMN IF NOT EXISTS slot_type TEXT NOT NULL DEFAULT 'available';
ALTER TABLE host_availability DROP CONSTRAINT IF EXISTS host_availability_slot_type_check;
ALTER TABLE host_availability ADD CONSTRAINT host_availability_slot_type_check
  CHECK (slot_type IN ('available', 'unavailable'));

ALTER TABLE host_bookings ADD COLUMN IF NOT EXISTS reject_reason TEXT;

ALTER TABLE auctions ADD COLUMN IF NOT EXISTS host_booking_id UUID REFERENCES host_bookings(id);

CREATE INDEX IF NOT EXISTS idx_auctions_host_booking ON auctions(host_booking_id);
