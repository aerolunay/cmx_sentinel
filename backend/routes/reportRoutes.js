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
    // us whether an (agent, day) HAS a schedule at all. Only the part of
    // each window that has already started counts (capped at now), so a
    // future day has a schedule but 0 scheduled seconds so far.
    const scheduleFilter = buildConditions("s.shift_date", filters);
    const [scheduleRows] = await db.query(
      `SELECT a.agent_id, a.display_name, a.group_id, g.group_name,
              DATE_FORMAT(s.shift_date, '%Y-%m-%d') AS report_date,
              SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, s.scheduled_start, LEAST(s.scheduled_end, ?)))) AS scheduled_seconds
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
        efficiencyPct: totalSeconds > 0 ? (productiveSeconds / totalSeconds) * 100 : 0,
        // Only meaningful once a schedule exists - null (not 0) when
        // it doesn't, so the frontend can render "N/A" instead of a
        // misleading 0%.
        scheduledHours: entry.hasSchedule ? entry.scheduledSeconds / 3600 : null,
        // Logged time within schedule plus credited reconnect gaps -
        // the numerator of adherencePct, exposed so monthly/dashboard
        // totals can sum it the same way.
        creditedGapHours: entry.hasSchedule ? creditedSeconds / 3600 : null,
        adherentHours: entry.hasSchedule ? adherentSeconds / 3600 : null,
        adherencePct: entry.hasSchedule && entry.scheduledSeconds > 0
          ? (adherentSeconds / entry.scheduledSeconds) * 100
          : null,
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

// Agents currently logged in to the desktop app, with their current aux
// and live efficiency/adherence for the shift they're on - optionally
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
  if (current.size === 0) {
    return [];
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

    return {
      agentId: cur.agent_id,
      displayName: cur.display_name,
      groupId: cur.group_id,
      groupName: cur.group_name,
      auxCode: cur.aux_code,
      auxSeconds: Math.max(0, Math.round((nowMs - toMs(cur.aux_started_est)) / 1000)),
      efficiencyPct: countedSeconds > 0 ? (productiveSeconds / countedSeconds) * 100 : null,
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
      return res.status(404).json({ error: "This agent is no longer logged in." });
    }
    res.json(agent);
  } catch (err) {
    console.error("Error loading live agent detail:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;
