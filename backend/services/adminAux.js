"use strict";

const db = require("../config/db");

// Who may use the desktop's Admin aux (desktop 2.4.13+). Set per agent by
// the "Admin Aux" checkbox on the Agents page (agents.admin_aux_allowed,
// sql/016). A new agent starts checked only if they're in the
// Supervisors, Training and Quality (TQA) or RRT group, or are also an
// active web user (agent email, or Employee ID for admins, matches).
// Group names are matched loosely: "Supervisor"/"Supervisors",
// "Training & Quality"/"TQA", "RRT ...".
const ADMIN_AUX_GROUP_PATTERNS = [/supervisor/i, /\brrt\b/i, /training\s*(and|&)\s*quality/i, /\btqa\b/i];

function isAdminAuxGroupName(groupName) {
  return ADMIN_AUX_GROUP_PATTERNS.some((p) => p.test(groupName || ""));
}

async function isWebUser(agentId, email) {
  const [[row]] = await db.query(
    `SELECT EXISTS (SELECT 1 FROM web_users u
                    WHERE u.is_active = TRUE
                      AND ((? <> '' AND LOWER(u.email) = LOWER(?)) OR u.login_identifier = ?)) AS is_web_user`,
    [email || "", email || "", agentId]
  );
  return Boolean(row?.is_web_user);
}

/** The checkbox's starting value for a new agent. */
async function defaultAdminAux(agentId, email, groupId) {
  if (groupId) {
    const [[group]] = await db.query("SELECT group_name FROM agent_groups WHERE group_id = ?", [groupId]);
    if (isAdminAuxGroupName(group?.group_name)) return true;
  }
  return isWebUser(agentId, email);
}

/**
 * For the desktop at login and session recovery. Null when the lookup
 * fails - the desktop then leaves Admin available rather than block a
 * login. Before sql/016 has been run (no column yet), the group / web
 * user rule decides on its own.
 */
async function isAdminAuxAllowed(agentId) {
  try {
    const [[row]] = await db.query("SELECT admin_aux_allowed FROM agents WHERE agent_id = ?", [agentId]);
    return Boolean(row?.admin_aux_allowed);
  } catch (err) {
    if (err.code !== "ER_BAD_FIELD_ERROR") {
      console.error("Error checking Admin aux access:", err);
      return null;
    }
  }
  try {
    const [[agent]] = await db.query(
      `SELECT a.email, g.group_name FROM agents a
       LEFT JOIN agent_groups g ON g.group_id = a.group_id WHERE a.agent_id = ?`,
      [agentId]
    );
    if (!agent) return false;
    return isAdminAuxGroupName(agent.group_name) || (await isWebUser(agentId, agent.email));
  } catch (err) {
    console.error("Error checking Admin aux access:", err);
    return null;
  }
}

module.exports = { defaultAdminAux, isAdminAuxAllowed, isAdminAuxGroupName };
