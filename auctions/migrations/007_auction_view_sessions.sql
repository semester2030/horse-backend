-- STEP 5: Thin qualified-view sessions (not an analytics platform)
-- viewCount / uniqueViewers derive from this table (one row per auction+viewer).
-- liveViewers is NEVER stored here — ephemeral WS presence only.
CREATE TABLE IF NOT EXISTS auction_view_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  viewer_key TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (auction_id, viewer_key)
);

CREATE INDEX IF NOT EXISTS auction_view_sessions_auction_idx
  ON auction_view_sessions (auction_id);

-- Soft peak gauge for admin (best-effort; not financial SoT)
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS peak_live_viewers INTEGER NOT NULL DEFAULT 0
    CHECK (peak_live_viewers >= 0);

CREATE INDEX IF NOT EXISTS bids_auction_created_id_idx
  ON bids (auction_id, created_at DESC, id DESC);
