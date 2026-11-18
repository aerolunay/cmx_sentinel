-- Run against your existing database. One-off repair.
--
-- Aux segments that overlap a later login of the same agent: a login
-- that was never logged out (e.g. the app restarted, or the PC was shut
-- down) stayed open, and was closed later - at the Check-Out, the shift
-- end, or days later when the agent switched PCs. The new login's first
-- segment was backdated to the end of the last CLOSED segment
-- (resumeFrom), so both covered the same time and it counted twice
-- (Total Hours over the schedule, Adherence over 100%). The backend now
-- ends the old login when the new one starts, and starts the new one
-- then (routes/desktopSyncRoutes.js /aux-events/open) - this fixes the
-- ones recorded before that.
--
-- For each overlap, the switch is when the new login really started -
-- its first segment's arrival, taken from the rows inserted just before
-- it (event_id order; a backdated start is earlier than its arrival).
--   - Relogin within 12 hours of the old segment's start: the old
--     segment ends at the switch, the new login's first segment starts
--     there.
--   - Relogin 12+ hours later (left open overnight or for days): the old
--     segment ends at the scheduled end of the shift it started in, or
--     at its own start if no schedule covers it - never credited
--     overnight.
-- Then any segment still running past the start of the agent's next
-- segment ends there (overlaps within one login).
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
       -- When the new login really started
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
         END) AS switch_est,
       -- Scheduled end of the shift the old segment started in
       (SELECT MAX(sc.scheduled_end) FROM agent_schedules sc
        WHERE sc.agent_id = x.agent_id
          AND x.started_at_est >= sc.scheduled_start AND x.started_at_est < sc.scheduled_end) AS shift_end_est,
       CAST(NULL AS DATETIME) AS old_end_est
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

-- Where the old segment will end
UPDATE overlap_fix f
JOIN aux_events x ON x.event_id = f.old_id
SET f.old_end_est = IF(TIMESTAMPDIFF(SECOND, x.started_at_est, f.switch_est) < 12 * 3600,
                       f.switch_est,
                       GREATEST(x.started_at_est, LEAST(f.switch_est, COALESCE(f.shift_end_est, x.started_at_est))));

-- Preview: old segment old_end -> old_new_end; new login's first
-- segment new_start -> new_new_start.
SELECT a.display_name, x.agent_id,
       x.event_id AS old_event, x.aux_code AS old_aux, x.started_at_est AS old_start,
       x.ended_at_est AS old_end, f.old_end_est AS old_new_end,
       SEC_TO_TIME(TIMESTAMPDIFF(SECOND, f.old_end_est, x.ended_at_est)) AS old_time_removed,
       n.event_id AS new_event, n.aux_code AS new_aux, n.started_at_est AS new_start,
       GREATEST(n.started_at_est, f.switch_est) AS new_new_start, n.ended_at_est AS new_end,
       x.logout_trigger AS old_logout_trigger
FROM overlap_fix f
JOIN aux_events x ON x.event_id = f.old_id
JOIN aux_events n ON n.event_id = f.new_id
LEFT JOIN agents a ON a.agent_id = x.agent_id
ORDER BY x.started_at_est;

SELECT COUNT(*) AS overlaps_to_fix,
       SEC_TO_TIME(SUM(TIMESTAMPDIFF(SECOND, f.old_end_est, x.ended_at_est))) AS total_removed_from_old,
       SUM(TIMESTAMPDIFF(SECOND, x.started_at_est, f.switch_est) >= 12 * 3600) AS left_open_12h_plus
FROM overlap_fix f JOIN aux_events x ON x.event_id = f.old_id;

-- ---------------------------------------------------------------------
-- Step 2 - apply (only after checking the preview above)
-- ---------------------------------------------------------------------

START TRANSACTION;

-- Old segment: ends at old_end_est.
UPDATE aux_events x
JOIN overlap_fix f ON f.old_id = x.event_id
SET x.ended_at_utc = DATE_ADD(x.started_at_utc,
        INTERVAL TIMESTAMPDIFF(MICROSECOND, x.started_at_est, f.old_end_est) MICROSECOND),
    x.ended_at_est = f.old_end_est,
    x.duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, x.started_at_est, f.old_end_est))
WHERE x.ended_at_est > f.old_end_est;

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

-- Anything still running past the agent's next segment ends there.
DROP TEMPORARY TABLE IF EXISTS overlap_cap;
CREATE TEMPORARY TABLE overlap_cap AS
SELECT y.event_id, y.next_start_est
FROM (
  SELECT x.event_id, x.ended_at_est,
         (SELECT MIN(n.started_at_est) FROM aux_events n
          WHERE n.agent_id = x.agent_id
            AND (n.started_at_est > x.started_at_est
                 OR (n.started_at_est = x.started_at_est AND n.event_id > x.event_id))) AS next_start_est
  FROM aux_events x
  WHERE x.started_at_est >= '2026-10-01' AND x.ended_at_est IS NOT NULL
) y
WHERE y.next_start_est < y.ended_at_est;

UPDATE aux_events x
JOIN overlap_cap c ON c.event_id = x.event_id
SET x.ended_at_utc = DATE_ADD(x.started_at_utc,
        INTERVAL TIMESTAMPDIFF(MICROSECOND, x.started_at_est, GREATEST(x.started_at_est, c.next_start_est)) MICROSECOND),
    x.ended_at_est = GREATEST(x.started_at_est, c.next_start_est),
    x.duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, x.started_at_est, c.next_start_est));

COMMIT;

-- Check: should return 0 - no segment runs past the agent's next one.
SELECT COUNT(*) AS overlaps_left
FROM aux_events x
WHERE x.started_at_est >= '2026-10-01' AND x.ended_at_est IS NOT NULL
  AND EXISTS (SELECT 1 FROM aux_events n
              WHERE n.agent_id = x.agent_id AND n.event_id <> x.event_id
                AND (n.started_at_est > x.started_at_est
                     OR (n.started_at_est = x.started_at_est AND n.event_id > x.event_id))
                AND n.started_at_est < x.ended_at_est);

DROP TEMPORARY TABLE overlap_cap;
DROP TEMPORARY TABLE overlap_fix;
