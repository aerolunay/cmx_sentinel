"use strict";

const express = require("express");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const db = require("../config/db");
const { requestOtp, verifyOtp } = require("../services/otpService");
const { requireAuth } = require("../middleware/requireAuth");
const { version: BACKEND_VERSION } = require("../package.json");

const router = express.Router();

/*
Shown on the login page and header (before anyone's authenticated,
hence no requireAuth here) - reads the backend's own version straight
from its package.json, so it always reflects whatever's actually
running, no separate value to keep in sync by hand. Same pattern
cmx_callsuite_v2 uses for the same reason.
*/
router.get("/version", (req, res) => {
  res.json({ version: BACKEND_VERSION });
});

/*
Used by the login screen to decide which buttons to show BEFORE
requesting an OTP - "Send Login Code" only, or both that and "Login
using Authenticator" if TOTP is already enrolled for this account.

NOTE - unlike request-otp, this deliberately reveals whether an
identifier has TOTP enabled (not whether the account exists at all,
but a step closer) - same trade-off cmx_callsuite_v2 makes and
documents for the same reason: acceptable for an internal admin tool
with known staff, would need reconsidering if this were ever exposed
more publicly.
*/
router.post("/check-user", async (req, res) => {
  const { loginIdentifier } = req.body || {};
  if (!loginIdentifier) {
    return res.status(400).json({ error: "Enter your Employee ID or email address." });
  }

  try {
    const [rows] = await db.query(
      "SELECT totp_enabled FROM web_users WHERE (login_identifier = ? OR email = ?) AND is_active = TRUE",
      [loginIdentifier.trim(), loginIdentifier.trim()]
    );
    res.json({ totpEnabled: rows.length ? Boolean(rows[0].totp_enabled) : false });
  } catch (err) {
    console.error("Error checking user:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.post("/request-otp", async (req, res) => {
  const { loginIdentifier } = req.body || {};
  if (!loginIdentifier) {
    return res.status(400).json({ error: "Enter your Employee ID or email address." });
  }

  try {
    await requestOtp(loginIdentifier.trim());
  } catch (err) {
    console.error("Error requesting OTP:", err);
    // Still return success below - see requestOtp's doc comment for
    // why this endpoint never reveals whether the identifier matched a
    // real account.
  }

  // Always the same response, whether or not the identifier matched a
  // real account - otherwise this endpoint could be used to enumerate
  // valid Employee IDs/emails.
  res.json({ message: "If that account exists, a login code has been sent to its email." });
});

router.post("/verify-otp", async (req, res) => {
  const { loginIdentifier, code } = req.body || {};
  if (!loginIdentifier || !code) {
    return res.status(400).json({ error: "Enter both your identifier and the code." });
  }

  try {
    const user = await verifyOtp(loginIdentifier.trim(), code.trim());
    if (!user) {
      return res.status(401).json({ error: "Invalid or expired code." });
    }

    // Regenerate the session on login - standard practice to prevent
    // session fixation.
    req.session.regenerate((err) => {
      if (err) {
        console.error("Session regenerate error:", err);
        return res.status(500).json({ error: "A server error occurred. Please try again." });
      }

      req.session.userId = user.user_id;
      req.session.role = user.role;
      req.session.displayName = user.display_name;
      req.session.loginIdentifier = user.login_identifier;

      res.json({
        userId: user.user_id,
        role: user.role,
        displayName: user.display_name,
        totpEnabled: Boolean(user.totp_enabled),
      });
    });
  } catch (err) {
    console.error("Error verifying OTP:", err);
    res.status(500).json({ error: "A server error occurred. Please try again." });
  }
});

/*
TOTP ENROLLMENT - similar to cmx_callsuite_v2's Setup2FAModal.jsx flow.
POST /totp/setup - generates a secret + QR code, but does NOT enable
TOTP yet. Requires an active session (i.e. the user already logged in
via OTP once) - enrollment is something you do FROM inside the app,
not a standalone unauthenticated flow.
POST /totp/confirm - verifies the first real code from the
authenticator app and only THEN flips totp_enabled on - this proves
the user actually scanned the QR into a real app, not just that setup
was started.
*/
router.post("/totp/setup", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT login_identifier FROM web_users WHERE user_id = ?", [
      req.session.userId,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Account not found." });
    }

    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(rows[0].login_identifier, "CMX Sentinel Admin", secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

    // Stored but not yet "enabled" - only confirmed after /totp/confirm.
    await db.query("UPDATE web_users SET totp_secret = ? WHERE user_id = ?", [secret, req.session.userId]);

    res.json({ qrDataUrl });
  } catch (err) {
    console.error("Error starting TOTP setup:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.post("/totp/confirm", requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!code) {
    return res.status(400).json({ error: "Enter the code from your authenticator app." });
  }

  try {
    const [rows] = await db.query("SELECT totp_secret FROM web_users WHERE user_id = ?", [req.session.userId]);
    if (rows.length === 0 || !rows[0].totp_secret) {
      return res.status(400).json({ error: "No authenticator setup in progress." });
    }

    const valid = authenticator.check(code.trim(), rows[0].totp_secret);
    if (!valid) {
      return res.status(401).json({ error: "Invalid code." });
    }

    await db.query("UPDATE web_users SET totp_enabled = TRUE WHERE user_id = ?", [req.session.userId]);

    res.json({ message: "Authenticator enabled." });
  } catch (err) {
    console.error("Error confirming TOTP setup:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

/*
TOTP LOGIN - for returning users who already enrolled. Skips email
entirely - enter your identifier + the code your app is showing right
now, done. This is the whole point of setting it up: no waiting for an
email to arrive.
*/
router.post("/login-totp", async (req, res) => {
  const { loginIdentifier, code } = req.body || {};
  if (!loginIdentifier || !code) {
    return res.status(400).json({ error: "Enter both your identifier and the code." });
  }

  try {
    const [rows] = await db.query(
      `SELECT user_id, role, display_name, login_identifier, totp_secret
       FROM web_users
       WHERE (login_identifier = ? OR email = ?) AND is_active = TRUE AND totp_enabled = TRUE`,
      [loginIdentifier.trim(), loginIdentifier.trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid identifier or code." });
    }

    const user = rows[0];
    const valid = authenticator.check(code.trim(), user.totp_secret);
    if (!valid) {
      return res.status(401).json({ error: "Invalid identifier or code." });
    }

    req.session.regenerate((err) => {
      if (err) {
        console.error("Session regenerate error:", err);
        return res.status(500).json({ error: "A server error occurred. Please try again." });
      }

      req.session.userId = user.user_id;
      req.session.role = user.role;
      req.session.displayName = user.display_name;
      req.session.loginIdentifier = user.login_identifier;

      res.json({ userId: user.user_id, role: user.role, displayName: user.display_name, totpEnabled: true });
    });
  } catch (err) {
    console.error("Error during TOTP login:", err);
    res.status(500).json({ error: "A server error occurred. Please try again." });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Session destroy error:", err);
    }
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT totp_enabled FROM web_users WHERE user_id = ?", [req.session.userId]);
    res.json({
      userId: req.session.userId,
      role: req.session.role,
      displayName: req.session.displayName,
      totpEnabled: rows.length ? Boolean(rows[0].totp_enabled) : false,
    });
  } catch (err) {
    console.error("Error fetching current user:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;