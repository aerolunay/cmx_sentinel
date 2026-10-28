"use strict";

const { DateTime } = require("luxon");
const db = require("../config/db");
const sessionOwnership = require("./sessionOwnership");

// Logins left open long after the shift (the agent never logged out:
// PC shut down, or Sentinel just left running) are closed by the
// server. Every hour, any aux_events row still open OVERRIDE_AFTER_HOURS
// after its shift's scheduled end is ended AT the scheduled end - the
// hours after it never count as worked - the PC is logged out if
// Sentinel is still connected, and the agent is recorded in
// auto_logouts (Reports > Logout Offenders).
//
// Which shift a segment belongs to: the earliest schedule window (the
// agent's same-day rows merged, e.g. Regular + OT back to back) that
// hadn't passed its override time when the segment started. So a
// segment started before or during the shift, or up to 6 hours after
// it, belongs to that shift; one started later belongs to the next.
// A segment that started after the scheduled end is ended where it
// started. Agents with no schedule are left alone.
const OVERRIDE_AFTER_HOURS = 6;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const EASTERN = "America/New_York";
const SQL_FORMAT = "yyyy-MM-dd HH:mm:ss";
const EST_FORMAT = "%Y-%m-%d %H:%i:%s";

function shiftEst(estString, hours) {
  return DateTime.fromSQL(estString, { zone: EASTERN }).plus({ hours }).toFormat(SQL_FORMAT);
}

// Back-to-back or overlapping windows count as one shift.
function mergeWindows(windows) {
  const merged = [];
  for (const w of [...windows].sort((a, b) => a.start.localeCompare(b.start))) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      if (w.end > last.end) last.end = w.end;
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

async function runAutoLogout() {
  const nowEst = DateTime.now().setZone(EASTERN).toFormat(SQL_FORMAT);
  const cutoffEst = shiftEst(nowEst, -OVERRIDE_AFTER_HOURS);

  const [openRows] = await db.query(
    `SELECT event_id, agent_id, login_session_id, machine_name, aux_code, started_at_utc,
            DATE_FORMAT(started_at_est, '${EST_FORMAT}') AS start_est
     FROM aux_events
     WHERE ended_at_utc IS NULL AND started_at_est IS NOT NULL`
  );
  if (openRows.length === 0) return 0;

  const earliestStart = openRows.reduce((min, r) => (r.start_est < min ? r.start_est : min), openRows[0].start_est);
  const [windowRows] = await db.query(
    `SELECT agent_id, DATE_FORMAT(shift_date, '%Y-%m-%d') AS shift_date,
            DATE_FORMAT(scheduled_start, '${EST_FORMAT}') AS start,
            DATE_FORMAT(scheduled_end, '${EST_FORMAT}') AS end
     FROM agent_schedules
     WHERE agent_id IN (?) AND scheduled_end >= ? AND scheduled_start <= ?`,
    [[...new Set(openRows.map((r) => r.agent_id))], shiftEst(earliestStart, -OVERRIDE_AFTER_HOURS), nowEst]
  );
  const windowsByAgent = new Map();
  for (const w of windowRows) {
    if (!windowsByAgent.has(w.agent_id)) windowsByAgent.set(w.agent_id, []);
    windowsByAgent.get(w.agent_id).push({ shiftDate: w.shift_date, start: w.start, end: w.end });
  }
  for (const [agentId, windows] of windowsByAgent) windowsByAgent.set(agentId, mergeWindows(windows));

  let closedCount = 0;
  for (const row of openRows) {
    const window = (windowsByAgent.get(row.agent_id) || [])
      .find((w) => shiftEst(w.end, OVERRIDE_AFTER_HOURS) >= row.start_est);
    if (!window || window.end > cutoffEst) continue;

    const closeEst = row.start_est > window.end ? row.start_est : window.end;
    const closeUtc = DateTime.fromSQL(closeEst, { zone: EASTERN }).toJSDate();
    const [result] = await db.query(
      `UPDATE aux_events
       SET ended_at_utc = GREATEST(started_at_utc, ?),
           ended_at_est = GREATEST(started_at_est, ?),
           duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, started_at_utc, ?)),
           logout_trigger = 'schedule_end'
       WHERE event_id = ? AND ended_at_utc IS NULL`,
      [closeUtc, closeEst, closeUtc, row.event_id]
    );
    if (result.affectedRows === 0) continue; // closed normally in the meantime

    // Only log the PC out if this is still the agent's latest login - an
    // old row left behind by a crash must not end the session they're
    // working in now.
    const [newer] = await db.query(
      "SELECT 1 FROM aux_events WHERE agent_id = ? AND started_at_utc > ? LIMIT 1",
      [row.agent_id, row.started_at_utc]
    );
    const appRunning = newer.length === 0 && row.machine_name
      ? sessionOwnership.forceLogout(row.agent_id, row.machine_name, "schedule_ended")
      : false;

    await db.query(
      `INSERT IGNORE INTO auto_logouts
         (event_id, agent_id, login_session_id, machine_name, aux_code, shift_date,
          scheduled_end_est, segment_started_est, closed_at_est, detected_at_est, app_running)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.event_id, row.agent_id, row.login_session_id, row.machine_name, row.aux_code, window.shiftDate,
        window.end, row.start_est, closeEst, nowEst, appRunning ? 1 : 0]
    );
    closedCount++;
    console.warn(`Auto-logout: agent ${row.agent_id} on ${row.machine_name} still in ${row.aux_code} ` +
      `${OVERRIDE_AFTER_HOURS}h+ after their shift ended at ${window.end} - closed at ${closeEst}` +
      `${appRunning ? " (Sentinel was still running, logged out)" : ""}.`);
  }
  return closedCount;
}

function startAutoLogoutJob() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAutoLogout();
    } catch (err) {
      console.error("Auto-logout check failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = { runAutoLogout, startAutoLogoutJob, OVERRIDE_AFTER_HOURS };
