"use strict";

const express = require("express");
const { DateTime } = require("luxon");
const { ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { s3, BUCKET_NAME } = require("../config/s3");
const db = require("../config/db");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");
const { getScopedGroupIds } = require("../services/groupScope");

const router = express.Router();

// Recordings are for ALL web roles (Admin, TQA, Supervisor, Manager) -
// unlike Users/Agents, this is NOT admin-only.
router.use(requireAuth);

// Matches the desktop service's own naming convention exactly (see
// S3UploadService.cs): sanitizedDisplayName_agentId_yyMMddHHmmss.mp4
// The timestamp is ALREADY Eastern time as embedded by the desktop
// service (EasternTime.ConvertFromUtc).
const FILENAME_PATTERN = /^([a-z0-9]+)_(\d+)_(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.mp4$/;

function parseRecordingKey(key) {
  const fileName = key.split("/").pop();
  const match = FILENAME_PATTERN.exec(fileName);
  if (!match) return null;

  const [, sanitizedName, agentId, yy, mm, dd, hh, min, ss] = match;

  // IMPORTANT: must explicitly interpret these components as Eastern
  // time via { zone: "America/New_York" } - using plain
  // `new Date(year, month, day, hour, min, sec)` would silently
  // interpret them as whatever timezone THIS NODE PROCESS happens to
  // be running in (commonly UTC on a cloud server), producing a
  // WRONG UTC instant - exactly the class of bug EasternTime.cs on the
  // desktop side exists specifically to prevent. This is the same
  // fix, just in JS instead of C#.
  const recordedAtEastern = DateTime.fromObject(
    { year: 2000 + Number(yy), month: Number(mm), day: Number(dd), hour: Number(hh), minute: Number(min), second: Number(ss) },
    { zone: "America/New_York" }
  );

  if (!recordedAtEastern.isValid) return null;

  return {
    key,
    fileName,
    sanitizedName,
    agentId,
    recordedAt: recordedAtEastern.toUTC().toISO(),
    // Eastern calendar date (YYYY-MM-DD) this recording belongs to -
    // sent alongside the UTC instant so the frontend can filter "today"
    // by the correct Eastern day without needing its own timezone
    // library just to re-derive this.
    recordedDateEastern: recordedAtEastern.toFormat("yyyy-MM-dd"),
  };
}

// Every object under recordings/. S3 returns at most 1000 keys per call
// and in ALPHABETICAL order - and keys start with the agent's name - so
// a single call only ever covered the first dozen-or-so agents (10-min
// chunks x ~70 agents is thousands of files a day). This follows
// ContinuationToken until the listing is complete.
async function listAllRecordingObjects() {
  const objects = [];
  let continuationToken;
  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: "recordings/",
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));
    objects.push(...(result.Contents || []));
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

// The Recordings page polls this on every load/date change and a full
// listing is one S3 call per 1000 files, so reuse it briefly rather
// than relisting the whole bucket for each viewer. New recordings show
// up within this window.
const LISTING_CACHE_MS = 60 * 1000;
let listingCache = { at: 0, objects: null, pending: null };

async function getRecordingObjectsCached() {
  if (listingCache.objects && Date.now() - listingCache.at < LISTING_CACHE_MS) {
    return listingCache.objects;
  }
  // Share one in-flight listing between concurrent requests.
  if (!listingCache.pending) {
    listingCache.pending = listAllRecordingObjects()
      .then((objects) => {
        listingCache = { at: Date.now(), objects, pending: null };
        return objects;
      })
      .catch((err) => {
        listingCache.pending = null;
        throw err;
      });
  }
  return listingCache.pending;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

router.get("/", async (req, res) => {
  // Optional Eastern-date range (YYYY-MM-DD, either end may be omitted)
  // so the page only receives the days it's showing, not every file in
  // the bucket.
  const dateFrom = DATE_PATTERN.test(req.query.dateFrom || "") ? req.query.dateFrom : null;
  const dateTo = DATE_PATTERN.test(req.query.dateTo || "") ? req.query.dateTo : null;
  const inRange = (r) =>
    (!dateFrom || r.recordedDateEastern >= dateFrom) && (!dateTo || r.recordedDateEastern <= dateTo);

  try {
    const objects = await getRecordingObjectsCached();

    const liveRecordings = objects
      .map((obj) => {
        const parsed = parseRecordingKey(obj.Key);
        if (!parsed) return null;
        return { ...parsed, sizeBytes: obj.Size, isArchived: false, archivedAt: null };
      })
      .filter(Boolean)
      .filter(inRange);

    // Recordings the local archival script has already moved off S3 -
    // still shown as a row (with isArchived: true instead of a working
    // sizeBytes/key) rather than just disappearing, so there's a
    // record of what happened to them. See
    // 003_create_archived_recordings.sql and archiveRoutes.js.
    const [archivedRows] = await db.query(
      "SELECT recording_key, agent_id, sanitized_name, recorded_at_utc, archived_at FROM archived_recordings"
    );
    const archivedRecordings = archivedRows.map((row) => {
      // Same "trust mysql2's Date object as the correct UTC instant"
      // convention already used for started_at_utc/ended_at_utc in
      // desktopSyncRoutes.js - this process's own OS timezone is UTC,
      // which is what makes that trust valid.
      const recordedAtIso = new Date(row.recorded_at_utc).toISOString();
      return {
        key: row.recording_key,
        fileName: row.recording_key.split("/").pop(),
        sanitizedName: row.sanitized_name,
        agentId: row.agent_id,
        recordedAt: recordedAtIso,
        recordedDateEastern: DateTime.fromISO(recordedAtIso).setZone("America/New_York").toFormat("yyyy-MM-dd"),
        sizeBytes: null,
        isArchived: true,
        archivedAt: row.archived_at,
      };
    }).filter(inRange);

    // Recordings come from S3 filenames, not a DB query - so the
    // agent's full name and group come from cross-referencing the
    // parsed agentId against the agents table here, unlike
    // reportRoutes.js where a JOIN does this as part of the query.
    // displayName is null for an agent ID that's no longer in the
    // table; the frontend falls back to the filename's sanitizedName.
    const [agentRows] = await db.query("SELECT agent_id, display_name, group_id FROM agents");
    const agentsById = new Map(agentRows.map((a) => [String(a.agent_id), a]));

    const recordings = [...liveRecordings, ...archivedRecordings]
      .map((r) => ({ ...r, displayName: agentsById.get(String(r.agentId))?.display_name ?? null }))
      .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));

    const scopedGroupIds = await getScopedGroupIds(req);
    if (scopedGroupIds !== null) {
      if (scopedGroupIds.length === 0) {
        return res.json([]);
      }
      const allowed = recordings.filter((r) => scopedGroupIds.includes(agentsById.get(String(r.agentId))?.group_id));
      return res.json(allowed);
    }

    res.json(recordings);
  } catch (err) {
    console.error("Error listing recordings:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// Shared by /url and /download below - a key that's been archived no
// longer exists in S3 at all (archiveRoutes.js deletes it once local
// copying succeeds), so both routes need to fail with a clear message
// instead of attempting a presigned URL for an object that's gone and
// surfacing a confusing raw S3 error instead.
async function checkNotArchived(key) {
  const [rows] = await db.query("SELECT 1 FROM archived_recordings WHERE recording_key = ?", [key]);
  return rows.length === 0;
}

// Shared group-scope check for a single recording key, used by both
// /url and /download - the list endpoint filters what a scoped user
// SEES, but these are independently reachable with any key (e.g. from
// browser history), so scope must be enforced here too.
async function isKeyInScope(req, parsed) {
  const scopedGroupIds = await getScopedGroupIds(req);
  if (scopedGroupIds === null) return true;
  const [agentRows] = await db.query("SELECT group_id FROM agents WHERE agent_id = ?", [parsed.agentId]);
  return scopedGroupIds.includes(agentRows[0]?.group_id);
}

router.get("/url", async (req, res) => {
  const { key } = req.query;
  if (!key || !key.startsWith("recordings/")) {
    return res.status(400).json({ error: "Invalid recording key." });
  }

  const parsed = parseRecordingKey(key);
  if (!parsed) {
    return res.status(400).json({ error: "Invalid recording key." });
  }

  if (!(await isKeyInScope(req, parsed))) {
    return res.status(403).json({ error: "You do not have access to this recording." });
  }

  if (!(await checkNotArchived(key))) {
    return res.status(410).json({ error: "This recording has been archived to local storage and is no longer available here." });
  }

  try {
    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
    // Short-lived - just long enough to load and watch one recording,
    // not a permanent public link.
    const url = await getSignedUrl(s3, command, { expiresIn: 15 * 60 });
    res.json({ url });
  } catch (err) {
    console.error("Error generating playback URL:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

// Per explicit request - download (as opposed to play/stream) is
// super_admin only. Same scope + archived checks as /url above, plus
// ResponseContentDisposition:"attachment" so the browser prompts an
// actual file save instead of playing it inline - same mechanism
// CMX Suite's own getDownloadUrl uses.
router.get("/download", requireRole("super_admin"), async (req, res) => {
  const { key } = req.query;
  if (!key || !key.startsWith("recordings/")) {
    return res.status(400).json({ error: "Invalid recording key." });
  }

  const parsed = parseRecordingKey(key);
  if (!parsed) {
    return res.status(400).json({ error: "Invalid recording key." });
  }

  if (!(await isKeyInScope(req, parsed))) {
    return res.status(403).json({ error: "You do not have access to this recording." });
  }

  if (!(await checkNotArchived(key))) {
    return res.status(410).json({ error: "This recording has been archived to local storage and is no longer available here." });
  }

  try {
    const fileName = key.split("/").pop();
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${fileName}"`,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 15 * 60 });
    res.json({ url });
  } catch (err) {
    console.error("Error generating download URL:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

module.exports = router;
// Reused by archiveRoutes.js so both files derive agentId/recordedAt
// from a recording key the exact same way - see that file's header
// comment.
module.exports.parseRecordingKey = parseRecordingKey;
// Same for the full (paginated) S3 listing - the archive script must see
// every recording too, not just the first 1000 alphabetically.
module.exports.listAllRecordingObjects = listAllRecordingObjects;