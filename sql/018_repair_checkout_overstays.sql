-- Run against your existing database. One-off repair - SQL version of
-- backend/scripts/repairCheckOutOverstays.js (use one or the other).
--
-- "Overstayed (14h)" violations recorded for agents who DID punch
-- biometric Check-Out: the PC was shut down before the punch, so the
-- desktop never saw it, and the hourly job closed the login 14 hours
-- after it started, at the scheduled end. The backend now ends such
-- logins at the Check-Out (services/biometrics.js) - this fixes the ones
-- recorded before that.
--
-- For each overstay violation of an onsite login with a Check-Out after
-- the segment started and before the violation was detected: the
-- segment is ended at that Check-Out (logout_trigger 'biometric', as the
-- desktop records it) and the violation (auto_logouts row) is deleted.
-- Violations with no Check-Out are left alone.
--
-- Times are compared in Eastern: aux_events' *_est columns, and
-- punched_at (real UTC) converted with US daylight saving for 2026. The
-- *_utc columns are NOT UTC on production - they're written in the
-- server's time zone (Manila) - so they're only ever moved by the same
-- amount as the matching *_est column, never compared with punched_at.
-- (The first version of this script compared them directly and searched
-- 8 hours too late - step 0 shows anything it changed.)
--
-- Needs sql/010 (work_setup) and sql/017 (biometric_punches). Run it all
-- in ONE session (the temporary tables only exist there): steps 0-1,
-- check the previews, then step 2. Safe to re-run.

USE cmx_sentinel;

DROP TEMPORARY TABLE IF EXISTS punches_est;
CREATE TEMPORARY TABLE punches_est (
  device_user VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  state TINYINT NOT NULL,
  punched_est DATETIME(3) NOT NULL,
  KEY (device_user, state, punched_est)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci AS
SELECT device_user COLLATE utf8mb4_unicode_ci AS device_user, state,
       DATE_SUB(punched_at, INTERVAL IF(punched_at >= '2026-03-08 07:00:00' AND punched_at < '2026-11-01 06:00:00', 4, 5) HOUR) AS punched_est
FROM ph_timekeeping.device_attendance_logs
WHERE punched_at >= '2026-10-01' AND state IN (0, 1)
UNION
SELECT device_user COLLATE utf8mb4_unicode_ci, state,
       DATE_SUB(punched_at, INTERVAL IF(punched_at >= '2026-03-08 07:00:00' AND punched_at < '2026-11-01 06:00:00', 4, 5) HOUR)
FROM biometric_punches
WHERE punched_at >= '2026-10-01' AND state IN (0, 1);

-- ---------------------------------------------------------------------
-- Step 0 - rows the FIRST version of this script changed (read-only).
-- It ended them 8 hours before the Check-Out it matched. Should be empty;
-- if not, send this list before going further.
-- ---------------------------------------------------------------------

SELECT a.display_name, ae.agent_id, ae.event_id, ae.aux_code, ae.started_at_est, ae.ended_at_est,
       DATE_ADD(ae.ended_at_est, INTERVAL 8 HOUR) AS matched_check_out_est
FROM aux_events ae
LEFT JOIN agents a ON a.agent_id = ae.agent_id
WHERE ae.logout_trigger = 'biometric' AND ae.started_at_est >= '2026-10-01'
  AND EXISTS (SELECT 1 FROM punches_est p
              WHERE p.device_user = ae.agent_id AND p.state = 1
                AND p.punched_est = DATE_ADD(ae.ended_at_est, INTERVAL 8 HOUR));

-- ---------------------------------------------------------------------
-- Step 1 - find them and preview
-- ---------------------------------------------------------------------

DROP TEMPORARY TABLE IF EXISTS checkout_overstay_fix;

CREATE TEMPORARY TABLE checkout_overstay_fix AS
SELECT al.auto_logout_id, al.event_id, al.agent_id,
       (SELECT MIN(p.punched_est) FROM punches_est p
        WHERE p.device_user = al.agent_id AND p.state = 1
          AND p.punched_est > ae.started_at_est
          AND p.punched_est <= al.detected_at_est) AS check_out_est
FROM auto_logouts al
JOIN aux_events ae ON ae.event_id = al.event_id
WHERE ae.logout_trigger = 'overstayed'
  AND (ae.work_setup IS NULL OR ae.work_setup <> 'remote');

DELETE FROM checkout_overstay_fix WHERE check_out_est IS NULL;

-- Preview: what will change. closed_as_overstay_est -> check_out_est.
SELECT a.display_name, f.agent_id, DATE_FORMAT(al.shift_date, '%Y-%m-%d') AS shift_date, al.aux_code,
       ae.started_at_est AS segment_started_est,
       ae.ended_at_est AS closed_as_overstay_est,
       f.check_out_est
FROM checkout_overstay_fix f
JOIN auto_logouts al ON al.auto_logout_id = f.auto_logout_id
JOIN aux_events ae ON ae.event_id = f.event_id
LEFT JOIN agents a ON a.agent_id = f.agent_id
ORDER BY al.shift_date, a.display_name;

SELECT COUNT(*) AS violations_to_remove FROM checkout_overstay_fix;

-- ---------------------------------------------------------------------
-- Step 2 - apply (only after checking the previews above)
-- ---------------------------------------------------------------------

START TRANSACTION;

-- ended_at_utc moves by the same amount as ended_at_est, from the row's
-- own start - whatever time zone the *_utc columns are in.
UPDATE aux_events ae
JOIN checkout_overstay_fix f ON f.event_id = ae.event_id
SET ae.ended_at_utc = DATE_ADD(ae.started_at_utc,
        INTERVAL TIMESTAMPDIFF(MICROSECOND, ae.started_at_est, GREATEST(ae.started_at_est, f.check_out_est)) MICROSECOND),
    ae.ended_at_est = GREATEST(ae.started_at_est, f.check_out_est),
    ae.duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, ae.started_at_est, f.check_out_est)),
    ae.logout_trigger = 'biometric',
    ae.logout_note = NULL
WHERE ae.logout_trigger = 'overstayed';

DELETE al FROM auto_logouts al
JOIN checkout_overstay_fix f ON f.auto_logout_id = al.auto_logout_id;

COMMIT;

-- Check: should return 0.
SELECT COUNT(*) AS remaining
FROM auto_logouts al JOIN checkout_overstay_fix f ON f.auto_logout_id = al.auto_logout_id;

DROP TEMPORARY TABLE checkout_overstay_fix;
DROP TEMPORARY TABLE punches_est;
