"use strict";

const { transporter, SMTP_FROM } = require("../config/mailer");
const { wrapEmailHtml, heading, paragraph, renderCodeBox, renderDetailsBox } = require("./emailTemplate");

const PRODUCT_NAME = "CMX Sentinel Admin";

// Where the welcome email sends a new user to log in. Falls back to a
// placeholder rather than throwing at startup like mailer.js's SMTP
// vars do - a missing login link is a broken email, not a broken app,
// so this degrades rather than taking down every other route.
const ADMIN_APP_URL = process.env.ADMIN_APP_URL || "https://sentinel.cmxinnovations.com";

// Mirrors formatRole() in frontend/src/utils/roles.js - kept as its own
// small copy here (rather than importing across the frontend/backend
// boundary, which isn't set up to share code) since this is the only
// place the backend needs a human-readable role label. If a new role
// value is ever added, update both copies.
const ROLE_LABELS = { super_admin: "Super Admin", tqa: "TQA", clinic: "Med / Clinic" };
function formatRole(role) {
  if (!role) return "";
  if (ROLE_LABELS[role]) return ROLE_LABELS[role];
  return role.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function sendOtpEmail(toEmail, code) {
  const minutes = process.env.OTP_EXPIRY_MINUTES || 10;
  const html = wrapEmailHtml(
    PRODUCT_NAME,
    heading("Here's your CMX Sentinel Admin login code:") +
      renderCodeBox(code) +
      paragraph(`This code expires in ${minutes} minutes. If you didn't request this, you can safely ignore this email.`)
  );
  await transporter.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: "CMX Sentinel Admin - Your login code",
    text: `Your login code is: ${code}\n\nThis code expires in ${minutes} minutes. If you didn't request this, you can ignore this email.`,
    html,
  });
}

/**
 * Sent once, when a super_admin creates a new web dashboard user (see
 * POST /api/users). `usesEmployeeId` decides the login-identifier
 * guidance line: Admin/Super Admin log in with a numeric Employee ID,
 * every other role logs in with their email - see userRoutes.js's own
 * usesEmployeeId check, which this must stay consistent with.
 */
async function sendWelcomeEmail(toEmail, displayName, role, loginIdentifier, usesEmployeeId) {
  const identifierLabel = usesEmployeeId ? "Employee ID" : "email address";
  const html = wrapEmailHtml(
    PRODUCT_NAME,
    heading(`Hi ${displayName},`) +
      paragraph(
        `Welcome to ${PRODUCT_NAME}. An account has been created for you with the following details:`
      ) +
      renderDetailsBox([
        ["Name", displayName],
        ["Role", formatRole(role)],
      ]) +
      paragraph(
        `<strong>To log in:</strong><br/>` +
          `1. Go to <a href="${ADMIN_APP_URL}" style="color:#2563eb;">${ADMIN_APP_URL}</a><br/>` +
          `2. Enter your ${identifierLabel} (<strong>${loginIdentifier}</strong>)<br/>` +
          `3. We'll email you a one-time login code - enter it to sign in`
      ) +
      paragraph("No password to remember - every login uses a fresh code sent to this email address.")
  );
  await transporter.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: `Welcome to ${PRODUCT_NAME}`,
    text:
      `Welcome to ${PRODUCT_NAME}. An account has been created for you with the following details:\n\n` +
      `Name: ${displayName}\nRole: ${formatRole(role)}\n\n` +
      `To log in:\n1. Go to ${ADMIN_APP_URL}\n2. Enter your ${identifierLabel} (${loginIdentifier})\n` +
      `3. We'll email you a one-time login code - enter it to sign in\n\n` +
      `No password to remember - every login uses a fresh code sent to this email address.`,
    html,
  });
}

async function sendTempPasswordEmail(toEmail, agentId, tempPassword) {
  const html = wrapEmailHtml(
    PRODUCT_NAME,
    heading("Your CMX Sentinel password has been reset by an administrator.") +
      renderDetailsBox([
        ["Agent ID", agentId],
        ["Temp. password", tempPassword],
      ]) +
      paragraph("You will be required to set a new password the next time you log in.")
  );
  await transporter.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: "CMX Sentinel - Your password has been reset",
    text: `Your CMX Sentinel password has been reset by an administrator.\n\nAgent ID: ${agentId}\nTemporary password: ${tempPassword}\n\nYou will be required to set a new password the next time you log in.`,
    html,
  });
}

async function sendViolationAlertEmail(toEmail, agentDisplayName, agentId, domain, path, blockedAt) {
  const html = wrapEmailHtml(
    PRODUCT_NAME,
    heading(`Restricted site access blocked`) +
      paragraph(`<strong>${agentDisplayName}</strong> (${agentId}) attempted to visit a restricted site.`) +
      renderDetailsBox([
        ["Site", `${domain}${path}`],
        ["Time", blockedAt],
      ]) +
      paragraph("The request was blocked - this is a notification only, no action was taken automatically.")
  );
  await transporter.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: `CMX Sentinel - Restricted site access blocked (${agentDisplayName})`,
    text: `${agentDisplayName} (${agentId}) attempted to visit a restricted site.\n\nSite: ${domain}${path}\nTime: ${blockedAt}\n\nThe request was blocked - this is a notification only, no action was taken automatically.`,
    html,
  });
}

// d: agentName, agentId, auxName (Production/Admin/Adhoc), groupName,
// machineName, inactiveSinceEst, idleSetAtEst (Eastern wall-clock),
// idleMinutes.
async function sendInactivityAlertEmail(toEmail, d) {
  const html = wrapEmailHtml(
    PRODUCT_NAME,
    heading(`${d.auxName} auto-set to Idle - inactivity`) +
      paragraph(`<strong>${d.agentName}</strong> (${d.agentId}) was in ${d.auxName} with no activity for 5 minutes ` +
        "and did not confirm the 1-minute prompt, so their aux was set to Idle.") +
      renderDetailsBox([
        ["Aux ended", d.auxName],
        ["Group", d.groupName],
        ["PC", d.machineName],
        ["Inactive since", `${d.inactiveSinceEst} ET`],
        ["Set to Idle at", `${d.idleSetAtEst} ET`],
        ["Changed to Idle", `${d.idleMinutes} minutes (from the last activity)`],
      ]) +
      paragraph("This is a notification only - the change is already recorded on the agent's aux log.")
  );
  await transporter.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: `CMX Sentinel - Inactivity: ${d.agentName} auto-set to Idle`,
    text: `${d.agentName} (${d.agentId}) was in ${d.auxName} with no activity for 5 minutes and did not confirm ` +
      "the 1-minute prompt, so their aux was set to Idle.\n\n" +
      `Aux ended: ${d.auxName}\nGroup: ${d.groupName}\nPC: ${d.machineName}\nInactive since: ${d.inactiveSinceEst} ET\n` +
      `Set to Idle at: ${d.idleSetAtEst} ET\nChanged to Idle: ${d.idleMinutes} minutes (from the last activity)\n\n` +
      "This is a notification only - the change is already recorded on the agent's aux log.",
    html,
  });
}

module.exports = {
  sendOtpEmail, sendWelcomeEmail, sendTempPasswordEmail, sendViolationAlertEmail, sendInactivityAlertEmail,
};
