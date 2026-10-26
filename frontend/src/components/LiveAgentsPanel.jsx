import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import {
  AUX_COLORS, LIVE_STATE_ORDER, getEfficiencyColor, getAdherenceColor, formatDuration, formatAuxLabel, liveStateRank,
} from '../utils/metrics.js';
import LiveAgentDetailModal from '../modals/LiveAgentDetailModal.jsx';
import AuxMultiSelect from './AuxMultiSelect.jsx';

const REFRESH_MS = 5000;

const NOT_ON_STATES = new Set(['LoggedOut', 'NotLoggedIn', 'Scheduled']);

// "2:00 PM" from an Eastern "YYYY-MM-DD HH:MM:SS" string - string
// parsing, not Date, so it stays Eastern in any viewer timezone.
function formatClock(sqlString) {
  const [hh, mm] = sqlString.slice(11, 16).split(':').map(Number);
  return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

// Agents on the Sentinel desktop app today - logged in, or logged out
// earlier today (aux "LoggedOut") - plus agents scheduled today who
// haven't logged in ("NotLoggedIn" once the shift has started,
// "Scheduled" before it), sorted by state (see
// LIVE_STATE_ORDER) and then longest in that state first. Reloaded from
// the server every 5s (paused while the browser tab is hidden, so idle
// tabs don't keep querying); in between, the aux duration counts up
// locally from when the data was fetched so it doesn't sit frozen.
export default function LiveAgentsPanel({ groupFilter, agentFilter }) {
  const [agents, setAgents] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detailAgentId, setDetailAgentId] = useState(null);
  // Aux states unticked in the filter - empty means all are shown.
  const [hiddenStates, setHiddenStates] = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.listLiveAgents();
        if (cancelled) return;
        setAgents(data);
        setFetchedAt(Date.now());
        setError('');
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    function onVisibilityChange() {
      if (!document.hidden) load();
    }
    load();
    const refresh = setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      clearInterval(refresh);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  // Group/agent filters first - the headcount badge and the per-state
  // counts in the aux filter use this, so they don't change as states
  // are ticked/unticked.
  const scopedAgents = useMemo(() => agents
    .filter((a) => {
      if (groupFilter && String(a.groupId) !== groupFilter) return false;
      if (agentFilter && String(a.agentId) !== agentFilter) return false;
      return true;
    })
    .sort((a, b) => liveStateRank(a.auxCode) - liveStateRank(b.auxCode)
      || b.auxSeconds - a.auxSeconds
      || a.displayName.localeCompare(b.displayName)), [agents, groupFilter, agentFilter]);
  const visibleAgents = useMemo(
    () => scopedAgents.filter((a) => !hiddenStates.has(a.auxCode)),
    [scopedAgents, hiddenStates]
  );
  const loggedInCount = scopedAgents.filter((a) => !NOT_ON_STATES.has(a.auxCode)).length;
  const loggedOutCount = scopedAgents.filter((a) => a.auxCode === 'LoggedOut').length;
  const notLoggedInCount = scopedAgents.filter((a) => a.auxCode === 'NotLoggedIn').length;
  const upcomingCount = scopedAgents.filter((a) => a.auxCode === 'Scheduled').length;

  // Every known state, plus any unknown one an agent is in right now.
  const stateCounts = useMemo(() => {
    const counts = {};
    for (const a of scopedAgents) counts[a.auxCode] = (counts[a.auxCode] || 0) + 1;
    return counts;
  }, [scopedAgents]);
  const stateOptions = useMemo(
    () => [...new Set([...LIVE_STATE_ORDER, ...Object.keys(stateCounts)])]
      .sort((x, y) => liveStateRank(x) - liveStateRank(y)),
    [stateCounts]
  );

  const elapsed = Math.max(0, Math.floor((now - fetchedAt) / 1000));

  return (
    <div className="dashboard-card live-agents">
      <div className="live-agents-head">
        <h3>
          Live Agent Status
          {!loading && (
            <span
              className="live-agents-count"
              title={`${loggedInCount} logged in, ${loggedOutCount} logged out, ${notLoggedInCount} scheduled but not logged in, ${upcomingCount} shift not started yet`}
            >
              {loggedInCount} logged in
              {notLoggedInCount > 0 && <span style={{ color: '#b91c1c' }}> · {notLoggedInCount} not logged in</span>}
            </span>
          )}
        </h3>
        <AuxMultiSelect options={stateOptions} hidden={hiddenStates} onChange={setHiddenStates} counts={stateCounts} />
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p style={{ fontSize: 14 }}>Loading...</p>
      ) : scopedAgents.length === 0 ? (
        <p style={{ fontSize: 14, color: '#999' }}>No agent activity yet today.</p>
      ) : visibleAgents.length === 0 ? (
        <p style={{ fontSize: 14, color: '#999' }}>No agents in the selected states.</p>
      ) : (
        <div className="live-agents-scroll">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Aux</th>
                <th>Time</th>
                <th title="Productive Hrs % for the current shift">Prod</th>
                <th title="Adherence to schedule so far this shift">Adh</th>
              </tr>
            </thead>
            <tbody>
              {visibleAgents.map((a) => (
                <tr key={a.agentId}>
                  <td
                    className="live-agents-name"
                    title="Double-click for details"
                    onDoubleClick={() => setDetailAgentId(a.agentId)}
                  >
                    <div>{a.displayName}</div>
                    {a.groupName && <div className="live-agents-group">{a.groupName}</div>}
                  </td>
                  <td>
                    <span className="aux-badge" style={{ background: AUX_COLORS[a.auxCode] || '#6b7280' }}>
                      {formatAuxLabel(a.auxCode)}
                    </span>
                  </td>
                  <td
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                    title={a.auxCode === 'NotLoggedIn' ? `Since scheduled start, ${formatClock(a.scheduledStart)}` : undefined}
                  >
                    {a.auxCode === 'Scheduled' ? `Starts ${formatClock(a.scheduledStart)}` : formatDuration(a.auxSeconds + elapsed)}
                  </td>
                  <td style={a.efficiencyPct == null ? undefined : { fontWeight: 600, color: getEfficiencyColor(a.efficiencyPct) }}>
                    {a.efficiencyPct == null ? 'N/A' : `${a.efficiencyPct.toFixed(2)}%`}
                  </td>
                  <td style={a.adherencePct == null ? undefined : { fontWeight: 600, color: getAdherenceColor(a.adherencePct) }}>
                    {a.adherencePct == null ? 'N/A' : `${a.adherencePct.toFixed(2)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailAgentId && (
        <LiveAgentDetailModal agentId={detailAgentId} onClose={() => setDetailAgentId(null)} />
      )}
    </div>
  );
}
