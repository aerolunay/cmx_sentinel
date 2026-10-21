// Shared by the dashboard charts and the live agents panel so an aux
// code, efficiency %, or adherence % gets the same color everywhere.
// (ReportsPage.jsx has its own copy of the same thresholds.)

export const AUX_COLORS = {
  Production: '#1e3a8a', Admin: '#2563eb', Adhoc: '#3b82f6',
  Lunch: '#c2660a', Break: '#d97706', Coaching: '#0d9488', Meeting: '#166534', Training: '#16a34a',
  BioBreak: '#7c3aed', Idle: '#6b7280',
  LoggedOut: '#374151',
};

// Order the live agents panel lists states in. Agents start in Idle on
// login, so every real state is listed; an unknown code (e.g. one added
// to the desktop app later) goes just before Logged Out.
export const LIVE_STATE_ORDER = [
  'Production', 'Admin', 'Adhoc', 'Training', 'Meeting', 'Coaching',
  'Idle', 'Lunch', 'Break', 'BioBreak', 'LoggedOut',
];

export function liveStateRank(auxCode) {
  const index = LIVE_STATE_ORDER.indexOf(auxCode);
  if (index !== -1) return index;
  return LIVE_STATE_ORDER.length - 1.5; // after Bio Break, before Logged Out
}

const AUX_LABELS = { BioBreak: 'Bio Break', LoggedOut: 'Logged Out' };

export function formatAuxLabel(auxCode) {
  return AUX_LABELS[auxCode] || auxCode;
}

export function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function getEfficiencyColor(pct) {
  if (pct >= 98) return '#1e3a8a'; // dark blue
  if (pct >= 95) return '#166534'; // dark green
  if (pct >= 90) return '#c2660a'; // orange
  return '#b91c1c'; // red
}

export function getAdherenceColor(pct) {
  if (pct >= 98) return '#1e3a8a'; // dark blue
  if (pct >= 95) return '#166534'; // dark green
  if (pct >= 90) return '#c2660a'; // orange
  return '#b91c1c'; // red
}
