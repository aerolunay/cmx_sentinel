"use strict";

const db = require("../config/db");
const { workSetupForIp } = require("./workSetup");

// Which CMX Sentinel Desktop version each agent PC runs (sql/014,
// shown on the Desktop Updates page). Desktop 2.3.10+ sends
// X-Cmx-Machine / X-Cmx-Version on every /api/desktop-sync request and
// a heartbeat every 30 minutes; recordClient is the middleware for
// that router.
//
// A busy PC makes a request every few seconds, so each PC is written
// at most once per WRITE_EVERY_MS - sooner when its version or agent
// changes.
const WRITE_EVERY_MS = 2 * 60 * 1000;
const MACHINE = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const lastWrites = new Map(); // machine -> { at, version, agentId }
let tableMissingUntil = 0;

function recordClient(req, res, next) {
  next();
  const machine = req.get("X-Cmx-Machine");
  const version = req.get("X-Cmx-Version");
  if (!machine || !version || !MACHINE.test(machine) || !VERSION.test(version)) return;
  const now = Date.now();
  if (now < tableMissingUntil) return;

  const rawAgent = (req.body && req.body.agentId) || (req.query && req.query.agentId) || null;
  const agentId = rawAgent && /^[A-Za-z0-9-]{1,32}$/.test(String(rawAgent)) ? String(rawAgent) : null;
  const last = lastWrites.get(machine);
  if (last && now - last.at < WRITE_EVERY_MS && last.version === version && (!agentId || last.agentId === agentId)) return;
  lastWrites.set(machine, { at: now, version, agentId: agentId || (last && last.agentId) || null });

  db.query(
    `INSERT INTO desktop_clients (machine_name, app_version, last_agent_id, last_ip, work_setup, last_seen_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE app_version = VALUES(app_version),
       last_agent_id = COALESCE(VALUES(last_agent_id), last_agent_id),
       last_ip = VALUES(last_ip), work_setup = VALUES(work_setup), last_seen_at = CURRENT_TIMESTAMP`,
    [machine, version, agentId, req.ip || null, workSetupForIp(req.ip)]
  ).catch((err) => {
    lastWrites.delete(machine);
    if (err && err.code === "ER_NO_SUCH_TABLE") {
      tableMissingUntil = Date.now() + 5 * 60 * 1000; // run sql/014; checked again in 5 minutes
      return;
    }
    console.error("Could not record desktop client version:", err);
  });
}

module.exports = { recordClient };
