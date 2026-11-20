-- Run against your existing database.

-- Per-group screen recording (desktop 2.4.16+), set with the "Enable
-- recordings" checkbox when adding or editing a group on the Groups &
-- Restrictions page. The desktop asks /api/desktop-sync/auth/verify at
-- each login (and /session-recovery after a service restart); agents
-- whose group has it off are not recorded at all - ffmpeg never starts,
-- so nothing is written to their PC either. Agents with no group are not
-- recorded, and neither is anyone while the web app can't tell (lookup
-- error) - so run this BEFORE deploying the web app update, or recording
-- stops for everyone until it is run.
--
-- When the column is first added, only the American Plan Administrators
-- group is left ON - every other existing group is switched OFF, so only
-- that group is recorded until a Super Admin ticks another one.
-- Re-running this file changes nothing - it never re-unticks a group
-- that was ticked afterwards.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_groups'
                     AND COLUMN_NAME = 'recording_enabled');

SET @sql = IF(@col_exists = 0,
  'ALTER TABLE agent_groups ADD COLUMN recording_enabled BOOLEAN NOT NULL DEFAULT TRUE',
  'SELECT ''agent_groups.recording_enabled already exists'' AS info');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE agent_groups
SET recording_enabled = FALSE
WHERE @col_exists = 0
  AND LOWER(TRIM(group_name)) <> 'american plan administrators';

-- Check: every group and whether it's recorded.
SELECT group_id, group_name, recording_enabled FROM agent_groups ORDER BY group_name;
