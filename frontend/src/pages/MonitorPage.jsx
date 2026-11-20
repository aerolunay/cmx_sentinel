import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import LiveMonitorModal from '../modals/LiveMonitorModal.jsx';

const REFRESH_MS = 10000;

function formatSince(isoString, now) {
  const seconds = Math.max(0, Math.floor((now - new Date(isoString).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function unavailableReason(agent) {
  if (!agent.connected) return 'The agent\'s PC isn\'t connected to Sentinel right now.';
  if (!agent.supported) return `Needs Sentinel 2.4.16 or later on the PC (has ${agent.appVersion || 'unknown'}).`;
  return null;
}

// Agents logged in to Sentinel desktop and in Production, in groups with
// monitoring enabled - with a live view of each.
export default function MonitorPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [watching, setWatching] = useState(null);
  const [search, setSearch] = useState('');
  const loadRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.listMonitorAgents();
        if (cancelled) return;
        setAgents(data);
        setError('');
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadRef.current = load;
    load();
    const refresh = setInterval(load, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      cancelled = true;
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, []);

  // The server ends the session ~3s after the viewer closes - refresh
  // just after that so the red dot goes away without waiting for the
  // next 10s refresh.
  function stopWatching() {
    setWatching(null);
    setTimeout(() => loadRef.current && loadRef.current(), 4000);
  }

  const term = search.trim().toLowerCase();
  const shown = term
    ? agents.filter((a) => [a.displayName, a.agentId, a.groupName, a.machineName]
      .some((v) => String(v || '').toLowerCase().includes(term)))
    : agents;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>Monitor</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#666' }}>
            Agents logged in to Sentinel desktop and in Production, in groups with monitoring enabled.
          </p>
        </div>
        <input
          type="search"
          placeholder="Search name, ID, group or PC"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 260 }}
        />
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Group</th>
              <th>PC</th>
              <th>In Production</th>
              <th>Sentinel</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr><td colSpan={6}>{term ? 'No agents match.' : 'No agents are in Production right now.'}</td></tr>
            ) : (
              shown.map((a) => {
                const reason = unavailableReason(a);
                return (
                  <tr key={a.agentId}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {a.beingMonitored && (
                          <span
                            className="live-dot"
                            title="Active monitoring in progress"
                            aria-label="Active monitoring in progress"
                            role="img"
                          />
                        )}
                        {a.displayName}
                      </div>
                      <div style={{ fontSize: 12, color: '#666' }}>{a.agentId}</div>
                    </td>
                    <td>{a.groupName}</td>
                    <td>{a.machineName}</td>
                    <td>{formatSince(a.productionSinceUtc, now)}</td>
                    <td>{a.appVersion || '-'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        className="btn"
                        onClick={() => setWatching(a)}
                        disabled={Boolean(reason)}
                        title={reason || 'Watch this agent\'s screen and listen to their PC audio live'}
                      >
                        Live monitoring
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      )}

      {watching && <LiveMonitorModal agent={watching} onClose={stopWatching} />}
    </>
  );
}
