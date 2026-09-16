"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../config/db");
const { requireInternalApiKey } = require("../middleware/requireInternalApiKey");
const { toEasternSqlString, getTodayUtcRangeEastern } = require("../services/easternTime");
const { DateTime } = require("luxon");

const router = express.Router();

// Everything here is machine-to-machine (the desktop service, not a
// browser) - same API-key auth as violationRoutes.js, applied to the
// whole router since every endpoint here needs it.
router.use(requireInternalApiKey);

// ---------------------------------------------------------------------
// Auth - replaces AuthService.cs's direct MySQL queries. The actual
// bcrypt comparison now happens HERE, server-side, not on the desktop
// machine - the desktop service just relays what the agent typed and
// trusts this response, same trust model as before (the SERVICE was
// already the trusted party doing the verification, not the tray app -
// this just moves that trust boundary one hop further to a server the
// desktop machine can't tamper with even if fully compromised).
// ---------------------------------------------------------------------

router.post("/auth/verify", async (req, res) => {
  const { agentId, password } = req.body || {};
  if (!agentId || !password) {
    return res.status(400).json({ success: false, error: "agentId and password are required." });
  }

  try {
    const [rows] = await db.query(
      "SELECT password_hash, is_active, display_name, must_reset_password FROM agents WHERE agent_id = ? LIMIT 1",
      [agentId]
    );

    if (rows.length === 0) {
      return res.json({ success: false, error: "Invalid agent ID or password." });
    }

    const agent = rows[0];
    if (!agent.is_active) {
      return res.json({ success: false, error: "This account is deactivated." });
    }

    const valid = await bcrypt.compare(password, agent.password_hash);
    if (!valid) {
      // Deliberately the same generic message as "unknown agent" above
      // - don't reveal whether the agent ID exists to someone guessing
      // credentials.
      return res.json({ success: false, error: "Invalid agent ID or password." });
    }

    res.json({
      success: true,
      displayName: agent.display_name,
      mustResetPassword: Boolean(agent.must_reset_password),
    });
  } catch (err) {
    console.error("Error verifying agent credentials:", err);
    res.status(500).json({ success: false, error: "Could not reach the authentication server. Try again shortly." });
  }
});

router.post("/auth/set-new-password", async (req, res) => {
  const { agentId, newPassword } = req.body || {};
  if (!agentId || !newPassword) {
    return res.status(400).json({ success: false, error: "agentId and newPassword are required." });
  }

  try {
    const newHash = await bcrypt.hash(newPassword, 11);
    const [result] = await db.query(
      "UPDATE agents SET password_hash = ?, must_reset_password = FALSE WHERE agent_id = ?",
      [newHash, agentId]
    );
    res.json({ success: result.affectedRows > 0 });
  } catch (err) {
    console.error("Error setting new agent password:", err);
    res.status(500).json({ success: false });
  }
});

// ---------------------------------------------------------------------
// Aux events - replaces AuxEventLogger.cs's INSERT/UPDATE. The desktop
// service still tracks which event_id is currently "open" per agent in
// its own memory (unchanged) - this just moves where the actual SQL
// happens.
// ---------------------------------------------------------------------

router.post("/aux-events/open", async (req, res) => {
  const { agentId, sessionId, machineName, auxCode, startedAtUtc } = req.body || {};
  if (!agentId || !sessionId || !machineName || !auxCode || !startedAtUtc) {
    return res.status(400).json({ error: "agentId, sessionId, machineName, auxCode, and startedAtUtc are all required." });
  }

  try {
    const startedAtUtcDate = new Date(startedAtUtc);
    const [result] = await db.query(
      `INSERT INTO aux_events (agent_id, login_session_id, machine_name, aux_code, started_at_utc, started_at_est)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [agentId, sessionId, machineName, auxCode, startedAtUtcDate, toEasternSqlString(startedAtUtcDate)]
    );
    res.json({ eventId: result.insertId });
  } catch (err) {
    console.error("Error opening aux event:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.post("/aux-events/close", async (req, res) => {
  const { eventId, endedAtUtc, logoutTrigger } = req.body || {};
  if (!eventId || !endedAtUtc) {
    return res.status(400).json({ error: "eventId and endedAtUtc are required." });
  }

  try {
    const endedAtUtcDate = new Date(endedAtUtc);
    await db.query(
      `UPDATE aux_events
       SET ended_at_utc = ?,
           ended_at_est = ?,
           duration_seconds = TIMESTAMPDIFF(SECOND, started_at_utc, ?),
           logout_trigger = ?
       WHERE event_id = ?`,
      [endedAtUtcDate, toEasternSqlString(endedAtUtcDate), endedAtUtcDate, logoutTrigger || null, eventId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error closing aux event:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// ---------------------------------------------------------------------
// Daily totals - replaces DailyTotalsService.cs, including its
// overnight-shift-continuity logic (a shift starting late Eastern that
// crosses midnight stays attributed to the day it started, not split
// across two "days").
// ---------------------------------------------------------------------

router.get("/daily-totals", async (req, res) => {
  const { agentId } = req.query;
  if (!agentId) {
    return res.status(400).json({ error: "agentId is required." });
  }

  const SHIFT_CONTINUITY_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours, matches DailyTotalsService.cs

  try {
    let { startUtc, endUtc } = getTodayUtcRangeEastern();

    // Resolve whether this should be treated as a continuation of an
    // overnight shift rather than a fresh "today" - same logic as
    // DailyTotalsService.ResolveAggregationDayRangeAsync.
    const [lastRows] = await db.query(
      `SELECT started_at_utc, ended_at_utc FROM aux_events
       WHERE agent_id = ? ORDER BY started_at_utc DESC LIMIT 1`,
      [agentId]
    );

    if (lastRows.length > 0) {
      const lastActivityUtc = lastRows[0].ended_at_utc ?? lastRows[0].started_at_utc;
      const recentEnough = Date.now() - new Date(lastActivityUtc).getTime() <= SHIFT_CONTINUITY_WINDOW_MS;

      const lastActivityEastern = DateTime.fromJSDate(new Date(lastActivityUtc), { zone: "utc" }).setZone("America/New_York");
      const nowEastern = DateTime.now().setZone("America/New_York");
      const differentCalendarDay = !lastActivityEastern.hasSame(nowEastern, "day");

      if (recentEnough && differentCalendarDay) {
        const priorDayStart = lastActivityEastern.startOf("day");
        startUtc = priorDayStart.toUTC().toJSDate();
        endUtc = priorDayStart.plus({ days: 1 }).toUTC().toJSDate();
      }
    }

    const [totalRows] = await db.query(
      `SELECT aux_code, SUM(duration_seconds) AS total_seconds
       FROM aux_events
       WHERE agent_id = ? AND started_at_utc >= ? AND started_at_utc < ? AND duration_seconds IS NOT NULL
       GROUP BY aux_code`,
      [agentId, startUtc, endUtc]
    );

    const totals = {};
    for (const row of totalRows) {
      totals[row.aux_code] = Number(row.total_seconds);
    }

    res.json({ totals });
  } catch (err) {
    console.error("Error loading daily totals:", err);
    res.status(500).json({ totals: {} }); // fail soft - matches DailyTotalsService's own "start from zero" fallback
  }
});

// ---------------------------------------------------------------------
// Restrictions - replaces PolicyService.cs. Deliberately fails OPEN
// (empty rule list, HTTP 200) on error, not a 500 - same "don't block
// someone's job over a transient hiccup" reasoning PolicyService.cs's
// own comment already documents.
// ---------------------------------------------------------------------

router.get("/restrictions", async (req, res) => {
  const { agentId } = req.query;
  if (!agentId) {
    return res.status(400).json({ error: "agentId is required." });
  }

  try {
    const [rows] = await db.query(
      `SELECT rp.domain, rp.path_prefix
       FROM agents a
       JOIN restricted_paths rp ON rp.group_id = a.group_id
       WHERE a.agent_id = ? AND rp.is_active = TRUE`,
      [agentId]
    );
    res.json({ rules: rows.map((r) => ({ domain: r.domain, pathPrefix: r.path_prefix })) });
  } catch (err) {
    console.error("Error loading restriction rules:", err);
    res.json({ rules: [] }); // fail open, deliberately 200 not 500
  }
});

// ---------------------------------------------------------------------
// Stale session closing - replaces StaleSessionCloser.cs.
// ---------------------------------------------------------------------

router.post("/stale-sessions/close", async (req, res) => {
  const { agentId, thisMachine } = req.body || {};
  if (!agentId || !thisMachine) {
    return res.status(400).json({ error: "agentId and thisMachine are required." });
  }

  try {
    const [staleRows] = await db.query(
      `SELECT event_id FROM aux_events
       WHERE agent_id = ? AND ended_at_utc IS NULL AND (machine_name IS NULL OR machine_name <> ?)`,
      [agentId, thisMachine]
    );

    const now = new Date();
    for (const row of staleRows) {
      await db.query(
        `UPDATE aux_events
         SET ended_at_utc = ?, ended_at_est = ?,
             duration_seconds = TIMESTAMPDIFF(SECOND, started_at_utc, ?),
             logout_trigger = 'switched_machine'
         WHERE event_id = ?`,
        [now, toEasternSqlString(now), now, row.event_id]
      );
    }

    res.json({ closedCount: staleRows.length });
  } catch (err) {
    console.error("Error closing stale sessions:", err);
    res.status(500).json({ closedCount: 0 });
  }
});

// ---------------------------------------------------------------------
// Session recovery - replaces SessionRecoveryService.cs. Note:
// login_session_id's GetStringOrGuid workaround on the C# side was only
// needed because of how MySqlConnector's driver-level GUID detection
// behaved - mysql2 on the Node side doesn't have that same quirk, so
// no equivalent handling is needed here.
// ---------------------------------------------------------------------

router.get("/session-recovery", async (req, res) => {
  const { machineName } = req.query;
  if (!machineName) {
    return res.status(400).json({ found: false });
  }

  try {
    const [rows] = await db.query(
      `SELECT ae.agent_id, ae.login_session_id, ae.aux_code, ae.started_at_utc, a.display_name
       FROM aux_events ae JOIN agents a ON a.agent_id = ae.agent_id
       WHERE ae.machine_name = ? AND ae.ended_at_utc IS NULL
       ORDER BY ae.started_at_utc DESC LIMIT 1`,
      [machineName]
    );

    if (rows.length === 0) {
      return res.json({ found: false });
    }

    const row = rows[0];

    const [startRows] = await db.query(
      "SELECT MIN(started_at_utc) AS session_start FROM aux_events WHERE login_session_id = ?",
      [row.login_session_id]
    );
    const sessionStartedAtUtc = startRows[0]?.session_start ?? row.started_at_utc;

    res.json({
      found: true,
      agentId: row.agent_id,
      sessionId: row.login_session_id,
      auxCode: row.aux_code,
      displayName: row.display_name,
      currentSegmentStartedAtUtc: new Date(row.started_at_utc).toISOString(),
      sessionStartedAtUtc: new Date(sessionStartedAtUtc).toISOString(),
    });
  } catch (err) {
    console.error("Error during session recovery lookup:", err);
    res.status(500).json({ found: false });
  }
});

module.exports = router;
