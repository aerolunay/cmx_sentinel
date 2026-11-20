-- Run against your existing database.

-- How many hours each group's recordings are kept in S3 before
-- backend/scripts/deleteOldRecordings.js purges them (set on the Groups &
-- Restrictions page, next to the Recordings tick box). Always 0 for a
-- group with recordings off: nothing of theirs is kept.
--
-- When the column is first added:
--   - groups with recordings on: 24 hours
--   - American Plan Administrators: 2160 hours (3 months = 90 days)
--   - groups with recordings off: 0
-- Re-running this file changes nothing - it never overwrites hours that
-- were changed on the page afterwards.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_groups'
                     AND COLUMN_NAME = 'recording_retention_hours');

SET @sql = IF(@col_exists = 0,
  'ALTER TABLE agent_groups ADD COLUMN recording_retention_hours INT NOT NULL DEFAULT 24',
  'SELECT ''agent_groups.recording_retention_hours already exists'' AS info');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE agent_groups
SET recording_retention_hours = CASE
      WHEN recording_enabled = FALSE THEN 0
      WHEN LOWER(TRIM(group_name)) = 'american plan administrators' THEN 2160
      ELSE 24
    END
WHERE @col_exists = 0 AND group_id > 0;

-- Check: every group, whether it's recorded, and for how long.
SELECT group_id, group_name, recording_enabled, recording_retention_hours
FROM agent_groups ORDER BY group_name;
