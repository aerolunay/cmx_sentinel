-- Run against your existing database. One-off repair.
--
-- Aux segments that overlap a later segment of the same agent: a login
-- that was never logged out (e.g. the app restarted and started a new
-- login on the same PC) stayed open, and was later closed at the
-- biometric Check-Out or the shift end - so its time counted twice,
-- alongside the new login's (Total Hours over the schedule, Adherence
-- over 100%). The backend now ends such a row where the next login
-- starts (routes/desktopSyncRoutes.js /aux-events/open,
-- services/biometrics.js closeAtCheckOut) - this fixes the ones
-- recorded before that.
--
-- Each overlapping row is ended where the agent's next segment starts.
-- Only *_est columns are compared; ended_at_utc moves from the row's own
-- start by the same amount (the *_utc columns are in the server's time
-- zone on production, not UTC).
--
-- Run it all in ONE session: step 1, check the preview, then step 2.
-- Safe to re-run.

USE cmx_sentinel;

-- ---------------------------------------------------------------------
-- Step 1 - find them and preview
-- ---------------------------------------------------------------------

DROP TEMPORARY TABLE IF EXISTS overlap_fix;

CREATE TEMPORARY TABLE overlap_fix AS
SELECT ae.event_id, ae.agent_id,
       (SELECT MIN(n.started_at_est) FROM aux_events n
        WHERE n.agent_id = ae.agent_id
          AND (n.started_at_est > ae.started_at_est
               OR (n.started_at_est = ae.started_at_est AND n.event_id > ae.event_id))) AS next_start_est
FROM aux_events ae
WHERE ae.started_at_est >= '2026-10-01' AND ae.ended_at_est IS NOT NULL;

DELETE FROM overlap_fix WHERE next_start_est IS NULL;
DELETE f FROM overlap_fix f JOIN aux_events ae ON ae.event_id = f.event_id
WHERE f.next_start_est >= ae.ended_at_est;

-- Preview: ended_at_est -> new_ended_at_est, and the time no longer double-counted.
SELECT a.display_name, ae.agent_id, ae.event_id, ae.login_session_id, ae.aux_code,
       ae.started_at_est, ae.ended_at_est, f.next_start_est AS new_ended_at_est,
       SEC_TO_TIME(TIMESTAMPDIFF(SECOND, f.next_start_est, ae.ended_at_est)) AS removed,
       ae.logout_trigger
FROM overlap_fix f
JOIN aux_events ae ON ae.event_id = f.event_id
LEFT JOIN agents a ON a.agent_id = ae.agent_id
ORDER BY ae.started_at_est;

SELECT COUNT(*) AS segments_to_fix FROM overlap_fix;

-- ---------------------------------------------------------------------
-- Step 2 - apply (only after checking the preview above)
-- ---------------------------------------------------------------------

START TRANSACTION;

UPDATE aux_events ae
JOIN overlap_fix f ON f.event_id = ae.event_id
SET ae.ended_at_utc = DATE_ADD(ae.started_at_utc,
        INTERVAL TIMESTAMPDIFF(MICROSECOND, ae.started_at_est, GREATEST(ae.started_at_est, f.next_start_est)) MICROSECOND),
    ae.ended_at_est = GREATEST(ae.started_at_est, f.next_start_est),
    ae.duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, ae.started_at_est, f.next_start_est))
WHERE ae.ended_at_est > f.next_start_est;

COMMIT;

DROP TEMPORARY TABLE overlap_fix;
