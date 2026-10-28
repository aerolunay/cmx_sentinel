import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { addDays, getTodayEastern } from '../utils/dateRanges.js';

// Logins the server closed because the agent never logged out - still
// open 6 hours after the scheduled shift end (see
// backend/services/autoLogout.js). Each row's session was ended at the
// scheduled end, so the hours after it don't count as worked.

const selectStyle = { padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 };

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}/${y}`;
}

// "10/27/2026 6:00 AM" for an Eastern "YYYY-MM-DD HH:MM:SS" string -
// string parsing only, never `new Date()`, so the browser's timezone
// can't shift it.
function formatDateTime(value) {
  if (!value) return '';
  const [datePart, timePart] = value.split(' ');
  const [h, m] = timePart.split(':').map(Number);
  return `${formatDate(datePart)} ${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function statusLabel(r) {
  return r.appRunning ? 'Left Sentinel running' : 'Did not log out';
}

function toCsv(rows) {
  const headers = ['Shift Date', 'Agent', 'Agent ID', 'Group', 'PC', 'Scheduled End', 'Last Aux', 'Aux Started', 'Logged Out At', 'Detected At', 'Status'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.date,
      `"${r.displayName}"`,
      r.agentId,
      `"${r.groupName || ''}"`,
      `"${r.machineName || ''}"`,
      r.scheduledEnd,
      r.auxCode,
      r.segmentStarted,
      r.closedAt,
      r.detectedAt,
      statusLabel(r),
    ].join(','));
  }
  return lines.join('\n');
}

export default function LogoutOffendersReport() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dateFrom, setDateFrom] = useState(addDays(getTodayEastern(), -6));
  const [dateTo, setDateTo] = useState(getTodayEastern());
  const [agentFilter, setAgentFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');

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
      setRows(await api.getAutoLogouts(params));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

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

  const agentCount = agentOptions.length;

  function handleExportCsv() {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `utilization-violations_${dateFrom}_to_${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#555', maxWidth: 520 }}>
          Agents still logged in 6 hours after their scheduled shift end. The session was ended at the
          scheduled end, so the time after it doesn't count as worked.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 13, color: '#555' }}>From</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={selectStyle} />
          <label style={{ fontSize: 13, color: '#555' }}>To</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={selectStyle} />

          <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} style={selectStyle}>
            <option value="">All Agents</option>
            {agentOptions.map(([id, name]) => (
              <option key={id} value={id}>{name} ({id})</option>
            ))}
          </select>

          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={selectStyle}>
            <option value="">All Groups</option>
            {groupOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>

          <button type="button" className="btn" onClick={loadReport} disabled={loading}>
            {loading ? 'Loading...' : 'Run Report'}
          </button>
          {rows.length > 0 && (
            <button type="button" className="btn-secondary" onClick={handleExportCsv}>
              Export CSV
            </button>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {!loading && rows.length === 0 && !error && (
        <p>No agents were logged out by the system for this filter.</p>
      )}

      {rows.length > 0 && (
        <>
          <p style={{ fontSize: 13, color: '#555' }}>
            {rows.length} {rows.length === 1 ? 'session' : 'sessions'} left open by {agentCount} {agentCount === 1 ? 'agent' : 'agents'}.
          </p>
          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Shift Date</th>
                  <th>Agent</th>
                  <th>Group</th>
                  <th>PC</th>
                  <th>Scheduled End</th>
                  <th title="The aux code the agent was left in">Last Aux</th>
                  <th>Aux Started</th>
                  <th title="Where the system ended the session - the scheduled end">Logged Out At</th>
                  <th title="When the hourly check found the session still open">Detected At</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDate(r.date)}</td>
                    <td>{r.displayName}</td>
                    <td>{r.groupName || <em style={{ color: '#999' }}>none</em>}</td>
                    <td>{r.machineName || <em style={{ color: '#999' }}>-</em>}</td>
                    <td>{formatDateTime(r.scheduledEnd)}</td>
                    <td>{r.auxCode}</td>
                    <td>{formatDateTime(r.segmentStarted)}</td>
                    <td>{formatDateTime(r.closedAt)}</td>
                    <td>{formatDateTime(r.detectedAt)}</td>
                    <td style={{ fontWeight: 600, color: r.appRunning ? '#b91c1c' : '#c2660a' }}>{statusLabel(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
