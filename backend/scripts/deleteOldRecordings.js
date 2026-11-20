"use strict";

// Deletes screen recordings from S3 once they are older than their group's
// retention: the hours set next to the Recordings tick box on the Groups &
// Restrictions page (agent_groups.recording_retention_hours, sql/022).
// 24 hours unless set otherwise; 0 for a group with recordings off, so
// anything of theirs still in S3 is deleted on the next run.
//
// "Old" is measured from the recording time saved in the file name
// (<name>_<agentId>_<yyMMddHHmmss>.mp4, Eastern - see recordingRoutes.js
// parseRecordingKey), not from when the file reached S3. Which retention
// applies goes by the agent ID in the file name and the group that agent
// is in when this runs. Agents with no group, or no longer in the agents
// table, get the default (--hours, 24 unless given).
//
// Deleted recordings are gone for good: they are not archived and the
// Recordings page no longer lists them. Files that don't follow the
// naming scheme are left alone.
//
// Run from the backend folder (uses its .env). Preview first, then apply:
//   node scripts/deleteOldRecordings.js
//   node scripts/deleteOldRecordings.js --apply
// Options:
//   --hours=N   retention for agents with no group (default 24)
// Safe to re-run, e.g. hourly from cron:
//   0 * * * * cd /path/to/backend && node scripts/deleteOldRecordings.js --apply >> logs/delete-recordings.log 2>&1

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { s3, BUCKET_NAME } = require("../config/s3");
const db = require("../config/db");
const { parseRecordingKey, listAllRecordingObjects } = require("../routes/recordingRoutes");

const apply = process.argv.includes("--apply");
const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
const defaultHours = hoursArg ? Number(hoursArg.split("=")[1]) : 24;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// agentId -> { hours, group }. Stops the run before sql/022: without the
// column every group would get the default and kept recordings (e.g. a
// 3-month group) would be deleted after a day.
async function loadRetention() {
  const [[col]] = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_groups' AND COLUMN_NAME = 'recording_retention_hours'`
  );
  if (!Number(col.n)) {
    throw new Error("agent_groups.recording_retention_hours is missing - run sql/022 first. Nothing deleted.");
  }
  const [rows] = await db.query(
    `SELECT a.agent_id, g.group_name, g.recording_retention_hours AS hours
     FROM agents a LEFT JOIN agent_groups g ON g.group_id = a.group_id`
  );
  const byAgent = new Map();
  for (const r of rows) {
    byAgent.set(String(r.agent_id), r.group_name == null
      ? { hours: defaultHours, group: "(no group)" }
      : { hours: Math.max(0, Number(r.hours) || 0), group: r.group_name });
  }
  return byAgent;
}

async function deleteKeys(keys) {
  let deleted = 0;
  let failed = 0;
  // DeleteObjects takes at most 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const result = await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET_NAME,
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
    }));
    const errors = result.Errors || [];
    for (const e of errors) {
      log(`  FAILED to delete ${e.Key}: ${e.Code} ${e.Message}`);
    }
    failed += errors.length;
    deleted += batch.length - errors.length;
  }
  return { deleted, failed };
}

async function main() {
  if (!Number.isInteger(defaultHours) || defaultHours < 1) {
    throw new Error("--hours must be a whole number of at least 1.");
  }

  const now = Date.now();
  log(`${apply ? "APPLY" : "PREVIEW"} | each group's retention; ${defaultHours}h for agents with no group.`);

  const retention = await loadRetention();
  const objects = await listAllRecordingObjects();
  let kept = 0;
  let unparsed = 0;
  const toDelete = [];
  const perGroup = new Map(); // group -> { hours, deleting, keeping }

  for (const obj of objects) {
    const parsed = parseRecordingKey(obj.Key);
    if (!parsed) {
      unparsed++;
      continue;
    }
    const rule = retention.get(String(parsed.agentId)) || { hours: defaultHours, group: "(unknown agent)" };
    const stats = perGroup.get(rule.group) || { hours: rule.hours, deleting: 0, keeping: 0 };
    perGroup.set(rule.group, stats);

    const ageHours = (now - new Date(parsed.recordedAt).getTime()) / 3600000;
    if (ageHours >= rule.hours) {
      toDelete.push(obj.Key);
      stats.deleting++;
    } else {
      kept++;
      stats.keeping++;
    }
  }

  log(`${objects.length} file(s) in S3: ${toDelete.length} to delete, ${kept} kept, ` +
      `${unparsed} not named like a recording (left alone).`);
  for (const [group, s] of [...perGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    log(`  ${group} (${s.hours}h): ${s.deleting} to delete, ${s.keeping} kept`);
  }

  if (!apply) {
    toDelete.slice(0, 20).forEach((k) => log(`  would delete ${k}`));
    if (toDelete.length > 20) log(`  ...and ${toDelete.length - 20} more.`);
    log("Preview only - run with --apply to delete.");
    return;
  }

  if (toDelete.length === 0) {
    log("Nothing to delete.");
    return;
  }
  const { deleted, failed } = await deleteKeys(toDelete);
  log(`Done. ${deleted} deleted, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    log(`ERROR: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.end());
