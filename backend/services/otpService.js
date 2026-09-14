"use strict";

const crypto = require("crypto");
const db = require("../config/db");
const { sendOtpEmail } = require("./emailService");

const OTP_TTL_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 10);

function generateCode() {
  // Cryptographically secure, not Math.random() - this gates account
  // access, so it needs to actually be unpredictable.
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * Looks up a web_users row by EITHER login_identifier OR email,
 * whichever was actually typed - accepted for any role, not just the
 * "official" identifier for that role (Employee ID for admins, email
 * for everyone else). Login is still fully gated behind the OTP
 * either way, so accepting either is a convenience, not a security
 * loosening. If found and active, generates a fresh OTP, invalidates
 * any previous still-valid one for this user (avoids confusion over
 * which of multiple emails is current), and emails it.
 *
 * Deliberately does NOT reveal whether the identifier matched a real
 * account in its return value - same response shape either way - so
 * this endpoint can't be used to enumerate valid Employee IDs/emails by
 * an attacker probing it.
 */
async function requestOtp(loginIdentifier) {
  const [rows] = await db.query(
    "SELECT user_id, email, is_active FROM web_users WHERE login_identifier = ? OR email = ?",
    [loginIdentifier, loginIdentifier]
  );

  if (rows.length === 0 || !rows[0].is_active) {
    return; // silently no-op - see doc comment above
  }

  const user = rows[0];
  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  // Void any previous still-valid code for this user first.
  await db.query(
    "UPDATE otp_codes SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW()",
    [user.user_id]
  );

  await db.query("INSERT INTO otp_codes (user_id, code, expires_at) VALUES (?, ?, ?)", [
    user.user_id,
    code,
    expiresAt,
  ]);

  await sendOtpEmail(user.email, code);
}

/**
 * Verifies a submitted code against the most recent unused, unexpired
 * OTP for the given identifier (Employee ID or email, either accepted
 * - see requestOtp's doc comment). Returns the user record on success,
 * or null on any failure (wrong code, expired, already used, no such
 * user) - same generic failure shape deliberately, to avoid leaking
 * which specific reason it failed for.
 */
async function verifyOtp(loginIdentifier, code) {
  const [userRows] = await db.query(
    "SELECT user_id, role, display_name, is_active FROM web_users WHERE login_identifier = ? OR email = ?",
    [loginIdentifier, loginIdentifier]
  );

  if (userRows.length === 0 || !userRows[0].is_active) {
    return null;
  }

  const user = userRows[0];

  const [otpRows] = await db.query(
    `SELECT otp_id FROM otp_codes
     WHERE user_id = ? AND code = ? AND used_at IS NULL AND expires_at > NOW()
     ORDER BY otp_id DESC LIMIT 1`,
    [user.user_id, code]
  );

  if (otpRows.length === 0) {
    return null;
  }

  await db.query("UPDATE otp_codes SET used_at = NOW() WHERE otp_id = ?", [otpRows[0].otp_id]);

  return user;
}

module.exports = { requestOtp, verifyOtp };