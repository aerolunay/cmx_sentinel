"use strict";

// Shared visual shell for every outgoing email - one place to keep the
// CallMax branding (navy header bar, boxed highlight for a code/detail
// block, gray footer) consistent across sendOtpEmail, sendWelcomeEmail,
// sendTempPasswordEmail and sendViolationAlertEmail, instead of each
// hand-rolling its own HTML. Matches the style already used in other
// CallMax product emails (e.g. CMX Dialer's login-code email).

const NAVY = "#152a5c";
const NAVY_TEXT = "#1a2b5c";
const BODY_TEXT = "#333333";
const MUTED_TEXT = "#6b7280";
const BORDER = "#e2e5ea";
const BOX_BG = "#f8f9fc";
const FOOTER_BG = "#f4f5f7";

/**
 * Wraps `bodyHtml` (already-built inner content - greeting, paragraphs,
 * an optional box from renderBox()) in the full branded email shell.
 * `productName` appears in the footer, e.g. "CMX Sentinel Admin".
 */
function wrapEmailHtml(productName, bodyHtml) {
  return `<!DOCTYPE html>
<html>
  <body style="margin:0; padding:0; background:${FOOTER_BG}; font-family:Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${FOOTER_BG}; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:8px; overflow:hidden;">
            <tr>
              <td style="background:${NAVY}; padding:28px 24px; text-align:center;">
                <span style="color:#ffffff; font-size:26px; font-weight:800; letter-spacing:2px;">CALLMAX</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 40px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="background:${FOOTER_BG}; padding:20px 24px; text-align:center;">
                <span style="color:${MUTED_TEXT}; font-size:13px;">CallMax Solutions &middot; ${productName}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** A paragraph in the body's navy heading color (greeting, lead-in lines). */
function heading(text) {
  return `<p style="margin:0 0 16px; color:${NAVY_TEXT}; font-size:16px; line-height:1.5;">${text}</p>`;
}

/** A plain body paragraph (explanatory/instructional text, expiry notes). */
function paragraph(text) {
  return `<p style="margin:0 0 16px; color:${BODY_TEXT}; font-size:15px; line-height:1.6;">${text}</p>`;
}

/**
 * The light-gray rounded box used for a prominent, centered value - an
 * OTP code or a temporary password. Renders `value` large, bold, navy,
 * letter-spaced, matching the reference design's code box.
 */
function renderCodeBox(value) {
  const spaced = String(value).split("").join(" ");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr>
      <td style="background:${BOX_BG}; border:1px solid ${BORDER}; border-radius:8px; padding:20px; text-align:center;">
        <span style="color:${NAVY_TEXT}; font-size:30px; font-weight:800; letter-spacing:4px;">${spaced}</span>
      </td>
    </tr>
  </table>`;
}

/**
 * The light-gray box for a set of label/value detail rows (used by the
 * welcome email for Name/Role) - same container styling as
 * renderCodeBox, but left-aligned rows instead of one centered value,
 * since a list of details doesn't read well centered.
 */
function renderDetailsBox(rows) {
  const rowsHtml = rows
    .map(
      ([label, value]) => `<tr>
        <td style="padding:6px 0; color:${MUTED_TEXT}; font-size:14px; width:90px;">${label}</td>
        <td style="padding:6px 0; color:${NAVY_TEXT}; font-size:15px; font-weight:700;">${value}</td>
      </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr>
      <td style="background:${BOX_BG}; border:1px solid ${BORDER}; border-radius:8px; padding:18px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${rowsHtml}
        </table>
      </td>
    </tr>
  </table>`;
}

module.exports = { wrapEmailHtml, heading, paragraph, renderCodeBox, renderDetailsBox };
