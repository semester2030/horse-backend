-- =============================================================================
-- ROLLBACK 011 — Bidder eligibility / Bid Security
-- G10.1 REVIEWED — STAGING ROLLBACK TEST ONLY. Never Production.
-- Drops ONLY 011 objects. Does not touch Auction Core, bids, users, or 009–010.
-- =============================================================================

DROP TRIGGER IF EXISTS haraj_bidder_audit_no_mutate ON haraj_bidder_audit_events;
DROP TABLE IF EXISTS haraj_bidder_audit_events CASCADE;
DROP TABLE IF EXISTS haraj_bidder_exposure_snapshots CASCADE;
DROP TABLE IF EXISTS haraj_bid_securities CASCADE;
DROP TABLE IF EXISTS haraj_bidder_profiles CASCADE;
DROP FUNCTION IF EXISTS haraj_bidder_audit_immutable();

DELETE FROM auction_schema_migrations WHERE id = '011_haraj_bidder_eligibility_security';
