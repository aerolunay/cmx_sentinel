-- Run against your existing database.

-- Per-agent access to the desktop's Admin aux (desktop 2.4.13+), set with
-- the "Admin Aux" checkbox on the Agents page. The desktop asks
-- /api/desktop-sync/auth/verify at each login; agents without it get a
-- disabled Admin button.
--
-- Unchecked by default. When the column is first added it is checked for
-- the agents who already had Admin under 2.4.13's group rule: the
-- Supervisors, Training and Quality (TQA) and RRT groups, and agents who
-- are also active web users. Re-running this file changes nothing - it
-- never re-checks someone who was unchecked afterwards.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents'
                     AND COLUMN_NAME = 'admin_aux_allowed');

SET @sql = IF(@col_exists = 0,
  'ALTER TABLE agents ADD COLUMN admin_aux_allowed BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT ''agents.admin_aux_allowed already exists'' AS info');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE agents a
LEFT JOIN agent_groups g ON g.group_id = a.group_id
SET a.admin_aux_allowed = TRUE
WHERE @col_exists = 0
  AND (
    LOWER(COALESCE(g.group_name, '')) LIKE '%supervisor%'
    OR LOWER(COALESCE(g.group_name, '')) REGEXP '(^|[^a-z])(rrt|tqa)([^a-z]|$)'
    OR LOWER(COALESCE(g.group_name, '')) REGEXP 'training[[:space:]]*(and|&)[[:space:]]*quality'
    OR EXISTS (SELECT 1 FROM web_users u
               WHERE u.is_active = TRUE
                 AND ((a.email IS NOT NULL AND a.email <> '' AND LOWER(u.email) = LOWER(a.email))
                      OR u.login_identifier = a.agent_id))
  );

-- Check: who has Admin aux now.
SELECT a.agent_id, a.display_name, g.group_name
FROM agents a LEFT JOIN agent_groups g ON g.group_id = a.group_id
WHERE a.admin_aux_allowed = TRUE
ORDER BY g.group_name, a.display_name;
