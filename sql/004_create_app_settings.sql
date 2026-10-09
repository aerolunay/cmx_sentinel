-- Small key/value table for settings admins can change from the web app
-- without editing backend/.env and restarting. First user: the
-- Violations page's "Email alerts" toggle (setting_key
-- 'violation_alert_emails', value 'true' / 'false').
--
-- Until a key has a row here, the backend falls back to its .env
-- default (for violation alerts: VIOLATION_ALERT_EMAILS, on unless set
-- to "false") - so running this migration changes nothing by itself.

CREATE TABLE IF NOT EXISTS app_settings (
    setting_key         VARCHAR(64)  NOT NULL PRIMARY KEY,
    setting_value       VARCHAR(255) NOT NULL,
    updated_by_user_id  INT          NULL,
    updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
