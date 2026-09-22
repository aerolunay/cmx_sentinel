"use strict";

const crypto = require("crypto");
const express = require("express");
const { GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { s3, BUCKET_NAME } = require("../config/s3");
const db = require("../config/db");
const { parseRecordingKey } = require("./recordingRoutes");

const router = express.Router();

/*
==================================================
ARCHIVE ROUTES
==================================================
Called by a local script (scripts/archive_recordings.py, run from
somewhere OTHER than this server - a PC outside AWS entirely) that
copies recordings older than a cutoff to local storage and removes
them from S3. Same reasoning as desktop-sync's requireInternalApiKey
for why this isn't behind session/cookie auth: a standalone script has
no way to participate in that. Protected the same way in spirit - a
shared secret, compared in constant time - but via its own
ARCHIVE_API_SECRET env var, deliberately NOT the same value as
INTERNAL_API_KEY, so a leaked archive-script secret can't also fake a
desktop-service callback, and vice versa.

Mounted at /archive, not /api/archive - same "visually and
structurally distinct from session-authenticated routes" reasoning
already used for /internal-style endpoints elsewhere in this app.

Per explicit request: once archived, a recording is genuinely gone
from this app's reach - no playback, no download, from ANY role
including super_admin. The file only exists in local storage outside
AWS from that point on. archived_recordings (see
003_create_archived_recordings.sql) is what lets the Recordings list
still show a row for it ("Archived to local storage on {date}")
instead of the recording just disappearing.
==================================================
*/

function isValidSecret(provided) {
  const expected = process.env.ARCHIVE_API_SECRET;
  if (!expected || !provided) return false;

  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(expected);

  // timingSafeEqual throws on mismatched lengths rather than just
  // returning false - the length check above must happen first, and
  // itself needs no constant-time treatment since string LENGTH isn't
  // sensitive, only its content is.
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function requireSecret(req, res, next) {
  const provided = req.query.secret || req.body?.secret;
  if (!isValidSecret(provided)) {
    return res.status(403).json({ success: false, message: "Invalid or missing secret." });
  }
  next();
}

/*
==================================================
GET /archive/eligible?secret=...&olderThanDate=YYYY-MM-DD
==================================================
Returns every recording in S3 whose recordedAt (parsed from its
filename, Eastern time - see recordingRoutes.js's parseRecordingKey)
falls strictly before olderThanDate, that isn't already in
archived_recordings. Each item carries a ready-to-use presigned
downloadUrl (1 hour expiry) so the script downloads directly from S3
with no second authenticated round-trip needed per file.

olderThanDate is REQUIRED and taken as-is from the caller (the script
computes it from its own PROD/TEST reference-date toggle) - this route
deliberately does not compute "14 days ago" itself, so the script's
testing mode can ask for any historical cutoff without this endpoint
needing a matching test mode of its own.
==================================================
*/
router.get("/eligible", requireSecret, async (req, res) => {
  try {
    const { olderThanDate } = req.query;
    if (!olderThanDate) {
      return res.status(400).json({ success: false, message: "olderThanDate query param is required (YYYY-MM-DD)." });
    }

    const command = new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: "recordings/", MaxKeys: 1000 });
    const result = await s3.send(command);

    const [alreadyArchivedRows] = await db.query("SELECT recording_key FROM archived_recordings");
    const alreadyArchived = new Set(alreadyArchivedRows.map((r) => r.recording_key));

    const eligible = (result.Contents || [])
      .map((obj) => {
        const parsed = parseRecordingKey(obj.Key);
        if (!parsed) return null;
        return { ...parsed, sizeBytes: obj.Size };
      })
      .filter(Boolean)
      .filter((r) => r.recordedDateEastern < olderThanDate)
      .filter((r) => !alreadyArchived.has(r.key));

    const items = await Promise.all(
      eligible.map(async (r) => {
        const fileName = r.key.split("/").pop();
        const command = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: r.key,
          ResponseContentDisposition: `attachment; filename="${fileName}"`,
        });
        const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
        return {
          recordingKey: r.key,
          agentId: r.agentId,
          sanitizedName: r.sanitizedName,
          recordedAt: r.recordedAt,
          // Includes the extension - the script saves under this exact
          // name, so the local file matches what was in S3 with no
          // separate naming scheme to keep in sync.
          suggestedFilename: fileName,
          downloadUrl,
        };
      })
    );

    return res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error("GET /archive/eligible failed:", err);
    return res.status(500).json({ success: false, message: "Failed to load eligible recordings." });
  }
});

/*
==================================================
POST /archive/confirm
==================================================
Body: { secret, recordingKeys: [...] }. Called by the script ONLY
after each file has actually finished downloading successfully to
local disk. For each key: records it in archived_recordings (so the
Recordings list can still show "Archived to local storage on {date}"),
then deletes the object from S3 - this is the point of no return for
this app's own access to the file; from here on, neither playback nor
download works for it, for any role.
==================================================
*/
router.post("/confirm", requireSecret, async (req, res) => {
  try {
    const { recordingKeys } = req.body;
    if (!Array.isArray(recordingKeys) || recordingKeys.length === 0) {
      return res.status(400).json({ success: false, message: "recordingKeys must be a non-empty array." });
    }

    let confirmed = 0;
    for (const key of recordingKeys) {
      const parsed = parseRecordingKey(key);
      if (!parsed) {
        console.error(`POST /archive/confirm: skipping unparseable key "${key}".`);
        continue;
      }

      await db.query(
        `INSERT INTO archived_recordings (recording_key, agent_id, sanitized_name, recorded_at_utc)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE archived_at = archived_at`,
        // parsed.recordedAt is an ISO string with an explicit 'Z'
        // offset (see parseRecordingKey), so new Date(...) here always
        // represents the correct absolute instant regardless of this
        // process's own timezone - same "pass a plain Date object for
        // a _utc column" convention already used for ended_at_utc in
        // desktopSyncRoutes.js.
        [parsed.key, parsed.agentId, parsed.sanitizedName, new Date(parsed.recordedAt)]
      );

      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      } catch (deleteErr) {
        // The DB row is already written, so the recording will still
        // correctly show as archived even if this particular delete
        // fails (e.g. transient S3 error, or it was already removed
        // by a previous run that crashed after deleting but before
        // this response reached the script) - log and move on rather
        // than leaving the whole batch half-confirmed.
        console.error(`Failed to delete ${key} from S3 after archiving (DB row still recorded):`, deleteErr);
      }

      confirmed++;
    }

    return res.json({ success: true, confirmed });
  } catch (err) {
    console.error("POST /archive/confirm failed:", err);
    return res.status(500).json({ success: false, message: "Failed to confirm archived recordings." });
  }
});

module.exports = router;
