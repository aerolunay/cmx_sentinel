"use strict";

// TEMPORARY one-off: deletes EVERY recording in S3 (any age) of the agents
// currently in the given groups. Default groups:
//   "ILM Medical Group, PC MS" and "ILM Medical Group, PC RN"
//
// Group names must match exactly (ignoring capitals and spaces at the
// ends); if any is not found, nothing is deleted. Recordings are matched
// by the agent ID in the file name, so it covers everything those agents
// recorded, even before they joined the group. The bucket has versioning
// disabled, so deletes are final.
//
// Run from the backend folder (uses its .env). Preview first, then apply:
//   node scripts/purgeGroupRecordings.js
//   node scripts/purgeGroupRecordings.js --apply
// Other groups:
//   node scripts/purgeGroupRecordings.js "Group A" "Group B" [--apply]
//
// Delete this file once the purge is done.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { s3, BUCKET_NAME } = require("../config/s3");
const db = require("../config/db");
const { parseRecordingKey, listAllRecordingObjects } = require("../routes/recordingRoutes");

const DEFAULT_GROUPS = ["ILM Medical Group, PC MS", "ILM Medical Group, PC RN"];
const apply = process.argv.includes("--apply");
const named = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const groupNames = named.length > 0 ? named : DEFAULT_GROUPS;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function loadAgents() {
  const [groups] = await db.query(
    `SELECT group_id, group_name FROM agent_groups
     WHERE LOWER(TRIM(group_name)) IN (${groupNames.map(() => "LOWER(TRIM(?))").join(", ")})`,
    groupNames
  );
  const found = new Set(groups.map((g) => g.group_name.trim().toLowerCase()));
  const missing = groupNames.filter((n) => !found.has(n.trim().toLowerCase()));
  if (missing.length > 0) {
    throw new Error(`Group(s) not found: ${missing.map((n) => `"${n}"`).join(", ")}. Nothing deleted.`);
  }

  const [agents] = await db.query(
    `SELECT a.agent_id, a.display_name, g.group_name
     FROM agents a JOIN agent_groups g ON g.group_id = a.group_id
     WHERE a.group_id IN (?)`,
    [groups.map((g) => g.group_id)]
  );
  return { groups, agents };
}

async function deleteKeys(keys) {
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < keys.length; i += 1000) { // DeleteObjects: max 1000 keys per call
    const batch = keys.slice(i, i + 1000);
    const result = await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET_NAME,
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
    }));
    const errors = result.Errors || [];
    for (const e of errors) log(`  FAILED to delete ${e.Key}: ${e.Code} ${e.Message}`);
    failed += errors.length;
    deleted += batch.length - errors.length;
  }
  return { deleted, failed };
}

async function main() {
  log(`${apply ? "APPLY" : "PREVIEW"} | purging ALL recordings of agents in: ${groupNames.map((n) => `"${n}"`).join(", ")}`);

  const { groups, agents } = await loadAgents();
  for (const g of groups) {
    const count = agents.filter((a) => a.group_name === g.group_name).length;
    log(`  ${g.group_name} (group ${g.group_id}): ${count} agent(s)`);
  }
  if (agents.length === 0) {
    log("No agents in these groups - nothing to delete.");
    return;
  }

  const ids = new Set(agents.map((a) => String(a.agent_id)));
  const objects = await listAllRecordingObjects();
  const toDelete = [];
  const perAgent = new Map();
  for (const obj of objects) {
    const parsed = parseRecordingKey(obj.Key);
    if (!parsed || !ids.has(String(parsed.agentId))) continue;
    toDelete.push(obj.Key);
    perAgent.set(parsed.agentId, (perAgent.get(parsed.agentId) || 0) + 1);
  }

  log(`${objects.length} file(s) in S3; ${toDelete.length} belong to these agents.`);
  for (const a of agents) {
    const n = perAgent.get(String(a.agent_id)) || 0;
    if (n > 0) log(`  ${a.display_name} (${a.agent_id}, ${a.group_name}): ${n}`);
  }

  if (!apply) {
    toDelete.slice(0, 10).forEach((k) => log(`  would delete ${k}`));
    if (toDelete.length > 10) log(`  ...and ${toDelete.length - 10} more.`);
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
