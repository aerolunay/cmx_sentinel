-- Run against your existing database. One-off repair.
--
-- Aux segments that overlap a later login of the same agent: a login
-- that was never logged out (e.g. the app restarted and started a new
-- login on the same PC) stayed open, and was later closed at the
-- biometric Check-Out or the shift end. The new login's first segment
-- was backdated to the end of the last CLOSED segment (resumeFrom), so
-- both covered the same time and it counted twice (Total Hours over the
-- schedule, Adherence over 100%). The backend now ends the old login
-- when the new one starts, and starts the new one then
-- (routes/desktopSyncRoutes.js /aux-events/open) - this fixes the ones
-- recorded before that.
--
-- For each overlap: the switch is when the new login really started -
-- its first segment's arrival, taken from the rows inserted just before
-- it (event_id order; a backdated start is earlier than its arrival).
-- The old login's segment ends there and the new login's first segment
-- starts there. If the overlapping row isn't a new login's first segment,
-- the old one just ends where it starts.
--
-- Only *_est columns are compared; *_utc columns move by the same
-- amount (they're in the server's time zone on production, not UTC).
--
-- Run it all in ONE session: step 1, check the preview, then step 2.
-- Safe to re-run.

USE cmx_sentinel;

-- ---------------------------------------------------------------------
-- Step 1 - find them and preview
-- ---------------------------------------------------------------------

DROP TEMPORARY TABLE IF EXISTS overlap_fix;

CREATE TEMPORARY TABLE overlap_fix AS
SELECT p.old_id, p.new_id,
       GREATEST(x.started_at_est,
         CASE WHEN NOT EXISTS (SELECT 1 FROM aux_events s
                               WHERE s.login_session_id = n.login_session_id
                                 AND s.started_at_est < n.started_at_est)
              THEN LEAST(x.ended_at_est, COALESCE(n.ended_at_est, x.ended_at_est),
                     GREATEST(n.started_at_est,
                       COALESCE((SELECT MAX(q.started_at_est) FROM aux_events q
                                 WHERE q.event_id BETWEEN n.event_id - 5 AND n.event_id - 1),
                                n.started_at_est)))
              ELSE n.started_at_est
         END) AS switch_est
FROM (
  SELECT x.event_id AS old_id,
         (SELECT n.event_id FROM aux_events n
          WHERE n.agent_id = x.agent_id
            AND n.login_session_id <> x.login_session_id
            AND (n.started_at_est > x.started_at_est
                 OR (n.started_at_est = x.started_at_est AND n.event_id > x.event_id))
            AND n.started_at_est < x.ended_at_est
          ORDER BY n.started_at_est, n.event_id
          LIMIT 1) AS new_id
  FROM aux_events x
  WHERE x.started_at_est >= '2026-10-01' AND x.ended_at_est IS NOT NULL
) p
JOIN aux_events x ON x.event_id = p.old_id
JOIN aux_events n ON n.event_id = p.new_id;

-- Preview: old login's segment now ends at switch_est; new login's
-- first segment now starts there (if it started earlier).
SELECT a.display_name, x.agent_id,
       x.event_id AS old_event, x.aux_code AS old_aux, x.started_at_est AS old_start,
       x.ended_at_est AS old_end, f.switch_est AS old_new_end,
       n.event_id AS new_event, n.aux_code AS new_aux, n.started_at_est AS new_start,
       GREATEST(n.started_at_est, f.switch_est) AS new_new_start, n.ended_at_est AS new_end,
       SEC_TO_TIME(TIMESTAMPDIFF(SECOND, f.switch_est, x.ended_at_est)
                 + GREATEST(0, TIMESTAMPDIFF(SECOND, n.started_at_est, f.switch_est))) AS double_counted_removed,
       x.logout_trigger AS old_logout_trigger
FROM overlap_fix f
JOIN aux_events x ON x.event_id = f.old_id
JOIN aux_events n ON n.event_id = f.new_id
LEFT JOIN agents a ON a.agent_id = x.agent_id
ORDER BY x.started_at_est;

SELECT COUNT(*) AS overlaps_to_fix FROM overlap_fix;

-- ---------------------------------------------------------------------
-- Step 2 - apply (only after checking the preview above)
-- ---------------------------------------------------------------------

START TRANSACTION;

-- Old login: ends at the switch.
UPDATE aux_events x
JOIN overlap_fix f ON f.old_id = x.event_id
SET x.ended_at_utc = DATE_ADD(x.started_at_utc,
        INTERVAL TIMESTAMPDIFF(MICROSECOND, x.started_at_est, f.switch_est) MICROSECOND),
    x.ended_at_est = f.switch_est,
    x.duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, x.started_at_est, f.switch_est))
WHERE x.ended_at_est > f.switch_est;

-- New login's first segment: starts at the switch (started_at_utc is
-- set first, from the old started_at_est).
UPDATE aux_events n
JOIN overlap_fix f ON f.new_id = n.event_id
SET n.started_at_utc = DATE_ADD(n.started_at_utc,
        INTERVAL TIMESTAMPDIFF(MICROSECOND, n.started_at_est, f.switch_est) MICROSECOND),
    n.started_at_est = f.switch_est,
    n.duration_seconds = IF(n.ended_at_est IS NULL, NULL,
        GREATEST(0, TIMESTAMPDIFF(SECOND, f.switch_est, n.ended_at_est)))
WHERE n.started_at_est < f.switch_est;

COMMIT;

DROP TEMPORARY TABLE overlap_fix;
