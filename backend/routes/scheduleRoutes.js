"use strict";

const express = require("express");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");
const { logAction } = require("../services/auditLog");

const router = express.Router();

// Same access level as Agents - shift scheduling is an operational
// admin function, not a reporting view (Reports/Recordings stay open
// to TQA/Supervisor/Manager, this doesn't).
router.use(requireAuth, requireRole("admin", "super_admin"));

const SHIFT_TYPE_PATTERN = /^.{1,32}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_UPLOAD_ROWS = 5000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB - a schedule CSV, even a large one, is nowhere near this
});

// Combines a shift_date + "HH:MM" start/end into full
// scheduled_start/scheduled_end DATETIME strings. If endTime is <=
// startTime, the shift is treated as crossing midnight and
// scheduled_end rolls to the NEXT calendar day - shift_date itself
// always stays the day the shift starts, matching the convention in
// sql/002_add_agent_schedules.sql.
function buildShiftWindow(shiftDate, startTime, endTime) {
  const scheduledStart = `${shiftDate} ${startTime}:00`;
  const crossesMidnight = endTime <= startTime;
  const endDate = crossesMidnight ? addOneDay(shiftDate) : shiftDate;
  const scheduledEnd = `${endDate} ${endTime}:00`;
  return { scheduledStart, scheduledEnd };
}

function addOneDay(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

// Pulls "HH:MM" back out of a DATETIME value (mysql2 returns DATETIME
// columns as JS Date objects in LOCAL server time by default, but
// since these are stored as naive Eastern wall-clock strings with no
// timezone info attached, reading the wall-clock digits back out
// requires going through the raw string mysql2 also exposes via
// dateStrings - see config/db.js - rather than Date methods, which
// would silently reinterpret them through the server's own local
// timezone.)
function toHHMM(dateTimeString) {
  return dateTimeString.slice(11, 16);
}

function validateShiftFields({ shiftDate, shiftType, startTime, endTime }) {
  if (!shiftDate || !DATE_PATTERN.test(shiftDate)) {
    return "Shift date must be in YYYY-MM-DD format.";
  }
  if (!shiftType || !SHIFT_TYPE_PATTERN.test(shiftType)) {
    return "Shift type is required (max 32 characters).";
  }
  if (!startTime || !TIME_PATTERN.test(startTime)) {
    return "Start time must be in HH:MM (24-hour) format.";
  }
  if (!endTime || !TIME_PATTERN.test(endTime)) {
    return "End time must be in HH:MM (24-hour) format.";
  }
  return null;
}

// GET /api/schedules/search-agents?q=... - powers the "find an agent
// by ID or name" box on the Edit Schedule tab. Matches agent_id
// (exact or partial) OR display_name (partial, case-insensitive).
router.get("/search-agents", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);

  try {
    const [rows] = await db.query(
      `SELECT a.agent_id, a.display_name, a.group_id, g.group_name
       FROM agents a
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       WHERE a.agent_id LIKE ? OR a.display_name LIKE ?
       ORDER BY a.display_name ASC
       LIMIT 20`,
      [`%${q}%`, `%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error searching agents for scheduling:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// GET /api/schedules?agentId=...&dateFrom=...&dateTo=... - one
// agent's shift rows for the Edit Schedule tab. Defaults to a
// -30/+90 day window around today (Eastern) when no explicit range is
// given - wide enough to cover "just missed a recent shift" and
// "scheduling a few months out" without pulling an agent's entire
// history by default.
// GET /api/schedules?agentId=...&dateFrom=...&dateTo=...&q=...
//
// Two modes, one query:
//   - agentId given (the Edit Agent Schedule tab, once an agent is
//     selected): every shift for that one agent in range. dateFrom/
//     dateTo default to a -30/+90 day window around today (Eastern)
//     when omitted, but the caller can always pass an explicit wider
//     range - this is what makes a shift someone loaded directly via
//     Workbench for a date outside that default window show up once
//     the range is widened, rather than it looking like the search
//     itself failed to find the agent.
//   - agentId omitted (the All Schedules tab): every agent's shifts
//     in range, optionally narrowed further by q (matches agent_id OR
//     display_name, same as /search-agents). dateFrom/dateTo default
//     to the current Eastern calendar month when omitted, since
//     browsing every agent's entire history by default would be a lot
//     of rows for very little benefit.
router.get("/", async (req, res) => {
  const { agentId, q } = req.query;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

  let dateFrom = req.query.dateFrom;
  let dateTo = req.query.dateTo;
  if (!dateFrom || !dateTo) {
    if (agentId) {
      dateFrom = dateFrom || addDaysToDateString(today, -30);
      dateTo = dateTo || addDaysToDateString(today, 90);
    } else {
      dateFrom = dateFrom || `${today.slice(0, 7)}-01`;
      // Comfortably covers the rest of the month regardless of
      // length; extra days beyond month-end are harmless since
      // nothing is scheduled there under THIS month's key anyway.
      dateTo = dateTo || addDaysToDateString(`${today.slice(0, 7)}-01`, 45);
    }
  }

  const conditions = ["s.shift_date BETWEEN ? AND ?"];
  const params = [dateFrom, dateTo];
  if (agentId) {
    conditions.push("s.agent_id = ?");
    params.push(agentId);
  }
  if (q && q.trim()) {
    conditions.push("(s.agent_id LIKE ? OR a.display_name LIKE ?)");
    params.push(`%${q.trim()}%`, `%${q.trim()}%`);
  }

  try {
    const [rows] = await db.query(
      `SELECT s.schedule_id, s.agent_id, a.display_name, a.group_id, g.group_name,
              DATE_FORMAT(s.shift_date, '%Y-%m-%d') AS shift_date,
              s.shift_type,
              DATE_FORMAT(s.scheduled_start, '%Y-%m-%d %H:%i:%s') AS scheduled_start,
              DATE_FORMAT(s.scheduled_end, '%Y-%m-%d %H:%i:%s') AS scheduled_end
       FROM agent_schedules s
       JOIN agents a ON a.agent_id = s.agent_id
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.shift_date ASC, a.display_name ASC, s.scheduled_start ASC`,
      params
    );
    res.json(
      rows.map((r) => ({
        scheduleId: r.schedule_id,
        agentId: r.agent_id,
        displayName: r.display_name,
        groupId: r.group_id,
        groupName: r.group_name,
        shiftDate: r.shift_date,
        shiftType: r.shift_type,
        startTime: toHHMM(r.scheduled_start),
        endTime: toHHMM(r.scheduled_end),
        crossesMidnight: r.scheduled_end.slice(0, 10) !== r.scheduled_start.slice(0, 10),
      }))
    );
  } catch (err) {
    console.error("Error listing schedules:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

function addDaysToDateString(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// POST /api/schedules - add one shift row for one agent.
router.post("/", async (req, res) => {
  const { agentId, shiftDate, shiftType, startTime, endTime } = req.body || {};

  if (!agentId) {
    return res.status(400).json({ error: "agentId is required." });
  }
  const validationError = validateShiftFields({ shiftDate, shiftType, startTime, endTime });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { scheduledStart, scheduledEnd } = buildShiftWindow(shiftDate, startTime, endTime);

  try {
    const [result] = await db.query(
      `INSERT INTO agent_schedules (agent_id, shift_date, shift_type, scheduled_start, scheduled_end)
       VALUES (?, ?, ?, ?, ?)`,
      [agentId, shiftDate, shiftType.trim(), scheduledStart, scheduledEnd]
    );

    await logAction(req, "created", "agent_schedule", agentId,
      `Added ${shiftType.trim()} shift for ${agentId} on ${shiftDate} (${startTime}-${endTime}).`);

    res.status(201).json({
      scheduleId: result.insertId, agentId, shiftDate, shiftType: shiftType.trim(), startTime, endTime,
      crossesMidnight: scheduledEnd.slice(0, 10) !== scheduledStart.slice(0, 10),
    });
  } catch (err) {
    if (err.code === "ER_NO_REFERENCED_ROW_2") {
      return res.status(404).json({ error: "That Agent ID doesn't exist." });
    }
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: `${agentId} already has a ${shiftType.trim()} shift on ${shiftDate}. Edit that row instead.` });
    }
    console.error("Error creating schedule row:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// PUT /api/schedules/:scheduleId - edit one shift row. agentId is
// deliberately NOT editable here - moving a shift to a different
// agent isn't a real-world edit, it's a delete-and-recreate; keeping
// it out avoids a confusing half-edit UI.
router.put("/:scheduleId", async (req, res) => {
  const { scheduleId } = req.params;
  const { shiftDate, shiftType, startTime, endTime } = req.body || {};

  const validationError = validateShiftFields({ shiftDate, shiftType, startTime, endTime });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { scheduledStart, scheduledEnd } = buildShiftWindow(shiftDate, startTime, endTime);

  try {
    const [result] = await db.query(
      `UPDATE agent_schedules
       SET shift_date = ?, shift_type = ?, scheduled_start = ?, scheduled_end = ?
       WHERE schedule_id = ?`,
      [shiftDate, shiftType.trim(), scheduledStart, scheduledEnd, scheduleId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Schedule row not found." });
    }

    await logAction(req, "updated", "agent_schedule", scheduleId,
      `Edited shift ${scheduleId} to ${shiftType.trim()} on ${shiftDate} (${startTime}-${endTime}).`);

    res.json({
      scheduleId: Number(scheduleId), shiftDate, shiftType: shiftType.trim(), startTime, endTime,
      crossesMidnight: scheduledEnd.slice(0, 10) !== scheduledStart.slice(0, 10),
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Another shift already exists for that agent, date and shift type." });
    }
    console.error("Error updating schedule row:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// DELETE /api/schedules/:scheduleId
router.delete("/:scheduleId", async (req, res) => {
  const { scheduleId } = req.params;

  try {
    const [result] = await db.query("DELETE FROM agent_schedules WHERE schedule_id = ?", [scheduleId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Schedule row not found." });
    }

    await logAction(req, "deleted", "agent_schedule", scheduleId, `Deleted shift ${scheduleId}.`);

    res.json({ scheduleId: Number(scheduleId) });
  } catch (err) {
    console.error("Error deleting schedule row:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// POST /api/schedules/bulk-upload - the mass upload. Expects a
// multipart form with one file field named "file" (CSV, matching the
// downloadable template's columns exactly: Agent ID, Agent Name,
// Shift Date, Shift Type, Start Time, End Time - Agent Name is
// informational only for whoever fills the sheet in, never used for
// lookup or validation).
//
// The upload REPLACES schedules: for every (agent, shift date) that
// appears in the file, all of that agent's existing shifts on that
// date are deleted and the uploaded ones saved instead - so a day that
// used to be Regular + OT and is now uploaded as just Regular loses
// the old OT row rather than keeping it (which would inflate scheduled
// hours and skew adherence). Agents/dates not in the file are left
// alone. Delete + insert run in one transaction.
//
// Rows are validated independently - one bad row (typo'd Agent ID, bad
// date) is reported for that row number without blocking the rest of
// the file. The exception is the bad row's own day: if any row for an
// (agent, date) has a problem, NONE of that day's rows are saved and
// its existing schedule is kept, so a typo can't wipe out a shift.
// Re-uploading after fixing is safe - the day is simply replaced again.
router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  let records;
  try {
    records = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (err) {
    return res.status(400).json({ error: `Could not read that file as CSV: ${err.message}` });
  }

  if (records.length === 0) {
    return res.status(400).json({ error: "The file has no data rows." });
  }
  if (records.length > MAX_UPLOAD_ROWS) {
    return res.status(400).json({ error: `Too many rows (${records.length}). Split into files of ${MAX_UPLOAD_ROWS} rows or fewer.` });
  }

  // One query to find out which Agent IDs in the file are real,
  // instead of one query per row.
  const fileAgentIds = [...new Set(records.map((r) => (r["Agent ID"] || "").trim()).filter(Boolean))];
  let knownAgentIds = new Set();
  if (fileAgentIds.length > 0) {
    const [agentRows] = await db.query(
      `SELECT agent_id FROM agents WHERE agent_id IN (${fileAgentIds.map(() => "?").join(",")})`,
      fileAgentIds
    );
    knownAgentIds = new Set(agentRows.map((r) => r.agent_id));
  }

  const errors = [];
  const validRows = []; // { rowNum, dayKey, values: [agentId, shiftDate, shiftType, start, end] }
  const daysWithErrors = new Set(); // "agentId|shiftDate" of any row that failed validation

  records.forEach((record, index) => {
    const rowNum = index + 2; // +1 for 0-index, +1 for the header row - matches what the person sees in Excel/Sheets
    const agentId = (record["Agent ID"] || "").trim();
    const shiftDate = (record["Shift Date"] || "").trim();
    const shiftType = (record["Shift Type"] || "").trim();
    const startTime = (record["Start Time"] || "").trim();
    const endTime = (record["End Time"] || "").trim();
    const dayKey = `${agentId}|${shiftDate}`;

    if (!agentId) {
      errors.push({ row: rowNum, message: "Agent ID is blank." });
      return;
    }
    if (!knownAgentIds.has(agentId)) {
      errors.push({ row: rowNum, message: `Agent ID "${agentId}" doesn't exist.` });
      return;
    }
    const validationError = validateShiftFields({ shiftDate, shiftType, startTime, endTime });
    if (validationError) {
      errors.push({ row: rowNum, message: validationError });
      if (shiftDate) daysWithErrors.add(dayKey);
      return;
    }

    const { scheduledStart, scheduledEnd } = buildShiftWindow(shiftDate, startTime, endTime);
    validRows.push({ rowNum, dayKey, values: [agentId, shiftDate, shiftType, scheduledStart, scheduledEnd] });
  });

  // A day with any bad row is skipped entirely (see the comment above).
  const rowsToSave = [];
  for (const row of validRows) {
    if (daysWithErrors.has(row.dayKey)) {
      const [agentId, shiftDate] = row.values;
      errors.push({
        row: row.rowNum,
        message: `Not saved - another row for agent ${agentId} on ${shiftDate} has a problem. ` +
          "Fix it and re-upload; that day's existing schedule was left unchanged.",
      });
    } else {
      rowsToSave.push(row.values);
    }
  }
  errors.sort((a, b) => a.row - b.row);

  let savedCount = 0;
  let replacedCount = 0;
  if (rowsToSave.length > 0) {
    const days = [...new Map(rowsToSave.map(([agentId, shiftDate]) => [`${agentId}|${shiftDate}`, [agentId, shiftDate]])).values()];
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Clear every uploaded (agent, date) first, in chunks to keep the
      // parameter list reasonable on a 5000-row file.
      const DELETE_CHUNK = 500;
      for (let i = 0; i < days.length; i += DELETE_CHUNK) {
        const chunk = days.slice(i, i + DELETE_CHUNK);
        const [del] = await conn.query(
          `DELETE FROM agent_schedules WHERE (agent_id, shift_date) IN (${chunk.map(() => "(?, ?)").join(",")})`,
          chunk.flat()
        );
        replacedCount += del.affectedRows;
      }

      // ON DUPLICATE KEY UPDATE only matters if the file itself lists
      // the same agent/date/shift type twice - the later row wins.
      await conn.query(
        `INSERT INTO agent_schedules (agent_id, shift_date, shift_type, scheduled_start, scheduled_end)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           scheduled_start = VALUES(scheduled_start),
           scheduled_end = VALUES(scheduled_end)`,
        [rowsToSave]
      );

      await conn.commit();
      savedCount = rowsToSave.length;
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error("Error bulk-replacing schedules:", err);
      return res.status(500).json({ error: "A server error occurred while saving the schedule. Nothing was changed." });
    } finally {
      conn.release();
    }
  }

  await logAction(req, "bulk_upload", "agent_schedule", "bulk",
    `Bulk schedule upload: ${savedCount} row(s) saved, replacing ${replacedCount} existing row(s); ` +
    `${errors.length} error(s), from a ${records.length}-row file.`);

  res.json({ totalRows: records.length, savedRows: savedCount, replacedRows: replacedCount, errors });
});

module.exports = router;
