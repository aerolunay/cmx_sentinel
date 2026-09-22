"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");
const { sendTempPasswordEmail } = require("../services/emailService");
const { logAction } = require("../services/auditLog");

const router = express.Router();

router.use(requireAuth, requireRole("admin", "super_admin"));

const EMPLOYEE_ID_PATTERN = /^\d+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Memory storage (never touches disk) - a roster CSV is tiny compared
// to the recordings/uploads this app otherwise handles, so there's no
// reason to stream it to a temp file first. 2MB comfortably covers
// even a several-thousand-row roster in plain CSV.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isCsv = file.mimetype === "text/csv" || file.originalname.toLowerCase().endsWith(".csv");
    cb(isCsv ? null : new Error("Only .csv files are accepted."), isCsv);
  },
});

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

// Mass agent creation via CSV, matching the same "safe to re-upload"
// UX as schedules' bulk upload (see SchedulerPage.jsx's MassUploadTab
// and /api/schedules/bulk-upload): NEW Agent IDs get created (with a
// temp password issued and emailed, same as the single-agent form) -
// EXISTING Agent IDs just get their profile fields (name/email/group)
// updated in place, exactly like the PUT /:agentId route below, and
// deliberately do NOT get a new temp password or another email - a
// re-upload to fix a typo in someone's name shouldn't also reset
// their password or spam everyone else in the file a second time.
//
// Response shape mirrors bulk-upload-schedules exactly
// ({ totalRows, savedRows, errors: [{row, message}] }) so the frontend
// can reuse the identical results-table rendering.
router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  let records;
  try {
    records = parse(req.file.buffer, {
      columns: (headerRow) => headerRow.map((h) => h.trim()),
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err) {
    return res.status(400).json({ error: `Could not read that file as CSV: ${err.message}` });
  }

  if (records.length === 0) {
    return res.status(400).json({ error: "The file has no data rows." });
  }

  // Loaded once, up front - looking a group name up per-row would be
  // one query per row for no reason, and there are only ever a
  // handful of groups.
  const [groupRows] = await db.query("SELECT group_id, group_name FROM agent_groups");
  const groupIdByName = new Map(groupRows.map((g) => [g.group_name.trim().toLowerCase(), g.group_id]));

  const [existingRows] = await db.query("SELECT agent_id FROM agents");
  const existingAgentIds = new Set(existingRows.map((r) => r.agent_id));

  const errors = [];
  let savedRows = 0;

  // Sequential, not Promise.all - each new agent triggers a real email
  // send (issueTempPassword below); firing dozens of those at once
  // needlessly hammers the SMTP connection for a roster upload that
  // isn't time-sensitive to the second.
  for (let i = 0; i < records.length; i++) {
    const rowNum = i + 2; // +1 for 1-indexing, +1 for the header row
    const record = records[i];

    const agentId = (record["Agent ID"] || "").trim();
    const displayName = (record["Agent Name"] || record["Display Name"] || "").trim();
    const email = (record["Email"] || "").trim();
    const groupName = (record["Group"] || "").trim();

    if (!agentId || !EMPLOYEE_ID_PATTERN.test(agentId)) {
      errors.push({ row: rowNum, message: "Agent ID must be numeric." });
      continue;
    }
    if (!displayName) {
      errors.push({ row: rowNum, message: "Agent Name is required." });
      continue;
    }
    if (!email || !EMAIL_PATTERN.test(email)) {
      errors.push({ row: rowNum, message: "A valid Email is required - the temporary password is sent here for new agents." });
      continue;
    }

    let groupId = null;
    if (groupName) {
      groupId = groupIdByName.get(groupName.toLowerCase());
      if (groupId === undefined) {
        errors.push({ row: rowNum, message: `Group "${groupName}" doesn't exist - check spelling or leave blank for no group.` });
        continue;
      }
    }

    try {
      if (existingAgentIds.has(agentId)) {
        await db.query(
          "UPDATE agents SET display_name = ?, email = ?, group_id = ? WHERE agent_id = ?",
          [displayName, email, groupId, agentId]
        );
      } else {
        const placeholderHash = await bcrypt.hash(crypto.randomBytes(16).toString("hex"), 4);
        await db.query(
          `INSERT INTO agents (agent_id, display_name, email, password_hash, must_reset_password, is_active, group_id)
           VALUES (?, ?, ?, ?, TRUE, TRUE, ?)`,
          [agentId, displayName, email, placeholderHash, groupId]
        );
        await issueTempPassword(agentId, email);
        await logAction(req, "created", "agent_credential", agentId,
          `Created agent ${displayName} (${agentId}) via bulk upload, temp password issued.`);
        existingAgentIds.add(agentId); // so a duplicate row later in the SAME file updates rather than re-inserts
      }
      savedRows++;
    } catch (err) {
      console.error(`Bulk agent upload row ${rowNum} (${agentId}) failed:`, err);
      errors.push({ row: rowNum, message: "A server error occurred saving this row." });
    }
  }

  res.json({ totalRows: records.length, savedRows, errors });
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