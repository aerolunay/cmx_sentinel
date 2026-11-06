"use strict";

// Use alongside requireAuth: requireAuth confirms someone's logged in,
// requireRole confirms they're ALLOWED here specifically. Example:
//   router.post("/agents", requireAuth, requireRole("admin", "super_admin"), handler)
//
// Super Admin gets everything. Admin gets everything EXCEPT Users and
// Groups & Restrictions (super_admin-only). TQA/Supervisor/Manager get
// Recordings + Reports - and for Supervisor specifically, those
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

// Read-only roles (Compliance) see a page's data but can't change it:
// `roles` get every method, `readOnlyRoles` only GET/HEAD.
//   router.use(requireAuth, requireRoleOrReadOnly(["admin", "super_admin"], READ_ONLY_ROLES))
const READ_ONLY_ROLES = ["compliance"];

function requireRoleOrReadOnly(roles, readOnlyRoles = READ_ONLY_ROLES) {
  return (req, res, next) => {
    const role = req.session && req.session.role;
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (roles.includes(role) || (isRead && readOnlyRoles.includes(role))) {
      return next();
    }
    return res.status(403).json({ error: "You do not have access to this." });
  };
}

module.exports = { requireRole, requireRoleOrReadOnly, READ_ONLY_ROLES };
