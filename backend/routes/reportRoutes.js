"use strict";

const express = require("express");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { getScopedGroupIds } = require("../services/groupScope");
const { toEasternSqlString } = require("../services/easternTime");
const { DateTime } = require("luxon");

const router = express.Router();

// Reports are for ALL web roles (Admin, TQA, Supervisor, Manager) -
// same as Recordings, not admin-only.
router.use(requireAuth);

// Same codes that trigger screen/audio recording on the desktop app
// (see CaptureManager.cs / MiniPanelForm.cs), PLUS Meeting, Coaching
// and Training - "productive" here is broader than the recording
// trigger set, by explicit request.
const PRODUCTIVE_AUX_CODES = ["Production", "Admin", "Adhoc", "Coaching", "Meeting", "Training"];

// Productive Hrs % = (Expected - Non-productive) ÷ Expected.
//
// Expected = login hours - break allowance, where login hours is the
// time logged INSIDE the schedule - so it can never exceed the scheduled
// hours, and overtime only counts once it's been added to the schedule.
// The allowance grows with the login:
//   <= 6h: 0.5h   > 6h-9h: 1h   > 9h-12h: 1.5h   > 12h: 2h
function breakAllowanceSeconds(loginSeconds) {
  const hours = loginSeconds / 3600;
  if (hours <= 6) return 0.5 * 3600;
  if (hours <= 9) return 1 * 3600;
  if (hours <= 12) return 1.5 * 3600;
  return 2 * 3600;
}

// Non-productive = Idle + Bio Break + Lunch/Break beyond that same
// allowance (it's the combined Lunch + Break allowance). Working through
// part of a lunch or break therefore earns nothing - it can't make up
// for Idle time.
//
// Only for an agent/day WITH a schedule - without one there's no
// Productive Hrs % at all (callers return null). `auxSeconds` is the
// counted (inside-schedule) time per aux code, `loginSeconds` its total.
// creditSeconds (Expected - Non-productive, never below 0) and
// expectedSeconds are exposed so dashboards/monthly totals can sum them
// and divide once.
function productiveHrs(auxSeconds, loginSeconds) {
  const allowanceSeconds = loginSeconds > 0 ? breakAllowanceSeconds(loginSeconds) : 0;
  const lunchBreakSeconds = (auxSeconds.Lunch || 0) + (auxSeconds.Break || 0);
  const excessBreakSeconds = Math.max(0, lunchBreakSeconds - allowanceSeconds);
  const nonProductiveSeconds = (auxSeconds.Idle || 0) + (auxSeconds.BioBreak || 0) + excessBreakSeconds;
  const result = {
    allowanceSeconds,
    expectedSeconds: 0,
    nonProductiveSeconds,
    excessBreakSeconds,
    creditSeconds: 0,
    pct: null,
  };
  if (loginSeconds <= 0) return result;

  const expectedSeconds = loginSeconds - result.allowanceSeconds;
  if (expectedSeconds <= 0) {
    // Logged in for no longer than the allowance itself - nothing to
    // measure against, so it's all or nothing.
    result.pct = nonProductiveSeconds > 0 ? 0 : 100;
    return result;
  }
  result.expectedSeconds = expectedSeconds;
  result.creditSeconds = Math.max(0, expectedSeconds - nonProductiveSeconds);
  result.pct = (result.creditSeconds / expectedSeconds) * 100;
  return result;
}

// _est columns and agent_schedules are plain Eastern wall-clock values,
// so they're compared as naive timestamps (parsed as if UTC) - the same
// thing TIMESTAMPDIFF does with them in the SQL below.
const EST_FORMAT = "%Y-%m-%d %H:%i:%s";
const toMs = (sqlString) => DateTime.fromSQL(sqlString, { zone: "utc" }).toMillis();

// An open aux_events row older than this is treated as a leftover from
// a crashed/powered-off machine that never logged out, not a live agent.
const MAX_OPEN_SEGMENT_HOURS = 16;

// An open aux_events row (alias `ae`) that counts as running up to now:
// recent (the ? is the MAX_OPEN_SEGMENT_HOURS cutoff) AND the agent's
// latest segment. A failed close during a backend restart or network
// blip leaves an older row open next to the real current one - without
// the second check it would be counted twice. Same "most recent wins"
// rule as loadLiveAgents.
const RUNNING_SEGMENT_SQL = `(ae.ended_at_utc IS NULL AND ae.started_at_est >= ?
  AND NOT EXISTS (SELECT 1 FROM aux_events later
                  WHERE later.agent_id = ae.agent_id AND later.started_at_est > ae.started_at_est))`;

// Seconds of [start, end) that fall inside any of the given windows.
function overlapSeconds(startMs, endMs, windows) {
  let total = 0;
  for (const w of windows) {
    const s = Math.max(startMs, w.startMs);
    const e = Math.min(endMs, w.endMs);
    if (e > s) total += (e - s) / 1000;
  }
  return total;
}

// Adherence rule shared by /efficiency and /live-agents: once an agent
// has logged in, a gap between one desktop login ending and the next
// starting (reconnects, remote_login, switching PCs) still counts as
// adherent time - UNLESS they were in Idle right before logging out,
// i.e. they actually left. Time before the first login (a late start)
// and after the last logout (leaving early) is never a "gap" and never
// credited. Efficiency is unaffected - it stays based on real aux time.
//
// `sessions` must be sorted by startMs; endMs is null for a login with
// no closed segment yet (still active). Returns one entry per gap; the
// caller decides how much of it falls inside the schedule.
function findLoginGaps(sessions) {
  const gaps = [];
  for (let i = 1; i < sessions.length; i++) {
    const prev = sessions[i - 1];
    const next = sessions[i];
    if (prev.endMs == null || next.startMs <= prev.endMs) continue;
    gaps.push({ nextIndex: i, startMs: prev.endMs, endMs: next.startMs, afterIdle: prev.lastAuxCode === "Idle" });
  }
  return gaps;
}

// Shared by all three queries below so the agent/group/date filtering
// logic (including manager/supervisor group-scoping) can't drift
// between them - they need to agree on exactly which agents and which
// days are in scope. dateColumnExpr is the one thing that differs per
// query (aux_events uses started_at_est, agent_schedules uses
// shift_date directly).
function buildConditions(dateColumnExpr, { dateFrom, dateTo, agentId, groupId, scopedGroupIds }) {
  const conditions = [`${dateColumnExpr} BETWEEN ? AND ?`];
  const params = [dateFrom, dateTo];

  if (agentId) {
    conditions.push("a.agent_id = ?");
    params.push(agentId);
  }
  if (groupId) {
    conditions.push("a.group_id = ?");
    params.push(groupId);
  }
  if (scopedGroupIds !== null) {
    conditions.push(`a.group_id IN (${scopedGroupIds.map(() => "?").join(",")})`);
    params.push(...scopedGroupIds);
  }

  return { conditions, params };
}

router.get("/efficiency", async (req, res) => {
  const { dateFrom, dateTo, agentId, groupId } = req.query;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: "dateFrom and dateTo are required." });
  }

  try {
    // Manager/Supervisor only ever see their assigned groups,
    // regardless of what's requested above - an explicit groupId
    // outside their scope just naturally returns zero rows (both
    // conditions must hold), no separate validation needed.
    const scopedGroupIds = await getScopedGroupIds(req);
    if (scopedGroupIds !== null && scopedGroupIds.length === 0) {
      return res.json([]); // scoped user with no groups assigned yet - show nothing, not everything
    }

    const filters = { dateFrom, dateTo, agentId, groupId, scopedGroupIds };

    // Everything below is a RUNNING total as of now: the segment an agent
    // is currently in counts up to now (unless it's a stale leftover - see
    // MAX_OPEN_SEGMENT_HOURS), and scheduled time only counts once it has
    // started - the rest of today's shift and any future day's schedule
    // stay out of the adherence denominator.
    const now = new Date();
    const nowEst = toEasternSqlString(now);
    const openCutoffEst = toEasternSqlString(new Date(now.getTime() - MAX_OPEN_SEGMENT_HOURS * 3600 * 1000));

    // Query 1 - LEGACY totals: every completed aux segment in range,
    // regardless of any schedule. This is the fallback used for any
    // agent/day the schedule sync hasn't loaded yet (or never will,
    // e.g. historical data from before schedules existed) - so a gap
    // in schedule coverage degrades gracefully to the old behavior
    // instead of the report going blank for that day.
    const legacyFilter = buildConditions("DATE(ae.started_at_est)", filters);
    const [legacyRows] = await db.query(
      `SELECT a.agent_id, a.display_name, a.group_id, g.group_name,
              DATE_FORMAT(ae.started_at_est, '%Y-%m-%d') AS report_date,
              ae.aux_code,
              SUM(COALESCE(ae.duration_seconds, GREATEST(0, TIMESTAMPDIFF(SECOND, ae.started_at_est, ?)))) AS total_seconds
       FROM aux_events ae
       JOIN agents a ON a.agent_id = ae.agent_id
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       WHERE ${legacyFilter.conditions.join(" AND ")}
         AND (ae.duration_seconds IS NOT NULL OR ${RUNNING_SEGMENT_SQL})
       GROUP BY a.agent_id, a.display_name, a.group_id, g.group_name, DATE_FORMAT(ae.started_at_est, '%Y-%m-%d'), ae.aux_code`,
      [nowEst, ...legacyFilter.params, openCutoffEst]
    );

    // Query 2 - total SCHEDULED seconds per (agent, day), summed across
    // every shift_type row that day (e.g. Regular + OT both count
    // toward the same day's scheduled total). This alone is what tells
    // us whether an (agent, day) HAS a schedule at all. scheduled_seconds
    // is the full shift length (what the report shows); elapsed_seconds
    // is only the part that has already started (capped at now) - the
    // adherence denominator, so a future day or the rest of today's shift
    // doesn't count against the agent yet.
    const scheduleFilter = buildConditions("s.shift_date", filters);
    const [scheduleRows] = await db.query(
      `SELECT a.agent_id, a.display_name, a.group_id, g.group_name,
              DATE_FORMAT(s.shift_date, '%Y-%m-%d') AS report_date,
              SUM(TIMESTAMPDIFF(SECOND, s.scheduled_start, s.scheduled_end)) AS scheduled_seconds,
              SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, s.scheduled_start, LEAST(s.scheduled_end, ?)))) AS elapsed_seconds
       FROM agent_schedules s
       JOIN agents a ON a.agent_id = s.agent_id
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       WHERE ${scheduleFilter.conditions.join(" AND ")}
       GROUP BY a.agent_id, a.display_name, a.group_id, g.group_name, DATE_FORMAT(s.shift_date, '%Y-%m-%d')`,
      [nowEst, ...scheduleFilter.params]
    );

    // Query 3 - aux time ACTUALLY WITHIN a scheduled window, per
    // (agent, day, aux_code). Joined on agent + time-range overlap
    // (not on matching dates) so an overnight shift that crosses
    // midnight still captures aux_events on either side of it
    // correctly; grouped by the SCHEDULE's shift_date, not the aux
    // event's own calendar date, so all of an overnight shift's time
    // lands under the one day it's dated. Completed segments count, plus
    // a still-open one up to now, same as the legacy query.
    // Overlapping schedule rows for the same agent would double-count
    // here - the sync job is expected to load non-overlapping windows
    // per agent per day (see sql/002_add_agent_schedules.sql).
    const overlapFilter = buildConditions("s.shift_date", filters);
    const [overlapRows] = await db.query(
      `SELECT a.agent_id, a.display_name, a.group_id, g.group_name,
              DATE_FORMAT(s.shift_date, '%Y-%m-%d') AS report_date,
              ae.aux_code,
              SUM(
                TIMESTAMPDIFF(
                  SECOND,
                  GREATEST(ae.started_at_est, s.scheduled_start),
                  LEAST(COALESCE(ae.ended_at_est, ?), s.scheduled_end)
                )
              ) AS overlap_seconds
       FROM agent_schedules s
       JOIN agents a ON a.agent_id = s.agent_id
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       JOIN aux_events ae
         ON ae.agent_id = s.agent_id
        AND (ae.ended_at_est IS NOT NULL OR ${RUNNING_SEGMENT_SQL})
        AND ae.started_at_est < s.scheduled_end
        AND COALESCE(ae.ended_at_est, ?) > s.scheduled_start
       WHERE ${overlapFilter.conditions.join(" AND ")}
       GROUP BY a.agent_id, a.display_name, a.group_id, g.group_name, DATE_FORMAT(s.shift_date, '%Y-%m-%d'), ae.aux_code`,
      [nowEst, openCutoffEst, nowEst, ...overlapFilter.params]
    );

    // Query 4 + 5 - reconnect gaps (see findLoginGaps). Query 4 lists the
    // individual schedule windows; Query 5 summarises each desktop login
    // (first start, last close, aux it was closed from) for the agents
    // that have them. The login range is widened a day either side so
    // overnight shifts and logins that started the day before are seen.
    // Each gap is credited to whichever schedule window(s) it overlaps.
    const creditedGapSeconds = new Map(); // "agentId|shiftDate" -> seconds
    const windowFilter = buildConditions("s.shift_date", filters);
    const [windowRows] = await db.query(
      `SELECT s.agent_id, DATE_FORMAT(s.shift_date, '%Y-%m-%d') AS shift_date,
              DATE_FORMAT(s.scheduled_start, '${EST_FORMAT}') AS start_est,
              DATE_FORMAT(s.scheduled_end, '${EST_FORMAT}') AS end_est
       FROM agent_schedules s
       JOIN agents a ON a.agent_id = s.agent_id
       WHERE ${windowFilter.conditions.join(" AND ")}`,
      windowFilter.params
    );

    if (windowRows.length > 0) {
      const windowsByAgent = new Map();
      for (const w of windowRows) {
        if (!windowsByAgent.has(w.agent_id)) windowsByAgent.set(w.agent_id, []);
        windowsByAgent.get(w.agent_id).push({ shiftDate: w.shift_date, startMs: toMs(w.start_est), endMs: toMs(w.end_est) });
      }

      const sessionFilter = buildConditions("DATE(ae.started_at_est)", {
        ...filters,
        dateFrom: DateTime.fromISO(dateFrom).minus({ days: 1 }).toISODate(),
        dateTo: DateTime.fromISO(dateTo).plus({ days: 1 }).toISODate(),
      });
      const [sessionRows] = await db.query(
        `SELECT ae.agent_id,
                DATE_FORMAT(MIN(ae.started_at_est), '${EST_FORMAT}') AS start_est,
                DATE_FORMAT(MAX(ae.ended_at_est), '${EST_FORMAT}') AS end_est,
                SUBSTRING_INDEX(
                  GROUP_CONCAT(CASE WHEN ae.ended_at_est IS NOT NULL THEN ae.aux_code END ORDER BY ae.ended_at_est DESC),
                  ',', 1
                ) AS last_aux
         FROM aux_events ae
         JOIN agents a ON a.agent_id = ae.agent_id
         WHERE ${sessionFilter.conditions.join(" AND ")}
           AND ae.login_session_id IS NOT NULL
           AND ae.agent_id IN (?)
         GROUP BY ae.agent_id, ae.login_session_id`,
        [...sessionFilter.params, [...windowsByAgent.keys()]]
      );

      const sessionsByAgent = new Map();
      for (const row of sessionRows) {
        if (!sessionsByAgent.has(row.agent_id)) sessionsByAgent.set(row.agent_id, []);
        sessionsByAgent.get(row.agent_id).push({
          startMs: toMs(row.start_est),
          endMs: row.end_est ? toMs(row.end_est) : null,
          lastAuxCode: row.last_aux,
        });
      }

      for (const [agentKey, agentSessions] of sessionsByAgent) {
        agentSessions.sort((a, b) => a.startMs - b.startMs);
        const agentWindows = windowsByAgent.get(agentKey) || [];
        for (const gap of findLoginGaps(agentSessions)) {
          if (gap.afterIdle) continue;
          for (const w of agentWindows) {
            const seconds = overlapSeconds(gap.startMs, gap.endMs, [w]);
            if (seconds > 0) {
              const key = `${agentKey}|${w.shiftDate}`;
              creditedGapSeconds.set(key, (creditedGapSeconds.get(key) || 0) + seconds);
            }
          }
        }
      }
    }

    // Query 6 - scheduled and actual start/end per (agent, day), shown in
    // the daily report. Scheduled = earliest start / latest end of that
    // day's schedule windows. Actual = first login / last logout of the
    // desktop logins that STARTED on that day (same "the shift is the
    // day the login started" rule as the live view, so an overnight
    // shift ends the morning after). The event range is widened a day
    // either side so those logins are seen whole; actualEnd is null
    // while the agent is still logged in.
    const scheduledTimes = new Map(); // "agentId|date" -> { start, end }
    for (const w of windowRows) {
      const key = `${w.agent_id}|${w.shift_date}`;
      const t = scheduledTimes.get(key);
      if (!t) scheduledTimes.set(key, { start: w.start_est, end: w.end_est });
      else {
        if (w.start_est < t.start) t.start = w.start_est;
        if (w.end_est > t.end) t.end = w.end_est;
      }
    }

    const actualFilter = buildConditions("DATE(ae.started_at_est)", {
      ...filters,
      dateFrom: DateTime.fromISO(dateFrom).minus({ days: 1 }).toISODate(),
      dateTo: DateTime.fromISO(dateTo).plus({ days: 1 }).toISODate(),
    });
    const [loginRows] = await db.query(
      `SELECT ae.agent_id,
              DATE_FORMAT(MIN(ae.started_at_est), '${EST_FORMAT}') AS start_est,
              DATE_FORMAT(MAX(ae.ended_at_est), '${EST_FORMAT}') AS end_est,
              MAX(CASE WHEN ${RUNNING_SEGMENT_SQL} THEN 1 ELSE 0 END) AS is_active
       FROM aux_events ae
       JOIN agents a ON a.agent_id = ae.agent_id
       WHERE ${actualFilter.conditions.join(" AND ")}
       GROUP BY ae.agent_id, COALESCE(ae.login_session_id, CONCAT('event-', ae.event_id))`,
      [openCutoffEst, ...actualFilter.params]
    );
    const actualTimes = new Map(); // "agentId|date" -> { start, end, active }
    for (const row of loginRows) {
      const day = row.start_est.slice(0, 10);
      if (day < dateFrom || day > dateTo) continue;
      const key = `${row.agent_id}|${day}`;
      const t = actualTimes.get(key) || { start: row.start_est, end: null, active: false };
      if (row.start_est < t.start) t.start = row.start_est;
      if (row.end_est && (!t.end || row.end_est > t.end)) t.end = row.end_est;
      if (Number(row.is_active)) t.active = true;
      actualTimes.set(key, t);
    }

    // Merge all three into one (agent, day) map. Every key present in
    // scheduleRows has a real schedule for that day (even if
    // overlapRows has nothing for it, e.g. the agent never logged in
    // at all during their shift - that's a real, important 0%
    // adherence case, not missing data). Keys only present in
    // legacyRows fall back to the unscoped legacy numbers.
    const grouped = new Map();

    function getEntry(row) {
      const key = `${row.agent_id}|${row.report_date}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          date: row.report_date,
          agentId: row.agent_id,
          displayName: row.display_name,
          groupId: row.group_id,
          groupName: row.group_name,
          hasSchedule: false,
          scheduledSeconds: 0,
          elapsedScheduledSeconds: 0,
          legacyAuxSeconds: {},
          scheduledAuxSeconds: {},
        });
      }
      return grouped.get(key);
    }

    for (const row of legacyRows) {
      getEntry(row).legacyAuxSeconds[row.aux_code] = Number(row.total_seconds);
    }
    for (const row of scheduleRows) {
      const entry = getEntry(row);
      entry.hasSchedule = true;
      entry.scheduledSeconds = Number(row.scheduled_seconds);
      entry.elapsedScheduledSeconds = Number(row.elapsed_seconds);
    }
    for (const row of overlapRows) {
      getEntry(row).scheduledAuxSeconds[row.aux_code] = Number(row.overlap_seconds);
    }

    const report = [...grouped.values()].map((entry) => {
      // Schedule-scoped when a schedule exists for this agent/day,
      // otherwise fall back to the legacy unscoped totals - see the
      // comment on Query 1 above for why.
      const auxSeconds = entry.hasSchedule ? entry.scheduledAuxSeconds : entry.legacyAuxSeconds;
      const totalSeconds = Object.values(auxSeconds).reduce((sum, s) => sum + s, 0);
      const productiveSeconds = PRODUCTIVE_AUX_CODES.reduce(
        (sum, code) => sum + (auxSeconds[code] || 0),
        0
      );

      const creditedSeconds = entry.hasSchedule
        ? creditedGapSeconds.get(`${entry.agentId}|${entry.date}`) || 0
        : 0;
      const adherentSeconds = totalSeconds + creditedSeconds;
      // No schedule, no Productive Hrs % - the aux rows are still
      // returned, so it appears on its own once a schedule is added.
      const productive = entry.hasSchedule ? productiveHrs(auxSeconds, totalSeconds) : null;
      const scheduled = scheduledTimes.get(`${entry.agentId}|${entry.date}`);
      const actual = actualTimes.get(`${entry.agentId}|${entry.date}`);

      return {
        date: entry.date,
        agentId: entry.agentId,
        displayName: entry.displayName,
        groupId: entry.groupId,
        groupName: entry.groupName,
        hasSchedule: entry.hasSchedule,
        auxHours: Object.fromEntries(
          Object.entries(auxSeconds).map(([code, seconds]) => [code, seconds / 3600])
        ),
        totalHours: totalSeconds / 3600,
        // Productive Hrs % and its two sides - the hours are exposed so
        // dashboard/monthly totals can sum them and divide once.
        productiveHours: productiveSeconds / 3600,
        productiveBaseHours: productive ? productive.expectedSeconds / 3600 : null, // Expected
        productiveCreditHours: productive ? productive.creditSeconds / 3600 : null, // Expected - Non-productive
        nonProductiveHours: productive ? productive.nonProductiveSeconds / 3600 : null,
        efficiencyPct: productive ? productive.pct : null,
        // Only meaningful once a schedule exists - null (not 0) when
        // it doesn't, so the frontend can render "N/A" instead of a
        // misleading 0%.
        scheduledHours: entry.hasSchedule ? entry.scheduledSeconds / 3600 : null,
        // The part of the schedule that has started so far - the
        // adherence denominator (equals scheduledHours once the shift is over).
        elapsedScheduledHours: entry.hasSchedule ? entry.elapsedScheduledSeconds / 3600 : null,
        // Logged time within schedule plus credited reconnect gaps -
        // the numerator of adherencePct, exposed so monthly/dashboard
        // totals can sum it the same way.
        creditedGapHours: entry.hasSchedule ? creditedSeconds / 3600 : null,
        adherentHours: entry.hasSchedule ? adherentSeconds / 3600 : null,
        adherencePct: entry.hasSchedule && entry.elapsedScheduledSeconds > 0
          ? (adherentSeconds / entry.elapsedScheduledSeconds) * 100
          : null,
        // Eastern "YYYY-MM-DD HH:MM:SS" strings (see Query 6), null when
        // there's no schedule / no login that day.
        scheduledStart: scheduled ? scheduled.start : null,
        scheduledEnd: scheduled ? scheduled.end : null,
        actualStart: actual ? actual.start : null,
        actualEnd: actual && !actual.active ? actual.end : null,
        stillLoggedIn: Boolean(actual && actual.active),
      };
    });

    report.sort((a, b) => b.date.localeCompare(a.date) || a.displayName.localeCompare(b.displayName));

    res.json(report);
  } catch (err) {
    console.error("Error generating efficiency report:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// Today's recorded aux time (Eastern day, midnight to now) split into
// one-hour buckets, per agent so the dashboard can filter by group/agent
// client-side. All recorded time counts here, schedule or not - it's a
// picture of what agents were doing each hour. A segment that spans an
// hour boundary is split across both hours, an overnight one is clipped
// at midnight, and the open segment counts up to now (stale open rows
// older than MAX_OPEN_SEGMENT_HOURS are ignored).
router.get("/hourly-aux", async (req, res) => {
  try {
    const scopedGroupIds = await getScopedGroupIds(req);
    if (scopedGroupIds !== null && scopedGroupIds.length === 0) {
      return res.json([]);
    }

    const now = new Date();
    const nowEst = toEasternSqlString(now);
    const dayStartEst = `${nowEst.slice(0, 10)} 00:00:00`;
    const openCutoffEst = toEasternSqlString(new Date(now.getTime() - MAX_OPEN_SEGMENT_HOURS * 3600 * 1000));

    const conditions = [
      "ae.started_at_est < ?",
      `(ae.ended_at_est > ? OR ${RUNNING_SEGMENT_SQL})`,
    ];
    const params = [nowEst, dayStartEst, openCutoffEst];
    if (scopedGroupIds !== null) {
      conditions.push(`a.group_id IN (${scopedGroupIds.map(() => "?").join(",")})`);
      params.push(...scopedGroupIds);
    }

    const [rows] = await db.query(
      `SELECT ae.agent_id, a.group_id, ae.aux_code,
              DATE_FORMAT(ae.started_at_est, '${EST_FORMAT}') AS started_est,
              DATE_FORMAT(ae.ended_at_est, '${EST_FORMAT}') AS ended_est
       FROM aux_events ae
       JOIN agents a ON a.agent_id = ae.agent_id
       WHERE ${conditions.join(" AND ")}`,
      params
    );

    const dayStartMs = toMs(dayStartEst);
    const nowMs = toMs(nowEst);
    const HOUR_MS = 3600 * 1000;
    const buckets = new Map(); // "agentId|hour|auxCode" -> entry

    for (const row of rows) {
      let startMs = Math.max(toMs(row.started_est), dayStartMs);
      const endMs = Math.min(row.ended_est ? toMs(row.ended_est) : nowMs, nowMs);
      while (startMs < endMs) {
        const hour = Math.floor((startMs - dayStartMs) / HOUR_MS);
        const sliceEndMs = Math.min(endMs, dayStartMs + (hour + 1) * HOUR_MS);
        const key = `${row.agent_id}|${hour}|${row.aux_code}`;
        if (!buckets.has(key)) {
          buckets.set(key, { agentId: row.agent_id, groupId: row.group_id, hour, auxCode: row.aux_code, seconds: 0 });
        }
        buckets.get(key).seconds += (sliceEndMs - startMs) / 1000;
        startMs = sliceEndMs;
      }
    }

    res.json([...buckets.values()].map((b) => ({ ...b, seconds: Math.round(b.seconds) })));
  } catch (err) {
    console.error("Error loading hourly aux:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// Agents currently logged in to the desktop app (plus those who logged
// out earlier today, as aux "LoggedOut", and those scheduled today who
// haven't logged in, as "NotLoggedIn"/"Scheduled"), with their current aux and
// live Productive Hrs/adherence for the shift they're on - optionally
// narrowed to one agent. "The shift" is the Eastern calendar day their
// current login session started on, so an overnight shift keeps
// counting past midnight instead of resetting. Same rules as
// /efficiency: when that day has a schedule, only time inside the
// scheduled windows counts. Adherence is measured against the scheduled
// time ELAPSED SO FAR, not the whole shift, so it isn't artificially
// low mid-shift, and short gaps between logins are credited (see the
// gap loop below).
//
// Each result carries a `detail` object (schedule windows, login
// sessions, per-aux time) - the list endpoint drops it to keep the
// 5-second poll light, the per-agent endpoint returns it for the modal.
async function loadLiveAgents(req, onlyAgentId = null) {
  const scopedGroupIds = await getScopedGroupIds(req);
  if (scopedGroupIds !== null && scopedGroupIds.length === 0) {
    return [];
  }

  const now = new Date();
  const nowEst = toEasternSqlString(now);
  const nowMs = toMs(nowEst);
  const cutoffEst = toEasternSqlString(new Date(now.getTime() - MAX_OPEN_SEGMENT_HOURS * 3600 * 1000));

  const conditions = ["ae.ended_at_utc IS NULL", "ae.started_at_est >= ?"];
  const params = [cutoffEst];
  if (scopedGroupIds !== null) {
    conditions.push(`a.group_id IN (${scopedGroupIds.map(() => "?").join(",")})`);
    params.push(...scopedGroupIds);
  }
  if (onlyAgentId) {
    conditions.push("ae.agent_id = ?");
    params.push(onlyAgentId);
  }

  const [openRows] = await db.query(
    `SELECT ae.event_id, ae.agent_id, a.display_name, a.group_id, g.group_name, ae.aux_code,
            DATE_FORMAT(ae.started_at_est, '${EST_FORMAT}') AS aux_started_est,
            DATE_FORMAT((
              SELECT MIN(x.started_at_est) FROM aux_events x
              WHERE x.agent_id = ae.agent_id AND x.login_session_id = ae.login_session_id
            ), '${EST_FORMAT}') AS session_started_est
     FROM aux_events ae
     JOIN agents a ON a.agent_id = ae.agent_id
     LEFT JOIN agent_groups g ON g.group_id = a.group_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ae.started_at_est DESC`,
    params
  );

  // Normally one open row per agent; if a stale one slipped through,
  // the most recent wins.
  const current = new Map();
  for (const row of openRows) {
    if (!current.has(row.agent_id)) current.set(row.agent_id, row);
  }

  // Agents who were on today (Eastern) but aren't logged in now - their
  // last closed segment ended today and nothing later is open. They're
  // listed as "LoggedOut", timed from that logout, with the stats of the
  // shift they logged out of. event_id is null so no event is treated
  // as the live one below.
  const loggedOutConditions = [
    "ae.ended_at_est >= ?",
    `NOT EXISTS (SELECT 1 FROM aux_events later
                 WHERE later.agent_id = ae.agent_id AND later.ended_at_est > ae.ended_at_est)`,
  ];
  const loggedOutParams = [`${nowEst.slice(0, 10)} 00:00:00`];
  if (scopedGroupIds !== null) {
    loggedOutConditions.push(`a.group_id IN (${scopedGroupIds.map(() => "?").join(",")})`);
    loggedOutParams.push(...scopedGroupIds);
  }
  if (onlyAgentId) {
    loggedOutConditions.push("ae.agent_id = ?");
    loggedOutParams.push(onlyAgentId);
  }
  const [loggedOutRows] = await db.query(
    `SELECT ae.agent_id, a.display_name, a.group_id, g.group_name,
            DATE_FORMAT(ae.started_at_est, '${EST_FORMAT}') AS started_est,
            DATE_FORMAT(ae.ended_at_est, '${EST_FORMAT}') AS ended_est,
            DATE_FORMAT((
              SELECT MIN(x.started_at_est) FROM aux_events x
              WHERE x.agent_id = ae.agent_id AND x.login_session_id = ae.login_session_id
            ), '${EST_FORMAT}') AS session_started_est
     FROM aux_events ae
     JOIN agents a ON a.agent_id = ae.agent_id
     LEFT JOIN agent_groups g ON g.group_id = a.group_id
     WHERE ${loggedOutConditions.join(" AND ")}`,
    loggedOutParams
  );
  for (const row of loggedOutRows) {
    if (current.has(row.agent_id)) continue;
    current.set(row.agent_id, {
      event_id: null,
      agent_id: row.agent_id,
      display_name: row.display_name,
      group_id: row.group_id,
      group_name: row.group_name,
      aux_code: "LoggedOut",
      aux_started_est: row.ended_est,
      session_started_est: row.session_started_est || row.started_est,
    });
  }

  // Agents scheduled today (Eastern) with no desktop activity today - the
  // overall adherence already counts them, so they're listed too:
  // "NotLoggedIn" once their shift has started (timed from the scheduled
  // start, 0% adherence), "Scheduled" while it hasn't (N/A adherence).
  const todayEst = nowEst.slice(0, 10);
  const scheduledConditions = ["s.shift_date = ?"];
  const scheduledParams = [todayEst];
  if (scopedGroupIds !== null) {
    scheduledConditions.push(`a.group_id IN (${scopedGroupIds.map(() => "?").join(",")})`);
    scheduledParams.push(...scopedGroupIds);
  }
  if (onlyAgentId) {
    scheduledConditions.push("s.agent_id = ?");
    scheduledParams.push(onlyAgentId);
  }
  const [scheduledTodayRows] = await db.query(
    `SELECT s.agent_id, a.display_name, a.group_id, g.group_name,
            DATE_FORMAT(MIN(s.scheduled_start), '${EST_FORMAT}') AS start_est
     FROM agent_schedules s
     JOIN agents a ON a.agent_id = s.agent_id
     LEFT JOIN agent_groups g ON g.group_id = a.group_id
     WHERE ${scheduledConditions.join(" AND ")}
     GROUP BY s.agent_id, a.display_name, a.group_id, g.group_name`,
    scheduledParams
  );
  for (const row of scheduledTodayRows) {
    if (current.has(row.agent_id)) continue;
    current.set(row.agent_id, {
      event_id: null,
      agent_id: row.agent_id,
      display_name: row.display_name,
      group_id: row.group_id,
      group_name: row.group_name,
      aux_code: toMs(row.start_est) <= nowMs ? "NotLoggedIn" : "Scheduled",
      aux_started_est: row.start_est,
      session_started_est: `${todayEst} 00:00:00`,
      scheduled_start_est: row.start_est,
    });
  }

  if (current.size === 0) {
    return [];
  }

  // Last login of the agents with no activity today: the start of their
  // most recent desktop login on any earlier day (null if never). Agents
  // with activity today already have it as session_started_est.
  const lastLoginByAgent = new Map();
  const noActivityIds = [...current.values()].filter((r) => r.scheduled_start_est).map((r) => r.agent_id);
  if (noActivityIds.length > 0) {
    const [lastLoginRows] = await db.query(
      `SELECT latest.agent_id,
              DATE_FORMAT(COALESCE(MIN(x.started_at_est), latest.started_at_est), '${EST_FORMAT}') AS last_login_est
       FROM aux_events latest
       LEFT JOIN aux_events x
         ON x.agent_id = latest.agent_id AND x.login_session_id = latest.login_session_id
       WHERE latest.agent_id IN (?)
         AND latest.started_at_utc = (SELECT MAX(m.started_at_utc) FROM aux_events m WHERE m.agent_id = latest.agent_id)
       GROUP BY latest.agent_id, latest.started_at_est`,
      [noActivityIds]
    );
    for (const row of lastLoginRows) lastLoginByAgent.set(row.agent_id, row.last_login_est);
  }

  const agentIds = [...current.keys()];
  for (const row of current.values()) {
    row.shiftDate = (row.session_started_est || row.aux_started_est).slice(0, 10);
  }
  const shiftDates = [...current.values()].map((r) => r.shiftDate).sort();
  const earliestShiftDate = shiftDates[0];
  const latestShiftDate = shiftDates[shiftDates.length - 1];

  const [eventRows] = await db.query(
    `SELECT event_id, agent_id, login_session_id, machine_name, aux_code, logout_trigger,
            DATE_FORMAT(started_at_est, '${EST_FORMAT}') AS started_est,
            DATE_FORMAT(ended_at_est, '${EST_FORMAT}') AS ended_est
     FROM aux_events
     WHERE agent_id IN (?) AND started_at_est >= ? AND started_at_est <= ?
     ORDER BY started_at_est ASC`,
    [agentIds, `${earliestShiftDate} 00:00:00`, nowEst]
  );

  const [scheduleRows] = await db.query(
    `SELECT agent_id, shift_type, DATE_FORMAT(shift_date, '%Y-%m-%d') AS shift_date,
            DATE_FORMAT(scheduled_start, '${EST_FORMAT}') AS start_est,
            DATE_FORMAT(scheduled_end, '${EST_FORMAT}') AS end_est
     FROM agent_schedules
     WHERE agent_id IN (?) AND shift_date BETWEEN ? AND ?
     ORDER BY scheduled_start ASC`,
    [agentIds, earliestShiftDate, latestShiftDate]
  );

  const result = [...current.values()].map((cur) => {
    const shiftStartMs = toMs(`${cur.shiftDate} 00:00:00`);
    const schedule = scheduleRows.filter((s) => s.agent_id === cur.agent_id && s.shift_date === cur.shiftDate);
    const windows = schedule.map((s) => ({ startMs: toMs(s.start_est), endMs: toMs(s.end_est) }));
    const hasSchedule = windows.length > 0;

    // Per aux code: all time logged this shift, and the part of it that
    // counts toward efficiency/adherence (inside the schedule, or all of
    // it when there's no schedule).
    const auxTotals = new Map();
    const sessions = new Map();
    let countedSeconds = 0;
    let productiveSeconds = 0;

    for (const ev of eventRows) {
      if (ev.agent_id !== cur.agent_id) continue;
      const isCurrent = ev.event_id === cur.event_id;
      // Any other still-open row is a leftover, not live time.
      if (!ev.ended_est && !isCurrent) continue;
      const startMs = toMs(ev.started_est);
      if (startMs < shiftStartMs) continue;
      const endMs = Math.min(ev.ended_est ? toMs(ev.ended_est) : nowMs, nowMs);
      const logged = Math.max(0, (endMs - startMs) / 1000);
      const counted = hasSchedule ? overlapSeconds(startMs, endMs, windows) : logged;

      const totals = auxTotals.get(ev.aux_code) || { loggedSeconds: 0, countedSeconds: 0 };
      totals.loggedSeconds += logged;
      totals.countedSeconds += counted;
      auxTotals.set(ev.aux_code, totals);

      countedSeconds += counted;
      if (PRODUCTIVE_AUX_CODES.includes(ev.aux_code)) productiveSeconds += counted;

      // One entry per desktop login (login_session_id) - its start is
      // the first aux segment, its end the last one to close.
      const sessionKey = ev.login_session_id || `event-${ev.event_id}`;
      const session = sessions.get(sessionKey) || {
        machineName: ev.machine_name, start: ev.started_est, end: null, isActive: false,
        logoutTrigger: null, lastAuxCode: null,
      };
      if (isCurrent) {
        session.isActive = true;
      } else if (!session.end || ev.ended_est > session.end) {
        session.end = ev.ended_est;
        session.logoutTrigger = ev.logout_trigger || null;
        session.lastAuxCode = ev.aux_code;
      }
      sessions.set(sessionKey, session);
    }

    // Reconnect gaps between logins - see findLoginGaps.
    const orderedSessions = [...sessions.values()].sort((a, b) => a.start.localeCompare(b.start));
    let creditedGapSeconds = 0;
    const gaps = findLoginGaps(orderedSessions.map((s) => ({
      startMs: toMs(s.start),
      endMs: s.isActive || !s.end ? null : toMs(s.end),
      lastAuxCode: s.lastAuxCode,
    })));
    for (const gap of gaps) {
      const credited = hasSchedule && !gap.afterIdle ? overlapSeconds(gap.startMs, gap.endMs, windows) : 0;
      orderedSessions[gap.nextIndex].gapBefore = {
        seconds: Math.round((gap.endMs - gap.startMs) / 1000),
        creditedSeconds: Math.round(credited),
        afterIdle: gap.afterIdle,
      };
      creditedGapSeconds += credited;
    }
    const adherentSeconds = countedSeconds + creditedGapSeconds;

    const scheduledSeconds = windows.reduce((sum, w) => sum + (w.endMs - w.startMs) / 1000, 0);
    const elapsedScheduledSeconds = windows.reduce(
      (sum, w) => sum + Math.max(0, (Math.min(nowMs, w.endMs) - w.startMs) / 1000),
      0
    );
    const loggedSeconds = [...auxTotals.values()].reduce((sum, t) => sum + t.loggedSeconds, 0);
    const countedAuxSeconds = Object.fromEntries([...auxTotals].map(([code, t]) => [code, t.countedSeconds]));
    const productive = hasSchedule ? productiveHrs(countedAuxSeconds, countedSeconds) : null;

    return {
      agentId: cur.agent_id,
      displayName: cur.display_name,
      groupId: cur.group_id,
      groupName: cur.group_name,
      auxCode: cur.aux_code,
      auxSeconds: Math.max(0, Math.round((nowMs - toMs(cur.aux_started_est)) / 1000)),
      // Only for "NotLoggedIn"/"Scheduled" agents - their first scheduled start today.
      scheduledStart: cur.scheduled_start_est || null,
      // Start of the agent's most recent desktop login; null if never.
      lastLoginAt: cur.scheduled_start_est ? lastLoginByAgent.get(cur.agent_id) || null
        : cur.session_started_est || cur.aux_started_est,
      efficiencyPct: productive ? productive.pct : null,
      adherencePct: elapsedScheduledSeconds > 0 ? (adherentSeconds / elapsedScheduledSeconds) * 100 : null,
      detail: {
        shiftDate: cur.shiftDate,
        asOf: nowEst,
        schedule: schedule.map((s) => ({ shiftType: s.shift_type, start: s.start_est, end: s.end_est })),
        sessions: orderedSessions.map((s) => ({
          machineName: s.machineName,
          start: s.start,
          end: s.isActive ? null : s.end,
          logoutTrigger: s.isActive ? null : s.logoutTrigger,
          lastAuxCode: s.isActive ? null : s.lastAuxCode,
          gapBefore: s.gapBefore || null,
        })),
        aux: [...auxTotals.entries()]
          .map(([auxCode, t]) => ({
            auxCode,
            isProductive: PRODUCTIVE_AUX_CODES.includes(auxCode),
            loggedSeconds: Math.round(t.loggedSeconds),
            countedSeconds: Math.round(t.countedSeconds),
          }))
          .sort((a, b) => b.loggedSeconds - a.loggedSeconds),
        loggedSeconds: Math.round(loggedSeconds),
        countedSeconds: Math.round(countedSeconds),
        productiveSeconds: Math.round(productiveSeconds),
        breakAllowanceSeconds: productive && countedSeconds > 0 ? productive.allowanceSeconds : null,
        expectedSeconds: productive && countedSeconds > 0 ? Math.round(countedSeconds - productive.allowanceSeconds) : null,
        nonProductiveSeconds: productive ? Math.round(productive.nonProductiveSeconds) : null,
        excessBreakSeconds: productive ? Math.round(productive.excessBreakSeconds) : null,
        creditedGapSeconds: Math.round(creditedGapSeconds),
        adherentSeconds: Math.round(adherentSeconds),
        scheduledSeconds: hasSchedule ? Math.round(scheduledSeconds) : null,
        elapsedScheduledSeconds: hasSchedule ? Math.round(elapsedScheduledSeconds) : null,
      },
    };
  });

  result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return result;
}

router.get("/live-agents", async (req, res) => {
  try {
    const agents = await loadLiveAgents(req);
    res.json(agents.map(({ detail, ...summary }) => summary));
  } catch (err) {
    console.error("Error loading live agents:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.get("/live-agents/:agentId", async (req, res) => {
  try {
    const [agent] = await loadLiveAgents(req, req.params.agentId);
    if (!agent) {
      return res.status(404).json({ error: "No desktop activity for this agent today." });
    }
    res.json(agent);
  } catch (err) {
    console.error("Error loading live agent detail:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;
