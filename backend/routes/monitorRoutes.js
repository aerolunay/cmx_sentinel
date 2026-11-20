"use strict";

const express = require("express");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");
const { logAction } = require("../services/auditLog");
const { hasColumn } = require("../services/workSetup");
const liveMonitor = require("../services/liveMonitor");
const sessionOwnership = require("../services/sessionOwnership");

// Monitor page: agents logged in to the desktop app and in Production,
// and live monitoring of one of them (screen + PC audio) - see
// services/liveMonitor.js. Admin, Super Admin, Compliance and TQA.
// Only agents whose group has "Enable monitoring" on (sql/021) appear or
// can be monitored; agents with no group can't be.

const router = express.Router();
router.use(requireAuth);
router.use(requireRole("admin", "super_admin", "compliance", "tqa"));

// Live monitoring needs desktop 2.4.16+ on the agent's PC.
const MIN_DESKTOP_VERSION = [2, 4, 16];

function supportsMonitoring(version) {
  if (!version) return false;
  const parts = String(version).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] || 0) !== MIN_DESKTOP_VERSION[i]) return (parts[i] || 0) > MIN_DESKTOP_VERSION[i];
  }
  return true;
}

async function monitoringCondition() {
  // Before sql/021 no group can be monitored.
  return (await hasColumn("agent_groups", "monitoring_enabled")) ? "g.monitoring_enabled = TRUE" : "FALSE";
}

async function loadProductionAgents(agentId = null) {
  const condition = await monitoringCondition();
  const hasClients = await hasColumn("desktop_clients", "app_version");
  const [rows] = await db.query(
    `SELECT ae.agent_id, a.display_name, g.group_name, ae.machine_name, ae.started_at_utc,
            ${hasClients ? "dc.app_version" : "NULL"} AS app_version
     FROM aux_events ae
     JOIN agents a ON a.agent_id = ae.agent_id
     JOIN agent_groups g ON g.group_id = a.group_id
     ${hasClients ? "LEFT JOIN desktop_clients dc ON dc.machine_name = ae.machine_name" : ""}
     WHERE ae.ended_at_utc IS NULL AND ae.aux_code = 'Production' AND a.is_active = TRUE
       AND ${condition}
       ${agentId ? "AND ae.agent_id = ?" : ""}
     ORDER BY a.display_name`,
    agentId ? [agentId] : []
  );
  const live = liveMonitor.activeAgentIds();
  // One row per agent (a stale second open row shouldn't list them twice).
  const seen = new Set();
  return rows
    .filter((r) => !seen.has(r.agent_id) && seen.add(r.agent_id))
    .map((r) => {
      const connected = sessionOwnership.connectedMachine(r.agent_id) === r.machine_name;
      return {
        agentId: r.agent_id,
        displayName: r.display_name,
        groupName: r.group_name,
        machineName: r.machine_name,
        productionSinceUtc: new Date(r.started_at_utc).toISOString(),
        appVersion: r.app_version,
        connected,
        supported: supportsMonitoring(r.app_version),
        beingMonitored: live.has(r.agent_id),
      };
    });
}

router.get("/agents", async (req, res) => {
  try {
    res.json(await loadProductionAgents());
  } catch (err) {
    console.error("Error listing agents for the Monitor page:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.post("/agents/:agentId/start", async (req, res) => {
  const { agentId } = req.params;
  try {
    const [agent] = await loadProductionAgents(agentId);
    if (!agent) {
      return res.status(409).json({ error: "This agent isn't in Production, or their group isn't monitored." });
    }
    if (!agent.supported) {
      return res.status(409).json({
        error: `The agent's PC runs Sentinel ${agent.appVersion || "(unknown version)"} - live monitoring needs 2.4.16 or later.`,
      });
    }

    const result = liveMonitor.start(agentId, req.session.displayName);
    if (result.error) return res.status(409).json({ error: result.error });

    await logAction(req, "monitored", "agent", agentId,
      `Started live monitoring of ${agent.displayName} (${agentId}) on ${agent.machineName}.`);
    res.json({ sessionId: result.sessionId, agent });
  } catch (err) {
    console.error("Error starting live monitoring:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// The viewer's stream - see services/liveMonitor.js for the framing.
// ?at=<ms epoch> replays from that point instead of following live.
router.get("/sessions/:sessionId/stream", (req, res) => {
  const at = req.query.at != null ? Number(req.query.at) : null;
  if (at != null && !Number.isFinite(at)) {
    return res.status(400).json({ error: "at must be a time in milliseconds." });
  }
  if (!liveMonitor.getSession(req.params.sessionId)) {
    return res.status(404).json({ error: "This live monitoring session has ended." });
  }
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-cache, no-store",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  liveMonitor.attachViewer(req.params.sessionId, res, at);
});

module.exports = router;
