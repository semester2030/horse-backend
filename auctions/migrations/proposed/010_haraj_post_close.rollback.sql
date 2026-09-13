-- =============================================================================
-- ROLLBACK 010 — Haraj post-close (PROPOSED)
-- =============================================================================

ALTER TABLE auction_disputes DROP COLUMN IF EXISTS inspection_id;
ALTER TABLE auction_disputes DROP COLUMN IF EXISTS provisional_award_id;

DROP TABLE IF EXISTS haraj_after_listings CASCADE;
DROP TABLE IF EXISTS haraj_settlements CASCADE;
DROP TABLE IF EXISTS haraj_inspections CASCADE;
DROP TABLE IF EXISTS haraj_provisional_awards CASCADE;

DELETE FROM auction_schema_migrations WHERE id = '010_haraj_post_close';
