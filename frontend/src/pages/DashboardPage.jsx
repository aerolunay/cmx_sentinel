import { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import Setup2FAModal from '../modals/Setup2FAModal.jsx';

const PRODUCTIVE_AUX_CODES = ['Production', 'Admin', 'Adhoc', 'Meeting', 'Training'];
const AUX_CODES = ['Production', 'Admin', 'Adhoc', 'Lunch', 'Break', 'Meeting', 'Training', 'BioBreak', 'Idle'];
const AUX_COLORS = {
  Production: '#1e3a8a', Admin: '#2563eb', Adhoc: '#3b82f6',
  Lunch: '#c2660a', Break: '#d97706', Meeting: '#166534', Training: '#16a34a',
  BioBreak: '#7c3aed', Idle: '#6b7280',
};

// Same thresholds as ReportsPage.jsx - kept consistent so "efficiency
// %" means the same color everywhere in the app.
function getEfficiencyColor(pct) {
  if (pct >= 88) return '#1e3a8a'; // dark blue
  if (pct >= 85) return '#166534'; // dark green
  if (pct >= 80) return '#c2660a'; // orange
  return '#b91c1c'; // red
}

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

  const filteredRows = useMemo(() => {
    if (!groupFilter) return rows;
    return rows.filter((r) => String(r.groupId) === groupFilter);
  }, [rows, groupFilter]);

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
            onChange={(e) => setGroupFilter(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
          >
            <option value="">All Groups</option>
            {groupOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </div>
      </div>

      <p>Logged in as <strong>{user?.displayName}</strong> ({user?.role}).</p>

      {!user?.totpEnabled && (
        <p>
          <button type="button" className="btn-link" onClick={() => setShow2FAModal(true)}>
            Set up an authenticator app
          </button>
          {' '}for faster login next time.
        </p>
      )}

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : filteredRows.length === 0 ? (
        <p>No data for this month{groupFilter ? ' / group' : ''} yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="dashboard-card" style={{ textAlign: 'center' }}>
            <h3 style={{ marginBottom: 4 }}>Month to Date Efficiency</h3>
            <div style={{ fontSize: 48, fontWeight: 700, color: getEfficiencyColor(monthToDateEfficiency) }}>
              {monthToDateEfficiency.toFixed(1)}%
            </div>
          </div>

          <div className="dashboard-card">
            <h3>Efficiency Trend</h3>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={efficiencyTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="day" label={{ value: 'Day of Month', position: 'insideBottom', offset: -5 }} fontSize={12} />
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

      {show2FAModal && (
        <Setup2FAModal
          onClose={() => setShow2FAModal(false)}
          onComplete={() => { refreshUser(); setShow2FAModal(false); }}
        />
      )}
    </>
  );
}
