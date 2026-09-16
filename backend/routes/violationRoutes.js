"use strict";

const express = require("express");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");
const { requireInternalApiKey } = require("../middleware/requireInternalApiKey");
const { sendViolationAlertEmail } = require("../services/emailService");

const router = express.Router();

// Called by the DESKTOP SERVICE (ProxyEnforcer.cs / ViolationReporter.cs)
// the moment a restricted site gets blocked - not a browser session, so
// this uses the API key middleware, not requireAuth.
router.post("/", requireInternalApiKey, async (req, res) => {
  const { agentId, domain, path } = req.body || {};

  if (!agentId || !domain) {
    return res.status(400).json({ error: "agentId and domain are required." });
  }

  try {
    const [agentRows] = await db.query(
      "SELECT display_name, group_id FROM agents WHERE agent_id = ?", [agentId]
    );
    const agentDisplayName = agentRows[0]?.display_name ?? agentId;
    const groupId = agentRows[0]?.group_id ?? null;
    const blockedAt = new Date();

    await db.query(
      "INSERT INTO restriction_violations (agent_id, group_id, domain, path, blocked_at) VALUES (?, ?, ?, ?, ?)",
      [agentId, groupId, domain, path || "/", blockedAt]
    );

    // Email everyone who can currently see/manage restrictions - Admin
    // and Super Admin. Best-effort: a failed email should never make
    // this endpoint report failure back to the desktop service, since
    // the violation is already durably logged either way.
    const [recipients] = await db.query(
      "SELECT email FROM web_users WHERE role IN ('admin','super_admin') AND is_active = TRUE"
    );
    for (const recipient of recipients) {
      try {
        await sendViolationAlertEmail(
          recipient.email, agentDisplayName, agentId, domain, path || "/", blockedAt.toISOString()
        );
      } catch (emailErr) {
        console.error(`Failed to send violation alert to ${recipient.email}:`, emailErr);
      }
    }

    res.status(201).json({ logged: true });
  } catch (err) {
    console.error("Error recording restriction violation:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// Viewing is a normal browser session - Admin/Super Admin only for now,
// matching where restriction MANAGEMENT lives (Groups & Restrictions is
// super_admin-only, Admin still has operational visibility here).
router.get("/", requireAuth, requireRole("admin", "super_admin"), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT v.violation_id, v.agent_id, a.display_name, v.group_id, g.group_name,
              v.domain, v.path, v.blocked_at
       FROM restriction_violations v
       LEFT JOIN agents a ON a.agent_id = v.agent_id
       LEFT JOIN agent_groups g ON g.group_id = v.group_id
       ORDER BY v.blocked_at DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error listing violations:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;
