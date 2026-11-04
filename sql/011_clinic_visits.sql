-- Run against your existing database.

-- 1. New web user role 'clinic' ("Med / Clinic"): only sees the Clinic
--    Visits page. web_users.role is an ENUM that has been extended since
--    sql/001 (super_admin etc.), so 'clinic' is appended to whatever it
--    is on this server rather than rewriting the list. Safe to run twice.
SET @role_type = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'web_users' AND COLUMN_NAME = 'role');
SET @sql = IF(
  @role_type LIKE 'enum(%' AND @role_type NOT LIKE '%''clinic''%',
  CONCAT('ALTER TABLE web_users MODIFY role ', LEFT(@role_type, CHAR_LENGTH(@role_type) - 1), ',''clinic'') NOT NULL'),
  'SELECT ''web_users.role already allows clinic (or is not an ENUM)'' AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. One row per clinic visit, entered by a Med / Clinic user
--    (backend/routes/clinicRoutes.js). Dates and times are the clinic's
--    own wall clock (Philippine time), as entered. employee_id is usually
--    an agents.agent_id but isn't a foreign key - non-agent staff visit
--    the clinic too. seen_by_* is the web user who recorded the visit.
CREATE TABLE IF NOT EXISTS clinic_visits (
    visit_id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    visit_date       DATE NOT NULL,
    employee_id      VARCHAR(32) NOT NULL,
    employee_name    VARCHAR(255) NOT NULL,
    time_of_visit    TIME NOT NULL,
    chief_complaint  VARCHAR(1000) NOT NULL,
    treatment        VARCHAR(1000) NULL,
    time_released    TIME NULL,
    seen_by_user_id  INT NULL,
    seen_by_name     VARCHAR(255) NOT NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_visit_date (visit_date),
    KEY idx_employee (employee_id, visit_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
