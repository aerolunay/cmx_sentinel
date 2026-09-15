"use strict";

const express = require("express");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");

const router = express.Router();

const VALID_ROLES = ["admin", "tqa", "supervisor", "manager"];
const EMPLOYEE_ID_PATTERN = /^\d+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Everything here requires being logged in AND being an admin - Users
// management is admin-only, TQA/Supervisor/Manager never see this.
router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT user_id, role, login_identifier, email, display_name, is_active, created_at
       FROM web_users ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error listing users:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.post("/", async (req, res) => {
  const { role, loginIdentifier, email, displayName } = req.body || {};

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

  // Admins log in with a numeric Employee ID; everyone else logs in
  // with their email - enforced here at CREATION time as the intended
  // convention, even though login itself now accepts either field
  // (see otpService.js) as a convenience.
  if (role === "admin" && !EMPLOYEE_ID_PATTERN.test(trimmedIdentifier)) {
    return res.status(400).json({ error: "Admin login identifier must be a numeric Employee ID." });
  }
  if (role !== "admin" && !EMAIL_PATTERN.test(trimmedIdentifier)) {
    return res.status(400).json({ error: "Login identifier must be a valid email address for this role." });
  }

  try {
    const [result] = await db.query(
      `INSERT INTO web_users (role, login_identifier, email, display_name)
       VALUES (?, ?, ?, ?)`,
      [role, trimmedIdentifier, email.trim(), displayName.trim()]
    );

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
  const { role, loginIdentifier, email, displayName } = req.body || {};

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

  if (role === "admin" && !EMPLOYEE_ID_PATTERN.test(trimmedIdentifier)) {
    return res.status(400).json({ error: "Admin login identifier must be a numeric Employee ID." });
  }
  if (role !== "admin" && !EMAIL_PATTERN.test(trimmedIdentifier)) {
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