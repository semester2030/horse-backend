-- =============================================================================
-- ROLLBACK 011 — Bidder eligibility / Bid Security (PROPOSED — DO NOT EXECUTE)
-- Staging only after explicit review. Never Production.
-- =============================================================================

DROP TABLE IF EXISTS haraj_bidder_audit_events CASCADE;
DROP TABLE IF EXISTS haraj_bidder_exposure_snapshots CASCADE;
DROP TABLE IF EXISTS haraj_bid_securities CASCADE;
DROP TABLE IF EXISTS haraj_bidder_profiles CASCADE;

DELETE FROM auction_schema_migrations WHERE id = '011_haraj_bidder_eligibility_security';
