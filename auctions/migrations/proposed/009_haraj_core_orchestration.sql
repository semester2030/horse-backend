-- =============================================================================
-- NOMAS HARAJ — Migration 009 (PROPOSED — NOT EXECUTED — REVIEW REQUIRED)
-- G2 Data Model: Haraj core orchestration (additive, backward-compatible)
-- Baseline: migrations 001–008 applied; auctions.id = lotId (G1-ADR-01)
-- DO NOT RUN ON PRODUCTION until Staging validation + explicit owner approval
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Global configuration (singleton active row pattern)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS haraj_configuration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  timezone_default TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  haraj_enabled BOOLEAN NOT NULL DEFAULT false,
  session_grace_seconds INTEGER NOT NULL DEFAULT 300 CHECK (session_grace_seconds >= 0),
  max_concurrent_live_rooms INTEGER NOT NULL DEFAULT 20 CHECK (max_concurrent_live_rooms >= 1),
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMPTZ,
  created_by_admin_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_haraj_configuration_effective
  ON haraj_configuration (effective_from DESC)
  WHERE effective_until IS NULL;

-- -----------------------------------------------------------------------------
-- 2) Categories (horse / camel / falcon — aligns with auctions.species CHECK)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS haraj_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code IN ('horse', 'camel', 'falcon')),
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 3) Rooms (operational container — NOT financial unit)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS haraj_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES haraj_categories(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN (
    'disabled', 'idle', 'pre_live', 'live', 'paused', 'closing', 'closed'
  )),
  sort_order INTEGER NOT NULL DEFAULT 0,
  livekit_room_prefix TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_haraj_rooms_category ON haraj_rooms(category_id);
CREATE INDEX IF NOT EXISTS idx_haraj_rooms_status ON haraj_rooms(status);

-- -----------------------------------------------------------------------------
-- 4) Room schedule policies (admin-configurable — NOT hard-coded daily)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS haraj_room_schedule_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES haraj_rooms(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  recurrence TEXT NOT NULL CHECK (recurrence IN (
    'daily', 'every_n_days', 'selected_weekdays', 'weekly', 'monthly', 'one_time', 'custom_rrule'
  )),
  recurrence_interval INTEGER CHECK (recurrence_interval IS NULL OR recurrence_interval >= 1),
  days_of_week SMALLINT[] CHECK (days_of_week IS NULL OR cardinality(days_of_week) >= 1),
  start_time_local TIME NOT NULL,
  end_time_local TIME NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  one_time_date DATE,
  custom_rrule TEXT,
  effective_from DATE NOT NULL,
  effective_until DATE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  capacity_lots INTEGER CHECK (capacity_lots IS NULL OR capacity_lots >= 1),
  auctioneer_assignment_rule TEXT NOT NULL DEFAULT 'admin_manual_per_session' CHECK (
    auctioneer_assignment_rule IN ('fixed_user', 'pool_round_robin', 'admin_manual_per_session')
  ),
  default_auctioneer_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'superseded', 'disabled')),
  superseded_by_policy_id UUID REFERENCES haraj_room_schedule_policies(id) ON DELETE SET NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_time_local > start_time_local OR end_time_local < start_time_local),
  CHECK (
    (recurrence <> 'every_n_days' OR recurrence_interval IS NOT NULL)
    AND (recurrence <> 'one_time' OR one_time_date IS NOT NULL)
    AND (recurrence NOT IN ('selected_weekdays', 'weekly') OR days_of_week IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS haraj_room_schedule_one_active_uidx
  ON haraj_room_schedule_policies (room_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_haraj_schedule_policies_room ON haraj_room_schedule_policies(room_id, status);

-- -----------------------------------------------------------------------------
-- 5) Schedule overrides (one-session exceptions — audited)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS haraj_schedule_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES haraj_rooms(id) ON DELETE RESTRICT,
  policy_id UUID REFERENCES haraj_room_schedule_policies(id) ON DELETE SET NULL,
  override_type TEXT NOT NULL CHECK (override_type IN (
    'cancel_session', 'change_time', 'extra_session', 'close_room_day',
    'extend_session', 'reassign_auctioneer', 'emergency_hold'
  )),
  target_session_id UUID,
  original_start_at TIMESTAMPTZ,
  original_end_at TIMESTAMPTZ,
  override_start_at TIMESTAMPTZ,
  override_end_at TIMESTAMPTZ,
  new_auctioneer_user_id TEXT,
  reason TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_admin_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_haraj_overrides_room ON haraj_schedule_overrides(room_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 6) Haraj sessions (concrete operational windows)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS haraj_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES haraj_categories(id) ON DELETE RESTRICT,
  policy_id UUID REFERENCES haraj_room_schedule_policies(id) ON DELETE SET NULL,
  override_id UUID REFERENCES haraj_schedule_overrides(id) ON DELETE SET NULL,
  scheduled_start_at TIMESTAMPTZ NOT NULL,
  scheduled_end_at TIMESTAMPTZ NOT NULL,
  actual_start_at TIMESTAMPTZ,
  actual_end_at TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned', 'upcoming', 'live', 'closing', 'closed', 'cancelled', 'archived'
  )),
  generation_source TEXT NOT NULL DEFAULT 'scheduler' CHECK (
    generation_source IN ('scheduler', 'override_extra', 'manual_admin')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (scheduled_end_at > scheduled_start_at)
);

CREATE INDEX IF NOT EXISTS idx_haraj_sessions_status_start ON haraj_sessions(status, scheduled_start_at);
CREATE INDEX IF NOT EXISTS idx_haraj_sessions_category ON haraj_sessions(category_id, scheduled_start_at DESC);

-- FK for override target session (deferred after haraj_sessions exists)
ALTER TABLE haraj_schedule_overrides
  DROP CONSTRAINT IF EXISTS haraj_schedule_overrides_target_session_id_fkey;
ALTER TABLE haraj_schedule_overrides
  ADD CONSTRAINT haraj_schedule_overrides_target_session_id_fkey
  FOREIGN KEY (target_session_id) REFERENCES haraj_sessions(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 7) Room session activation (one row per room per haraj session)
-- Reuses auction_hosts registry — auctioneer_user_id references host user_id (app-level)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS haraj_room_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  haraj_session_id UUID NOT NULL REFERENCES haraj_sessions(id) ON DELETE RESTRICT,
  room_id UUID NOT NULL REFERENCES haraj_rooms(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN (
    'idle', 'pre_live', 'live', 'paused', 'closing', 'closed'
  )),
  auctioneer_user_id TEXT NOT NULL,
  backup_auctioneer_user_id TEXT,
  active_lot_id UUID REFERENCES auctions(id) ON DELETE RESTRICT,
  active_lot_set_at TIMESTAMPTZ,
  queue_status TEXT NOT NULL DEFAULT 'building' CHECK (queue_status IN (
    'building', 'locked', 'in_progress', 'drained', 'closed'
  )),
  paused_at TIMESTAMPTZ,
  paused_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (haraj_session_id, room_id)
);

CREATE INDEX IF NOT EXISTS idx_haraj_room_sessions_room ON haraj_room_sessions(room_id, status);
CREATE INDEX IF NOT EXISTS idx_haraj_room_sessions_auctioneer ON haraj_room_sessions(auctioneer_user_id)
  WHERE status IN ('pre_live', 'live', 'paused');

-- One active lot pointer per room session when live
CREATE UNIQUE INDEX IF NOT EXISTS haraj_room_sessions_one_active_lot_uidx
  ON haraj_room_sessions (active_lot_id)
  WHERE active_lot_id IS NOT NULL AND status IN ('pre_live', 'live', 'paused');

-- One live room session per auctioneer (G1-ADR-06)
CREATE UNIQUE INDEX IF NOT EXISTS haraj_room_sessions_one_auctioneer_live_uidx
  ON haraj_room_sessions (auctioneer_user_id)
  WHERE status IN ('pre_live', 'live', 'paused');

-- -----------------------------------------------------------------------------
-- 8) Queue entries (orchestration link to existing auctions.id = lotId)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS haraj_queue_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_session_id UUID NOT NULL REFERENCES haraj_room_sessions(id) ON DELETE RESTRICT,
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 1),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'ready', 'active', 'completed', 'skipped', 'withdrawn', 'carried_over', 'cancelled'
  )),
  carry_over_from_entry_id UUID REFERENCES haraj_queue_entries(id) ON DELETE SET NULL,
  seller_no_show BOOLEAN NOT NULL DEFAULT false,
  planned_start_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_session_id, position),
  UNIQUE (room_session_id, auction_id)
);

CREATE INDEX IF NOT EXISTS idx_haraj_queue_auction ON haraj_queue_entries(auction_id);
CREATE INDEX IF NOT EXISTS idx_haraj_queue_room_session_pos ON haraj_queue_entries(room_session_id, position);

-- One non-terminal queue membership per auction across active queues
CREATE UNIQUE INDEX IF NOT EXISTS haraj_queue_one_active_auction_uidx
  ON haraj_queue_entries (auction_id)
  WHERE status IN ('queued', 'ready', 'active');

-- -----------------------------------------------------------------------------
-- 9) Extend auctions — minimal; financial SoT unchanged
-- -----------------------------------------------------------------------------
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS haraj_mode TEXT NOT NULL DEFAULT 'standalone';

ALTER TABLE auctions DROP CONSTRAINT IF EXISTS auctions_haraj_mode_check;
ALTER TABLE auctions ADD CONSTRAINT auctions_haraj_mode_check
  CHECK (haraj_mode IN ('standalone', 'haraj_queued'));

COMMENT ON COLUMN auctions.haraj_mode IS
  'standalone = legacy/current auction path; haraj_queued = lot in Haraj queue orchestration';

-- -----------------------------------------------------------------------------
-- 10) Haraj audit trail (orchestration + admin schedule changes)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS haraj_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id TEXT,
  actor_role TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_haraj_audit_entity ON haraj_audit_events(entity_type, entity_id, created_at DESC);

-- Register migration (ONLY when executed in staging — commented out for review package)
-- INSERT INTO auction_schema_migrations (id) VALUES ('009_haraj_core_orchestration');
