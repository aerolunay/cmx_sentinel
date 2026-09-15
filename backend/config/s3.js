"use strict";

const { S3Client } = require("@aws-sdk/client-s3");

// Uses a SEPARATE, read-only-scoped IAM user from the desktop
// service's own S3 credentials (which are PutObject-only, write-side).
// Create a dedicated user/policy here too (GetObject + ListBucket on
// this bucket's recordings/ prefix) - reusing the write-only one would
// break the same least-privilege separation kept everywhere else in
// this project (see S3UploadService.cs on the desktop service side for
// the original reasoning).
const s3 = new S3Client({ region: process.env.AWS_REGION });

const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

module.exports = { s3, BUCKET_NAME };
