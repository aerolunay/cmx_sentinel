import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Same aux codes the desktop app tracks (see AgentState.cs) - shown as
// columns in a fixed order regardless of which ones a given row
// actually has hours in, so the table doesn't reflow oddly row to row.
const AUX_CODES = ['Production', 'Admin', 'Adhoc', 'Lunch', 'Break', 'Coaching', 'Meeting', 'Training', 'BioBreak', 'Idle'];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Pure string parsing, deliberately NOT `new Date(dateStr)` - the
// backend's report_date is already a specific Eastern calendar day
// (e.g. "2026-09-11"), and constructing a Date object from that string
// gets interpreted as UTC midnight, which .toLocaleDateString() could
// then shift back a day for anyone west of UTC. Same class of bug the
// rest of this project has been careful to avoid around Eastern-day
// boundaries (see EasternTime.cs, luxon usage in recordingRoutes.js).
function formatDailyDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

function formatMonthLabel(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

// Aggregates already-fetched daily rows up to one row per
// (agent, month). Productive Hrs % is recomputed from SUMMED hours
// (productiveCreditHours ÷ productiveBaseHours - each day's Expected
// minus Non-productive, over its Expected, worked out server-side), not
// averaged from the daily percentages - averaging percentages across
// days of different lengths would be mathematically wrong (a 100%
// efficient 2-hour day and a 50% efficient 10-hour day do NOT average
// to 75% of the combined 12 hours). Same reasoning applies to
// adherencePct below.
//
// Each daily row's auxHours/totalHours is ALREADY schedule-scoped when
// that day has a schedule (hasSchedule: true) and falls back to the
// legacy unscoped totals otherwise - see reportRoutes.js. A month can
// freely mix both kinds of days (e.g. schedule sync only recently
// started); Productive Hrs % and adherence are accumulated ONLY from days
// that actually have a schedule, so a day with no schedule simply
// doesn't affect the adherence figure either way. adherentHours
// includes credited reconnect gaps between logins - see reportRoutes.js.
function aggregateMonthly(dailyRows) {
  const grouped = new Map();

  for (const r of dailyRows) {
    const monthKey = r.date.slice(0, 7); // "2026-09-11" -> "2026-09"
    const key = `${r.agentId}|${monthKey}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        date: monthKey,
        agentId: r.agentId,
        displayName: r.displayName,
        groupId: r.groupId,
        groupName: r.groupName,
        auxHours: {},
        productiveCreditHours: 0,
        productiveBaseHours: 0,
        scheduledHours: 0,
        adherentHours: 0,
        hasAnySchedule: false,
      });
    }
    const entry = grouped.get(key);
    for (const [code, hours] of Object.entries(r.auxHours)) {
      entry.auxHours[code] = (entry.auxHours[code] || 0) + hours;
    }
    if (r.hasSchedule) {
      entry.hasAnySchedule = true;
      entry.scheduledHours += r.scheduledHours || 0;
      entry.adherentHours += r.adherentHours ?? r.totalHours;
      if (r.productiveBaseHours != null) {
        entry.productiveCreditHours += r.productiveCreditHours || 0;
        entry.productiveBaseHours += r.productiveBaseHours;
      }
    }
  }

  return [...grouped.values()]
    .map((entry) => {
      const totalHours = Object.values(entry.auxHours).reduce((sum, h) => sum + h, 0);
      return {
        ...entry,
        totalHours,
        efficiencyPct: entry.productiveBaseHours > 0
          ? (entry.productiveCreditHours / entry.productiveBaseHours) * 100
          : null,
        adherencePct: entry.hasAnySchedule && entry.scheduledHours > 0
          ? (entry.adherentHours / entry.scheduledHours) * 100
          : null,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.displayName.localeCompare(b.displayName));
}

function getTodayEastern() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function formatHours(hours) {
  const totalSeconds = Math.round((hours || 0) * 3600);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function getEfficiencyColor(pct) {
  if (pct >= 98) return '#1e3a8a'; // dark blue
  if (pct >= 95) return '#166534'; // dark green
  if (pct >= 90) return '#c2660a'; // orange
  return '#b91c1c'; // red
}

// Adherence is a different metric than Productive Hrs (time actually
// logged during the shift, vs. time spent productively while logged
// in), but it currently has the same targets.
function getAdherenceColor(pct) {
  if (pct >= 98) return '#1e3a8a'; // dark blue
  if (pct >= 95) return '#166534'; // dark green
  if (pct >= 90) return '#c2660a'; // orange
  return '#b91c1c'; // red
}

function toCsv(rows) {
  const headers = ['Date', 'Agent', 'Agent ID', 'Group', ...AUX_CODES, 'Total Hours', 'Productive Hrs %', 'Scheduled Hours', 'Adherence %'];
  const lines = [headers.join(',')];

  for (const r of rows) {
    const line = [
      r.date,
      `"${r.displayName}"`,
      r.agentId,
      `"${r.groupName || ''}"`,
      ...AUX_CODES.map((code) => (r.auxHours[code] || 0).toFixed(2)),
      r.totalHours.toFixed(2),
      r.efficiencyPct == null ? '' : r.efficiencyPct.toFixed(2),
      r.scheduledHours == null ? '' : r.scheduledHours.toFixed(2),
      r.adherencePct == null ? '' : r.adherencePct.toFixed(2),
    ];
    lines.push(line.join(','));
  }

  return lines.join('\n');
}

export default function ReportsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dateFrom, setDateFrom] = useState(getTodayEastern());
  const [dateTo, setDateTo] = useState(getTodayEastern());
  const [agentFilter, setAgentFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [viewMode, setViewMode] = useState('monthly'); // 'monthly' | 'daily'

  useEffect(() => {
    loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadReport() {
    setLoading(true);
    setError('');
    try {
      const params = { dateFrom, dateTo };
      if (agentFilter) params.agentId = agentFilter;
      if (groupFilter) params.groupId = groupFilter;
      const data = await api.getEfficiencyReport(params);
      setRows(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Derived from whatever's currently loaded, same pattern as
  // RecordingsPage - avoids a separate /api/agents call (admin-only)
  // that TQA/Supervisor/Manager wouldn't have access to.
  const agentOptions = useMemo(() => {
    const seen = new Map();
    for (const r of rows) {
      if (!seen.has(r.agentId)) seen.set(r.agentId, r.displayName);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const groupOptions = useMemo(() => {
    const seen = new Map();
    for (const r of rows) {
      if (r.groupId && !seen.has(r.groupId)) seen.set(r.groupId, r.groupName);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const displayRows = useMemo(() => {
    return viewMode === 'monthly' ? aggregateMonthly(rows) : rows;
  }, [rows, viewMode]);

  function handleExportCsv() {
    const csv = toCsv(displayRows);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `efficiency-report_${dateFrom}_to_${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Reports</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={viewMode} onChange={(e) => setViewMode(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14, fontWeight: 600 }}>
            <option value="monthly">Monthly</option>
            <option value="daily">Daily</option>
          </select>

          <label style={{ fontSize: 13, color: '#555' }}>From</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }} />
          <label style={{ fontSize: 13, color: '#555' }}>To</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }} />

          <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}>
            <option value="">All Agents</option>
            {agentOptions.map(([id, name]) => (
              <option key={id} value={id}>{name} ({id})</option>
            ))}
          </select>

          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}>
            <option value="">All Groups</option>
            {groupOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>

          <button type="button" className="btn" onClick={loadReport} disabled={loading}>
            {loading ? 'Loading...' : 'Run Report'}
          </button>
          {displayRows.length > 0 && (
            <button type="button" className="btn-secondary" onClick={handleExportCsv}>
              Export CSV
            </button>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {!loading && displayRows.length === 0 && !error && (
        <p>No data for this filter. Try widening the date range or changing filters, then click Run Report.</p>
      )}

      {displayRows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>{viewMode === 'monthly' ? 'Month' : 'Date'}</th>
                <th>Agent</th>
                <th>Group</th>
                {AUX_CODES.map((code) => <th key={code}>{code}</th>)}
                <th>Total Hours</th>
                <th>Productive Hrs %</th>
                <th>Scheduled Hours</th>
                <th>Adherence %</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((r) => (
                <tr key={`${r.agentId}-${r.date}`}>
                  <td>{viewMode === 'monthly' ? formatMonthLabel(r.date) : formatDailyDate(r.date)}</td>
                  <td>{r.displayName}</td>
                  <td>{r.groupName || <em style={{ color: '#999' }}>none</em>}</td>
                  {AUX_CODES.map((code) => (
                    <td key={code}>{formatHours(r.auxHours[code])}</td>
                  ))}
                  <td>{formatHours(r.totalHours)}</td>
                  <td style={r.efficiencyPct == null ? undefined : { fontWeight: 600, color: getEfficiencyColor(r.efficiencyPct) }}>
                    {r.efficiencyPct == null ? <em style={{ color: '#999' }}>N/A</em> : `${r.efficiencyPct.toFixed(2)}%`}
                  </td>
                  <td>{r.scheduledHours == null ? <em style={{ color: '#999' }}>no schedule</em> : formatHours(r.scheduledHours)}</td>
                  <td style={r.adherencePct == null ? undefined : { fontWeight: 600, color: getAdherenceColor(r.adherencePct) }}>
                    {r.adherencePct == null ? <em style={{ color: '#999' }}>N/A</em> : `${r.adherencePct.toFixed(2)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
