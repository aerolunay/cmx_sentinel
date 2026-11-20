"use strict";

const express = require("express");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole, requireRoleOrReadOnly } = require("../middleware/requireRole");
const { logAction } = require("../services/auditLog");
const { hasColumn } = require("../services/workSetup");
const liveMonitor = require("../services/liveMonitor");

// Per-group switches, ticked on the Add/Edit Group form:
// - recording_enabled (sql/020): only agents in a group with it on are
//   screen-recorded by the desktop - see services/groupRecording.js.
// - monitoring_enabled (sql/021): only agents in a group with it on can
//   be watched live from the Monitor page - see routes/monitorRoutes.js.
// Until a column exists the switch reads as off and isn't saved.
const GROUP_FLAGS = [
  { column: "recording_enabled", bodyKey: "recordingEnabled", label: "recordings" },
  { column: "monitoring_enabled", bodyKey: "monitoringEnabled", label: "monitoring" },
];

// agent_groups.recording_retention_hours (sql/022): how long the group's
// recordings stay in S3 before scripts/deleteOldRecordings.js purges them.
// 24 by default; always 0 while recordings are off (nothing is kept).
const RETENTION_COLUMN = "recording_retention_hours";
const DEFAULT_RETENTION_HOURS = 24;
const MAX_RETENTION_HOURS = 87600; // 10 years

function hasRetentionColumn() {
  return hasColumn("agent_groups", RETENTION_COLUMN);
}

// The hours sent by the page, or undefined if none was sent. Throws with
// a message for the page if it's not a whole number in range.
function requestedHours(body) {
  const raw = body?.recordingRetentionHours;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RETENTION_HOURS) {
    const err = new Error(`Enter how many hours to keep recordings: a whole number from 1 to ${MAX_RETENTION_HOURS.toLocaleString("en-US")}.`);
    err.status = 400;
    throw err;
  }
  return n;
}

async function presentFlags() {
  const present = [];
  for (const flag of GROUP_FLAGS) {
    if (await hasColumn("agent_groups", flag.column)) present.push(flag);
  }
  return present;
}

const router = express.Router();

router.use(requireAuth);

// Listing groups is also open to Admin - they assign agents to groups on
// the agent edit form (agentRoutes.js allows that), which needs this
// list for its dropdown. Everything else here (creating/renaming/
// deleting groups, editing restrictions) stays Super Admin only.
router.get("/", requireRole("admin", "super_admin", "compliance"), async (req, res) => {
  try {
    // restriction_count is informational only (shown in GroupsPage's
    // table so an admin can tell at a glance which groups actually
    // have rules configured vs. empty placeholders) - full restriction
    // details are fetched separately per-group via GET /:groupId/restrictions
    // when that group's detail page is actually opened.
    const present = await presentFlags();
    const flagCols = GROUP_FLAGS.map((f) =>
      `${present.includes(f) ? `g.${f.column}` : "FALSE"} AS ${f.column}`).join(", ");
    const retentionCol = (await hasRetentionColumn())
      ? `g.${RETENTION_COLUMN}`
      : `${present.some((f) => f.column === "recording_enabled") ? "IF(g.recording_enabled, 24, 0)" : "0"}`;
    const [rows] = await db.query(`
      SELECT g.group_id, g.group_name, ${flagCols}, ${retentionCol} AS ${RETENTION_COLUMN},
             COUNT(rp.restriction_id) AS restriction_count
      FROM agent_groups g
      LEFT JOIN restricted_paths rp ON rp.group_id = g.group_id
      GROUP BY g.group_id
      ORDER BY g.group_name ASC
    `);
    res.json(rows.map((r) => {
      const out = { ...r };
      for (const f of GROUP_FLAGS) out[f.column] = Boolean(r[f.column]);
      out[RETENTION_COLUMN] = Number(r[RETENTION_COLUMN]) || 0;
      return out;
    }));
  } catch (err) {
    console.error("Error listing groups:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// Compliance reads groups and restrictions (GET) but changes nothing.
router.use(requireRoleOrReadOnly(["super_admin"]));

router.post("/", async (req, res) => {
  const { groupName } = req.body || {};
  if (!groupName || !groupName.trim()) {
    return res.status(400).json({ error: "Enter a group name." });
  }

  try {
    // New groups get each switch on unless its checkbox was unticked.
    const present = await presentFlags();
    const values = {};
    for (const f of GROUP_FLAGS) values[f.column] = present.includes(f) && req.body?.[f.bodyKey] !== false;

    const hasRetention = await hasRetentionColumn();
    const hours = values.recording_enabled ? (requestedHours(req.body) ?? DEFAULT_RETENTION_HOURS) : 0;
    values[RETENTION_COLUMN] = hours;

    const columns = ["group_name", ...present.map((f) => f.column), ...(hasRetention ? [RETENTION_COLUMN] : [])];
    const [result] = await db.query(
      `INSERT INTO agent_groups (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      [groupName.trim(), ...present.map((f) => values[f.column]), ...(hasRetention ? [hours] : [])]
    );
    const summary = GROUP_FLAGS.map((f) => `${f.label} ${values[f.column] ? "enabled" : "disabled"}`).join(", ") +
      (values.recording_enabled ? `, recordings kept ${hours}h` : "");
    await logAction(req, "created", "group", result.insertId, `Created group "${groupName.trim()}" (${summary}).`);
    res.status(201).json({
      group_id: result.insertId,
      group_name: groupName.trim(),
      ...values,
      restriction_count: 0,
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
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
    const [[before]] = await db.query("SELECT * FROM agent_groups WHERE group_id = ?", [groupId]);
    if (!before) {
      return res.status(404).json({ error: "Group not found." });
    }

    // A switch left out of the request (an older page) keeps its setting.
    const present = await presentFlags();
    const was = {};
    const now = {};
    for (const f of GROUP_FLAGS) {
      was[f.column] = present.includes(f) ? Boolean(before[f.column]) : false;
      now[f.column] = present.includes(f) && typeof req.body?.[f.bodyKey] === "boolean"
        ? req.body[f.bodyKey]
        : was[f.column];
    }

    // Hours: 0 while recordings are off. Turned on (or left on) with no
    // hours sent: keep the current hours, or 24 if there were none.
    const hasRetention = await hasRetentionColumn();
    const wasHours = hasRetention ? Number(before[RETENTION_COLUMN]) || 0 : (was.recording_enabled ? DEFAULT_RETENTION_HOURS : 0);
    const asked = requestedHours(req.body);
    const nowHours = !now.recording_enabled ? 0 : (asked ?? (wasHours > 0 ? wasHours : DEFAULT_RETENTION_HOURS));

    const sets = ["group_name = ?", ...present.map((f) => `${f.column} = ?`), ...(hasRetention ? [`${RETENTION_COLUMN} = ?`] : [])];
    await db.query(`UPDATE agent_groups SET ${sets.join(", ")} WHERE group_id = ?`,
      [groupName.trim(), ...present.map((f) => now[f.column]), ...(hasRetention ? [nowHours] : []), groupId]);

    const changes = [];
    if (before.group_name !== groupName.trim()) changes.push(`renamed "${before.group_name}" to "${groupName.trim()}"`);
    for (const f of GROUP_FLAGS) {
      if (was[f.column] !== now[f.column]) changes.push(`${f.label} ${now[f.column] ? "enabled" : "disabled"}`);
    }
    if (hasRetention && wasHours !== nowHours) changes.push(`recordings kept ${wasHours}h -> ${nowHours}h`);
    if (changes.length > 0) {
      await logAction(req, "updated", "group", groupId, `Group "${groupName.trim()}": ${changes.join(", ")}.`);
    }

    // Monitoring turned off: anyone in this group being watched stops now.
    if (was.monitoring_enabled && !now.monitoring_enabled) {
      const [members] = await db.query("SELECT agent_id FROM agents WHERE group_id = ?", [groupId]);
      for (const m of members) liveMonitor.stopForAgent(m.agent_id, "Monitoring was turned off for this agent's group.");
    }

    res.json({ group_id: Number(groupId), group_name: groupName.trim(), ...now, [RETENTION_COLUMN]: nowHours });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
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

// A wildcard-only pattern (just '*', '.', and whitespace, no real
// substring left) would match literally every domain - almost
// certainly a typo, not an intentional "block the entire internet for
// this group" rule. Stripping '*' and '.' and requiring SOMETHING
// left over catches "*", "*.*", "**", etc. while still allowing a
// real pattern like "*porn*.*" (leaves "porn") through untouched.
function isDangerouslyBroadPattern(domain) {
  return domain.replace(/[*.\s]/g, "").length === 0;
}

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
  if (isDangerouslyBroadPattern(domain.trim())) {
    return res.status(400).json({ error: "This pattern matches every possible domain - narrow it down (e.g. \"*porn*.*\", not just \"*\")." });
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
  if (isDangerouslyBroadPattern(domain.trim())) {
    return res.status(400).json({ error: "This pattern matches every possible domain - narrow it down (e.g. \"*porn*.*\", not just \"*\")." });
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

// Copies every restriction from :groupId into another existing group.
// Rules the target already has (same domain + path_prefix) are skipped
// rather than duplicated, so copying twice is harmless. Active/disabled
// state is carried over as-is.
router.post("/:groupId/restrictions/copy", async (req, res) => {
  const { groupId } = req.params;
  const targetGroupId = Number(req.body?.targetGroupId);

  if (!targetGroupId) {
    return res.status(400).json({ error: "Select a group to copy to." });
  }
  if (targetGroupId === Number(groupId)) {
    return res.status(400).json({ error: "Select a different group to copy to." });
  }

  try {
    const [groupRows] = await db.query(
      "SELECT group_id, group_name FROM agent_groups WHERE group_id IN (?, ?)",
      [groupId, targetGroupId]
    );
    const source = groupRows.find((g) => g.group_id === Number(groupId));
    const target = groupRows.find((g) => g.group_id === targetGroupId);
    if (!source || !target) {
      return res.status(404).json({ error: "Group not found." });
    }

    const [[{ total }]] = await db.query(
      "SELECT COUNT(*) AS total FROM restricted_paths WHERE group_id = ?",
      [groupId]
    );
    const [result] = await db.query(
      `INSERT INTO restricted_paths (group_id, domain, path_prefix, is_active)
       SELECT ?, src.domain, src.path_prefix, src.is_active
       FROM restricted_paths src
       WHERE src.group_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM restricted_paths dst
           WHERE dst.group_id = ? AND dst.domain = src.domain AND dst.path_prefix = src.path_prefix
         )`,
      [targetGroupId, groupId, targetGroupId]
    );
    const copied = result.affectedRows;
    const skipped = Number(total) - copied;

    await logAction(req, "copied", "restriction", groupId,
      `Copied ${copied} restriction(s) from group "${source.group_name}" to "${target.group_name}"` +
      (skipped > 0 ? ` (${skipped} already present, skipped).` : "."));
    res.json({ copied, skipped });
  } catch (err) {
    console.error("Error copying restrictions:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;
