-- Read-only check: is each Utilization Violation legitimate? Changes nothing.
--
-- One row per violation in the date range, with the agent's biometric
-- punches (CMX Pulse + biometric_punches, Eastern time, IN/OUT/other
-- states) from 3 hours before the login to 12 hours after the violation
-- was detected, and a verdict:
--   FALSE - Check-Out after last aux   punched out after the last aux
--                                      started - should not be a violation
--                                      (sql/018 removes these)
--   Check-Out before last aux          punched out, but the PC kept a
--                                      session going after it
--   Check-Out before login             last Check-Out came before this
--                                      login - none for this shift
--   LEGIT - no Check-Out               Check-In(s) only
--   No punches synced                  nothing from the devices at all
--
-- Everything is compared in Eastern time: aux_events' *_est columns, and
-- punched_at (real UTC) converted with US daylight saving for 2026. The
-- *_utc columns can't be compared with punched_at: they're written in the
-- server's own time zone (Manila on production), not UTC.
--
-- Set the date range below (shift dates, inclusive; 2026 only - the
-- daylight-saving dates are for 2026).

USE cmx_sentinel;

SET @from_date = '2026-11-04', @to_date = '2026-11-10';

SELECT x.display_name, x.agent_id, x.shift_date, x.reason, x.work_setup, x.logout_note, x.machine_name,
       x.login_started_est, x.last_aux_started_est, x.scheduled_end_est, x.detected_at_est,
       x.out_after_aux AS check_out_after_aux_est,
       x.out_during_login AS check_out_during_login_est,
       CASE
         WHEN x.out_after_aux IS NOT NULL THEN 'FALSE - Check-Out after last aux'
         WHEN x.out_during_login IS NOT NULL THEN 'Check-Out before last aux'
         WHEN x.punches IS NULL THEN 'No punches synced'
         WHEN x.punches LIKE '%OUT%' THEN 'Check-Out before login'
         ELSE 'LEGIT - no Check-Out'
       END AS verdict,
       x.punches
FROM (
  SELECT v.*,
         (SELECT MIN(p.punched_est) FROM (
             SELECT device_user COLLATE utf8mb4_unicode_ci AS device_user, state,
                    DATE_SUB(punched_at, INTERVAL IF(punched_at >= '2026-03-08 07:00:00' AND punched_at < '2026-11-01 06:00:00', 4, 5) HOUR) AS punched_est
             FROM ph_timekeeping.device_attendance_logs
             UNION ALL
             SELECT device_user COLLATE utf8mb4_unicode_ci, state,
                    DATE_SUB(punched_at, INTERVAL IF(punched_at >= '2026-03-08 07:00:00' AND punched_at < '2026-11-01 06:00:00', 4, 5) HOUR)
             FROM biometric_punches) p
          WHERE p.device_user = v.agent_id AND p.state = 1
            AND p.punched_est > v.last_aux_started_est AND p.punched_est <= v.detected_at_est) AS out_after_aux,
         (SELECT MIN(p.punched_est) FROM (
             SELECT device_user COLLATE utf8mb4_unicode_ci AS device_user, state,
                    DATE_SUB(punched_at, INTERVAL IF(punched_at >= '2026-03-08 07:00:00' AND punched_at < '2026-11-01 06:00:00', 4, 5) HOUR) AS punched_est
             FROM ph_timekeeping.device_attendance_logs
             UNION ALL
             SELECT device_user COLLATE utf8mb4_unicode_ci, state,
                    DATE_SUB(punched_at, INTERVAL IF(punched_at >= '2026-03-08 07:00:00' AND punched_at < '2026-11-01 06:00:00', 4, 5) HOUR)
             FROM biometric_punches) p
          WHERE p.device_user = v.agent_id AND p.state = 1
            AND p.punched_est > v.login_started_est AND p.punched_est <= v.last_aux_started_est) AS out_during_login,
         (SELECT GROUP_CONCAT(DISTINCT CONCAT(DATE_FORMAT(p.punched_est, '%m-%d %H:%i'), ' ',
                     CASE p.state WHEN 0 THEN 'IN' WHEN 1 THEN 'OUT' ELSE CONCAT('state', p.state) END)
                 ORDER BY p.punched_est SEPARATOR ', ')
          FROM (
             SELECT device_user COLLATE utf8mb4_unicode_ci AS device_user, state,
                    DATE_SUB(punched_at, INTERVAL IF(punched_at >= '2026-03-08 07:00:00' AND punched_at < '2026-11-01 06:00:00', 4, 5) HOUR) AS punched_est
             FROM ph_timekeeping.device_attendance_logs
             UNION ALL
             SELECT device_user COLLATE utf8mb4_unicode_ci, state,
                    DATE_SUB(punched_at, INTERVAL IF(punched_at >= '2026-03-08 07:00:00' AND punched_at < '2026-11-01 06:00:00', 4, 5) HOUR)
             FROM biometric_punches) p
          WHERE p.device_user = v.agent_id
            AND p.punched_est BETWEEN v.login_started_est - INTERVAL 3 HOUR AND v.detected_at_est + INTERVAL 12 HOUR) AS punches
  FROM (
    SELECT a.display_name, al.agent_id, DATE_FORMAT(al.shift_date, '%Y-%m-%d') AS shift_date, al.reason, al.machine_name,
           al.scheduled_end_est, al.detected_at_est, ae.work_setup, ae.logout_note,
           ae.started_at_est AS last_aux_started_est,
           (SELECT MIN(s.started_at_est) FROM aux_events s WHERE s.login_session_id = al.login_session_id) AS login_started_est
    FROM auto_logouts al
    JOIN aux_events ae ON ae.event_id = al.event_id
    LEFT JOIN agents a ON a.agent_id = al.agent_id
    WHERE al.shift_date BETWEEN @from_date AND @to_date
  ) v
) x
ORDER BY x.shift_date DESC, x.display_name;
