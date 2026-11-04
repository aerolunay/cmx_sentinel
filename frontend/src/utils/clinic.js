// Shared by the Clinic Visits page (Med / Clinic users) and the Reports
// page's Clinic Visits tab. Dates and times are the clinic's own wall
// clock (Philippine time) as entered - plain strings, never Date objects,
// so the viewer's timezone can't shift them.

const MANILA = 'Asia/Manila';

// "YYYY-MM-DD" today in the Philippines.
export function getTodayManila() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// "HH:MM" (24h) now in the Philippines - what an <input type="time"> takes.
export function getNowTimeManila() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: MANILA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date());
}

// "11/04/2026" from "2026-11-04".
export function formatVisitDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}/${y}`;
}

// "2:05 PM" from "14:05"; '' for none.
export function formatVisitTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function downloadClinicVisitsCsv(visits, dateFrom, dateTo) {
  const headers = ['Date of Visit', 'Employee ID', 'Employee Name', 'Time of Visit', 'Chief Complaint',
    'Treatment / Intervention', 'Time Released', 'Seen By'];
  const lines = [headers.join(',')];
  for (const v of visits) {
    lines.push([
      v.visitDate, v.employeeId, v.employeeName, formatVisitTime(v.timeOfVisit), v.chiefComplaint,
      v.treatment, formatVisitTime(v.timeReleased), v.seenBy,
    ].map(csvCell).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `clinic-visits_${dateFrom}_to_${dateTo}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
