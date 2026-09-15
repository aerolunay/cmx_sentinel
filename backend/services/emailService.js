"use strict";

const { transporter, SMTP_FROM } = require("../config/mailer");

async function sendOtpEmail(toEmail, code) {
  await transporter.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: "CMX Sentinel Admin - Your login code",
    text: `Your login code is: ${code}\n\nThis code expires in ${process.env.OTP_EXPIRY_MINUTES || 10} minutes. If you didn't request this, you can ignore this email.`,
    html: `<p>Your login code is: <strong style="font-size:20px;">${code}</strong></p><p>This code expires in ${process.env.OTP_EXPIRY_MINUTES || 10} minutes. If you didn't request this, you can ignore this email.</p>`,
  });
}

async function sendTempPasswordEmail(toEmail, agentId, tempPassword) {
  await transporter.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: "CMX Sentinel - Your password has been reset",
    text: `Your CMX Sentinel password has been reset by an administrator.\n\nAgent ID: ${agentId}\nTemporary password: ${tempPassword}\n\nYou will be required to set a new password the next time you log in.`,
    html: `<p>Your CMX Sentinel password has been reset by an administrator.</p><p>Agent ID: <strong>${agentId}</strong><br/>Temporary password: <strong style="font-size:18px;">${tempPassword}</strong></p><p>You will be required to set a new password the next time you log in.</p>`,
  });
}

module.exports = { sendOtpEmail, sendTempPasswordEmail };