"use strict";

// Use alongside requireAuth: requireAuth confirms someone's logged in,
// requireRole confirms they're ALLOWED here specifically. Example:
//   router.post("/agents", requireAuth, requireRole("admin", "super_admin"), handler)
//
// Super Admin gets everything. Admin gets everything EXCEPT Users and
// Groups & Restrictions (super_admin-only). TQA/Supervisor/Manager get
// Recordings + Reports - and for Supervisor/Manager specifically, those
// are further scoped to their assigned groups (see web_user_groups,
// enforced in recordingRoutes.js/reportRoutes.js, not here - this
// middleware only checks ROLE, not group membership).
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.session || !allowedRoles.includes(req.session.role)) {
      return res.status(403).json({ error: "You do not have access to this." });
    }
    next();
  };
}

module.exports = { requireRole };
