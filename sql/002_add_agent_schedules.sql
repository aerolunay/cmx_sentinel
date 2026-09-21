-- Run against your existing database.

-- One row = one scheduled shift window for one agent on one calendar
-- day. An agent can have MORE THAN ONE row for the same shift_date -
-- e.g. a Regular row and a separate OT row - distinguished by
-- shift_type, not by date alone. Rest days are simply never inserted
-- here (per how the source scheduling system exports data) - there is
-- no "RestDay" shift_type row to represent a day off, so a day with no
-- row for an agent just means "not scheduled to work."
--
-- scheduled_start/scheduled_end are stored as plain DATETIME in
-- EASTERN LOCAL time (no UTC conversion, no offset) - the same
-- convention as aux_events.started_at_est/ended_at_est, so the
-- efficiency query in reportRoutes.js can compare the two directly
-- without any timezone math. The Python sync job must write Eastern
-- wall-clock times here, not UTC.
--
-- shift_type is a free-text VARCHAR rather than an ENUM, deliberately -
-- same reasoning as aux_events.aux_code (see schema.sql in the desktop
-- repo): the actual set of values ('Regular', 'OT', 'RestDayOT', etc.)
-- is owned by the upstream scheduling system, not this app, and a new
-- shift type showing up in an export should never require a migration
-- here.
--
-- shift_date is the day the shift is DATED in the source system (for
-- an overnight shift, typically the day it starts), used only for
-- day-level lookups/reporting grouping - the actual overlap
-- calculation against aux_events always uses the full
-- scheduled_start/scheduled_end timestamps, not shift_date, so
-- overnight shifts crossing midnight are still handled correctly.
CREATE TABLE IF NOT EXISTS agent_schedules (
    schedule_id      BIGINT AUTO_INCREMENT PRIMARY KEY,
    agent_id         VARCHAR(32) NOT NULL,
    shift_date       DATE NOT NULL,
    shift_type       VARCHAR(32) NOT NULL,
    scheduled_start  DATETIME NOT NULL,
    scheduled_end    DATETIME NOT NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Bumped automatically whenever the Python job re-syncs/corrects a
    -- previously-loaded shift (upsert via the unique key below), so a
    -- row's history of edits is at least visible via this timestamp
    -- even without a separate audit table.
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    -- Lets the sync job UPSERT cleanly: one row per
    -- (agent, date, shift type), so re-running the sync for a day that
    -- already loaded just updates the times instead of creating a
    -- duplicate. If the same agent legitimately has two separate
    -- Regular blocks in one day, distinguish them with different
    -- shift_type values (e.g. 'Regular', 'Regular2') on the source
    -- side.
    UNIQUE KEY uq_agent_date_shift (agent_id, shift_date, shift_type),
    -- Supports the efficiency query's per-agent time-range overlap
    -- lookups (see reportRoutes.js).
    INDEX idx_agent_window (agent_id, scheduled_start, scheduled_end)
) ENGINE=InnoDB;

-- Dedicated, least-privilege account for the Python schedule-sync job -
-- same reasoning as cmx_service in the desktop repo's schema.sql: this
-- account can only read/write agent_schedules, nothing else in the
-- database. CHANGE THE PASSWORD before running this - this is a
-- placeholder.
CREATE USER IF NOT EXISTS 'cmx_scheduler'@'%' IDENTIFIED BY 'CHANGE_ME_BEFORE_RUNNING';
GRANT SELECT, INSERT, UPDATE, DELETE ON cmx_sentinel.agent_schedules TO 'cmx_scheduler'@'%';

-- The admin web backend (cmx_admin) needs to READ schedules to compute
-- schedule-scoped efficiency/adherence in reportRoutes.js. It never
-- writes to this table - only the Python job does.
GRANT SELECT ON cmx_sentinel.agent_schedules TO 'cmx_admin'@'%';

FLUSH PRIVILEGES;

-- Example upsert, for reference (what the Python job should do per
-- shift row it loads):
-- INSERT INTO agent_schedules (agent_id, shift_date, shift_type, scheduled_start, scheduled_end)
-- VALUES ('A1234', '2026-09-19', 'Regular', '2026-09-19 09:00:00', '2026-09-19 18:00:00')
-- ON DUPLICATE KEY UPDATE
--   scheduled_start = VALUES(scheduled_start),
--   scheduled_end   = VALUES(scheduled_end);
