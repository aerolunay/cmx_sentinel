-- Run against your existing database.

USE cmx_sentinel;

-- One row per agent PC: the CMX Sentinel Desktop version it runs and
-- when it was last seen - for the Desktop Updates page (Super Admin).
-- Desktop 2.3.10+ sends its PC name and version with every request to
-- the web app and a heartbeat every 30 minutes
-- (backend/services/desktopClients.js). PCs on older versions don't
-- report; the page lists them from their recent activity as "2.3.9 or
-- older". Until this table exists nothing is recorded.
CREATE TABLE IF NOT EXISTS desktop_clients (
    machine_name    VARCHAR(64)  NOT NULL PRIMARY KEY,
    app_version     VARCHAR(32)  NOT NULL,
    last_agent_id   VARCHAR(32)  NULL,
    last_ip         VARCHAR(45)  NULL,
    work_setup      VARCHAR(8)   NULL,
    first_seen_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Check: should return 1.
SELECT COUNT(*) AS desktop_clients_table FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'desktop_clients';
