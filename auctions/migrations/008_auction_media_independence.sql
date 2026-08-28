-- ADR: Auction Data & Media Independence
-- Non-destructive: legacy listing_id/video_id remain for old lots; new auctions may omit them.

-- 1) Allow independent lots (nullable legacy refs)
ALTER TABLE auction_lots
  ALTER COLUMN listing_id DROP NOT NULL;

ALTER TABLE auction_lots
  ALTER COLUMN video_id DROP NOT NULL;

-- Replace rigid unique pair with partial unique (legacy linked lots only)
ALTER TABLE auction_lots
  DROP CONSTRAINT IF EXISTS auction_lots_listing_id_video_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS auction_lots_listing_video_uidx
  ON auction_lots (listing_id, video_id)
  WHERE listing_id IS NOT NULL AND video_id IS NOT NULL;

-- 2) Auction-owned media (Cloudflare refs) — preferred over store.videos enrich
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS media_video_cloudflare_id TEXT;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS media_video_hls_url TEXT;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS media_video_thumbnail_url TEXT;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS media_images JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 3) Optional auction metadata (all optional except enforced in app/API)
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS breed TEXT;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS gender TEXT;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS color TEXT;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS age_label TEXT;

COMMENT ON COLUMN auctions.media_video_hls_url IS
  'Auction-owned HLS URL (Cloudflare Stream). Preferred over store.videos enrich.';
COMMENT ON COLUMN auctions.media_images IS
  'Auction-owned image URL array (Cloudflare Images). Not from /horses.';
COMMENT ON COLUMN auction_lots.listing_id IS
  'LEGACY nullable — required only for pre-independence auctions.';
COMMENT ON COLUMN auction_lots.video_id IS
  'LEGACY nullable — normal /videos store id for old auctions only.';
