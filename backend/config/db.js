"use strict";

const mysql = require("mysql2/promise");

const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME || "cmx_sentinel";

if (!DB_USER || DB_PASSWORD === undefined || DB_PASSWORD === "") {
  throw new Error("Missing MySQL configuration. Set DB_USER and DB_PASSWORD in backend/.env.");
}

// Uses the DEDICATED cmx_admin account - NOT the desktop service's
// cmx_service account, which is intentionally locked down to only
// what an agent PC needs. See sql/001_add_web_users_otp.sql.
const db = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4",
});

module.exports = db;
