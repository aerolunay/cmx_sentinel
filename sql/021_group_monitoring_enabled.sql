-- Run against your existing database.

-- Per-group live monitoring (desktop 2.4.16+), set with the "Enable
-- monitoring" checkbox when adding or editing a group on the Groups &
-- Restrictions page. Only agents in a group with it on are listed on the
-- Monitor page and can be watched live (screen + PC audio). Agents with
-- no group can't be. Independent of recording: a group with recordings
-- off can still be monitored - nothing is saved on the PC or in S3.
--
-- Every group starts ON (the column default) - untick a group to stop it.
-- Re-running this file changes nothing.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_groups'
                     AND COLUMN_NAME = 'monitoring_enabled');

SET @sql = IF(@col_exists = 0,
  'ALTER TABLE agent_groups ADD COLUMN monitoring_enabled BOOLEAN NOT NULL DEFAULT TRUE',
  'SELECT ''agent_groups.monitoring_enabled already exists'' AS info');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Starting live monitoring is written to the audit log as 'monitored'.
-- Re-running this is harmless.
ALTER TABLE audit_log
  MODIFY action ENUM('created','updated','deleted','copied','bulk_upload','monitored') NOT NULL;

-- Check: every group and its switches.
SELECT group_id, group_name, recording_enabled, monitoring_enabled FROM agent_groups ORDER BY group_name;
