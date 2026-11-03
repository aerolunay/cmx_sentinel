-- Run against your existing database.

-- Shifts now start and end with the office biometric punches (see
-- backend/services/biometrics.js), read from the timekeeping app's
-- ph_timekeeping.device_attendance_logs on this same MySQL server.

-- Free-text reason on the row that ends a login, next to the short
-- logout_trigger code - e.g. trigger 'overstayed' with note
-- 'Automatic Logout - Overstayed - No Biometrics Logout' when the agent
-- never punched out and the server closed the login at the scheduled
-- shift end 18 hours after the Check-In.
ALTER TABLE aux_events
    ADD COLUMN logout_note VARCHAR(255) NULL AFTER logout_trigger;

-- The admin backend's account (DB_USER in backend/.env - 'admin',
-- connecting to 127.0.0.1) reads the punches. Skip this if
-- SHOW GRANTS FOR 'admin'@'127.0.0.1' already shows SELECT or ALL
-- PRIVILEGES ON *.*. Both hosts, since MySQL may match a 127.0.0.1
-- connection to either entry.
GRANT SELECT ON ph_timekeeping.device_attendance_logs TO 'admin'@'127.0.0.1';
GRANT SELECT ON ph_timekeeping.device_attendance_logs TO 'admin'@'localhost';
