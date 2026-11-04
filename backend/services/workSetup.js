"use strict";

const db = require("../config/db");
const { isOfficeIp, officeNetworkConfigured } = require("./officeNetwork");

// Each aux_events row remembers whether it was opened from the office
// network ("onsite") or not ("remote") - aux_events.work_setup, see
// sql/010 - so the dashboard can filter historical numbers by it. NULL
// for rows from before that, or while OFFICE_PUBLIC_IPS is unset (when
// everyone is treated as onsite anyway); reports count NULL as onsite.

// "onsite" / "remote" for a desktop request, or null while the office
// network isn't configured.
function workSetupForIp(ip) {
  if (!officeNetworkConfigured()) return null;
  return isOfficeIp(ip) ? "onsite" : "remote";
}

// Whether sql/010 has been run - queries skip the column until it has,
// so deploying the code first doesn't break anything. A "no" is checked
// again every few minutes, so running the migration needs no restart.
const RECHECK_MS = 5 * 60 * 1000;
let known = null; // { has: boolean, at: number }

async function hasWorkSetupColumn() {
  if (known && (known.has || Date.now() - known.at < RECHECK_MS)) return known.has;
  try {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aux_events' AND COLUMN_NAME = 'work_setup'`
    );
    known = { has: Number(row.n) > 0, at: Date.now() };
  } catch (err) {
    console.error("Could not check for aux_events.work_setup:", err);
    known = { has: false, at: Date.now() };
  }
  return known.has;
}

module.exports = { workSetupForIp, hasWorkSetupColumn };
