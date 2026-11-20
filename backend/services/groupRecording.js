"use strict";

const db = require("../config/db");

// Whether an agent's screen is recorded (desktop 2.4.16+). Set per group
// by the "Enable recordings" checkbox on the Groups & Restrictions page
// (agent_groups.recording_enabled, sql/020). Only agents in a group with
// it on are recorded; agents with no group are not.

/**
 * For the desktop at login and session recovery. False when the lookup
 * fails, and before sql/020 has been run (no column yet) - nobody is
 * recorded unless their group is known to have recordings on. Run
 * sql/020 before deploying this, or recording stops for everyone.
 */
async function isRecordingEnabled(agentId) {
  try {
    const [[row]] = await db.query(
      `SELECT g.recording_enabled FROM agents a
       LEFT JOIN agent_groups g ON g.group_id = a.group_id
       WHERE a.agent_id = ?`,
      [agentId]
    );
    return Boolean(row?.recording_enabled);
  } catch (err) {
    if (err.code !== "ER_BAD_FIELD_ERROR") {
      console.error("Error checking whether the agent's group is recorded:", err);
    }
    return false;
  }
}

module.exports = { isRecordingEnabled };
