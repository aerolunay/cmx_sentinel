"use strict";

const express = require("express");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");

const router = express.Router();

router.use(requireAuth, requireRole("super_admin"));

router.get("/", async (req, res) => {
  try {
    // Most-recent-first, capped at 500 - this is a viewer for recent
    // activity, not a full export tool. If you need older history or
    // a filtered export later, that's a reasonable next addition here.
    const [rows] = await db.query(
      `SELECT log_id, actor_display_name, action, entity_type, entity_id, details, created_at
       FROM audit_log ORDER BY created_at DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error listing audit log:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;
