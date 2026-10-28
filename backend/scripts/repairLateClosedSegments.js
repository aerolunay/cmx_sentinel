"use strict";

// One-off repair of past data, applying services/autoLogout.js's rule to
// segments that were already CLOSED before it existed: a login left open
// after the shift and only closed much later (the PC resumed the old
// login hours or days afterwards) is cut back to the scheduled end, as if
// the hourly check had caught it. Without this, such a segment counts in
// full for every shift it spans - the over-100% adherence days.
//
// Run from the backend folder (uses its .env). Preview first, then apply:
//   node scripts/repairLateClosedSegments.js
//   node scripts/repairLateClosedSegments.js --apply
//
// Applied rows get logout_trigger 'schedule_end' and an auto_logouts row
// (so they show under Reports > Logout Offenders, with Detected At = when
// the segment was originally closed). Needs sql/007 first. Safe to
// re-run: a repaired row no longer ends past its shift.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { DateTime } = require("luxon");
const db = require("../config/db");
const { mergeWindows, findOwningWindow, shiftEst, OVERRIDE_AFTER_HOURS } = require("../services/autoLogout");

const EASTERN = "America/New_York";
const EST_FORMAT = "%Y-%m-%d %H:%i:%s";
const apply = process.argv.includes("--apply");

function hoursBetween(fromEst, toEst) {
  return DateTime.fromSQL(toEst, { zone: EASTERN }).diff(DateTime.fromSQL(fromEst, { zone: EASTERN }), "hours").hours;
}

async function main() {
  const [windowRows] = await db.query(
    `SELECT agent_id, DATE_FORMAT(shift_date, '%Y-%m-%d') AS shift_date,
            DATE_FORMAT(scheduled_start, '${EST_FORMAT}') AS start,
            DATE_FORMAT(scheduled_end, '${EST_FORMAT}') AS end
     FROM agent_schedules`
  );
  const windowsByAgent = new Map();
  for (const w of windowRows) {
    if (!windowsByAgent.has(w.agent_id)) windowsByAgent.set(w.agent_id, []);
    windowsByAgent.get(w.agent_id).push({ shiftDate: w.shift_date, start: w.start, end: w.end });
  }
  for (const [agentId, windows] of windowsByAgent) windowsByAgent.set(agentId, mergeWindows(windows));

  const [rows] = await db.query(
    `SELECT ae.event_id, ae.agent_id, a.display_name, ae.login_session_id, ae.machine_name, ae.aux_code,
            DATE_FORMAT(ae.started_at_est, '${EST_FORMAT}') AS start_est,
            DATE_FORMAT(ae.ended_at_est, '${EST_FORMAT}') AS end_est
     FROM aux_events ae
     JOIN agents a ON a.agent_id = ae.agent_id
     WHERE ae.ended_at_utc IS NOT NULL AND ae.started_at_est IS NOT NULL AND ae.ended_at_est IS NOT NULL
     ORDER BY ae.agent_id, ae.started_at_est`
  );

  const fixes = [];
  for (const row of rows) {
    const window = findOwningWindow(windowsByAgent.get(row.agent_id) || [], row.start_est);
    if (!window || row.end_est <= shiftEst(window.end, OVERRIDE_AFTER_HOURS)) continue;
    const newEnd = row.start_est > window.end ? row.start_est : window.end;
    if (newEnd >= row.end_est) continue;
    fixes.push({ ...row, window, newEnd, hoursRemoved: hoursBetween(newEnd, row.end_est) });
  }

  console.table(fixes.map((f) => ({
    agent: f.display_name,
    shift: f.window.shiftDate,
    aux: f.aux_code,
    started: f.start_est,
    endedWas: f.end_est,
    endsNow: f.newEnd,
    hoursRemoved: f.hoursRemoved.toFixed(2),
  })));
  const totalHours = fixes.reduce((sum, f) => sum + f.hoursRemoved, 0);
  console.log(`${fixes.length} segment(s) closed past their shift, ${totalHours.toFixed(1)} hours to remove.`);

  if (!apply) {
    console.log("Preview only - run again with --apply to repair them.");
    return;
  }

  let repaired = 0;
  for (const f of fixes) {
    const closeUtc = DateTime.fromSQL(f.newEnd, { zone: EASTERN }).toJSDate();
    const [result] = await db.query(
      `UPDATE aux_events
       SET ended_at_utc = GREATEST(started_at_utc, ?),
           ended_at_est = GREATEST(started_at_est, ?),
           duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, started_at_utc, ?)),
           logout_trigger = 'schedule_end'
       WHERE event_id = ? AND ended_at_est = ?`,
      [closeUtc, f.newEnd, closeUtc, f.event_id, f.end_est]
    );
    if (result.affectedRows === 0) continue;
    await db.query(
      `INSERT IGNORE INTO auto_logouts
         (event_id, agent_id, login_session_id, machine_name, aux_code, shift_date,
          scheduled_end_est, segment_started_est, closed_at_est, detected_at_est, app_running)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [f.event_id, f.agent_id, f.login_session_id, f.machine_name, f.aux_code, f.window.shiftDate,
        f.window.end, f.start_est, f.newEnd, f.end_est]
    );
    repaired++;
  }
  console.log(`Repaired ${repaired} segment(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
