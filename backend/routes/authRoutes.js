"use strict";

const express = require("express");
const { requestOtp, verifyOtp } = require("../services/otpService");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();

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

      res.json({ userId: user.user_id, role: user.role, displayName: user.display_name });
    });
  } catch (err) {
    console.error("Error verifying OTP:", err);
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

router.get("/me", requireAuth, (req, res) => {
  res.json({ userId: req.session.userId, role: req.session.role, displayName: req.session.displayName });
});

module.exports = router;
