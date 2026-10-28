-- Run against your existing database.

-- One row = one login the server logged out on the agent's behalf
-- because it was still open 6 hours after the scheduled shift end
-- (see backend/services/autoLogout.js, run hourly). The open aux_events
-- row is closed at the scheduled end, so the hours after it never count
-- as worked; this table keeps the record of who didn't log out, shown in
-- Reports > Logout Offenders.
--
-- app_running: whether Sentinel was still running and connected on the
-- agent's PC when the check found it (they left the app running), as
-- opposed to the PC having been shut down or disconnected without
-- logging out.
--
-- scheduled_end_est / segment_started_est / closed_at_est are Eastern
-- wall-clock DATETIMEs, same convention as aux_events' _est columns.
CREATE TABLE IF NOT EXISTS auto_logouts (
    auto_logout_id      BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_id            BIGINT NOT NULL,
    agent_id            VARCHAR(32) NOT NULL,
    login_session_id    CHAR(36) NOT NULL,
    machine_name        VARCHAR(64) NULL,
    aux_code            VARCHAR(32) NOT NULL,
    shift_date          DATE NOT NULL,
    scheduled_end_est   DATETIME NOT NULL,
    segment_started_est DATETIME NOT NULL,
    closed_at_est       DATETIME NOT NULL,
    detected_at_est     DATETIME NOT NULL,
    app_running         TINYINT(1) NOT NULL DEFAULT 0,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_event (event_id),
    KEY idx_shift_date (shift_date),
    KEY idx_agent_shift (agent_id, shift_date),
    CONSTRAINT auto_logouts_agent_fk FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
