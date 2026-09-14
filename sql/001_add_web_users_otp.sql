-- Run against your existing database.

-- Replaces the earlier admin_users table (password-based, Stage 1) -
-- the web app now uses OTP-over-email instead of passwords entirely.
-- If admin_users was already created, drop it first:
--   DROP TABLE IF EXISTS admin_users;
CREATE TABLE IF NOT EXISTS web_users (
    user_id          INT AUTO_INCREMENT PRIMARY KEY,
    role             ENUM('admin','tqa','supervisor','manager') NOT NULL,
    -- What the user actually TYPES to identify themselves at login -
    -- numeric Employee ID for admins, email address for everyone else.
    -- Looked up directly (role-agnostic) so the login form doesn't need
    -- to ask "which role are you" - whoever matches, matches.
    login_identifier VARCHAR(128) NOT NULL UNIQUE,
    -- Where the OTP actually gets emailed - same as login_identifier
    -- for non-admins (who log in WITH their email), but a SEPARATE
    -- field for admins (who log in with Employee ID, not email).
    email            VARCHAR(255) NOT NULL,
    display_name     VARCHAR(128) NOT NULL,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Short-lived, single-use OTP codes. Stored in the DB (not just in
-- memory) so a backend restart mid-login doesn't strand someone who
-- already received a code - consistent with how this whole project
-- prefers durable state over in-memory-only where it's cheap to do so.
CREATE TABLE IF NOT EXISTS otp_codes (
    otp_id      BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    code        CHAR(6) NOT NULL,
    expires_at  DATETIME NOT NULL,
    used_at     DATETIME NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES web_users(user_id) ON DELETE CASCADE,
    INDEX idx_user_active (user_id, used_at, expires_at)
) ENGINE=InnoDB;

-- New agents (created via the future Agents management page) get this
-- TRUE by default, so the DESKTOP APP can enforce a forced password
-- reset on first login. Enforcement UI/flow on the desktop side is
-- being built LATER - this column just needs to exist now so the web
-- app's agent-creation flow can set it correctly from day one.
ALTER TABLE agents
    ADD COLUMN must_reset_password BOOLEAN NOT NULL DEFAULT TRUE;

GRANT SELECT, INSERT, UPDATE, DELETE ON cmx_sentinel.web_users TO 'cmx_admin'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON cmx_sentinel.otp_codes TO 'cmx_admin'@'%';
FLUSH PRIVILEGES;

-- Bootstrapping the first admin account (same chicken-and-egg problem
-- as before - no UI yet to create the very first one):
-- INSERT INTO web_users (role, login_identifier, email, display_name)
-- VALUES ('admin', '7001340', 'you@yourcompany.com', 'Your Name');
