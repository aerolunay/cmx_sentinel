// Shared by the dashboard charts and the live agents panel so an aux
// code, efficiency %, or adherence % gets the same color everywhere.
// (ReportsPage.jsx has its own copy of the same thresholds.)

export const AUX_COLORS = {
  Production: '#1e3a8a', Admin: '#2563eb', Adhoc: '#3b82f6',
  Lunch: '#c2660a', Break: '#d97706', Coaching: '#0d9488', Meeting: '#166534', Training: '#16a34a',
  BioBreak: '#7c3aed', Idle: '#6b7280',
};

export function getEfficiencyColor(pct) {
  if (pct >= 88) return '#1e3a8a'; // dark blue
  if (pct >= 85) return '#166534'; // dark green
  if (pct >= 80) return '#c2660a'; // orange
  return '#b91c1c'; // red
}

export function getAdherenceColor(pct) {
  if (pct >= 95) return '#1e3a8a'; // dark blue
  if (pct >= 90) return '#166534'; // dark green
  if (pct >= 80) return '#c2660a'; // orange
  return '#b91c1c'; // red
}
