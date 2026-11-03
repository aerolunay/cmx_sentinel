"use strict";

const { DateTime } = require("luxon");
const db = require("../config/db");
const sessionOwnership = require("./sessionOwnership");
const { mergeWindows, findOwningWindow, shiftEst } = require("./autoLogout");

// Shift start/end come from the office biometric devices, not from
// logging in to the desktop app. The timekeeping app's zk-sync pushes
// every punch into ph_timekeeping.device_attendance_logs (same MySQL
// server - cmx_admin needs SELECT on it, see sql/008) within seconds:
//   device_user  the 7-digit employee number = agents.agent_id
//   punched_at   UTC
//   state        0 Check-In, 1 Check-Out (break/OT states are ignored,
//                same as the timekeeping app's own attendance)
//
// A shift is open from the first Check-In after the last Check-Out (a
// double scan is just a second In) until the next Check-Out. One left
// open longer than OVERSTAY_HOURS (the agent never punched out) is
// closed by the server at the scheduled shift end.
const OVERSTAY_HOURS = 18;
// Far enough back to see an overstayed shift's Check-In; an In older
// than this with nothing after it is just a missed punch-out from days
// ago, handled long since.
const LOOKBACK_HOURS = 36;
const OVERSTAY_TRIGGER = "overstayed";
const OVERSTAY_NOTE = "Automatic Logout - Overstayed - No Biometrics Logout";
const EASTERN = "America/New_York";
const SQL_FORMAT = "yyyy-MM-dd HH:mm:ss";
const EST_FORMAT = "%Y-%m-%d %H:%i:%s";

const CHECK_IN = 0;
const CHECK_OUT = 1;

async function loadPunches(agentId) {
  // punched_at formatted in SQL and parsed as UTC here, so the result
  // doesn't depend on the Node process's own timezone.
  const [rows] = await db.query(
    `SELECT DATE_FORMAT(punched_at, '%Y-%m-%d %H:%i:%s.%f') AS punched_at, state
     FROM ph_timekeeping.device_attendance_logs
     WHERE device_user = ? AND state IN (${CHECK_IN}, ${CHECK_OUT}) AND punched_at IS NOT NULL
       AND punched_at >= UTC_TIMESTAMP(3) - INTERVAL ${LOOKBACK_HOURS} HOUR
     ORDER BY punched_at, id`,
    [String(agentId)]
  );
  return rows.map((r) => ({
    at: DateTime.fromSQL(r.punched_at, { zone: "utc" }).toJSDate(),
    state: Number(r.state),
  }));
}

// punches: oldest first. Returns where the agent stands right now:
//   status "in"          on shift since shiftStartedAt
//   status "overstayed"  on shift since shiftStartedAt, past OVERSTAY_HOURS
//   status "out"         punched out at punchedOutAt (shiftStartedAt = that shift's In, if seen)
//   status "none"        no punches in the lookback window
function shiftFromPunches(punches, now = new Date()) {
  let shiftStartedAt = null;
  let punchedOutAt = null;
  let lastShiftStartedAt = null;
  for (const p of punches) {
    if (p.at > now) continue;
    if (p.state === CHECK_IN) {
      if (!shiftStartedAt) shiftStartedAt = p.at;
    } else if (shiftStartedAt || !punchedOutAt) {
      lastShiftStartedAt = shiftStartedAt;
      punchedOutAt = p.at;
      shiftStartedAt = null;
    }
  }

  if (shiftStartedAt) {
    const overstayed = now - shiftStartedAt > OVERSTAY_HOURS * 3600 * 1000;
    return { status: overstayed ? "overstayed" : "in", shiftStartedAt, punchedOutAt: null };
  }
  if (punchedOutAt) {
    return { status: "out", shiftStartedAt: lastShiftStartedAt, punchedOutAt };
  }
  return { status: "none", shiftStartedAt: null, punchedOutAt: null };
}

async function getBiometricShift(agentId, now = new Date()) {
  return shiftFromPunches(await loadPunches(agentId), now);
}

// Where an aux session for this shift should start: the Check-In, or
// later if the agent already had (and ended) an app session during this
// shift - that time is already counted.
async function resumeFrom(agentId, shiftStartedAt) {
  const [[row]] = await db.query(
    "SELECT MAX(ended_at_utc) AS last_end FROM aux_events WHERE agent_id = ? AND ended_at_utc >= ?",
    [agentId, shiftStartedAt]
  );
  const lastEnd = row && row.last_end ? new Date(row.last_end) : null;
  return lastEnd && lastEnd > shiftStartedAt ? lastEnd : shiftStartedAt;
}

// The scheduled end of the shift the agent punched in for, in Eastern
// wall-clock time - same shift matching as autoLogout.js. No schedule:
// OVERSTAY_HOURS after the Check-In.
async function scheduledEndFor(agentId, shiftStartedAt) {
  const shiftStartEst = DateTime.fromJSDate(shiftStartedAt).setZone(EASTERN).toFormat(SQL_FORMAT);
  const [rows] = await db.query(
    `SELECT DATE_FORMAT(shift_date, '%Y-%m-%d') AS shift_date,
            DATE_FORMAT(scheduled_start, '${EST_FORMAT}') AS start,
            DATE_FORMAT(scheduled_end, '${EST_FORMAT}') AS end
     FROM agent_schedules
     WHERE agent_id = ? AND scheduled_end >= ? AND scheduled_start <= ?`,
    [agentId, shiftEst(shiftStartEst, -24), shiftEst(shiftStartEst, OVERSTAY_HOURS)]
  );
  const window = findOwningWindow(
    mergeWindows(rows.map((r) => ({ shiftDate: r.shift_date, start: r.start, end: r.end }))),
    shiftStartEst
  );
  if (window) {
    return { shiftDate: window.shiftDate, scheduledEndEst: window.end > shiftStartEst ? window.end : shiftStartEst };
  }
  return { shiftDate: shiftStartEst.slice(0, 10), scheduledEndEst: shiftEst(shiftStartEst, OVERSTAY_HOURS) };
}

// Ends every login the agent still has open for an overstayed shift AT
// the scheduled shift end, with logout_trigger 'overstayed' and the
// note, and records it in auto_logouts. pushLogout: tell the PC over
// its event stream (the hourly job) - the desktop's own status check
// logs itself out without it.
async function closeOverstayedShift(agentId, shiftStartedAt, { pushLogout }) {
  const { shiftDate, scheduledEndEst } = await scheduledEndFor(agentId, shiftStartedAt);
  const closeUtc = DateTime.fromSQL(scheduledEndEst, { zone: EASTERN }).toJSDate();
  const nowEst = DateTime.now().setZone(EASTERN).toFormat(SQL_FORMAT);

  // Rows opened during this shift - or shortly before the Check-In, by a
  // desktop that started the session at app login.
  const [openRows] = await db.query(
    `SELECT event_id, login_session_id, machine_name, aux_code,
            DATE_FORMAT(started_at_est, '${EST_FORMAT}') AS start_est
     FROM aux_events
     WHERE agent_id = ? AND ended_at_utc IS NULL AND started_at_utc >= ?`,
    [agentId, new Date(shiftStartedAt.getTime() - 12 * 3600 * 1000)]
  );

  let closedCount = 0;
  for (const row of openRows) {
    const [result] = await db.query(
      `UPDATE aux_events
       SET ended_at_utc = GREATEST(started_at_utc, ?),
           ended_at_est = GREATEST(started_at_est, ?),
           duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, started_at_utc, ?)),
           logout_trigger = ?,
           logout_note = ?
       WHERE event_id = ? AND ended_at_utc IS NULL`,
      [closeUtc, scheduledEndEst, closeUtc, OVERSTAY_TRIGGER, OVERSTAY_NOTE, row.event_id]
    );
    if (result.affectedRows === 0) continue; // closed normally in the meantime

    const appRunning = pushLogout && row.machine_name
      ? sessionOwnership.forceLogout(agentId, row.machine_name, OVERSTAY_TRIGGER)
      : !pushLogout;
    const closedAtEst = row.start_est > scheduledEndEst ? row.start_est : scheduledEndEst;
    await db.query(
      `INSERT IGNORE INTO auto_logouts
         (event_id, agent_id, login_session_id, machine_name, aux_code, shift_date,
          scheduled_end_est, segment_started_est, closed_at_est, detected_at_est, app_running)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.event_id, agentId, row.login_session_id, row.machine_name, row.aux_code, shiftDate,
        scheduledEndEst, row.start_est, closedAtEst, nowEst, appRunning ? 1 : 0]
    );
    closedCount++;
    console.warn(`Overstay: agent ${agentId} punched in ${shiftStartedAt.toISOString()} with no biometric ` +
      `Check-Out ${OVERSTAY_HOURS}h+ later - ${row.aux_code} on ${row.machine_name} closed at the scheduled end ${scheduledEndEst}.`);
  }
  return { closedCount, scheduledEndEst, closedAtUtc: closeUtc };
}

// Hourly, alongside autoLogout.js: overstayed shifts whose PC isn't
// asking (switched off, or still on a desktop build without biometrics).
async function runOverstayCheck() {
  const [agents] = await db.query("SELECT DISTINCT agent_id FROM aux_events WHERE ended_at_utc IS NULL");
  let closed = 0;
  for (const { agent_id: agentId } of agents) {
    const shift = await getBiometricShift(agentId);
    if (shift.status !== "overstayed") continue;
    closed += (await closeOverstayedShift(agentId, shift.shiftStartedAt, { pushLogout: true })).closedCount;
  }
  return closed;
}

module.exports = {
  getBiometricShift, shiftFromPunches, resumeFrom, closeOverstayedShift, runOverstayCheck,
  OVERSTAY_HOURS, OVERSTAY_TRIGGER, OVERSTAY_NOTE,
};
