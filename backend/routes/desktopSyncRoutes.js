"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../config/db");
const { requireInternalApiKey } = require("../middleware/requireInternalApiKey");
const { toEasternSqlString, getTodayUtcRangeEastern } = require("../services/easternTime");
const { DateTime } = require("luxon");
const sessionOwnership = require("../services/sessionOwnership");

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
//
// Timestamps come from THIS server's clock, not the startedAtUtc /
// endedAtUtc the desktop sends: an agent PC with a wrong clock (one was
// ~1 hour fast) would otherwise put its whole day at the wrong times.
// Safe because AuxEventLogger.cs reports each transition the moment it
// happens, with no offline queue or retry - arrival time IS the
// transition time, give or take network latency. The desktop's own
// value is still accepted (older builds send it) and only used to log
// PCs whose clocks are noticeably off.
// ---------------------------------------------------------------------

const CLOCK_SKEW_WARN_MS = 2 * 60 * 1000;
const CLOCK_SKEW_WARN_EVERY_MS = 60 * 60 * 1000;
const lastSkewWarningByMachine = new Map();

function warnIfClockSkewed(machineName, clientTimestamp, serverNow) {
  const clientDate = clientTimestamp ? new Date(clientTimestamp) : null;
  if (!clientDate || Number.isNaN(clientDate.getTime())) return;
  const skewMs = clientDate.getTime() - serverNow.getTime();
  if (Math.abs(skewMs) < CLOCK_SKEW_WARN_MS) return;
  const key = machineName || "unknown";
  const last = lastSkewWarningByMachine.get(key) || 0;
  if (serverNow.getTime() - last < CLOCK_SKEW_WARN_EVERY_MS) return;
  lastSkewWarningByMachine.set(key, serverNow.getTime());
  console.warn(`Clock on ${key} is off by ${Math.round(skewMs / 1000)}s - using server time for its aux events.`);
}

router.post("/aux-events/open", async (req, res) => {
  const { agentId, sessionId, machineName, auxCode, startedAtUtc } = req.body || {};
  if (!agentId || !sessionId || !machineName || !auxCode) {
    return res.status(400).json({ error: "agentId, sessionId, machineName, and auxCode are all required." });
  }

  try {
    const startedAtUtcDate = new Date();
    warnIfClockSkewed(machineName, startedAtUtc, startedAtUtcDate);
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
  const { eventId, logoutTrigger } = req.body || {};
  if (!eventId) {
    return res.status(400).json({ error: "eventId is required." });
  }

  try {
    // Server time, same as /open (the request's endedAtUtc is ignored;
    // skew is already logged when the PC opens its next segment).
    const endedAtUtcDate = new Date();
    // GREATEST guards a row that a fast-clocked PC opened BEFORE the
    // switch to server time: its start can be later than "now", and it
    // must not end up with an end before its start or a negative
    // duration.
    await db.query(
      `UPDATE aux_events
       SET ended_at_utc = GREATEST(started_at_utc, ?),
           ended_at_est = GREATEST(started_at_est, ?),
           duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, started_at_utc, ?)),
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
// Session ownership - single-active-session enforcement. Replaces
// StaleSessionCloser.cs / the old /stale-sessions/close endpoint,
// which only ever closed the DB bookkeeping row and never told the
// other machine's live service to actually stop. This does three
// things atomically, in order, on every LOGIN attempt (called from
// IpcServer BEFORE AgentState.Login runs locally - see
// SessionOwnershipClient.cs on the desktop side):
//   1. close out the previous machine's open aux_events row (same SQL
//      as before, logout_trigger='switched_machine')
//   2. push a force_logout event down that machine's live SSE
//      connection, if it has one open right now (near-instant - no
//      polling)
//   3. record this machine as the new owner, so a THIRD machine
//      logging in later evicts the right one
// A machine that's offline/asleep/never subscribed just doesn't get a
// push - there's nothing live to notify, and that's fine: its
// aux_events row is still correctly closed in the DB either way. See
// sessionOwnership.js for why this deliberately doesn't wait for an
// acknowledgement.
// ---------------------------------------------------------------------

router.post("/session/claim", async (req, res) => {
  const { agentId, machineName } = req.body || {};
  if (!agentId || !machineName) {
    return res.status(400).json({ error: "agentId and machineName are required." });
  }

  try {
    const [staleRows] = await db.query(
      `SELECT event_id FROM aux_events
       WHERE agent_id = ? AND ended_at_utc IS NULL AND (machine_name IS NULL OR machine_name <> ?)`,
      [agentId, machineName]
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

    // Ownership claim + push happens AFTER the DB close succeeds, so a
    // pushed force-logout on the other machine is never ahead of the
    // report data actually reflecting it.
    const { previousMachineName, pushed } = sessionOwnership.claim(agentId, machineName);

    if (previousMachineName) {
      console.warn(
        `Agent ${agentId} claimed by ${machineName}, evicting ${previousMachineName} ` +
        `(closed ${staleRows.length} stale event(s), live push ${pushed ? "sent" : "not possible - not connected"}).`
      );
    }

    res.json({ closedCount: staleRows.length, previousMachineName, pushed });
  } catch (err) {
    console.error("Error claiming session:", err);
    res.status(500).json({ closedCount: 0, previousMachineName: null, pushed: false });
  }
});

// Long-lived Server-Sent Events stream - one per logged-in machine.
// The desktop service opens this immediately after a successful LOGIN
// (having already called /session/claim first) and keeps it open for
// the life of that login. A force_logout event means "a different
// machine just claimed this agent's session - log out now."
router.get("/session/subscribe", async (req, res) => {
  const { agentId, machineName } = req.query;
  if (!agentId || !machineName) {
    return res.status(400).json({ error: "agentId and machineName are required." });
  }

  // The ownership registry is in-memory, so after a backend restart it's
  // empty and every logged-in machine reconnects here with no claim on
  // record. Rejecting those would force-logout every agent on every
  // deploy. Instead, re-adopt the machine as owner when the database
  // agrees: its open aux_events row is on this machine (claim() always
  // closes other machines' open rows), or there's no open row at all.
  // Only an open row on a DIFFERENT machine means it really was
  // superseded.
  if (!sessionOwnership.hasOwner(agentId)) {
    try {
      const [openRows] = await db.query(
        `SELECT machine_name FROM aux_events
         WHERE agent_id = ? AND ended_at_utc IS NULL
         ORDER BY started_at_utc DESC LIMIT 1`,
        [agentId]
      );
      const openMachine = openRows[0]?.machine_name;
      if (!openMachine || openMachine === machineName) {
        sessionOwnership.claim(agentId, machineName);
        console.warn(`Re-adopted agent ${agentId}'s session on ${machineName} after the ownership registry was reset.`);
      }
    } catch (err) {
      // Fail open, same as the desktop side does for connection
      // problems - a DB hiccup shouldn't log a working agent out.
      console.error(`Error checking session re-adoption for agent ${agentId}:`, err);
      sessionOwnership.claim(agentId, machineName);
    }
  }

  const attached = sessionOwnership.attachConnection(agentId, machineName, res);
  if (!attached) {
    // This machine claimed ownership, then got evicted by yet another
    // machine before it managed to open this stream - it should treat
    // itself as already logged out rather than sit here believing
    // it's still the active session.
    return res.status(409).json({ error: "This machine is no longer the active session for this agent." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Caddy (and any other intermediary) must not buffer this - see
    // Caddyfile.snippet's flush_interval note.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(": connected\n\n");

  // Keeps the connection alive through proxies/load balancers that
  // drop idle connections, and lets a dead TCP connection surface via
  // a write error instead of hanging around as a zombie in the
  // registry until the next claim() tries to use it.
  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    sessionOwnership.detachConnection(agentId, machineName, res);
  });
});

// Called on a normal (agent-initiated) LOGOUT so this machine's
// ownership entry doesn't linger after it's genuinely no longer
// logged in - without this, a later force_logout push race is
// harmless (the SSE connection is already closed) but the registry
// would otherwise hold a stale "owner" that's actually logged out
// until some other machine happens to claim() and overwrite it.
router.post("/session/release", async (req, res) => {
  const { agentId, machineName } = req.body || {};
  if (!agentId || !machineName) {
    return res.status(400).json({ error: "agentId and machineName are required." });
  }
  sessionOwnership.release(agentId, machineName);
  res.json({ released: true });
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
