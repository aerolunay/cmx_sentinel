"use strict";

const express = require("express");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");

const router = express.Router();

const VALID_ROLES = ["super_admin", "admin", "tqa", "supervisor", "manager"];
// Roles that get scoped to specific groups (see web_user_groups) -
// Admin, Super Admin, and TQA see everything regardless, per the
// explicit request that only these two roles are group-restricted.
const GROUP_SCOPED_ROLES = ["supervisor", "manager"];
const EMPLOYEE_ID_PATTERN = /^\d+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Users management is super_admin-only - not even regular Admin can
// reach this.
router.use(requireAuth, requireRole("super_admin"));

async function setUserGroups(userId, groupIds) {
  await db.query("DELETE FROM web_user_groups WHERE user_id = ?", [userId]);
  if (Array.isArray(groupIds) && groupIds.length > 0) {
    const values = groupIds.map((gid) => [userId, Number(gid)]);
    await db.query("INSERT INTO web_user_groups (user_id, group_id) VALUES ?", [values]);
  }
}

router.get("/", async (req, res) => {
  try {
    const [users] = await db.query(
      `SELECT user_id, role, login_identifier, email, display_name, is_active, created_at
       FROM web_users ORDER BY created_at DESC`
    );
    const [groupLinks] = await db.query(
      `SELECT ug.user_id, ug.group_id, g.group_name
       FROM web_user_groups ug JOIN agent_groups g ON g.group_id = ug.group_id`
    );

    const usersWithGroups = users.map((u) => ({
      ...u,
      groups: groupLinks.filter((gl) => gl.user_id === u.user_id).map((gl) => ({
        group_id: gl.group_id,
        group_name: gl.group_name,
      })),
    }));

    res.json(usersWithGroups);
  } catch (err) {
    console.error("Error listing users:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.post("/", async (req, res) => {
  const { role, loginIdentifier, email, displayName, groupIds } = req.body || {};

  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: "Select a valid role." });
  }
  if (!displayName || !displayName.trim()) {
    return res.status(400).json({ error: "Enter a display name." });
  }
  if (!email || !EMAIL_PATTERN.test(email.trim())) {
    return res.status(400).json({ error: "Enter a valid email address - this is where OTP codes are sent." });
  }
  if (!loginIdentifier || !loginIdentifier.trim()) {
    return res.status(400).json({ error: "Enter a login identifier." });
  }

  const trimmedIdentifier = loginIdentifier.trim();
  // Admin and Super Admin log in with a numeric Employee ID; everyone
  // else logs in with their email - enforced here at CREATION time as
  // the intended convention, even though login itself now accepts
  // either field (see otpService.js) as a convenience.
  const usesEmployeeId = role === "admin" || role === "super_admin";

  if (usesEmployeeId && !EMPLOYEE_ID_PATTERN.test(trimmedIdentifier)) {
    return res.status(400).json({ error: "Admin/Super Admin login identifier must be a numeric Employee ID." });
  }
  if (!usesEmployeeId && !EMAIL_PATTERN.test(trimmedIdentifier)) {
    return res.status(400).json({ error: "Login identifier must be a valid email address for this role." });
  }

  try {
    const [result] = await db.query(
      `INSERT INTO web_users (role, login_identifier, email, display_name)
       VALUES (?, ?, ?, ?)`,
      [role, trimmedIdentifier, email.trim(), displayName.trim()]
    );

    if (GROUP_SCOPED_ROLES.includes(role)) {
      await setUserGroups(result.insertId, groupIds);
    }

    res.status(201).json({
      userId: result.insertId,
      role,
      loginIdentifier: trimmedIdentifier,
      email: email.trim(),
      displayName: displayName.trim(),
      isActive: true,
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "That login identifier is already in use." });
    }
    console.error("Error creating user:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.put("/:userId", async (req, res) => {
  const { userId } = req.params;
  const { role, loginIdentifier, email, displayName, groupIds } = req.body || {};

  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: "Select a valid role." });
  }
  if (!displayName || !displayName.trim()) {
    return res.status(400).json({ error: "Enter a display name." });
  }
  if (!email || !EMAIL_PATTERN.test(email.trim())) {
    return res.status(400).json({ error: "Enter a valid email address - this is where OTP codes are sent." });
  }
  if (!loginIdentifier || !loginIdentifier.trim()) {
    return res.status(400).json({ error: "Enter a login identifier." });
  }

  const trimmedIdentifier = loginIdentifier.trim();
  const usesEmployeeId = role === "admin" || role === "super_admin";

  if (usesEmployeeId && !EMPLOYEE_ID_PATTERN.test(trimmedIdentifier)) {
    return res.status(400).json({ error: "Admin/Super Admin login identifier must be a numeric Employee ID." });
  }
  if (!usesEmployeeId && !EMAIL_PATTERN.test(trimmedIdentifier)) {
    return res.status(400).json({ error: "Login identifier must be a valid email address for this role." });
  }

  try {
    const [result] = await db.query(
      `UPDATE web_users SET role = ?, login_identifier = ?, email = ?, display_name = ?
       WHERE user_id = ?`,
      [role, trimmedIdentifier, email.trim(), displayName.trim(), userId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    // Always reconcile group assignments on edit - if the role changed
    // AWAY from a group-scoped one, this correctly clears any groups
    // they no longer need; if it's group-scoped, this sets exactly the
    // submitted list.
    if (GROUP_SCOPED_ROLES.includes(role)) {
      await setUserGroups(userId, groupIds);
    } else {
      await setUserGroups(userId, []);
    }

    res.json({ userId: Number(userId), role, loginIdentifier: trimmedIdentifier, email: email.trim(), displayName: displayName.trim() });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "That login identifier is already in use." });
    }
    console.error("Error updating user:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.patch("/:userId/status", async (req, res) => {
  const { userId } = req.params;
  const { isActive } = req.body || {};

  if (typeof isActive !== "boolean") {
    return res.status(400).json({ error: "isActive must be true or false." });
  }

  try {
    const [result] = await db.query("UPDATE web_users SET is_active = ? WHERE user_id = ?", [
      isActive,
      userId,
    ]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "User not found." });
    }
    res.json({ userId: Number(userId), isActive });
  } catch (err) {
    console.error("Error updating user status:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;
