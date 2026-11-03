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

-- The admin backend's account reads the punches. Match the host part to
-- however 'cmx_admin' is defined here (SELECT user, host FROM mysql.user).
GRANT SELECT ON ph_timekeeping.device_attendance_logs TO 'cmx_admin'@'%';
