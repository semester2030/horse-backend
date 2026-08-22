-- Phase 5 — Live Audio session lifecycle

ALTER TABLE audio_sessions DROP CONSTRAINT IF EXISTS audio_sessions_status_check;

UPDATE audio_sessions SET status = 'inactive' WHERE status = 'pending';
UPDATE audio_sessions SET status = 'live' WHERE status = 'active';

ALTER TABLE audio_sessions ADD COLUMN IF NOT EXISTS host_booking_id UUID REFERENCES host_bookings(id);
ALTER TABLE audio_sessions ADD COLUMN IF NOT EXISTS room_name TEXT;
ALTER TABLE audio_sessions ADD COLUMN IF NOT EXISTS host_user_id TEXT;
ALTER TABLE audio_sessions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE audio_sessions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
ALTER TABLE audio_sessions ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

ALTER TABLE audio_sessions ADD CONSTRAINT audio_sessions_status_check
  CHECK (status IN ('inactive', 'ready', 'live', 'paused', 'ended', 'failed'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_sessions_auction_active
  ON audio_sessions(auction_id)
  WHERE status IN ('inactive', 'ready', 'live', 'paused');

CREATE INDEX IF NOT EXISTS idx_audio_sessions_auction ON audio_sessions(auction_id);
