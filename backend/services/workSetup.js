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

// Whether a column exists yet (its migration has been run) - queries
// skip the column until it has, so deploying the code first doesn't
// break anything. A "no" is checked again every few minutes, so running
// the migration needs no restart.
const RECHECK_MS = 5 * 60 * 1000;
const known = new Map(); // "table.column" -> { has: boolean, at: number }

async function hasColumn(table, column) {
  const key = `${table}.${column}`;
  const k = known.get(key);
  if (k && (k.has || Date.now() - k.at < RECHECK_MS)) return k.has;
  let has = false;
  try {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    has = Number(row.n) > 0;
  } catch (err) {
    console.error(`Could not check for ${key}:`, err);
  }
  known.set(key, { has, at: Date.now() });
  return has;
}

// sql/010
function hasWorkSetupColumn() {
  return hasColumn("aux_events", "work_setup");
}

module.exports = { workSetupForIp, hasWorkSetupColumn, hasColumn };
