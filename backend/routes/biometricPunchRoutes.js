"use strict";

const crypto = require("crypto");
const express = require("express");
const db = require("../config/db");

// ---------------------------------------------------------------------
// Biometric punches straight from zk-sync (the office PC that reads the
// time clocks), sent alongside what it sends to CMX Pulse - so the
// desktop's shift start/end doesn't depend on the Pulse server. Stored in
// biometric_punches (sql/017); services/biometrics.js reads that and
// Pulse's device_attendance_logs together.
//
// POST /api/biometric-punches
//   Authorization: Bearer <BIOMETRIC_PUSH_KEY from backend/.env>
//   { "deviceSerial": "LSR205160865",
//     "punches": [{ "deviceUser": "1234567", "at": "2026-11-06 07:58:12", "state": 0, "verify": 1 }] }
// `at` is the device's wall clock (Manila, UTC+8, no daylight saving).
// Sending the same punch again changes nothing. Answers
//   200 { ok: true, received, stored, rejected: [{ index, reason }] }
//   401 wrong key, 400 bad request, 503 not set up yet (zk-sync retries).
// ---------------------------------------------------------------------

const router = express.Router();

const BATCH_MAX = 500;
const MANILA_OFFSET_MS = 8 * 3600 * 1000;
// Further ahead than this means the device's clock is wrong (same rule as CMX Pulse).
const MAX_AHEAD_MS = 10 * 60 * 1000;
const DEVICE_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

function keyMatches(provided, expected) {
  const a = Buffer.from(provided || "");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requirePushKey(req, res, next) {
  const expected = process.env.BIOMETRIC_PUSH_KEY;
  if (!expected) {
    console.error("BIOMETRIC_PUSH_KEY is not configured - rejecting biometric punches.");
    return res.status(503).json({ error: "Biometric punches aren't set up on this server yet." });
  }
  const match = /^Bearer (.+)$/.exec(req.get("Authorization") || "");
  if (!match || !keyMatches(match[1], expected)) {
    return res.status(401).json({ error: "Invalid or missing key." });
  }
  next();
}

// Manila wall clock -> UTC Date, or null for an impossible time (Feb 30).
function manilaToUtc(deviceTime) {
  const m = DEVICE_TIME.exec(deviceTime);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ") === deviceTime ? d : null;
}

router.post("/", requirePushKey, async (req, res) => {
  const { deviceSerial, punches } = req.body || {};
  if (typeof deviceSerial !== "string" || !deviceSerial.trim() || deviceSerial.length > 64) {
    return res.status(400).json({ error: "deviceSerial is required." });
  }
  if (!Array.isArray(punches) || punches.length > BATCH_MAX) {
    return res.status(400).json({ error: `punches must be a list of at most ${BATCH_MAX}.` });
  }

  const now = Date.now();
  const rows = [];
  const rejected = [];
  punches.forEach((p, index) => {
    const deviceUser = String(p?.deviceUser ?? "").trim();
    const deviceTime = String(p?.at ?? "").trim();
    const state = Number(p?.state);
    const verify = p?.verify == null ? null : Number(p.verify);
    const at = manilaToUtc(deviceTime);
    if (!deviceUser || deviceUser.length > 32) return rejected.push({ index, reason: "bad_user" });
    if (!at) return rejected.push({ index, reason: "bad_time" });
    if (at.getTime() - now > MAX_AHEAD_MS) return rejected.push({ index, reason: "future_time" });
    if (!Number.isInteger(state) || state < 0 || state > 127) return rejected.push({ index, reason: "bad_state" });
    // As a UTC string, not a Date: mysql2 would convert a Date with the
    // Node process's own timezone.
    const punchedAtUtc = at.toISOString().slice(0, 19).replace("T", " ");
    rows.push([deviceSerial.trim(), deviceUser, deviceTime, punchedAtUtc, state, Number.isInteger(verify) ? verify : null]);
  });

  try {
    let stored = 0;
    if (rows.length) {
      const [result] = await db.query(
        `INSERT IGNORE INTO biometric_punches (device_serial, device_user, device_time, punched_at, state, verify_mode)
         VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
        rows.flat()
      );
      stored = result.affectedRows;
    }
    res.json({ ok: true, received: punches.length, stored, rejected });
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({ error: "Run sql/017_biometric_punches.sql first." });
    }
    console.error("Error storing biometric punches:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;
