// Calendar-day helpers for the dashboard's date filters. Every date is a
// plain "YYYY-MM-DD" string for an Eastern calendar day (the same thing
// the reports API takes), and the arithmetic runs on UTC Date objects so
// the browser's own timezone and DST never shift a day.

export function getTodayEastern() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function parseDay(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDay(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(dayStr, days) {
  const date = parseDay(dayStr);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDay(date);
}

// Weeks run Sunday-Saturday.
function startOfWeek(dayStr) {
  return addDays(dayStr, -parseDay(dayStr).getUTCDay());
}

function startOfMonth(dayStr) {
  return `${dayStr.slice(0, 7)}-01`;
}

export const HISTORICAL_PRESETS = [
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'thisWeek', label: 'This Week' },
  { key: 'lastWeek', label: 'Last Week' },
  { key: 'thisMonth', label: 'This Month' },
  { key: 'lastMonth', label: 'Last Month' },
  { key: 'custom', label: 'Custom' },
];

// "This week/month" run up to today, not to the end of the period.
export function getPresetRange(key, today = getTodayEastern()) {
  switch (key) {
    case 'yesterday': {
      const day = addDays(today, -1);
      return { dateFrom: day, dateTo: day };
    }
    case 'thisWeek':
      return { dateFrom: startOfWeek(today), dateTo: today };
    case 'lastWeek': {
      const dateFrom = addDays(startOfWeek(today), -7);
      return { dateFrom, dateTo: addDays(dateFrom, 6) };
    }
    case 'thisMonth':
      return { dateFrom: startOfMonth(today), dateTo: today };
    case 'lastMonth': {
      const dateTo = addDays(startOfMonth(today), -1);
      return { dateFrom: startOfMonth(dateTo), dateTo };
    }
    default:
      return null;
  }
}

const SHORT_FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const LONG_FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

export function formatDayShort(dayStr) {
  return SHORT_FORMAT.format(parseDay(dayStr));
}

export function formatRangeLabel({ dateFrom, dateTo }) {
  if (dateFrom === dateTo) return LONG_FORMAT.format(parseDay(dateFrom));
  const sameYear = dateFrom.slice(0, 4) === dateTo.slice(0, 4);
  const from = sameYear ? SHORT_FORMAT.format(parseDay(dateFrom)) : LONG_FORMAT.format(parseDay(dateFrom));
  return `${from} – ${LONG_FORMAT.format(parseDay(dateTo))}`;
}
