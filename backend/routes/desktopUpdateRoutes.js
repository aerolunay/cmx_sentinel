"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");
const {
  GetObjectCommand, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { s3, BUCKET_NAME } = require("../config/s3");
const { requireAuth } = require("../middleware/requireAuth");
const { requireRole } = require("../middleware/requireRole");
const { logAction } = require("../services/auditLog");

// Desktop app auto-update, published from the web app (Super Admin):
// the same two files build-release.ps1 writes, uploaded to the
// recordings bucket the same way as by hand (installer/AUTO-UPDATE.md in
// the desktop repo):
//   updates/CmxSentinel_v_X.Y.Z_Setup.exe   the signed installer
//   updates/latest.json                     the manifest agent PCs poll hourly
// The server checks the pair belongs together BEFORE uploading anything
// - the manifest's version, installerKey and SHA-256 must match the
// installer - then uploads the installer first and the manifest last,
// so a PC never reads a manifest whose installer isn't there yet. The
// PCs still verify the hash and the Authenticode signature themselves.
//
// The backend's IAM user needs s3:PutObject and s3:GetObject on
// updates/* and s3:ListBucket for the updates/ prefix.

const router = express.Router();
router.use(requireAuth, requireRole("super_admin"));

const MANIFEST_KEY = "updates/latest.json";
const INSTALLER_NAME = /^CmxSentinel_v_(\d+\.\d+\.\d+)_Setup\.exe$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_INSTALLER_BYTES = 500 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: MAX_INSTALLER_BYTES, files: 2 },
});

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let n = 0; n < 3; n++) {
    if (pa[n] !== pb[n]) return pa[n] < pb[n] ? -1 : 1;
  }
  return 0;
}

function s3Error(err) {
  const name = err && (err.name || err.Code);
  if (name === "AccessDenied" || (err && err.$metadata && err.$metadata.httpStatusCode === 403)) {
    return "The web app's AWS user isn't allowed to read/write updates/ in the bucket - "
      + "add s3:PutObject, s3:GetObject (updates/*) and s3:ListBucket (updates/) to its policy.";
  }
  return null;
}

async function streamToString(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// The published manifest, or null if there isn't one yet.
async function readPublishedManifest() {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: MANIFEST_KEY }));
    return { manifest: JSON.parse(await streamToString(result.Body)), lastModified: result.LastModified || null };
  } catch (err) {
    if (err && (err.name === "NoSuchKey" || (err.$metadata && err.$metadata.httpStatusCode === 404))) return null;
    throw err;
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex").toUpperCase()))
      .on("error", reject);
  });
}

function startsWithMz(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    return buf.toString("latin1") === "MZ";
  } finally {
    fs.closeSync(fd);
  }
}

// What's published now, and the installers in updates/.
router.get("/", async (req, res) => {
  try {
    const published = await readPublishedManifest();
    const installers = [];
    let continuationToken;
    do {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET_NAME, Prefix: "updates/", ContinuationToken: continuationToken,
      }));
      for (const obj of result.Contents || []) {
        const name = obj.Key.slice("updates/".length);
        const match = INSTALLER_NAME.exec(name);
        if (match) installers.push({ key: obj.Key, fileName: name, version: match[1], sizeBytes: obj.Size, uploadedAt: obj.LastModified });
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    installers.sort((a, b) => compareVersions(b.version, a.version));

    res.json({
      bucket: BUCKET_NAME,
      published: published ? {
        version: published.manifest.version || null,
        installerKey: published.manifest.installerKey || null,
        sha256: published.manifest.sha256 || null,
        machines: Array.isArray(published.manifest.machines) ? published.manifest.machines : [],
        publishedAt: published.lastModified,
      } : null,
      installers,
    });
  } catch (err) {
    const message = s3Error(err);
    console.error("Error reading desktop update status:", err);
    res.status(message ? 403 : 500).json({ error: message || "A server error occurred." });
  }
});

// Upload + publish: multipart with "installer" (the .exe) and "manifest"
// (latest.json), both from the same build-release.ps1 run.
router.post("/", upload.fields([{ name: "installer", maxCount: 1 }, { name: "manifest", maxCount: 1 }]), async (req, res) => {
  const installer = req.files && req.files.installer && req.files.installer[0];
  const manifestFile = req.files && req.files.manifest && req.files.manifest[0];
  const cleanup = () => {
    for (const f of [installer, manifestFile]) {
      if (f) fs.promises.unlink(f.path).catch(() => {});
    }
  };
  const fail = (status, error) => {
    cleanup();
    return res.status(status).json({ error });
  };

  try {
    if (!installer || !manifestFile) return fail(400, "Choose both the installer (.exe) and latest.json.");

    // --- the manifest ---
    if (manifestFile.size > MAX_MANIFEST_BYTES) return fail(400, "latest.json is too large - choose the file build-release.ps1 wrote.");
    const manifestText = (await fs.promises.readFile(manifestFile.path, "utf8")).replace(/^﻿/, "");
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      return fail(400, "latest.json isn't valid JSON.");
    }
    if (!manifest || !VERSION.test(String(manifest.version || ""))) return fail(400, "latest.json has no valid version.");
    if (typeof manifest.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(manifest.sha256)) return fail(400, "latest.json has no valid sha256.");
    if (manifest.machines !== undefined && !(Array.isArray(manifest.machines) && manifest.machines.every((m) => typeof m === "string"))) {
      return fail(400, "latest.json's machines must be a list of computer names.");
    }

    // --- the installer, and that the two belong together ---
    const nameMatch = INSTALLER_NAME.exec(installer.originalname);
    if (!nameMatch) return fail(400, "The installer must be named CmxSentinel_v_X.Y.Z_Setup.exe.");
    if (nameMatch[1] !== manifest.version) {
      return fail(400, `The installer is version ${nameMatch[1]} but latest.json is for ${manifest.version}.`);
    }
    const installerKey = `updates/${installer.originalname}`;
    if (manifest.installerKey !== installerKey) {
      return fail(400, `latest.json points to ${manifest.installerKey || "(nothing)"}, not ${installerKey}.`);
    }
    if (!startsWithMz(installer.path)) return fail(400, "The installer isn't a Windows program (.exe).");
    const sha256 = await sha256File(installer.path);
    if (sha256 !== manifest.sha256.toUpperCase()) {
      return fail(400, "The installer doesn't match latest.json (SHA-256 differs) - upload the two files from the same build.");
    }

    // --- not older than what's published ---
    const published = await readPublishedManifest();
    const publishedVersion = published && VERSION.test(String(published.manifest.version || "")) ? published.manifest.version : null;
    if (publishedVersion && compareVersions(manifest.version, publishedVersion) < 0) {
      return fail(400, `${publishedVersion} is already published - PCs only install a newer version than they have.`);
    }

    // --- upload: installer first, manifest last ---
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: installerKey,
      Body: fs.createReadStream(installer.path),
      ContentLength: installer.size,
      ContentType: "application/vnd.microsoft.portable-executable",
    }));
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: installerKey }));
    if (Number(head.ContentLength) !== installer.size) {
      return fail(500, "The installer upload to S3 didn't complete - nothing was published. Try again.");
    }
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: MANIFEST_KEY,
      Body: manifestText,
      ContentType: "application/json",
      CacheControl: "no-cache",
    }));

    const machines = Array.isArray(manifest.machines) ? manifest.machines : [];
    await logAction(req, "updated", "desktop_update", manifest.version,
      `Published desktop app ${manifest.version} (${installer.originalname}, ${machines.length ? `pilot: ${machines.join(", ")}` : "all PCs"}).`);
    cleanup();
    res.json({
      version: manifest.version, installerKey, sha256, sizeBytes: installer.size, machines,
      previousVersion: publishedVersion,
    });
  } catch (err) {
    const message = s3Error(err);
    console.error("Error publishing desktop update:", err);
    return fail(message ? 403 : 500, message || "A server error occurred - nothing may have been published. Check the status and try again.");
  }
});

// multer limits (file too large, too many files) as a readable error.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: err.code === "LIMIT_FILE_SIZE" ? "The installer is larger than 500 MB." : `Upload problem: ${err.message}`,
    });
  }
  next(err);
});

module.exports = router;
