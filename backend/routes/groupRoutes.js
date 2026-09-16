"use strict";

const express = require("express");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");
const { logAction } = require("../services/auditLog");

const router = express.Router();

router.use(requireAuth, requireRole("super_admin"));

router.get("/", async (req, res) => {
  try {
    // restriction_count is informational only (shown in GroupsPage's
    // table so an admin can tell at a glance which groups actually
    // have rules configured vs. empty placeholders) - full restriction
    // details are fetched separately per-group via GET /:groupId/restrictions
    // when that group's detail page is actually opened.
    const [rows] = await db.query(`
      SELECT g.group_id, g.group_name,
             COUNT(rp.restriction_id) AS restriction_count
      FROM agent_groups g
      LEFT JOIN restricted_paths rp ON rp.group_id = g.group_id
      GROUP BY g.group_id, g.group_name
      ORDER BY g.group_name ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error listing groups:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.post("/", async (req, res) => {
  const { groupName } = req.body || {};
  if (!groupName || !groupName.trim()) {
    return res.status(400).json({ error: "Enter a group name." });
  }

  try {
    const [result] = await db.query("INSERT INTO agent_groups (group_name) VALUES (?)", [groupName.trim()]);
    await logAction(req, "created", "group", result.insertId, `Created group "${groupName.trim()}".`);
    res.status(201).json({ group_id: result.insertId, group_name: groupName.trim(), restriction_count: 0 });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "A group with that name already exists." });
    }
    console.error("Error creating group:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.put("/:groupId", async (req, res) => {
  const { groupId } = req.params;
  const { groupName } = req.body || {};
  if (!groupName || !groupName.trim()) {
    return res.status(400).json({ error: "Enter a group name." });
  }

  try {
    const [result] = await db.query("UPDATE agent_groups SET group_name = ? WHERE group_id = ?", [
      groupName.trim(),
      groupId,
    ]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Group not found." });
    }
    await logAction(req, "updated", "group", groupId, `Renamed group to "${groupName.trim()}".`);
    res.json({ group_id: Number(groupId), group_name: groupName.trim() });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "A group with that name already exists." });
    }
    console.error("Error updating group:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.delete("/:groupId", async (req, res) => {
  const { groupId } = req.params;

  try {
    const [nameRows] = await db.query("SELECT group_name FROM agent_groups WHERE group_id = ?", [groupId]);
    const groupName = nameRows[0]?.group_name ?? `#${groupId}`;

    // Unassign any agents currently in this group first (matches the
    // confirmation text GroupsPage.jsx shows: "Agents assigned to it
    // will become unassigned, not deleted") - don't rely on an assumed
    // FK cascade behavior for something this important, handle it
    // explicitly so the outcome is certain either way.
    await db.query("UPDATE agents SET group_id = NULL WHERE group_id = ?", [groupId]);
    const [result] = await db.query("DELETE FROM agent_groups WHERE group_id = ?", [groupId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Group not found." });
    }
    await logAction(req, "deleted", "group", groupId, `Deleted group "${groupName}".`);
    res.json({ deleted: true });
  } catch (err) {
    console.error("Error deleting group:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.get("/:groupId/restrictions", async (req, res) => {
  const { groupId } = req.params;
  try {
    const [rows] = await db.query(
      "SELECT restriction_id, group_id, domain, path_prefix, is_active FROM restricted_paths WHERE group_id = ? ORDER BY domain ASC",
      [groupId]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error listing restrictions:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.post("/:groupId/restrictions", async (req, res) => {
  const { groupId } = req.params;
  const { domain, pathPrefix, isActive } = req.body || {};

  if (!domain || !domain.trim()) {
    return res.status(400).json({ error: "Enter a domain to restrict." });
  }

  try {
    const [result] = await db.query(
      "INSERT INTO restricted_paths (group_id, domain, path_prefix, is_active) VALUES (?, ?, ?, ?)",
      [groupId, domain.trim(), (pathPrefix && pathPrefix.trim()) || "/", isActive !== false]
    );
    await logAction(req, "created", "restriction", result.insertId,
      `Added restriction on ${domain.trim()}${(pathPrefix && pathPrefix.trim()) || "/"} to group #${groupId}.`);
    res.status(201).json({
      restriction_id: result.insertId,
      group_id: Number(groupId),
      domain: domain.trim(),
      path_prefix: (pathPrefix && pathPrefix.trim()) || "/",
      is_active: isActive !== false,
    });
  } catch (err) {
    console.error("Error adding restriction:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.put("/:groupId/restrictions/:restrictionId", async (req, res) => {
  const { restrictionId } = req.params;
  const { domain, pathPrefix, isActive } = req.body || {};

  if (!domain || !domain.trim()) {
    return res.status(400).json({ error: "Enter a domain to restrict." });
  }

  try {
    const [result] = await db.query(
      "UPDATE restricted_paths SET domain = ?, path_prefix = ?, is_active = ? WHERE restriction_id = ?",
      [domain.trim(), (pathPrefix && pathPrefix.trim()) || "/", isActive !== false, restrictionId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Restriction not found." });
    }
    await logAction(req, "updated", "restriction", restrictionId,
      `Updated restriction to ${domain.trim()}${(pathPrefix && pathPrefix.trim()) || "/"}, active=${isActive !== false}.`);
    res.json({
      restriction_id: Number(restrictionId),
      domain: domain.trim(),
      path_prefix: (pathPrefix && pathPrefix.trim()) || "/",
      is_active: isActive !== false,
    });
  } catch (err) {
    console.error("Error updating restriction:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.delete("/:groupId/restrictions/:restrictionId", async (req, res) => {
  const { restrictionId } = req.params;
  try {
    const [result] = await db.query("DELETE FROM restricted_paths WHERE restriction_id = ?", [restrictionId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Restriction not found." });
    }
    await logAction(req, "deleted", "restriction", restrictionId, `Deleted restriction #${restrictionId}.`);
    res.json({ deleted: true });
  } catch (err) {
    console.error("Error deleting restriction:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;
