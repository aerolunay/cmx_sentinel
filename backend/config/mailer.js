"use strict";

const nodemailer = require("nodemailer");

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
// SES SMTP credentials are NOT the same as regular AWS access keys -
// generate these specifically from the SES console (SMTP settings ->
// Create SMTP credentials), not your normal IAM access key/secret.
const SMTP_FROM = process.env.SMTP_FROM;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
  throw new Error(
    "Missing SMTP configuration. Set SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM in backend/.env."
  );
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  // false = STARTTLS on port 587 (the normal SES SMTP setup) - true
  // would mean implicit TLS on port 465 instead.
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
  tls: {
    // Only relevant for unusual network setups (e.g. a corporate proxy
    // doing TLS inspection) - leave this OFF (the default here) against
    // SES's real endpoint, since SES's own certificate is always
    // properly signed and doesn't need this.
    rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== "true",
  },
});

module.exports = { transporter, SMTP_FROM };