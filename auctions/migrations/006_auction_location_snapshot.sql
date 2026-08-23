-- STEP 4: Authoritative auction location snapshot (nullable for existing rows)
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS location_city TEXT,
  ADD COLUMN IF NOT EXISTS location_district TEXT,
  ADD COLUMN IF NOT EXISTS location_address TEXT,
  ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_source_listing_id TEXT,
  ADD COLUMN IF NOT EXISTS location_captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS auctions_location_city_idx
  ON auctions (location_city)
  WHERE location_city IS NOT NULL;
