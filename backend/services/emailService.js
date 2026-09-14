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

module.exports = { sendOtpEmail };