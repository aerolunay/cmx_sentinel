"use strict";

// For server-to-server calls (the desktop service reporting a
// restriction violation) - not a browser session, so requireAuth's
// cookie-based check doesn't apply here at all. A shared secret,
// configured via INTERNAL_API_KEY in .env, checked against a header.
//
// This is a SINGLE shared key for now, not per-machine credentials -
// reasonable for an internal endpoint with one caller (the desktop
// service), but if this ever needs finer-grained revocation (e.g.
// per-deployment keys), that's the point to reconsider this.
function requireInternalApiKey(req, res, next) {
  const expectedKey = process.env.INTERNAL_API_KEY;
  if (!expectedKey) {
    console.error("INTERNAL_API_KEY is not configured - rejecting all internal API calls.");
    return res.status(500).json({ error: "Server misconfiguration." });
  }

  const providedKey = req.get("X-Internal-Api-Key");
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(401).json({ error: "Invalid or missing API key." });
  }

  next();
}

module.exports = { requireInternalApiKey };
