-- =============================================================================
-- ROLLBACK 009 — Haraj core orchestration (PROPOSED — run only if 009 was applied on STAGING)
-- Order: drop dependents first. NEVER run on Production without explicit approval.
-- =============================================================================

DROP TABLE IF EXISTS haraj_audit_events CASCADE;
DROP TABLE IF EXISTS haraj_queue_entries CASCADE;
DROP TABLE IF EXISTS haraj_room_sessions CASCADE;
ALTER TABLE haraj_schedule_overrides DROP CONSTRAINT IF EXISTS haraj_schedule_overrides_target_session_id_fkey;
DROP TABLE IF EXISTS haraj_sessions CASCADE;
DROP TABLE IF EXISTS haraj_schedule_overrides CASCADE;
DROP TABLE IF EXISTS haraj_room_schedule_policies CASCADE;
DROP TABLE IF EXISTS haraj_rooms CASCADE;
DROP TABLE IF EXISTS haraj_categories CASCADE;
DROP TABLE IF EXISTS haraj_configuration CASCADE;

ALTER TABLE auctions DROP CONSTRAINT IF EXISTS auctions_haraj_mode_check;
ALTER TABLE auctions DROP COLUMN IF EXISTS haraj_mode;

DELETE FROM auction_schema_migrations WHERE id = '009_haraj_core_orchestration';
