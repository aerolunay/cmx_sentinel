"use strict";

const db = require("../config/db");

// Employee IDs whose recordings the web app doesn't show (sql/013,
// managed by Super Admins on the Recordings page). Only hidden: the
// recordings themselves stay as they are.

// The exempted IDs as a Set of strings. Before sql/013 has been run
// there's no table - nobody is exempted.
async function loadExemptIds() {
  try {
    const [rows] = await db.query("SELECT employee_id FROM recording_exemptions");
    return new Set(rows.map((r) => String(r.employee_id)));
  } catch (err) {
    if (err && err.code === "ER_NO_SUCH_TABLE") return new Set();
    throw err;
  }
}

async function isExempt(employeeId) {
  return (await loadExemptIds()).has(String(employeeId));
}

module.exports = { loadExemptIds, isExempt };
