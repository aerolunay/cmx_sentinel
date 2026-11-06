-- Run against your existing database.

USE cmx_sentinel;

-- Biometric punches sent straight to Sentinel by zk-sync (the office PC
-- that reads the time clocks), alongside what it sends to CMX Pulse - so
-- the desktop's shift start/end doesn't wait on, or stop with, the Pulse
-- server. POST /api/biometric-punches (routes/biometricPunchRoutes.js).
-- services/biometrics.js reads this AND ph_timekeeping.device_attendance_logs,
-- so either one alone is enough. Only the last few days matter; old rows
-- can be deleted at any time.
CREATE TABLE IF NOT EXISTS biometric_punches (
    id             BIGINT       AUTO_INCREMENT PRIMARY KEY,
    device_serial  VARCHAR(64)  NOT NULL,
    device_user    VARCHAR(32)  NOT NULL COMMENT '7-digit employee number = agents.agent_id',
    device_time    CHAR(19)     NOT NULL COMMENT 'As the device shows it (Manila), YYYY-MM-DD HH:mm:ss',
    punched_at     DATETIME(3)  NOT NULL COMMENT 'The same moment in UTC',
    state          TINYINT      NOT NULL COMMENT '0 Check-In, 1 Check-Out, others Break/OT',
    verify_mode    INT          NULL,
    received_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_biometric_punch (device_serial, device_user, device_time, state),
    KEY idx_user_time (device_user, punched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Check: should return 1.
SELECT COUNT(*) AS biometric_punches_table FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biometric_punches';
