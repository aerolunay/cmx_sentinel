"use strict";

// One-off repair of "Overstayed (14h)" violations recorded for agents who
// DID punch biometric Check-Out. The PC was shut down before the punch,
// so the desktop never saw it and the login stayed open; the hourly job
// then closed it 14 hours after the login as an overstay, at the
// scheduled end. services/biometrics.js (runOverstayCheck) now ends such
// logins at the Check-Out instead - this fixes the ones recorded before.
//
// For each overstay violation of an onsite login, it looks for a
// Check-Out (CMX Pulse's device log or biometric_punches) after the
// segment started and before the violation was detected. When there is
// one, the segment is ended at that Check-Out (logout_trigger
// 'biometric', as the desktop records it) and the auto_logouts row - the
// violation - is deleted. Rows without a Check-Out are left alone.
//
// Run from the backend folder (uses its .env). Preview first, then apply:
//   node scripts/repairCheckOutOverstays.js
//   node scripts/repairCheckOutOverstays.js --apply
// Safe to re-run: a repaired row no longer has a violation.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { DateTime } = require("luxon");
const db = require("../config/db");
const { hasColumn, hasWorkSetupColumn } = require("../services/workSetup");

const EASTERN = "America/New_York";
const SQL_FORMAT = "yyyy-MM-dd HH:mm:ss";
const EST_FORMAT = "%Y-%m-%d %H:%i:%s";
const apply = process.argv.includes("--apply");

async function firstCheckOut(agentId, fromUtc, toUtc) {
  const tables = ["ph_timekeeping.device_attendance_logs"];
  if (await hasColumn("biometric_punches", "punched_at")) tables.push("biometric_punches");
  let first = null;
  for (const table of tables) {
    try {
      const [[row]] = await db.query(
        `SELECT DATE_FORMAT(MIN(punched_at), '%Y-%m-%d %H:%i:%s.%f') AS punched_at
         FROM ${table}
         WHERE device_user = ? AND state = 1 AND punched_at > ? AND punched_at <= ?`,
        [String(agentId), fromUtc, toUtc]
      );
      if (row && row.punched_at) {
        const at = DateTime.fromSQL(row.punched_at, { zone: "utc" }).toJSDate();
        if (!first || at < first) first = at;
      }
    } catch (err) {
      console.error(`Reading ${table} failed:`, err.message);
    }
  }
  return first;
}

async function main() {
  const withSetup = await hasWorkSetupColumn();
  const withNote = await hasColumn("aux_events", "logout_note");
  const [rows] = await db.query(
    `SELECT al.auto_logout_id, al.event_id, al.agent_id, a.display_name, al.aux_code,
            DATE_FORMAT(al.shift_date, '%Y-%m-%d') AS shift_date,
            DATE_FORMAT(al.closed_at_est, '${EST_FORMAT}') AS closed_est,
            DATE_FORMAT(al.detected_at_est, '${EST_FORMAT}') AS detected_est,
            ae.started_at_utc, DATE_FORMAT(ae.started_at_est, '${EST_FORMAT}') AS start_est
     FROM auto_logouts al
     JOIN aux_events ae ON ae.event_id = al.event_id
     LEFT JOIN agents a ON a.agent_id = al.agent_id
     WHERE ae.logout_trigger = 'overstayed'
       ${withSetup ? "AND (ae.work_setup IS NULL OR ae.work_setup <> 'remote')" : ""}
     ORDER BY al.shift_date, al.agent_id`
  );

  const fixes = [];
  for (const row of rows) {
    const startedAt = new Date(row.started_at_utc);
    const detectedAt = DateTime.fromSQL(row.detected_est, { zone: EASTERN }).toJSDate();
    const checkOut = await firstCheckOut(row.agent_id, startedAt, detectedAt);
    if (checkOut) fixes.push({ ...row, checkOut });
  }

  const est = (d) => DateTime.fromJSDate(d).setZone(EASTERN).toFormat(SQL_FORMAT);
  console.table(fixes.map((f) => ({
    agent: f.display_name || f.agent_id,
    shift: f.shift_date,
    aux: f.aux_code,
    segmentStarted: f.start_est,
    closedAsOverstay: f.closed_est,
    checkOut: est(f.checkOut),
  })));
  console.log(`${fixes.length} of ${rows.length} overstay violation(s) had a biometric Check-Out.`);

  if (!apply) {
    console.log("Preview only - run again with --apply to end them at the Check-Out and remove the violations.");
    return;
  }

  let repaired = 0;
  for (const f of fixes) {
    const [result] = await db.query(
      `UPDATE aux_events
       SET ended_at_utc = GREATEST(started_at_utc, ?),
           ended_at_est = GREATEST(started_at_est, ?),
           duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, started_at_utc, ?)),
           logout_trigger = 'biometric'${withNote ? ", logout_note = NULL" : ""}
       WHERE event_id = ? AND logout_trigger = 'overstayed'`,
      [f.checkOut, est(f.checkOut), f.checkOut, f.event_id]
    );
    if (result.affectedRows === 0) continue;
    await db.query("DELETE FROM auto_logouts WHERE auto_logout_id = ?", [f.auto_logout_id]);
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
