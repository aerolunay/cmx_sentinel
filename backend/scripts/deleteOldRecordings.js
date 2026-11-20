"use strict";

// Runs the recording clean-up once, by hand (services/recordingCleanup.js
// has the rules). The backend also runs it hourly on its own when
// RECORDING_CLEANUP_JOB=1 in backend/.env - use this to preview first, or
// for a one-off run.
//
// Run from the backend folder (uses its .env). Preview first, then apply:
//   node scripts/deleteOldRecordings.js
//   node scripts/deleteOldRecordings.js --apply
// Options:
//   --hours=N   retention for agents with no group (default 24)

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const db = require("../config/db");
const { runRecordingCleanup } = require("../services/recordingCleanup");

const apply = process.argv.includes("--apply");
const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
const defaultHours = hoursArg ? Number(hoursArg.split("=")[1]) : 24;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

runRecordingCleanup({ apply, defaultHours, log })
  .then((result) => {
    if (!apply) log("Preview only - run with --apply to delete.");
    if (result.failed > 0) process.exitCode = 1;
  })
  .catch((err) => {
    log(`ERROR: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.end());
