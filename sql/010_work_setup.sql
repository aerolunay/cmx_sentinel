-- Run against your existing database.

-- Whether each aux segment was recorded onsite (from an office IP in
-- OFFICE_PUBLIC_IPS) or remote, so the dashboard's Onsite/Remote filter
-- works for historical dates too (backend/services/workSetup.js). Set by
-- the server from the desktop's IP when the segment opens. Adds an empty
-- column only - existing rows stay NULL, which reports count as onsite.
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aux_events' AND COLUMN_NAME = 'work_setup') = 0,
  'ALTER TABLE aux_events ADD COLUMN work_setup VARCHAR(8) NULL AFTER machine_name',
  'SELECT ''work_setup already exists'' AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
