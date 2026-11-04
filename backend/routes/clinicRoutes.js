"use strict";

const express = require("express");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");
const { getScopedGroupIds } = require("../services/groupScope");
const { logAction } = require("../services/auditLog");

const router = express.Router();

// Clinic Visits: the clinic records each employee visit - Med / Clinic
// users ('clinic') add and edit them; everyone who can open Reports reads
// them there (Supervisors only for their own groups' agents). Dates and
// times are the clinic's wall clock (Philippine time) as entered - see
// sql/011_clinic_visits.sql.
const CLINIC_ROLES = ["clinic"];
const REPORT_ROLES = ["super_admin", "admin", "tqa", "supervisor", "manager"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const MAX_TEXT = 1000;

router.use(requireAuth);

function toVisit(r) {
  return {
    visitId: r.visit_id,
    visitDate: r.visit_date,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    groupName: r.group_name || null,
    timeOfVisit: r.time_of_visit,
    chiefComplaint: r.chief_complaint,
    treatment: r.treatment || "",
    timeReleased: r.time_released || null,
    seenBy: r.seen_by_name,
  };
}

const VISIT_COLUMNS = `
  cv.visit_id, DATE_FORMAT(cv.visit_date, '%Y-%m-%d') AS visit_date, cv.employee_id, cv.employee_name,
  TIME_FORMAT(cv.time_of_visit, '%H:%i') AS time_of_visit, cv.chief_complaint, cv.treatment,
  TIME_FORMAT(cv.time_released, '%H:%i') AS time_released, cv.seen_by_name, g.group_name`;

// Validates and normalises a visit from the request body; returns
// { error } or { visit }.
function readVisit(body) {
  const b = body || {};
  const visit = {
    visitDate: String(b.visitDate || "").trim(),
    employeeId: String(b.employeeId || "").trim(),
    employeeName: String(b.employeeName || "").trim(),
    timeOfVisit: String(b.timeOfVisit || "").trim(),
    chiefComplaint: String(b.chiefComplaint || "").trim(),
    treatment: String(b.treatment || "").trim(),
    timeReleased: String(b.timeReleased || "").trim(),
  };
  if (!DATE_RE.test(visit.visitDate)) return { error: "Date of visit is required." };
  if (!visit.employeeId || visit.employeeId.length > 32) return { error: "Employee ID is required." };
  if (!visit.employeeName || visit.employeeName.length > 255) return { error: "Employee name is required." };
  if (!TIME_RE.test(visit.timeOfVisit)) return { error: "Time of visit is required." };
  if (!visit.chiefComplaint) return { error: "Chief complaint is required." };
  if (visit.chiefComplaint.length > MAX_TEXT || visit.treatment.length > MAX_TEXT) {
    return { error: `Chief complaint and treatment can be at most ${MAX_TEXT} characters.` };
  }
  if (visit.timeReleased && !TIME_RE.test(visit.timeReleased)) return { error: "Time released is not a valid time." };
  return { visit };
}

// Visits in a date range (visit date, inclusive), newest first.
router.get("/", requireRole(...CLINIC_ROLES, ...REPORT_ROLES), async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  if (!DATE_RE.test(dateFrom || "") || !DATE_RE.test(dateTo || "")) {
    return res.status(400).json({ error: "dateFrom and dateTo are required." });
  }

  try {
    const conditions = ["cv.visit_date BETWEEN ? AND ?"];
    const params = [dateFrom, dateTo];
    // Supervisors see their groups' agents only; visits by anyone else
    // (non-agents included) stay out of their view.
    const scopedGroupIds = req.session.role === "clinic" ? null : await getScopedGroupIds(req);
    if (scopedGroupIds !== null) {
      if (scopedGroupIds.length === 0) return res.json([]);
      conditions.push(`a.group_id IN (${scopedGroupIds.map(() => "?").join(",")})`);
      params.push(...scopedGroupIds);
    }

    const [rows] = await db.query(
      `SELECT ${VISIT_COLUMNS}
       FROM clinic_visits cv
       LEFT JOIN agents a ON a.agent_id = cv.employee_id
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY cv.visit_date DESC, cv.time_of_visit DESC, cv.visit_id DESC`,
      params
    );
    res.json(rows.map(toVisit));
  } catch (err) {
    console.error("Error listing clinic visits:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// Name for an Employee ID, to fill in the form - from the agents list;
// { found: false } for anyone else (the clinic types the name).
router.get("/employee/:employeeId", requireRole(...CLINIC_ROLES), async (req, res) => {
  try {
    const [[agent]] = await db.query(
      "SELECT display_name FROM agents WHERE agent_id = ? LIMIT 1",
      [req.params.employeeId]
    );
    res.json(agent ? { found: true, employeeName: agent.display_name } : { found: false });
  } catch (err) {
    console.error("Error looking up employee for clinic visit:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.post("/", requireRole(...CLINIC_ROLES), async (req, res) => {
  const { visit, error } = readVisit(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const [result] = await db.query(
      `INSERT INTO clinic_visits
         (visit_date, employee_id, employee_name, time_of_visit, chief_complaint, treatment, time_released,
          seen_by_user_id, seen_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [visit.visitDate, visit.employeeId, visit.employeeName, visit.timeOfVisit, visit.chiefComplaint,
        visit.treatment || null, visit.timeReleased || null, req.session.userId, req.session.displayName]
    );
    await logAction(req, "created", "clinic_visit", result.insertId,
      `Clinic visit for ${visit.employeeName} (${visit.employeeId}) on ${visit.visitDate} ${visit.timeOfVisit}.`);
    res.status(201).json({ visitId: result.insertId });
  } catch (err) {
    console.error("Error adding clinic visit:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// Edit a visit - typically to add the time released once the employee
// leaves. "Seen by" stays whoever recorded it.
router.put("/:visitId", requireRole(...CLINIC_ROLES), async (req, res) => {
  const { visit, error } = readVisit(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const [result] = await db.query(
      `UPDATE clinic_visits
       SET visit_date = ?, employee_id = ?, employee_name = ?, time_of_visit = ?, chief_complaint = ?,
           treatment = ?, time_released = ?
       WHERE visit_id = ?`,
      [visit.visitDate, visit.employeeId, visit.employeeName, visit.timeOfVisit, visit.chiefComplaint,
        visit.treatment || null, visit.timeReleased || null, req.params.visitId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Clinic visit not found." });
    await logAction(req, "updated", "clinic_visit", req.params.visitId,
      `Clinic visit for ${visit.employeeName} (${visit.employeeId}) on ${visit.visitDate} ${visit.timeOfVisit}.`);
    res.json({ visitId: Number(req.params.visitId) });
  } catch (err) {
    console.error("Error updating clinic visit:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;
