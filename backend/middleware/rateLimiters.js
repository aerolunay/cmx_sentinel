"use strict";

const rateLimit = require("express-rate-limit");

// Keyed by IP (express-rate-limit's default via req.ip) - requires
// server.js to set app.set("trust proxy", ...) correctly, or every
// request arriving through Caddy would appear to come from the same
// address, making this either useless (if trust proxy is unset - req.ip
// just resolves to Caddy's own loopback address) or spoofable (if set
// too permissively). See server.js for the specific setting used.
//
// A 6-digit OTP/TOTP code is only 1,000,000 possibilities - without
// this, verify-otp and login-totp were brute-forceable by a simple
// script within the code's validity window. 10 attempts per 15 minutes
// makes even 1% of the code space take roughly 250 hours to try.
const otpAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

// Looser limit for request-otp/check-user - these don't gate a secret
// code directly, but still deserve a cap to prevent spamming a
// target's inbox with OTP emails or hammering the account-lookup query.
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

module.exports = { otpAttemptLimiter, otpRequestLimiter };
