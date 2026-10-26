import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import {
  AUX_COLORS, LIVE_STATE_ORDER, getEfficiencyColor, getAdherenceColor, formatDuration, formatAuxLabel, liveStateRank,
} from '../utils/metrics.js';
import LiveAgentDetailModal from '../modals/LiveAgentDetailModal.jsx';
import AuxMultiSelect from './AuxMultiSelect.jsx';

const REFRESH_MS = 5000;

// States of agents who aren't on the desktop app right now - listed in
// the second card, not in Live Agent Status.
const NOT_ON_STATES = new Set(['LoggedOut', 'NotLoggedIn', 'Scheduled']);

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Oct 26, 8:05 AM" from an Eastern "YYYY-MM-DD HH:MM:SS" string -
// string parsing, not Date, so it stays Eastern in any viewer timezone.
function formatDateTime(sqlString) {
  const [date, time] = sqlString.split(' ');
  const [, month, day] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}, ${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

function AgentCell({ agent, onOpen }) {
  return (
    <td className="live-agents-name" title="Double-click for details" onDoubleClick={() => onOpen(agent.agentId)}>
      <div>{agent.displayName}</div>
      <div className="live-agents-group">
        {agent.agentId}
        {agent.groupName && ` · ${agent.groupName}`}
      </div>
    </td>
  );
}

// Two cards from one 5s poll (paused while the browser tab is hidden):
// - Live Agent Status: agents logged in to the desktop app right now,
//   sorted by state (see LIVE_STATE_ORDER) and then longest in that state
//   first; the aux duration counts up locally between polls.
// - Not Logged In: agents who logged out earlier today ("Logged Out")
//   and agents scheduled today who haven't logged in ("No Log In"), with
//   when they last logged in.
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

  // Group/agent filters first - the headcount badges and the per-state
  // counts in the aux filter use this, so they don't change as states
  // are ticked/unticked.
  const scopedAgents = useMemo(() => agents.filter((a) => {
    if (groupFilter && String(a.groupId) !== groupFilter) return false;
    if (agentFilter && String(a.agentId) !== agentFilter) return false;
    return true;
  }), [agents, groupFilter, agentFilter]);

  const onlineAgents = useMemo(() => scopedAgents
    .filter((a) => !NOT_ON_STATES.has(a.auxCode))
    .sort((a, b) => liveStateRank(a.auxCode) - liveStateRank(b.auxCode)
      || b.auxSeconds - a.auxSeconds
      || a.displayName.localeCompare(b.displayName)), [scopedAgents]);
  const visibleAgents = useMemo(
    () => onlineAgents.filter((a) => !hiddenStates.has(a.auxCode)),
    [onlineAgents, hiddenStates]
  );

  // No Log In first (they count against adherence), then Logged Out.
  const offlineAgents = useMemo(() => scopedAgents
    .filter((a) => NOT_ON_STATES.has(a.auxCode))
    .sort((a, b) => (a.auxCode === 'LoggedOut') - (b.auxCode === 'LoggedOut')
      || a.displayName.localeCompare(b.displayName)), [scopedAgents]);
  const noLoginCount = offlineAgents.filter((a) => a.auxCode !== 'LoggedOut').length;

  // Every known logged-in state, plus any unknown one an agent is in right now.
  const stateCounts = useMemo(() => {
    const counts = {};
    for (const a of onlineAgents) counts[a.auxCode] = (counts[a.auxCode] || 0) + 1;
    return counts;
  }, [onlineAgents]);
  const stateOptions = useMemo(
    () => [...new Set([...LIVE_STATE_ORDER, ...Object.keys(stateCounts)])]
      .filter((code) => !NOT_ON_STATES.has(code))
      .sort((x, y) => liveStateRank(x) - liveStateRank(y)),
    [stateCounts]
  );

  const elapsed = Math.max(0, Math.floor((now - fetchedAt) / 1000));

  return (
    <>
      <div className="dashboard-card live-agents">
        <div className="live-agents-head">
          <h3>
            Live Agent Status
            {!loading && <span className="live-agents-count">{onlineAgents.length} logged in</span>}
          </h3>
          <AuxMultiSelect options={stateOptions} hidden={hiddenStates} onChange={setHiddenStates} counts={stateCounts} />
        </div>

        {error && <div className="error">{error}</div>}

        {loading ? (
          <p style={{ fontSize: 14 }}>Loading...</p>
        ) : onlineAgents.length === 0 ? (
          <p style={{ fontSize: 14, color: '#999' }}>No agents logged in right now.</p>
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
                    <AgentCell agent={a} onOpen={setDetailAgentId} />
                    <td>
                      <span className="aux-badge" style={{ background: AUX_COLORS[a.auxCode] || '#6b7280' }}>
                        {formatAuxLabel(a.auxCode)}
                      </span>
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDuration(a.auxSeconds + elapsed)}</td>
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
      </div>

      <div className="dashboard-card live-agents">
        <div className="live-agents-head">
          <h3>
            Not Logged In
            {!loading && (
              <span className="live-agents-count" title={`${noLoginCount} no log in, ${offlineAgents.length - noLoginCount} logged out`}>
                {offlineAgents.length}
              </span>
            )}
          </h3>
        </div>

        {loading ? (
          <p style={{ fontSize: 14 }}>Loading...</p>
        ) : offlineAgents.length === 0 ? (
          <p style={{ fontSize: 14, color: '#999' }}>Everyone scheduled today is logged in.</p>
        ) : (
          <div className="live-agents-scroll">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Last Log In</th>
                </tr>
              </thead>
              <tbody>
                {offlineAgents.map((a) => (
                  <tr key={a.agentId}>
                    <AgentCell agent={a} onOpen={setDetailAgentId} />
                    <td>
                      {a.auxCode === 'LoggedOut' ? (
                        <span className="aux-badge" style={{ background: AUX_COLORS.LoggedOut }}>Logged Out</span>
                      ) : (
                        <span className="aux-badge" style={{ background: AUX_COLORS.NotLoggedIn }}>No Log In</span>
                      )}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {a.lastLoginAt ? formatDateTime(a.lastLoginAt) : <em style={{ color: '#999' }}>Never</em>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detailAgentId && (
        <LiveAgentDetailModal agentId={detailAgentId} onClose={() => setDetailAgentId(null)} />
      )}
    </>
  );
}
