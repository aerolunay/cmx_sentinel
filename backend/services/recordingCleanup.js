"use strict";

const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { s3, BUCKET_NAME } = require("../config/s3");
const db = require("../config/db");
const { parseRecordingKey, listAllRecordingObjects } = require("../routes/recordingRoutes");

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
// is in at the time of the run. Agents with no group, or no longer in the
// agents table, get defaultHours (24).
//
// The bucket has versioning disabled, so a delete is final - nothing is
// archived and the Recordings page no longer lists the file. Files that
// don't follow the naming scheme are left alone.
//
// Runs hourly inside the backend when RECORDING_CLEANUP_JOB=1 in
// backend/.env (startRecordingCleanupJob), or by hand with
// scripts/deleteOldRecordings.js (preview unless --apply).

const DEFAULT_HOURS = 24;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
const RUN_EVERY_MS = 60 * 60 * 1000;

// agentId -> { hours, group }. Throws before sql/022: without the column
// every group would get the default and recordings kept longer (e.g. a
// 3-month group) would be deleted after a day.
async function loadRetention(defaultHours) {
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

async function deleteKeys(keys, log) {
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

/**
 * One clean-up pass. apply=false only reports what would be deleted.
 * Returns { total, toDelete, kept, unparsed, deleted, failed }.
 */
async function runRecordingCleanup({ apply = false, defaultHours = DEFAULT_HOURS, log = console.log, verbose = true } = {}) {
  if (!Number.isInteger(defaultHours) || defaultHours < 1) {
    throw new Error("The default retention must be a whole number of hours, at least 1.");
  }

  const now = Date.now();
  const retention = await loadRetention(defaultHours);
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

  log(`Recording clean-up${apply ? "" : " (preview)"}: ${objects.length} file(s) in S3, ${toDelete.length} to delete, ` +
      `${kept} kept, ${unparsed} not named like a recording (left alone).`);
  if (verbose) {
    for (const [group, s] of [...perGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      log(`  ${group} (${s.hours}h): ${s.deleting} to delete, ${s.keeping} kept`);
    }
  }

  const result = { total: objects.length, toDelete: toDelete.length, kept, unparsed, deleted: 0, failed: 0 };
  if (!apply) {
    if (verbose) {
      toDelete.slice(0, 20).forEach((k) => log(`  would delete ${k}`));
      if (toDelete.length > 20) log(`  ...and ${toDelete.length - 20} more.`);
    }
    return result;
  }
  if (toDelete.length > 0) {
    Object.assign(result, await deleteKeys(toDelete, log));
    log(`Recording clean-up: ${result.deleted} deleted, ${result.failed} failed.`);
  }
  return result;
}

/** Hourly inside the backend - only with RECORDING_CLEANUP_JOB=1 in backend/.env. */
function startRecordingCleanupJob() {
  if (process.env.RECORDING_CLEANUP_JOB !== "1") {
    console.log("Recording clean-up job is off (set RECORDING_CLEANUP_JOB=1 in backend/.env to turn it on).");
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runRecordingCleanup({ apply: true, verbose: false });
    } catch (err) {
      console.error("Recording clean-up failed:", err.message || err);
    } finally {
      running = false;
    }
  };
  console.log("Recording clean-up job is on: runs hourly, first run in 2 minutes.");
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, RUN_EVERY_MS);
}

module.exports = { runRecordingCleanup, startRecordingCleanupJob };
