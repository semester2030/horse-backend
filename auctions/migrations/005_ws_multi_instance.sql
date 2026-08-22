-- Phase 7 / PR-01 — PostgreSQL-authoritative auction WS events (multi-instance fan-out)

CREATE TABLE IF NOT EXISTS auction_ws_events (
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK (seq > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (auction_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_auction_ws_events_auction_created
  ON auction_ws_events(auction_id, created_at ASC);
