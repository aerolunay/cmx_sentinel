import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Same aux codes the desktop app tracks (see AgentState.cs) - shown as
// columns in a fixed order regardless of which ones a given row
// actually has hours in, so the table doesn't reflow oddly row to row.
const AUX_CODES = ['Production', 'Admin', 'Adhoc', 'Lunch', 'Break', 'Meeting', 'Training', 'BioBreak', 'Idle'];

// Same codes the backend treats as "productive" - duplicated here
// since monthly aggregation happens client-side (see aggregateMonthly
// below), not a separate backend query.
const PRODUCTIVE_AUX_CODES = ['Production', 'Admin', 'Adhoc', 'Meeting', 'Training'];

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
// (agent, month). Efficiency is recomputed from SUMMED hours, not
// averaged from the daily percentages - averaging percentages across
// days of different lengths would be mathematically wrong (a 100%
// efficient 2-hour day and a 50% efficient 10-hour day do NOT average
// to 75% of the combined 12 hours).
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
      });
    }
    const entry = grouped.get(key);
    for (const [code, hours] of Object.entries(r.auxHours)) {
      entry.auxHours[code] = (entry.auxHours[code] || 0) + hours;
    }
  }

  return [...grouped.values()]
    .map((entry) => {
      const totalHours = Object.values(entry.auxHours).reduce((sum, h) => sum + h, 0);
      const productiveHours = PRODUCTIVE_AUX_CODES.reduce((sum, code) => sum + (entry.auxHours[code] || 0), 0);
      return {
        ...entry,
        totalHours,
        efficiencyPct: totalHours > 0 ? (productiveHours / totalHours) * 100 : 0,
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
  if (!hours) return '-';
  return `${hours.toFixed(1)}h`;
}

function getEfficiencyColor(pct) {
  if (pct >= 88) return '#1e3a8a'; // dark blue
  if (pct >= 85) return '#166534'; // dark green
  if (pct >= 80) return '#c2660a'; // orange
  return '#b91c1c'; // red
}

function toCsv(rows) {
  const headers = ['Date', 'Agent', 'Agent ID', 'Group', ...AUX_CODES, 'Total Hours', 'Efficiency %'];
  const lines = [headers.join(',')];

  for (const r of rows) {
    const line = [
      r.date,
      `"${r.displayName}"`,
      r.agentId,
      `"${r.groupName || ''}"`,
      ...AUX_CODES.map((code) => (r.auxHours[code] || 0).toFixed(2)),
      r.totalHours.toFixed(2),
      r.efficiencyPct.toFixed(1),
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
                <th>Efficiency %</th>
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
                  <td style={{ fontWeight: 600, color: getEfficiencyColor(r.efficiencyPct) }}>{r.efficiencyPct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
