"use strict";

// Use alongside requireAuth: requireAuth confirms someone's logged in,
// requireRole confirms they're ALLOWED here specifically. Example:
//   router.post("/agents", requireAuth, requireRole("admin"), handler)
//
// Admin gets everything (Users, Groups, Agents, Recordings, Reports).
// TQA/Supervisor/Manager only get Recordings + Reports - enforced by
// applying requireRole("admin") to every Groups/Agents/Users route.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.session || !allowedRoles.includes(req.session.role)) {
      return res.status(403).json({ error: "You do not have access to this." });
    }
    next();
  };
}

module.exports = { requireRole };
