"use strict";

const express = require("express");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { getScopedGroupIds } = require("../services/groupScope");

const router = express.Router();

// Reports are for ALL web roles (Admin, TQA, Supervisor, Manager) -
// same as Recordings, not admin-only.
router.use(requireAuth);

// Same codes that trigger screen/audio recording on the desktop app
// (see CaptureManager.cs / MiniPanelForm.cs), PLUS Meeting, Coaching
// and Training - "productive" here is broader than the recording
// trigger set, by explicit request.
const PRODUCTIVE_AUX_CODES = ["Production", "Admin", "Adhoc", "Coaching", "Meeting", "Training"];

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
              SUM(ae.duration_seconds) AS total_seconds
       FROM aux_events ae
       JOIN agents a ON a.agent_id = ae.agent_id
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       WHERE ${legacyFilter.conditions.join(" AND ")}
       GROUP BY a.agent_id, a.display_name, a.group_id, g.group_name, DATE_FORMAT(ae.started_at_est, '%Y-%m-%d'), ae.aux_code`,
      legacyFilter.params
    );

    // Query 2 - total SCHEDULED seconds per (agent, day), summed across
    // every shift_type row that day (e.g. Regular + OT both count
    // toward the same day's scheduled total). This alone is what tells
    // us whether an (agent, day) HAS a schedule at all.
    const scheduleFilter = buildConditions("s.shift_date", filters);
    const [scheduleRows] = await db.query(
      `SELECT a.agent_id, a.display_name, a.group_id, g.group_name,
              DATE_FORMAT(s.shift_date, '%Y-%m-%d') AS report_date,
              SUM(TIMESTAMPDIFF(SECOND, s.scheduled_start, s.scheduled_end)) AS scheduled_seconds
       FROM agent_schedules s
       JOIN agents a ON a.agent_id = s.agent_id
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       WHERE ${scheduleFilter.conditions.join(" AND ")}
       GROUP BY a.agent_id, a.display_name, a.group_id, g.group_name, DATE_FORMAT(s.shift_date, '%Y-%m-%d')`,
      scheduleFilter.params
    );

    // Query 3 - aux time ACTUALLY WITHIN a scheduled window, per
    // (agent, day, aux_code). Joined on agent + time-range overlap
    // (not on matching dates) so an overnight shift that crosses
    // midnight still captures aux_events on either side of it
    // correctly; grouped by the SCHEDULE's shift_date, not the aux
    // event's own calendar date, so all of an overnight shift's time
    // lands under the one day it's dated. Only completed segments
    // count (ended_at_est IS NOT NULL), same as the legacy query.
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
                  LEAST(ae.ended_at_est, s.scheduled_end)
                )
              ) AS overlap_seconds
       FROM agent_schedules s
       JOIN agents a ON a.agent_id = s.agent_id
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       JOIN aux_events ae
         ON ae.agent_id = s.agent_id
        AND ae.ended_at_est IS NOT NULL
        AND ae.started_at_est < s.scheduled_end
        AND ae.ended_at_est > s.scheduled_start
       WHERE ${overlapFilter.conditions.join(" AND ")}
       GROUP BY a.agent_id, a.display_name, a.group_id, g.group_name, DATE_FORMAT(s.shift_date, '%Y-%m-%d'), ae.aux_code`,
      overlapFilter.params
    );

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
        adherencePct: entry.hasSchedule && entry.scheduledSeconds > 0
          ? (totalSeconds / entry.scheduledSeconds) * 100
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

module.exports = router;
