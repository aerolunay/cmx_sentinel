import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { AUX_COLORS, getEfficiencyColor, getAdherenceColor } from '../utils/metrics.js';

const REFRESH_MS = 5000;

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Agents currently logged in to the Sentinel desktop app. Reloaded from
// the server every 5s (paused while the browser tab is hidden, so idle
// tabs don't keep querying); in between, the aux duration counts up
// locally from when the data was fetched so it doesn't sit frozen.
export default function LiveAgentsPanel({ groupFilter, agentFilter }) {
  const [agents, setAgents] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  const visibleAgents = useMemo(() => agents.filter((a) => {
    if (groupFilter && String(a.groupId) !== groupFilter) return false;
    if (agentFilter && String(a.agentId) !== agentFilter) return false;
    return true;
  }), [agents, groupFilter, agentFilter]);

  const elapsed = Math.max(0, Math.floor((now - fetchedAt) / 1000));

  return (
    <div className="dashboard-card live-agents">
      <h3>
        Logged In Agents
        {!loading && <span className="live-agents-count">{visibleAgents.length}</span>}
      </h3>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p style={{ fontSize: 14 }}>Loading...</p>
      ) : visibleAgents.length === 0 ? (
        <p style={{ fontSize: 14, color: '#999' }}>No agents logged in right now.</p>
      ) : (
        <div className="live-agents-scroll">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Aux</th>
                <th>Time</th>
                <th title="Efficiency for the current shift">Eff</th>
                <th title="Adherence to schedule so far this shift">Adh</th>
              </tr>
            </thead>
            <tbody>
              {visibleAgents.map((a) => (
                <tr key={a.agentId}>
                  <td>
                    <div>{a.displayName}</div>
                    {a.groupName && <div className="live-agents-group">{a.groupName}</div>}
                  </td>
                  <td>
                    <span className="aux-badge" style={{ background: AUX_COLORS[a.auxCode] || '#6b7280' }}>
                      {a.auxCode}
                    </span>
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDuration(a.auxSeconds + elapsed)}</td>
                  <td style={a.efficiencyPct == null ? undefined : { fontWeight: 600, color: getEfficiencyColor(a.efficiencyPct) }}>
                    {a.efficiencyPct == null ? '-' : `${a.efficiencyPct.toFixed(1)}%`}
                  </td>
                  <td style={a.adherencePct == null ? undefined : { fontWeight: 600, color: getAdherenceColor(a.adherencePct) }}>
                    {a.adherencePct == null ? 'N/A' : `${a.adherencePct.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
