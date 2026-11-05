"use strict";

const { DateTime } = require("luxon");
const db = require("../config/db");
const sessionOwnership = require("./sessionOwnership");
const { mergeWindows, findOwningWindow, shiftEst } = require("./autoLogout");
const { hasWorkSetupColumn, hasColumn } = require("./workSetup");

// Shift start/end come from the office biometric devices, not from
// logging in to the desktop app. The timekeeping app's zk-sync pushes
// every punch into ph_timekeeping.device_attendance_logs (same MySQL
// server - cmx_admin needs SELECT on it, see sql/008) within seconds:
//   device_user  the 7-digit employee number = agents.agent_id
//   punched_at   UTC
//   state        0 Check-In, 1 Check-Out (break/OT states are ignored,
//                same as the timekeeping app's own attendance)
//
// A shift is open from the first Check-In after the last Check-Out until
// the next Check-Out. Check-Ins with no Check-Out in between:
//   - less than DOUBLE_LOGIN_MIN_HOURS after the shift's In: a double
//     scan, ignored
//   - DOUBLE_LOGIN_MIN_HOURS to OVERSTAY_HOURS after it, at the start of
//     the agent's NEXT scheduled shift (from NEXT_SHIFT_EARLY_HOURS before
//     its start to its end; no schedules: NO_SCHEDULE_NEXT_SHIFT_HOURS+
//     after the first In): the agent forgot to log out - this In starts
//     the new shift, and the old one ends at its scheduled end or this In,
//     whichever is earlier, logged as a violation (No Logout).
//   - otherwise DOUBLE_LOGIN_MIN_HOURS to OVERSTAY_HOURS after it: a
//     double login (In pressed instead of Out) - the shift ends at the
//     scheduled end or that second In, whichever is earlier, logged as a
//     violation. The next In, hours later, starts the new shift (one
//     within DOUBLE_LOGIN_MIN_HOURS of the second In is a double scan of
//     it; a Check-Out that soon corrects it - an ordinary end of the shift).
//   - more than OVERSTAY_HOURS after it: the shift was an overstay
//     (closed at the scheduled end) and this In starts the new shift.
// A shift left open longer than OVERSTAY_HOURS (the agent never punched
// out) is closed by the server at the scheduled shift end.
//
// The same 14 hours apply to WFH/hybrid agents, whose shift is their
// Sentinel login (onsite/remote: services/officeNetwork.js): a login
// still open OVERSTAY_HOURS after it started is closed at the scheduled
// end too. This replaced autoLogout.js's "6 hours after the shift end".
const OVERSTAY_HOURS = 14;
// Far enough back to see the whole chain behind the current shift - an
// overstayed or double-login shift's Check-In before it; an In older than
// this with nothing after it is a missed punch-out from days ago,
// handled long since.
const LOOKBACK_HOURS = 72;
const DOUBLE_LOGIN_MIN_HOURS = 4;
const OVERSTAY_TRIGGER = "overstayed";
const DOUBLE_LOGIN_TRIGGER = "double_login";
const DOUBLE_LOGIN_NOTE = "Automatic Logout - Double Login - Biometric Check-In instead of Check-Out";
const NEXT_SHIFT_EARLY_HOURS = 3;
const NO_SCHEDULE_NEXT_SHIFT_HOURS = 12;
const NO_LOGOUT_TRIGGER = "no_logout";
const NO_LOGOUT_NOTE = "Automatic Logout - No Biometrics Logout - Next Shift Check-In";
const OVERSTAY_NOTE = "Automatic Logout - Overstayed - No Biometrics Logout";
const OVERSTAY_NOTE_SENTINEL = "Automatic Logout - Overstayed - No Sentinel Logout";
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
//   status "double_login" the shift from shiftStartedAt was ended by a second
//                        Check-In at punchedOutAt (closed at the scheduled
//                        end or then, whichever is earlier); no new shift yet
//   status "none"        no punches in the lookback window
// previousShift (with "in"/"overstayed"): the shift before this one when it
// had no Check-Out - { shiftStartedAt, reason: "double_login"|"no_logout"|
// "overstayed", secondInAt } - whose rows the server closes if still open.
// schedules: the agent's scheduled shifts around the punches, [{ start, end }]
// as Dates.
function shiftFromPunches(punches, now = new Date(), schedules = []) {
  const overstayMs = OVERSTAY_HOURS * 3600 * 1000;
  const doubleMs = DOUBLE_LOGIN_MIN_HOURS * 3600 * 1000;
  const hour = 3600 * 1000;
  // A Check-In at the open shift's (from openIn) NEXT scheduled shift.
  const isNextShiftIn = (at, openIn) => {
    const near = schedules.filter((w) => w.end > openIn - 24 * hour && w.start < at.getTime() + 24 * hour);
    if (near.length === 0) return at - openIn >= NO_SCHEDULE_NEXT_SHIFT_HOURS * hour;
    return near.some((w) => w.start - openIn >= doubleMs
      && at >= w.start - NEXT_SHIFT_EARLY_HOURS * hour && at < w.end);
  };
  let shiftStartedAt = null;
  let punchedOutAt = null;
  let lastShiftStartedAt = null;
  let doubleLogin = null; // { shiftStartedAt, secondInAt } - waiting for the next shift's In
  let previousShift = null;
  for (const p of punches) {
    if (p.at > now) continue;
    if (p.state === CHECK_IN) {
      if (doubleLogin) {
        if (p.at - doubleLogin.secondInAt < doubleMs) continue; // double scan of the second In
        previousShift = { ...doubleLogin, reason: DOUBLE_LOGIN_TRIGGER };
        doubleLogin = null;
        shiftStartedAt = p.at;
      } else if (!shiftStartedAt) {
        shiftStartedAt = p.at;
      } else if (p.at - shiftStartedAt > overstayMs) {
        previousShift = { shiftStartedAt, secondInAt: null, reason: OVERSTAY_TRIGGER };
        shiftStartedAt = p.at;
      } else if (p.at - shiftStartedAt >= doubleMs) {
        if (isNextShiftIn(p.at, shiftStartedAt)) {
          previousShift = { shiftStartedAt, secondInAt: p.at, reason: NO_LOGOUT_TRIGGER };
          shiftStartedAt = p.at;
        } else {
          doubleLogin = { shiftStartedAt, secondInAt: p.at };
          shiftStartedAt = null;
        }
      }
      // else: a double scan
    } else if (doubleLogin) {
      // A Check-Out soon after the wrong In: the agent corrected it - an
      // ordinary end of the shift. Later than that it's a stray, ignored.
      if (p.at - doubleLogin.secondInAt < doubleMs) {
        lastShiftStartedAt = doubleLogin.shiftStartedAt;
        punchedOutAt = p.at;
        doubleLogin = null;
      }
    } else if (shiftStartedAt || !punchedOutAt) {
      lastShiftStartedAt = shiftStartedAt;
      punchedOutAt = p.at;
      shiftStartedAt = null;
    }
  }

  if (shiftStartedAt) {
    const overstayed = now - shiftStartedAt > overstayMs;
    return { status: overstayed ? "overstayed" : "in", shiftStartedAt, punchedOutAt: null, previousShift };
  }
  if (doubleLogin) {
    return { status: DOUBLE_LOGIN_TRIGGER, shiftStartedAt: doubleLogin.shiftStartedAt, punchedOutAt: doubleLogin.secondInAt };
  }
  if (punchedOutAt) {
    return { status: "out", shiftStartedAt: lastShiftStartedAt, punchedOutAt };
  }
  return { status: "none", shiftStartedAt: null, punchedOutAt: null };
}

// The agent's scheduled shifts around the punch lookback, as UTC Dates
// (agent_schedules is Eastern wall-clock; back-to-back ones merged).
async function loadSchedules(agentId, now) {
  const fromEst = DateTime.fromJSDate(now).setZone(EASTERN).minus({ hours: LOOKBACK_HOURS + 24 }).toFormat(SQL_FORMAT);
  const toEst = DateTime.fromJSDate(now).setZone(EASTERN).plus({ hours: 24 }).toFormat(SQL_FORMAT);
  const [rows] = await db.query(
    `SELECT DATE_FORMAT(shift_date, '%Y-%m-%d') AS shift_date,
            DATE_FORMAT(scheduled_start, '${EST_FORMAT}') AS start,
            DATE_FORMAT(scheduled_end, '${EST_FORMAT}') AS end
     FROM agent_schedules
     WHERE agent_id = ? AND scheduled_end >= ? AND scheduled_start <= ?`,
    [agentId, fromEst, toEst]
  );
  return mergeWindows(rows.map((r) => ({ shiftDate: r.shift_date, start: r.start, end: r.end })))
    .map((w) => ({
      start: DateTime.fromSQL(w.start, { zone: EASTERN }).toJSDate(),
      end: DateTime.fromSQL(w.end, { zone: EASTERN }).toJSDate(),
    }));
}

async function getBiometricShift(agentId, now = new Date()) {
  const [punches, schedules] = await Promise.all([loadPunches(agentId), loadSchedules(agentId, now)]);
  return shiftFromPunches(punches, now, schedules);
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

// Ends every login the agent still has open for a shift with no logout,
// and records each in auto_logouts (Utilization Violations, with the
// reason):
//   overstay (default): AT the scheduled shift end, trigger 'overstayed'
//   double login / no logout (reason DOUBLE_LOGIN_TRIGGER or
//     NO_LOGOUT_TRIGGER, secondInAt): at the scheduled end or the second
//     Check-In, whichever is earlier
// shiftStartedAt: the biometric Check-In, or for WFH the Sentinel login.
// pushLogout: tell the PC over its event stream - an onsite desktop's
// own status check logs itself out without it. note: OVERSTAY_NOTE
// (onsite) or OVERSTAY_NOTE_SENTINEL (WFH) for an overstay. before: only
// rows opened before this time (the next shift's Check-In, when closing
// the shift before it) - that shift's rows stay. The biometric records
// themselves are never changed.
async function closeOverstayedShift(agentId, shiftStartedAt,
  { pushLogout, note = null, before = null, reason = OVERSTAY_TRIGGER, secondInAt = null }) {
  const { shiftDate, scheduledEndEst } = await scheduledEndFor(agentId, shiftStartedAt);
  let closeUtc = DateTime.fromSQL(scheduledEndEst, { zone: EASTERN }).toJSDate();
  if (secondInAt && secondInAt < closeUtc) closeUtc = secondInAt;
  const closeEst = DateTime.fromJSDate(closeUtc).setZone(EASTERN).toFormat(SQL_FORMAT);
  const logoutNote = note
    || { [DOUBLE_LOGIN_TRIGGER]: DOUBLE_LOGIN_NOTE, [NO_LOGOUT_TRIGGER]: NO_LOGOUT_NOTE }[reason]
    || OVERSTAY_NOTE;
  const nowEst = DateTime.now().setZone(EASTERN).toFormat(SQL_FORMAT);
  const withReason = await hasColumn("auto_logouts", "reason");

  // Rows opened during this shift - or shortly before the Check-In, by a
  // desktop that started the session at app login.
  const [openRows] = await db.query(
    `SELECT event_id, login_session_id, machine_name, aux_code,
            DATE_FORMAT(started_at_est, '${EST_FORMAT}') AS start_est
     FROM aux_events
     WHERE agent_id = ? AND ended_at_utc IS NULL AND started_at_utc >= ?${before ? " AND started_at_utc < ?" : ""}`,
    [agentId, new Date(shiftStartedAt.getTime() - 12 * 3600 * 1000), ...(before ? [before] : [])]
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
      [closeUtc, closeEst, closeUtc, reason, logoutNote, row.event_id]
    );
    if (result.affectedRows === 0) continue; // closed normally in the meantime

    const appRunning = pushLogout && row.machine_name
      ? sessionOwnership.forceLogout(agentId, row.machine_name, reason)
      : !pushLogout;
    const closedAtEst = row.start_est > closeEst ? row.start_est : closeEst;
    await db.query(
      `INSERT IGNORE INTO auto_logouts
         (event_id, agent_id, login_session_id, machine_name, aux_code, shift_date,
          scheduled_end_est, segment_started_est, closed_at_est, detected_at_est, app_running${withReason ? ", reason" : ""})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${withReason ? ", ?" : ""})`,
      [row.event_id, agentId, row.login_session_id, row.machine_name, row.aux_code, shiftDate,
        scheduledEndEst, row.start_est, closedAtEst, nowEst, appRunning ? 1 : 0, ...(withReason ? [reason] : [])]
    );
    closedCount++;
    console.warn(`Auto logout (${reason}): agent ${agentId}, shift started ` +
      `${shiftStartedAt.toISOString()} (${logoutNote}) - ${row.aux_code} on ${row.machine_name} closed at ${closeEst} ` +
      `(scheduled end ${scheduledEndEst}).`);
  }
  return { closedCount, scheduledEndEst, closedAtUtc: closeUtc };
}

// The shift before a new Check-In (shift.previousShift) when it had no
// Check-Out - whatever it still has open is closed as a double login or
// an overstay.
function closePreviousShift(agentId, shift, pushLogout) {
  const prev = shift.previousShift;
  return closeOverstayedShift(agentId, prev.shiftStartedAt, {
    pushLogout, before: shift.shiftStartedAt, reason: prev.reason, secondInAt: prev.secondInAt,
  });
}

// Status "double_login": a second Check-In ended the shift, no new one yet.
function closeDoubleLogin(agentId, shift, pushLogout) {
  return closeOverstayedShift(agentId, shift.shiftStartedAt, {
    pushLogout, reason: DOUBLE_LOGIN_TRIGGER, secondInAt: shift.punchedOutAt,
  });
}

// The agent's current (open) Sentinel login: when it started, and
// whether it was recorded from outside the office (aux_events.work_setup,
// sql/010). null if they have no open login.
async function openLogin(agentId) {
  const [[latest]] = await db.query(
    `SELECT login_session_id FROM aux_events
     WHERE agent_id = ? AND ended_at_utc IS NULL
     ORDER BY started_at_utc DESC LIMIT 1`,
    [agentId]
  );
  if (!latest) return null;
  const withSetup = await hasWorkSetupColumn();
  const [[session]] = await db.query(
    `SELECT MIN(started_at_utc) AS started_at, ${withSetup ? "MAX(work_setup = 'remote')" : "0"} AS remote
     FROM aux_events WHERE agent_id = ? AND login_session_id = ?`,
    [agentId, latest.login_session_id]
  );
  if (!session || !session.started_at) return null;
  return { startedAt: new Date(session.started_at), remote: Boolean(Number(session.remote)) };
}

function isOverstayed(shiftStartedAt, now = new Date()) {
  return now - shiftStartedAt > OVERSTAY_HOURS * 3600 * 1000;
}

// WFH/hybrid: a Sentinel login still open OVERSTAY_HOURS after it started
// is closed at the scheduled end and the PC told to log out. Called by
// the desktop's own status check (remote PCs) and the hourly job.
async function closeOverstayedRemoteLogin(agentId) {
  const login = await openLogin(agentId);
  if (!login || !isOverstayed(login.startedAt)) return 0;
  return (await closeOverstayedShift(agentId, login.startedAt, {
    pushLogout: true, note: OVERSTAY_NOTE_SENTINEL,
  })).closedCount;
}

// Hourly (autoLogout.js's job): overstayed shifts whose PC isn't asking -
// switched off, or on a desktop build without these rules. The shift
// starts at the biometric Check-In while one is open, unless the login
// was recorded as remote - then, and when there's no open Check-In, it
// starts at the Sentinel login.
async function runOverstayCheck() {
  const [agents] = await db.query("SELECT DISTINCT agent_id FROM aux_events WHERE ended_at_utc IS NULL");
  let closed = 0;
  for (const { agent_id: agentId } of agents) {
    const login = await openLogin(agentId);
    if (!login) continue;
    const shift = login.remote ? null : await getBiometricShift(agentId);
    if (shift && shift.status === DOUBLE_LOGIN_TRIGGER) {
      closed += (await closeDoubleLogin(agentId, shift, true)).closedCount;
    } else if (shift && (shift.status === "in" || shift.status === "overstayed")) {
      if (shift.previousShift) {
        closed += (await closePreviousShift(agentId, shift, true)).closedCount;
      }
      if (shift.status === "overstayed") {
        closed += (await closeOverstayedShift(agentId, shift.shiftStartedAt, { pushLogout: true })).closedCount;
      }
    } else {
      closed += await closeOverstayedRemoteLogin(agentId);
    }
  }
  return closed;
}

module.exports = {
  getBiometricShift, shiftFromPunches, resumeFrom, closeOverstayedShift, closeOverstayedRemoteLogin,
  closePreviousShift, closeDoubleLogin, runOverstayCheck, OVERSTAY_HOURS, OVERSTAY_TRIGGER, OVERSTAY_NOTE,
  OVERSTAY_NOTE_SENTINEL, DOUBLE_LOGIN_TRIGGER, DOUBLE_LOGIN_MIN_HOURS, NO_LOGOUT_TRIGGER,
};
