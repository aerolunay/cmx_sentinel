// Roles as stored/sent by the backend (web_users.role) are lowercase,
// underscore_separated identifiers - fine for code, not for display.
// This is the single place that maps a role id to what's actually shown
// to a person; anywhere a role appears on screen should go through this
// instead of rendering `user.role` directly.
const ROLE_LABELS = {
  super_admin: 'Super Admin',
  // tqa is an acronym (Training & Quality Assurance), not a word - the
  // generic "capitalize first letter" fallback below would otherwise
  // render it as "Tqa".
  tqa: 'TQA',
};

export function formatRole(role) {
  if (!role) return '';
  if (ROLE_LABELS[role]) return ROLE_LABELS[role];
  // Fallback for admin/supervisor/manager, and safe for any future role
  // added on the backend before this list gets updated to match - still
  // strips underscores and title-cases each word instead of showing the
  // raw identifier.
  return role
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
