-- Run against your existing database.

-- Why the server logged an agent out (Utilization Violations report):
--   'overstayed'    no logout 14 hours after the time in - closed at the
--                   scheduled end
--   'double_login'  a second biometric Check-In 4 to 14 hours after the
--                   first, with no Check-Out (In pressed instead of Out) -
--                   closed at the scheduled end or that second In,
--                   whichever is earlier
--   'no_logout'     no Check-Out, then a Check-In at the next scheduled
--                   shift (forgot to log out) - closed at the scheduled
--                   end or that In, whichever is earlier
--   NULL           rows from before this column; the report shows them
--                   as "No logout"
-- Adds an empty column only (backend/services/biometrics.js fills it).
-- The backend checks for it, so it can be deployed before or after this.
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_logouts' AND COLUMN_NAME = 'reason') = 0,
  'ALTER TABLE auto_logouts ADD COLUMN reason VARCHAR(16) NULL AFTER app_running',
  'SELECT ''reason already exists'' AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Check: should return 1.
SELECT COUNT(*) AS reason_column FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_logouts' AND COLUMN_NAME = 'reason';
