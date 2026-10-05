"use strict";

const db = require("../config/db");

// Only Supervisors get scoped to specific groups (any number of them) -
// Super Admin, Admin, TQA, and Manager see everything regardless
// (Manager was moved to full visibility by explicit request).
const GROUP_SCOPED_ROLES = ["supervisor"];

/**
 * Returns null if the current user's role is unrestricted (sees
 * everything - Super Admin, Admin, TQA, Manager), or an array of
 * allowed group_ids if their role is scoped. That array can be EMPTY
 * if a scoped user has no groups assigned yet - callers should treat
 * an empty array as "show nothing", not "show everything", since an
 * unconfigured assignment should never silently fall back to full
 * visibility.
 */
async function getScopedGroupIds(req) {
  if (!GROUP_SCOPED_ROLES.includes(req.session.role)) {
    return null;
  }
  const [rows] = await db.query("SELECT group_id FROM web_user_groups WHERE user_id = ?", [req.session.userId]);
  return rows.map((r) => r.group_id);
}

module.exports = { getScopedGroupIds, GROUP_SCOPED_ROLES };
