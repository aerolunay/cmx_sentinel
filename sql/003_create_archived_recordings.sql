-- Tracks recordings the local archival script (scripts/archive_recordings.py)
-- has copied to local storage and removed from S3. Needed because,
-- unlike a normal DB-backed table, CMX Sentinel's recordings list is
-- built live by listing S3 objects and parsing filenames
-- (recordingRoutes.js) - there is no existing row to mark "archived"
-- on. Without this table, a recording would just silently vanish from
-- the list the moment it's deleted from S3, instead of showing
-- "Archived to local storage on {date}".
--
-- Columns mirror what parseRecordingKey() already extracts from the
-- filename (see recordingRoutes.js) - the archive routes re-derive
-- these from the key itself rather than trusting the calling script to
-- send them back correctly.

CREATE TABLE IF NOT EXISTS archived_recordings (
    recording_key     VARCHAR(255) NOT NULL,
    agent_id          VARCHAR(32)  NOT NULL,
    sanitized_name    VARCHAR(128) NOT NULL,
    recorded_at_utc   DATETIME     NOT NULL,
    archived_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (recording_key),
    KEY idx_agent_id (agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
