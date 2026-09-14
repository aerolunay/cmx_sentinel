"use strict";

// Attach to any route that requires a logged-in user. Checks the
// session (stored in MySQL via express-mysql-session - see
// server.js), not a JWT - simpler to invalidate (just destroy the
// session server-side) and no token-expiry edge cases to manage.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Not logged in." });
  }
  next();
}

module.exports = { requireAuth };
