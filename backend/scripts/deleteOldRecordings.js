"use strict";

// Deletes screen recordings from S3 once they are more than 24 hours old,
// except recordings of agents in the American Plan Administrators group,
// which are kept.
//
// "Old" is measured from the recording time saved in the file name
// (<name>_<agentId>_<yyMMddHHmmss>.mp4, Eastern - see recordingRoutes.js
// parseRecordingKey), not from when the file reached S3. Whether an agent
// is kept goes by the agent ID in the file name and the group that agent
// is in when this runs.
//
// Deleted recordings are gone for good: they are not archived and the
// Recordings page no longer lists them. Files that don't follow the
// naming scheme are left alone.
//
// Run from the backend folder (uses its .env). Preview first, then apply:
//   node scripts/deleteOldRecordings.js
//   node scripts/deleteOldRecordings.js --apply
// Options:
//   --hours=N   age limit in hours (default 24)
// Safe to re-run, e.g. hourly from cron:
//   0 * * * * cd /path/to/backend && node scripts/deleteOldRecordings.js --apply >> logs/delete-recordings.log 2>&1

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { s3, BUCKET_NAME } = require("../config/s3");
const db = require("../config/db");
const { parseRecordingKey, listAllRecordingObjects } = require("../routes/recordingRoutes");

const KEEP_GROUP_NAME = "American Plan Administrators";
const apply = process.argv.includes("--apply");
const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
const maxAgeHours = hoursArg ? Number(hoursArg.split("=")[1]) : 24;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Agent IDs in the kept group. Throws if the group isn't there: a renamed
// or missing group must stop the run, not delete that group's recordings.
async function loadKeptAgentIds() {
  const [groups] = await db.query(
    "SELECT group_id, group_name FROM agent_groups WHERE LOWER(TRIM(group_name)) = LOWER(?)",
    [KEEP_GROUP_NAME]
  );
  if (groups.length === 0) {
    throw new Error(`No group named "${KEEP_GROUP_NAME}" - nothing deleted. Check the group's name on the Groups page.`);
  }
  const [agents] = await db.query(
    "SELECT agent_id FROM agents WHERE group_id IN (?)",
    [groups.map((g) => g.group_id)]
  );
  return new Set(agents.map((a) => String(a.agent_id)));
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
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 1) {
    throw new Error("--hours must be a number of at least 1.");
  }

  const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000);
  log(`${apply ? "APPLY" : "PREVIEW"} | deleting recordings made before ${cutoff.toISOString()} ` +
      `(${maxAgeHours}h), keeping "${KEEP_GROUP_NAME}".`);

  const keptAgentIds = await loadKeptAgentIds();
  log(`${keptAgentIds.size} agent(s) in "${KEEP_GROUP_NAME}" - their recordings are kept.`);

  const objects = await listAllRecordingObjects();
  let kept = 0;
  let recent = 0;
  let unparsed = 0;
  const toDelete = [];
  for (const obj of objects) {
    const parsed = parseRecordingKey(obj.Key);
    if (!parsed) {
      unparsed++;
      continue;
    }
    if (new Date(parsed.recordedAt) >= cutoff) {
      recent++;
    } else if (keptAgentIds.has(String(parsed.agentId))) {
      kept++;
    } else {
      toDelete.push(obj.Key);
    }
  }

  log(`${objects.length} file(s) in S3: ${toDelete.length} to delete, ${recent} newer than ${maxAgeHours}h, ` +
      `${kept} kept (${KEEP_GROUP_NAME}), ${unparsed} not named like a recording (left alone).`);

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
