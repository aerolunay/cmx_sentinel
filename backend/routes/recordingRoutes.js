"use strict";

const express = require("express");
const { DateTime } = require("luxon");
const { ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { s3, BUCKET_NAME } = require("../config/s3");
const { requireAuth } = require("../middleware/requireAuth");

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

router.get("/", async (req, res) => {
  try {
    // NOTE: lists up to 1000 objects (S3's per-call max) and parses
    // all of them - fine for now, but if recording volume grows large
    // enough that this becomes slow, this is the point to add
    // pagination or server-side filtering (e.g. by date range) instead
    // of listing everything on every request.
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: "recordings/",
      MaxKeys: 1000,
    });
    const result = await s3.send(command);

    const recordings = (result.Contents || [])
      .map((obj) => {
        const parsed = parseRecordingKey(obj.Key);
        if (!parsed) return null;
        return { ...parsed, sizeBytes: obj.Size };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));

    res.json(recordings);
  } catch (err) {
    console.error("Error listing recordings:", err);
    res.status(500).json({ error: "A server error occurred." });
  }
});

router.get("/url", async (req, res) => {
  const { key } = req.query;
  if (!key || !key.startsWith("recordings/")) {
    return res.status(400).json({ error: "Invalid recording key." });
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

module.exports = router;