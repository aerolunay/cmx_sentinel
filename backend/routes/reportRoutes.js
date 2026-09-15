"use strict";

const express = require("express");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();

// Reports are for ALL web roles (Admin, TQA, Supervisor, Manager) -
// same as Recordings, not admin-only.
router.use(requireAuth);

// Same codes that trigger screen/audio recording on the desktop app
// (see CaptureManager.cs / MiniPanelForm.cs), PLUS Meeting and
// Training - "productive" here is broader than the recording trigger
// set, by explicit request.
const PRODUCTIVE_AUX_CODES = ["Production", "Admin", "Adhoc", "Meeting", "Training"];

router.get("/efficiency", async (req, res) => {
  const { dateFrom, dateTo, agentId, groupId } = req.query;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: "dateFrom and dateTo are required." });
  }

  try {
    const conditions = ["DATE(ae.started_at_est) BETWEEN ? AND ?"];
    const params = [dateFrom, dateTo];

    if (agentId) {
      conditions.push("a.agent_id = ?");
      params.push(agentId);
    }
    if (groupId) {
      conditions.push("a.group_id = ?");
      params.push(groupId);
    }

    // Aggregated at (agent, day, aux_code) granularity here - only
    // COMPLETED segments (aux_events rows get written once a segment
    // ends, see AuxEventLogger.cs) are counted, so an agent's
    // CURRENTLY ACTIVE aux segment today won't be reflected until it
    // ends. Fine for a historical report, worth knowing if "today"
    // looks lower than expected while someone's still logged in.
    const [rows] = await db.query(
      `SELECT a.agent_id, a.display_name, a.group_id, g.group_name,
              DATE_FORMAT(ae.started_at_est, '%Y-%m-%d') AS report_date,
              ae.aux_code,
              SUM(ae.duration_seconds) AS total_seconds
       FROM aux_events ae
       JOIN agents a ON a.agent_id = ae.agent_id
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY a.agent_id, a.display_name, a.group_id, g.group_name, DATE_FORMAT(ae.started_at_est, '%Y-%m-%d'), ae.aux_code
       ORDER BY report_date DESC, a.display_name ASC`,
      params
    );

    // Pivot flat (agent, day, aux_code) rows into one row per
    // (agent, day) with an hours-per-aux breakdown - done here in JS
    // rather than SQL PIVOT (MySQL has no native pivot syntax), and
    // small enough result sets that this is simple and fast enough.
    const grouped = new Map();
    for (const row of rows) {
      const key = `${row.agent_id}|${row.report_date}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          date: row.report_date,
          agentId: row.agent_id,
          displayName: row.display_name,
          groupId: row.group_id,
          groupName: row.group_name,
          auxSeconds: {},
        });
      }
      grouped.get(key).auxSeconds[row.aux_code] = Number(row.total_seconds);
    }

    const report = [...grouped.values()].map((entry) => {
      const totalSeconds = Object.values(entry.auxSeconds).reduce((sum, s) => sum + s, 0);
      const productiveSeconds = PRODUCTIVE_AUX_CODES.reduce(
        (sum, code) => sum + (entry.auxSeconds[code] || 0),
        0
      );

      return {
        date: entry.date,
        agentId: entry.agentId,
        displayName: entry.displayName,
        groupId: entry.groupId,
        groupName: entry.groupName,
        auxHours: Object.fromEntries(
          Object.entries(entry.auxSeconds).map(([code, seconds]) => [code, seconds / 3600])
        ),
        totalHours: totalSeconds / 3600,
        efficiencyPct: totalSeconds > 0 ? (productiveSeconds / totalSeconds) * 100 : 0,
      };
    });

    res.json(report);
  } catch (err) {
    console.error("Error generating efficiency report:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;