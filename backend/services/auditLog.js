"use strict";

const db = require("../config/db");

/**
 * Writes one audit_log row. Never throws into the caller - an audit
 * write failing should be logged for someone to notice, but must never
 * block or fail the actual operation it's recording (e.g. a group
 * genuinely getting created shouldn't roll back just because the audit
 * insert had a transient problem).
 */
async function logAction(req, action, entityType, entityId, details) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_user_id, actor_display_name, action, entity_type, entity_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.session.userId, req.session.displayName, action, entityType, String(entityId), details ?? null]
    );
  } catch (err) {
    console.error("Failed to write audit log entry:", err);
  }
}

module.exports = { logAction };
