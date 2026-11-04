"use strict";

const { DateTime } = require("luxon");
const db = require("../config/db");

// Clinic visits excuse Idle time: Idle that overlaps a visit - from the
// time of visit to the time released plus up to RELEASE_ALLOWANCE_MINUTES
// to get back to the desk - is relabelled "ClinicVisit". That removes it
// from Idle (non-productive) AND from Expected hours in Productive Hrs %
// (see productiveHrs in routes/reportRoutes.js). Idle before the visit,
// or more than the allowance after release, stays Idle; other aux codes
// (Break, Lunch, ...) are never changed.
//
// Example: Idle 3:25-4:10, visit 3:30, released 4:00 - 3:30-4:10 (40 min)
// becomes ClinicVisit, 3:25-3:30 stays Idle.
//
// Visits are entered in Philippine time (clinic_visits, sql/011);
// windows here are Eastern wall-clock milliseconds parsed as UTC, the
// same convention as reportRoutes' toMs for the _est columns. A visit
// with no time released yet counts up to now, at most
// OPEN_VISIT_MAX_HOURS after it started, and without the allowance.
const CLINIC_AUX = "ClinicVisit";
const RELEASE_ALLOWANCE_MINUTES = 10;
const OPEN_VISIT_MAX_HOURS = 4;
const SQL_FORMAT = "yyyy-MM-dd HH:mm:ss";

function manilaToEasternMs(date, time) {
  const eastern = DateTime.fromSQL(`${date} ${time}`, { zone: "Asia/Manila" })
    .setZone("America/New_York").toFormat(SQL_FORMAT);
  return DateTime.fromSQL(eastern, { zone: "utc" }).toMillis();
}

// agentIds' visits on Philippine dates fromDate..toDate (YYYY-MM-DD) ->
// Map agentId -> merged, sorted [{ startMs, endMs }]. nowMs: Eastern
// wall-clock now, for visits not released yet.
async function loadClinicWindows(agentIds, fromDate, toDate, nowMs) {
  const windowsByAgent = new Map();
  if (!agentIds.length) return windowsByAgent;

  let rows;
  try {
    [rows] = await db.query(
      `SELECT employee_id, DATE_FORMAT(visit_date, '%Y-%m-%d') AS visit_date,
              TIME_FORMAT(time_of_visit, '%H:%i:%s') AS time_of_visit,
              TIME_FORMAT(time_released, '%H:%i:%s') AS time_released
       FROM clinic_visits
       WHERE employee_id IN (?) AND visit_date BETWEEN ? AND ?`,
      [agentIds.map(String), fromDate, toDate]
    );
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return windowsByAgent; // sql/011 not run yet
    throw err;
  }

  for (const r of rows) {
    const startMs = manilaToEasternMs(r.visit_date, r.time_of_visit);
    let endMs;
    if (r.time_released) {
      // Released before the visit time = past midnight, the next day.
      const releaseDate = r.time_released < r.time_of_visit
        ? DateTime.fromISO(r.visit_date).plus({ days: 1 }).toISODate()
        : r.visit_date;
      endMs = manilaToEasternMs(releaseDate, r.time_released) + RELEASE_ALLOWANCE_MINUTES * 60 * 1000;
    } else {
      endMs = Math.min(nowMs, startMs + OPEN_VISIT_MAX_HOURS * 3600 * 1000);
    }
    if (endMs <= startMs) continue;
    const agentId = String(r.employee_id);
    if (!windowsByAgent.has(agentId)) windowsByAgent.set(agentId, []);
    windowsByAgent.get(agentId).push({ startMs, endMs });
  }

  // Overlapping visits must not excuse the same minutes twice.
  for (const [agentId, windows] of windowsByAgent) {
    windows.sort((a, b) => a.startMs - b.startMs);
    const merged = [];
    for (const w of windows) {
      const last = merged[merged.length - 1];
      if (last && w.startMs <= last.endMs) last.endMs = Math.max(last.endMs, w.endMs);
      else merged.push({ ...w });
    }
    windowsByAgent.set(agentId, merged);
  }
  return windowsByAgent;
}

// The parts of [startMs, endMs) inside the clinic windows.
function clinicPieces(startMs, endMs, windows) {
  const pieces = [];
  for (const w of windows || []) {
    const s = Math.max(startMs, w.startMs);
    const e = Math.min(endMs, w.endMs);
    if (e > s) pieces.push({ startMs: s, endMs: e });
  }
  return pieces;
}

// An aux segment split into [{ auxCode, startMs, endMs }] - Idle broken
// into its ClinicVisit and remaining Idle parts, anything else unchanged.
function splitForClinic(auxCode, startMs, endMs, windows) {
  if (auxCode !== "Idle" || !windows || !windows.length) return [{ auxCode, startMs, endMs }];
  const result = [];
  let cursor = startMs;
  for (const p of clinicPieces(startMs, endMs, windows)) {
    if (p.startMs > cursor) result.push({ auxCode: "Idle", startMs: cursor, endMs: p.startMs });
    result.push({ auxCode: CLINIC_AUX, startMs: p.startMs, endMs: p.endMs });
    cursor = p.endMs;
  }
  if (cursor < endMs) result.push({ auxCode: "Idle", startMs: cursor, endMs });
  return result;
}

module.exports = { loadClinicWindows, clinicPieces, splitForClinic, CLINIC_AUX, RELEASE_ALLOWANCE_MINUTES };
