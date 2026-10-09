import { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import Setup2FAModal from '../modals/Setup2FAModal.jsx';
import { formatRole } from '../utils/roles.js';
import { AUX_COLORS, getEfficiencyColor, getAdherenceColor } from '../utils/metrics.js';
import LiveAgentsPanel from '../components/LiveAgentsPanel.jsx';

const PRODUCTIVE_AUX_CODES = ['Production', 'Admin', 'Adhoc', 'Coaching', 'Meeting', 'Training'];
const AUX_CODES = ['Production', 'Admin', 'Adhoc', 'Lunch', 'Break', 'Coaching', 'Meeting', 'Training', 'BioBreak', 'Idle'];

function getCurrentMonthEastern() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).slice(0, 7); // "2026-09-15" -> "2026-09"
}

// Pure arithmetic (day-count of a month), not a display conversion -
// safe to use a plain Date object here unlike formatting a specific
// calendar day for display (see ReportsPage.jsx's formatDailyDate for
// why THAT needs to avoid Date entirely).
function getMonthRange(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const lastDayNum = new Date(y, m, 0).getDate();
  return { dateFrom: `${monthStr}-01`, dateTo: `${monthStr}-${String(lastDayNum).padStart(2, '0')}` };
}

export default function DashboardPage() {
  const { user, refreshUser } = useAuth();
  const [show2FAModal, setShow2FAModal] = useState(false);
  const [month, setMonth] = useState(getCurrentMonthEastern());
  const [groupFilter, setGroupFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadMonth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  async function loadMonth() {
    setLoading(true);
    setError('');
    try {
      // Always fetched WITHOUT a group filter - group filtering happens
      // client-side below so switching groups is instant and doesn't
      // need a new request, and so the group dropdown itself can be
      // built from whatever groups actually appear in this month's data.
      const { dateFrom, dateTo } = getMonthRange(month);
      const data = await api.getEfficiencyReport({ dateFrom, dateTo });
      setRows(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const groupOptions = useMemo(() => {
    const seen = new Map();
    for (const r of rows) {
      if (r.groupId && !seen.has(r.groupId)) seen.set(r.groupId, r.groupName);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  // Scoped to the current GROUP filter (not the agent filter itself) so
  // switching groups narrows the agent dropdown to agents who actually
  // belong to it, same cascading behavior as picking a country narrowing
  // a city dropdown - built from `rows`, not `filteredRows`, to avoid a
  // circular dependency on agentFilter.
  const groupScopedRows = useMemo(() => {
    if (!groupFilter) return rows;
    return rows.filter((r) => String(r.groupId) === groupFilter);
  }, [rows, groupFilter]);

  const agentOptions = useMemo(() => {
    const seen = new Map();
    for (const r of groupScopedRows) {
      if (r.agentId && !seen.has(r.agentId)) seen.set(r.agentId, r.displayName);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [groupScopedRows]);

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (groupFilter && String(r.groupId) !== groupFilter) return false;
      if (agentFilter && String(r.agentId) !== agentFilter) return false;
      return true;
    });
  }, [rows, groupFilter, agentFilter]);

  // One point per day - sums ALL agents together for that day (overall,
  // or within the selected group), then computes efficiency from those
  // summed totals - same "sum first, then divide" reasoning as
  // ReportsPage's monthly aggregation, not an average of per-agent
  // percentages.
  const efficiencyTrend = useMemo(() => {
    const byDay = new Map();
    for (const r of filteredRows) {
      if (!byDay.has(r.date)) byDay.set(r.date, { date: r.date, totalHours: 0, productiveHours: 0 });
      const day = byDay.get(r.date);
      day.totalHours += r.totalHours;
      day.productiveHours += PRODUCTIVE_AUX_CODES.reduce((sum, code) => sum + (r.auxHours[code] || 0), 0);
    }
    return [...byDay.values()]
      .map((d) => ({
        day: Number(d.date.slice(-2)), // just the day-of-month number for a compact x-axis
        efficiency: d.totalHours > 0 ? Number(((d.productiveHours / d.totalHours) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => a.day - b.day);
  }, [filteredRows]);

  // Overall efficiency across the whole filtered month (all days, all
  // agents in the current group filter) - same "sum first, then
  // divide" math as everywhere else efficiency gets computed, not an
  // average of daily/agent percentages.
  const monthToDateEfficiency = useMemo(() => {
    let totalHours = 0;
    let productiveHours = 0;
    for (const r of filteredRows) {
      totalHours += r.totalHours;
      productiveHours += PRODUCTIVE_AUX_CODES.reduce((sum, code) => sum + (r.auxHours[code] || 0), 0);
    }
    return totalHours > 0 ? (productiveHours / totalHours) * 100 : 0;
  }, [filteredRows]);

  // Same "sum first, then divide" approach, but only over days that
  // actually have a schedule loaded (hasSchedule: true) - a day
  // without one simply doesn't contribute to either side of the
  // ratio, rather than being treated as 0% adherence.
  const monthToDateAdherence = useMemo(() => {
    let scheduledHours = 0;
    let scheduledLoggedHours = 0;
    let hasAnySchedule = false;
    for (const r of filteredRows) {
      if (!r.hasSchedule) continue;
      hasAnySchedule = true;
      scheduledHours += r.scheduledHours || 0;
      scheduledLoggedHours += r.adherentHours ?? r.totalHours; // includes credited reconnect gaps
    }
    return hasAnySchedule && scheduledHours > 0 ? (scheduledLoggedHours / scheduledHours) * 100 : null;
  }, [filteredRows]);

  // Each aux code's SHARE of total logged time, not raw hours - easier
  // to compare across agents/groups of different total hours this way.
  const auxBreakdown = useMemo(() => {
    const totals = {};
    for (const code of AUX_CODES) totals[code] = 0;
    for (const r of filteredRows) {
      for (const code of AUX_CODES) {
        totals[code] += r.auxHours[code] || 0;
      }
    }
    const grandTotal = Object.values(totals).reduce((sum, h) => sum + h, 0);
    return AUX_CODES.map((code) => ({
      aux: code,
      pct: grandTotal > 0 ? Number(((totals[code] / grandTotal) * 100).toFixed(1)) : 0,
    }));
  }, [filteredRows]);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Dashboard</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
          />
          <select
            value={groupFilter}
            onChange={(e) => { setGroupFilter(e.target.value); setAgentFilter(''); }}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
          >
            <option value="">All Groups</option>
            {groupOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
          >
            <option value="">All Agents</option>
            {agentOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </div>
      </div>

      <p>Logged in as <strong>{user?.displayName}</strong> ({formatRole(user?.role)}).</p>

      {!user?.totpEnabled && (
        <p>
          <button type="button" className="btn-link" onClick={() => setShow2FAModal(true)}>
            Set up an authenticator app
          </button>
          {' '}for faster login next time.
        </p>
      )}

      {error && <div className="error">{error}</div>}

      <div className="dashboard-layout">
        <div className="dashboard-main">
          {loading ? (
            <p>Loading...</p>
          ) : filteredRows.length === 0 ? (
            <p>No data for this month{groupFilter || agentFilter ? ' / filter' : ''} yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <div className="dashboard-card" style={{ textAlign: 'center', flex: '1 1 240px' }}>
                  <h3 style={{ marginBottom: 4 }}>Month to Date Efficiency</h3>
                  <div style={{ fontSize: 48, fontWeight: 700, color: getEfficiencyColor(monthToDateEfficiency) }}>
                    {monthToDateEfficiency.toFixed(1)}%
                  </div>
                </div>

                <div className="dashboard-card" style={{ textAlign: 'center', flex: '1 1 240px' }}>
                  <h3 style={{ marginBottom: 4 }}>Month to Date Schedule Adherence</h3>
                  {monthToDateAdherence == null ? (
                    <div style={{ fontSize: 16, color: '#999', padding: '14px 0' }}>No schedule data for this month yet.</div>
                  ) : (
                    <div style={{ fontSize: 48, fontWeight: 700, color: getAdherenceColor(monthToDateAdherence) }}>
                      {monthToDateAdherence.toFixed(1)}%
                    </div>
                  )}
                </div>
              </div>

              <div className="dashboard-card">
                <h3>Efficiency Trend</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={efficiencyTrend} margin={{ top: 5, right: 20, left: 0, bottom: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey="day" label={{ value: 'Day of Month', position: 'insideBottom', offset: -14 }} fontSize={12} />
                    <YAxis domain={[0, 100]} unit="%" fontSize={12} />
                    <Tooltip formatter={(value) => `${value}%`} labelFormatter={(day) => `Day ${day}`} />
                    <Line type="monotone" dataKey="efficiency" stroke="#1e3a8a" strokeWidth={2} dot={{ r: 3 }} name="Efficiency %" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="dashboard-card">
                <h3>Aux Code Breakdown (% of Total Time)</h3>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={auxBreakdown}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey="aux" fontSize={12} angle={-20} textAnchor="end" height={60} />
                    <YAxis unit="%" fontSize={12} />
                    <Tooltip formatter={(value) => `${value}%`} />
                    <Bar dataKey="pct" name="% of Total Time">
                      {auxBreakdown.map((entry) => (
                        <Cell key={entry.aux} fill={AUX_COLORS[entry.aux]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>

        <div className="dashboard-side">
          <LiveAgentsPanel groupFilter={groupFilter} agentFilter={agentFilter} />
        </div>
      </div>

      {show2FAModal && (
        <Setup2FAModal
          onClose={() => setShow2FAModal(false)}
          onComplete={() => { refreshUser(); setShow2FAModal(false); }}
        />
      )}
    </>
  );
}
