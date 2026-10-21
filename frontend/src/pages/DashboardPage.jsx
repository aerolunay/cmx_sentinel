import { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import Setup2FAModal from '../modals/Setup2FAModal.jsx';
import MetricsHelpModal from '../modals/MetricsHelpModal.jsx';
import { formatRole } from '../utils/roles.js';
import { AUX_COLORS, getEfficiencyColor, getAdherenceColor } from '../utils/metrics.js';
import {
  HISTORICAL_PRESETS, getPresetRange, getTodayEastern, formatDayShort, formatRangeLabel,
} from '../utils/dateRanges.js';
import LiveAgentsPanel from '../components/LiveAgentsPanel.jsx';
import DateRangePicker from '../components/DateRangePicker.jsx';

const PRODUCTIVE_AUX_CODES = ['Production', 'Admin', 'Adhoc', 'Coaching', 'Meeting', 'Training'];
const AUX_CODES = ['Production', 'Admin', 'Adhoc', 'Lunch', 'Break', 'Coaching', 'Meeting', 'Training', 'BioBreak', 'Idle'];

// How often the Live view's stats reload (the live agents panel has its
// own, faster refresh).
const LIVE_REFRESH_MS = 60000;

// "8 AM", "12 PM" ... for an Eastern hour-of-day number.
function formatHourLabel(hour) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? 'AM' : 'PM'}`;
}

function formatMinutes(minutes) {
  const whole = Math.floor(minutes);
  const seconds = Math.round((minutes - whole) * 60);
  return seconds > 0 ? `${whole}m ${seconds}s` : `${whole}m`;
}

const selectStyle = { padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 };

export default function DashboardPage() {
  const { user, refreshUser } = useAuth();
  const [show2FAModal, setShow2FAModal] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // 'live' = today so far, with the live agents panel; 'historical' = a
  // preset or custom date range, without it.
  const [view, setView] = useState('live');
  const [preset, setPreset] = useState('thisMonth');
  const [customRange, setCustomRange] = useState(null);
  const [groupFilter, setGroupFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [rows, setRows] = useState([]);
  const [hourlyRows, setHourlyRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const isLive = view === 'live';
  const today = getTodayEastern();
  let range;
  if (isLive) range = { dateFrom: today, dateTo: today };
  else if (preset === 'custom') range = customRange; // null until both ends are picked
  else range = getPresetRange(preset, today);

  useEffect(() => {
    if (!range) {
      setRows([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;

    async function load({ quiet = false } = {}) {
      if (!quiet) {
        setLoading(true);
        setError('');
      }
      try {
        // Always fetched WITHOUT a group filter - group filtering happens
        // client-side below so switching groups is instant and doesn't
        // need a new request, and so the group dropdown itself can be
        // built from whatever groups actually appear in this range's data.
        const [data, hourly] = await Promise.all([
          api.getEfficiencyReport(range),
          isLive ? api.getHourlyAux() : [],
        ]);
        if (cancelled) return;
        setRows(data);
        setHourlyRows(hourly);
        setError('');
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled && !quiet) setLoading(false);
      }
    }

    load();
    if (!isLive) return () => { cancelled = true; };

    // Live: keep today's running numbers fresh without flashing
    // "Loading...", paused while the tab is hidden.
    const refresh = setInterval(() => {
      if (!document.hidden) load({ quiet: true });
    }, LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, range?.dateFrom, range?.dateTo]);

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

  // Productive Hrs % = summed productive hours ÷ summed productive
  // base hours (each agent/day's login hours minus its break allowance,
  // worked out server-side - see productiveHrs in reportRoutes.js).
  // Only agent/days WITH a schedule count; without one there's no
  // Productive Hrs %. Summing first, then dividing - not averaging
  // per-agent percentages - same as ReportsPage's monthly aggregation.
  function sumProductive(list) {
    let productiveHours = 0;
    let baseHours = 0;
    for (const r of list) {
      if (!r.hasSchedule || r.productiveBaseHours == null) continue;
      productiveHours += r.productiveHours || 0;
      baseHours += r.productiveBaseHours;
    }
    return baseHours > 0 ? (productiveHours / baseHours) * 100 : null;
  }

  // One point per day, all agents in the current filters together. Days
  // with nothing to measure (no schedule, or not logged in yet) are left
  // off rather than plotted as 0%.
  const productiveTrend = useMemo(() => {
    const byDay = new Map();
    for (const r of filteredRows) {
      if (!byDay.has(r.date)) byDay.set(r.date, []);
      byDay.get(r.date).push(r);
    }
    return [...byDay.entries()]
      .map(([date, dayRows]) => ({ date, pct: sumProductive(dayRows) }))
      .filter((d) => d.pct != null)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        day: formatDayShort(d.date), // ranges can span months, so "Oct 3" rather than a bare day number
        productive: Number(d.pct.toFixed(1)),
      }));
  }, [filteredRows]);

  const overallProductive = useMemo(() => sumProductive(filteredRows), [filteredRows]);

  // Same "sum first, then divide" approach, but only over days that
  // actually have a schedule loaded (hasSchedule: true) - a day
  // without one simply doesn't contribute to either side of the
  // ratio, rather than being treated as 0% adherence. scheduledHours
  // is only the scheduled time elapsed so far (see
  // /api/reports/efficiency), so the rest of today and future days add
  // nothing to the denominator.
  const overallAdherence = useMemo(() => {
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

  // Live view: recorded aux time per hour of today. The hours shown run
  // from the first to the last hour anything was recorded in (empty
  // hours in between kept so the axis is even), and only aux codes that
  // actually appear get a series.
  const filteredHourly = useMemo(() => hourlyRows.filter((r) => {
    if (groupFilter && String(r.groupId) !== groupFilter) return false;
    if (agentFilter && String(r.agentId) !== agentFilter) return false;
    return true;
  }), [hourlyRows, groupFilter, agentFilter]);

  // Per hour: the AVERAGE minutes per agent in each aux code - each
  // code's total divided by the number of agents who recorded any time
  // in that hour, so a full hour stacks to at most 60m however many
  // agents are on. productivePct is that hour's productive SHARE of all
  // recorded time - not Productive Hrs %, whose break allowance only
  // makes sense per shift, not per hour.
  const { hourlyAux, hourlyCodes } = useMemo(() => {
    if (filteredHourly.length === 0) return { hourlyAux: [], hourlyCodes: [] };
    const byHour = new Map();
    const codes = new Set();
    for (const r of filteredHourly) {
      if (!byHour.has(r.hour)) byHour.set(r.hour, { seconds: {}, agents: new Set() });
      const hour = byHour.get(r.hour);
      hour.seconds[r.auxCode] = (hour.seconds[r.auxCode] || 0) + r.seconds;
      hour.agents.add(r.agentId);
      codes.add(r.auxCode);
    }
    const hours = [...byHour.keys()];
    const data = [];
    for (let h = Math.min(...hours); h <= Math.max(...hours); h++) {
      const entry = { hour: formatHourLabel(h), agents: 0, productivePct: null };
      const bucket = byHour.get(h);
      if (bucket) {
        const agentCount = bucket.agents.size;
        let totalSeconds = 0;
        let productiveSeconds = 0;
        for (const [code, seconds] of Object.entries(bucket.seconds)) {
          entry[code] = Number((seconds / 60 / agentCount).toFixed(2));
          totalSeconds += seconds;
          if (PRODUCTIVE_AUX_CODES.includes(code)) productiveSeconds += seconds;
        }
        entry.agents = agentCount;
        entry.productivePct = totalSeconds > 0 ? Number(((productiveSeconds / totalSeconds) * 100).toFixed(1)) : null;
      }
      data.push(entry);
    }
    // Same order as the aux breakdown chart, unknown codes last.
    const ordered = [...codes].sort((x, y) => {
      const ix = AUX_CODES.indexOf(x);
      const iy = AUX_CODES.indexOf(y);
      return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy);
    });
    return { hourlyAux: data, hourlyCodes: ordered };
  }, [filteredHourly]);

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

  const periodLabel = isLive ? 'Today' : range ? formatRangeLabel(range) : '';
  const hasData = filteredRows.some((r) => r.totalHours > 0 || r.scheduledHours > 0);

  return (
    <>
      <div className="dashboard-toolbar">
        <div className="dashboard-toolbar-left">
          <div className={`view-switch${isLive ? '' : ' is-historical'}`} role="tablist" aria-label="Dashboard view">
            <span className="view-switch-thumb" aria-hidden="true" />
            <button type="button" role="tab" aria-selected={isLive} className={isLive ? 'active' : ''} onClick={() => setView('live')}>
              <span className="live-dot" aria-hidden="true" />Live
            </button>
            <button type="button" role="tab" aria-selected={!isLive} className={isLive ? '' : 'active'} onClick={() => setView('historical')}>
              Historical
            </button>
          </div>
          <h2 style={{ margin: 0 }}>Dashboard</h2>
          <button
            type="button"
            className="help-button"
            onClick={() => setShowHelp(true)}
            aria-label="How are these numbers calculated?"
            title="How are these numbers calculated?"
          >
            ?
          </button>
        </div>

        <div className="dashboard-toolbar-right">
          {!isLive && (
            <>
              <select value={preset} onChange={(e) => setPreset(e.target.value)} style={selectStyle} aria-label="Date range">
                {HISTORICAL_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
              {preset === 'custom' && (
                <DateRangePicker value={customRange} onChange={setCustomRange} maxDate={today} />
              )}
            </>
          )}
          <select
            value={groupFilter}
            onChange={(e) => { setGroupFilter(e.target.value); setAgentFilter(''); }}
            style={selectStyle}
          >
            <option value="">All Groups</option>
            {groupOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            style={selectStyle}
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
          {!range ? (
            <p>Pick a start and end date to see the numbers.</p>
          ) : loading ? (
            <p>Loading...</p>
          ) : !hasData ? (
            <p>No data for {isLive ? 'today' : 'this date range'}{groupFilter || agentFilter ? ' / filter' : ''} yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <div className="dashboard-card" style={{ textAlign: 'center', flex: '1 1 240px' }}>
                  <h3 style={{ marginBottom: 4 }}>{periodLabel} Productive Hrs</h3>
                  {overallProductive == null ? (
                    <div style={{ fontSize: 16, color: '#999', padding: '14px 0' }}>
                      No scheduled time {isLive ? 'so far today' : 'in this date range'}.
                    </div>
                  ) : (
                    <div style={{ fontSize: 48, fontWeight: 700, color: getEfficiencyColor(overallProductive) }}>
                      {overallProductive.toFixed(1)}%
                    </div>
                  )}
                </div>

                <div className="dashboard-card" style={{ textAlign: 'center', flex: '1 1 240px' }}>
                  <h3 style={{ marginBottom: 4 }}>{periodLabel} Schedule Adherence</h3>
                  {overallAdherence == null ? (
                    <div style={{ fontSize: 16, color: '#999', padding: '14px 0' }}>
                      No scheduled time {isLive ? 'so far today' : 'in this date range'}.
                    </div>
                  ) : (
                    <div style={{ fontSize: 48, fontWeight: 700, color: getAdherenceColor(overallAdherence) }}>
                      {overallAdherence.toFixed(1)}%
                    </div>
                  )}
                </div>
              </div>

              {isLive ? (
                <>
                  <div className="dashboard-card">
                    <h3>Average Aux Time per Agent by Hour (Today)</h3>
                    {hourlyAux.length === 0 ? (
                      <p style={{ fontSize: 14, color: '#999' }}>No aux time recorded yet today.</p>
                    ) : (
                      <ResponsiveContainer width="100%" height={320}>
                        <BarChart data={hourlyAux} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                          <XAxis dataKey="hour" fontSize={12} />
                          <YAxis fontSize={12} domain={[0, 60]} ticks={[0, 15, 30, 45, 60]} tickFormatter={(v) => `${v}m`} />
                          <Tooltip
                            formatter={(value) => formatMinutes(value)}
                            labelFormatter={(label, payload) => {
                              const agents = payload?.[0]?.payload?.agents;
                              return agents ? `${label} · ${agents} agent${agents === 1 ? '' : 's'}` : label;
                            }}
                          />
                          <Legend wrapperStyle={{ fontSize: 12 }} />
                          {hourlyCodes.map((code) => (
                            <Bar key={code} dataKey={code} stackId="aux" name={code} fill={AUX_COLORS[code] || '#9ca3af'} />
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>

                  <div className="dashboard-card">
                    <h3>Productive Share by Hour (Today)</h3>
                    {hourlyAux.length === 0 ? (
                      <p style={{ fontSize: 14, color: '#999' }}>No aux time recorded yet today.</p>
                    ) : (
                      <ResponsiveContainer width="100%" height={260}>
                        <LineChart data={hourlyAux} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                          <XAxis dataKey="hour" fontSize={12} />
                          <YAxis domain={[0, 100]} unit="%" fontSize={12} />
                          <Tooltip formatter={(value) => `${value}%`} />
                          <Line
                            type="monotone"
                            dataKey="productivePct"
                            stroke="#1e3a8a"
                            strokeWidth={2}
                            dot={{ r: 3 }}
                            connectNulls
                            name="Productive Share %"
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </>
              ) : (
                <>
                <div className="dashboard-card">
                  <h3>Productive Hrs Trend</h3>
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={productiveTrend} margin={{ top: 5, right: 20, left: 0, bottom: 24 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="day" label={{ value: 'Day', position: 'insideBottom', offset: -14 }} fontSize={12} />
                      <YAxis domain={[0, 100]} unit="%" fontSize={12} />
                      <Tooltip formatter={(value) => `${value}%`} />
                      <Line type="monotone" dataKey="productive" stroke="#1e3a8a" strokeWidth={2} dot={{ r: 3 }} name="Productive Hrs %" />
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
                </>
              )}
            </div>
          )}
        </div>

        {isLive && (
          <div className="dashboard-side">
            <LiveAgentsPanel groupFilter={groupFilter} agentFilter={agentFilter} />
          </div>
        )}
      </div>

      {showHelp && <MetricsHelpModal onClose={() => setShowHelp(false)} />}

      {show2FAModal && (
        <Setup2FAModal
          onClose={() => setShow2FAModal(false)}
          onComplete={() => { refreshUser(); setShow2FAModal(false); }}
        />
      )}
    </>
  );
}
