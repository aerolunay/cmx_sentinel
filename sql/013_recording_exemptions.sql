-- Run against your existing database.

-- Employee IDs whose recordings are hidden in the web app (Recordings
-- page, playback and download) - managed by Super Admins on the
-- Recordings page. The recordings themselves are untouched: the desktop
-- keeps recording and uploading, and they stay in S3 and the archive.
-- Removing an ID shows its recordings again.
-- backend/services/recordingExemptions.js reads this; until the table
-- exists nobody is exempted.
CREATE TABLE IF NOT EXISTS recording_exemptions (
    employee_id       VARCHAR(32)  NOT NULL PRIMARY KEY,
    note              VARCHAR(255) NULL,
    added_by_user_id  INT          NULL,
    added_by_name     VARCHAR(255) NULL,
    created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Check: should return 1.
SELECT COUNT(*) AS recording_exemptions_table FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recording_exemptions';
