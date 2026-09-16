"use strict";

const db = require("../config/db");

// Only these two roles get scoped to specific groups - Admin, Super
// Admin, and TQA see everything regardless, per the explicit request
// that only Managers and Supervisors get this restriction.
const GROUP_SCOPED_ROLES = ["supervisor", "manager"];

/**
 * Returns null if the current user's role is unrestricted (sees
 * everything - Admin, Super Admin, TQA), or an array of allowed
 * group_ids if their role is scoped. That array can be EMPTY if a
 * scoped user has no groups assigned yet - callers should treat an
 * empty array as "show nothing", not "show everything", since an
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
