-- Run against your existing database. One-off data repair, safe to
-- re-run (it only touches rows that are still open). Run the whole file
-- in one go (MySQL Workbench: Execute All) - the temporary table only
-- exists on the connection that created it.

-- Some aux_events rows were never closed: the desktop app moved on to
-- the next aux code (a new row in the same login) but its request to
-- close the previous row didn't reach the server. Those rows stay open,
-- so their time is dropped from the reports and the live view could
-- show the agent as still logged in. desktopSyncRoutes.js now closes
-- them automatically when the next segment opens; this repairs the ones
-- already in the table the same way: each open row ends where the next
-- segment of the same login session starts.
--
-- Only when that next segment started within 12 hours. In production
-- (Oct 2026) the gaps split cleanly: 52 rows under 10 h (lost closes
-- within a shift) and 38 rows of 15 h to 8 days (the app was shut down
-- and the same login resumed the next day or later). Closing those at
-- the next segment would credit days of time nobody worked, so they're
-- left open - which keeps them out of the reports, as now. Rows with no
-- later segment in their session are left alone too.

-- 1. Preview: what will be closed, and how much time it adds back.
SELECT o.event_id, o.agent_id, o.machine_name, o.aux_code, o.started_at_est,
       n.next_est AS new_ended_at_est,
       SEC_TO_TIME(TIMESTAMPDIFF(SECOND, o.started_at_utc, n.next_utc)) AS time_added_back
FROM aux_events o
JOIN (
  SELECT o2.event_id,
         (SELECT MIN(x.started_at_utc) FROM aux_events x
          WHERE x.agent_id = o2.agent_id AND x.login_session_id = o2.login_session_id
            AND x.started_at_utc > o2.started_at_utc) AS next_utc,
         (SELECT MIN(x.started_at_est) FROM aux_events x
          WHERE x.agent_id = o2.agent_id AND x.login_session_id = o2.login_session_id
            AND x.started_at_utc > o2.started_at_utc) AS next_est
  FROM aux_events o2
  WHERE o2.ended_at_utc IS NULL
) n ON n.event_id = o.event_id
WHERE n.next_utc IS NOT NULL
  AND n.next_utc <= o.started_at_utc + INTERVAL 12 HOUR
ORDER BY o.agent_id, o.started_at_utc;

-- 2. Repair. The next-segment times go into a temporary table first -
-- MySQL won't UPDATE aux_events while reading it in a subquery.
SET SQL_SAFE_UPDATES = 0;

DROP TEMPORARY TABLE IF EXISTS orphan_fix;
CREATE TEMPORARY TABLE orphan_fix AS
SELECT o.event_id, o.started_at_utc,
       (SELECT MIN(n.started_at_utc) FROM aux_events n
        WHERE n.agent_id = o.agent_id AND n.login_session_id = o.login_session_id
          AND n.started_at_utc > o.started_at_utc) AS next_utc,
       (SELECT MIN(n.started_at_est) FROM aux_events n
        WHERE n.agent_id = o.agent_id AND n.login_session_id = o.login_session_id
          AND n.started_at_utc > o.started_at_utc) AS next_est
FROM aux_events o
WHERE o.ended_at_utc IS NULL;

START TRANSACTION;

UPDATE aux_events ae
JOIN orphan_fix f ON f.event_id = ae.event_id
SET ae.ended_at_utc = f.next_utc,
    ae.ended_at_est = f.next_est,
    ae.duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, ae.started_at_utc, f.next_utc))
WHERE f.next_utc IS NOT NULL
  AND f.next_utc <= f.started_at_utc + INTERVAL 12 HOUR
  AND ae.ended_at_utc IS NULL;

SELECT ROW_COUNT() AS rows_closed;   -- should equal the number of rows in the preview

COMMIT;

DROP TEMPORARY TABLE orphan_fix;
SET SQL_SAFE_UPDATES = 1;
