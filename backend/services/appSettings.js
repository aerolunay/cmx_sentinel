"use strict";

const db = require("../config/db");

// Admin-changeable settings stored in app_settings (see
// sql/004_create_app_settings.sql). Reads fall back to the given
// default when the key has never been saved - or when the table doesn't
// exist yet because the migration hasn't been run - so a missing row
// never breaks the feature that asks for it.

async function getBooleanSetting(key, fallback) {
  try {
    const [rows] = await db.query("SELECT setting_value FROM app_settings WHERE setting_key = ?", [key]);
    if (rows.length === 0) return fallback;
    return rows[0].setting_value === "true";
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return fallback;
    throw err;
  }
}

async function setBooleanSetting(key, value, userId) {
  await db.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by_user_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by_user_id = VALUES(updated_by_user_id)`,
    [key, value ? "true" : "false", userId ?? null]
  );
}

module.exports = { getBooleanSetting, setBooleanSetting };
