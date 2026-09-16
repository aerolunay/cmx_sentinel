"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");
const { sendTempPasswordEmail } = require("../services/emailService");
const { logAction } = require("../services/auditLog");

const router = express.Router();

router.use(requireAuth, requireRole("admin", "super_admin"));

const EMPLOYEE_ID_PATTERN = /^\d+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Shared by both "create agent" and "reset password" - generates a
// fresh temp password, hashes it the SAME way the desktop service's
// own AuthService does (bcrypt - a standardized algorithm, fully
// cross-compatible between bcryptjs here and BCrypt.Net-Next on the
// desktop side; the cost factor doesn't need to match either, since
// bcrypt embeds it directly in the hash string), and emails the
// PLAINTEXT temp password (only ever exists in memory here, never
// stored anywhere) to the agent.
//
// NOTE - a real gap worth knowing: must_reset_password is set
// correctly by both callers of this, but the DESKTOP APP doesn't
// enforce it yet (explicitly deferred - see AgentState.cs/
// MiniPanelForm.cs comments). Until that's built, a temp password
// works as a completely normal, permanent password if the agent just
// keeps using it - the flag is set correctly and ready for when
// enforcement is added, but nothing currently forces the change.
async function issueTempPassword(agentId, agentEmail) {
  const tempPassword = crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12);
  const passwordHash = await bcrypt.hash(tempPassword, 11);

  await db.query(
    "UPDATE agents SET password_hash = ?, must_reset_password = TRUE WHERE agent_id = ?",
    [passwordHash, agentId]
  );

  await sendTempPasswordEmail(agentEmail, agentId, tempPassword);
}

router.get("/", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT a.agent_id, a.display_name, a.email, a.is_active, a.must_reset_password,
              a.group_id, g.group_name
       FROM agents a
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       ORDER BY a.display_name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error listing agents:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.post("/", async (req, res) => {
  const { agentId, displayName, email, groupId } = req.body || {};

  if (!agentId || !EMPLOYEE_ID_PATTERN.test(agentId.trim())) {
    return res.status(400).json({ error: "Agent ID must be numeric." });
  }
  if (!displayName || !displayName.trim()) {
    return res.status(400).json({ error: "Enter a display name." });
  }
  if (!email || !EMAIL_PATTERN.test(email.trim())) {
    return res.status(400).json({ error: "Enter a valid email address - the temporary password is sent here." });
  }

  const trimmedAgentId = agentId.trim();
  const trimmedEmail = email.trim();
  // Empty string / undefined means "no group" (NULL) - matches the
  // schema's own convention (agents.group_id nullable = no website
  // restrictions enforced).
  const resolvedGroupId = groupId ? Number(groupId) : null;

  try {
    // Insert with a random throwaway hash first - issueTempPassword
    // below immediately overwrites it with the REAL generated temp
    // password. This just avoids a moment where the row exists with no
    // password at all (password_hash is NOT NULL in the schema).
    const placeholderHash = await bcrypt.hash(crypto.randomBytes(16).toString("hex"), 4);

    await db.query(
      `INSERT INTO agents (agent_id, display_name, email, password_hash, must_reset_password, is_active, group_id)
       VALUES (?, ?, ?, ?, TRUE, TRUE, ?)`,
      [trimmedAgentId, displayName.trim(), trimmedEmail, placeholderHash, resolvedGroupId]
    );

    await issueTempPassword(trimmedAgentId, trimmedEmail);

    await logAction(req, "created", "agent_credential", trimmedAgentId,
      `Created agent ${displayName.trim()} (${trimmedAgentId}), temp password issued.`);

    res.status(201).json({
      agentId: trimmedAgentId,
      displayName: displayName.trim(),
      email: trimmedEmail,
      isActive: true,
      mustResetPassword: true,
      groupId: resolvedGroupId,
      message: `Agent created. Temporary password sent to ${trimmedEmail}.`,
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "That Agent ID is already in use." });
    }
    console.error("Error creating agent:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// Profile fields (display name, email, group) - deliberately does NOT
// touch the password or agent_id. agent_id is the login credential's
// identity and shouldn't change once created; password changes only
// happen through the explicit Reset Password action, kept separate on
// purpose so editing someone's name/email can never accidentally also
// reset their credentials.
router.put("/:agentId", async (req, res) => {
  const { agentId } = req.params;
  const { displayName, email, groupId } = req.body || {};

  if (!displayName || !displayName.trim()) {
    return res.status(400).json({ error: "Enter a display name." });
  }
  if (!email || !EMAIL_PATTERN.test(email.trim())) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const resolvedGroupId = groupId ? Number(groupId) : null;

  try {
    const [result] = await db.query(
      "UPDATE agents SET display_name = ?, email = ?, group_id = ? WHERE agent_id = ?",
      [displayName.trim(), email.trim(), resolvedGroupId, agentId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Agent not found." });
    }
    res.json({ agentId, displayName: displayName.trim(), email: email.trim(), groupId: resolvedGroupId });
  } catch (err) {
    console.error("Error updating agent:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.patch("/:agentId/status", async (req, res) => {
  const { agentId } = req.params;
  const { isActive } = req.body || {};

  if (typeof isActive !== "boolean") {
    return res.status(400).json({ error: "isActive must be true or false." });
  }

  try {
    const [result] = await db.query("UPDATE agents SET is_active = ? WHERE agent_id = ?", [
      isActive,
      agentId,
    ]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Agent not found." });
    }
    res.json({ agentId, isActive });
  } catch (err) {
    console.error("Error updating agent status:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.post("/:agentId/reset-password", async (req, res) => {
  const { agentId } = req.params;

  try {
    const [rows] = await db.query("SELECT email FROM agents WHERE agent_id = ?", [agentId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Agent not found." });
    }
    const agentEmail = rows[0].email;
    if (!agentEmail) {
      return res.status(400).json({ error: "This agent has no email on file - add one before resetting their password." });
    }

    await issueTempPassword(agentId, agentEmail);

    await logAction(req, "updated", "agent_credential", agentId,
      `Password reset for agent ${agentId}, temp password sent to ${agentEmail}.`);

    res.json({ message: `Temporary password sent to ${agentEmail}.` });
  } catch (err) {
    console.error("Error resetting agent password:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;