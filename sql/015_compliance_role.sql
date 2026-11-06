-- Run against your existing database.

-- New web user role 'compliance' ("Compliance"): sees every agent (no
-- group scoping) - Dashboard, Violations, Recordings, Reports (with the
-- Clinic Visits tab, read-only like Manager) and Audit Log - plus
-- read-only Users, Agents, Groups & Restrictions and Shift Scheduler.
-- Gets every agent's inactivity alert email (desktopSyncRoutes.js).
--
-- web_users.role is an ENUM that has been extended since 001, so the
-- value is appended to whatever the column has now, not retyped.
SET @role_type = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'web_users' AND COLUMN_NAME = 'role');
SET @sql = IF(
  @role_type LIKE 'enum(%' AND @role_type NOT LIKE '%''compliance''%',
  CONCAT('ALTER TABLE web_users MODIFY role ', LEFT(@role_type, CHAR_LENGTH(@role_type) - 1), ',''compliance'') NOT NULL'),
  'SELECT ''web_users.role already allows compliance (or is not an ENUM)'' AS info');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
