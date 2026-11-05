import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Agent PCs and the CMX Sentinel Desktop version each runs (Desktop
// Updates page). 2.3.10+ reports itself; older PCs are listed from
// their recent activity as "2.3.9 or older".

const inputStyle = { padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 };

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let n = 0; n < 3; n++) if (pa[n] !== pb[n]) return pa[n] < pb[n] ? -1 : 1;
  return 0;
}

function formatSeen(value) {
  if (!value) return '';
  const ms = Date.now() - new Date(value).getTime();
  const min = Math.round(ms / 60000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function statusOf(pc, latest) {
  if (!pc.reported) return { label: 'Needs update (2.3.9 or older)', color: '#b91c1c', rank: 0 };
  if (!latest) return { label: pc.version, color: '#374151', rank: 2 };
  const cmp = compareVersions(pc.version, latest);
  if (cmp >= 0) return { label: 'Up to date', color: '#047857', rank: 2 };
  return { label: 'Update pending', color: '#c2660a', rank: 1 };
}

export default function DesktopClientsCard({ latestVersion }) {
  const [pcs, setPcs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [onlyOutdated, setOnlyOutdated] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setPcs(await api.getDesktopClients());
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const rows = useMemo(() => pcs
    .map((pc) => ({ ...pc, status: statusOf(pc, latestVersion) }))
    .filter((pc) => !onlyOutdated || pc.status.rank < 2)
    .filter((pc) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return [pc.machineName, pc.agentName, pc.agentId, pc.version].some((v) => v && String(v).toLowerCase().includes(q));
    })
    .sort((a, b) => a.status.rank - b.status.rank || a.machineName.localeCompare(b.machineName)),
  [pcs, latestVersion, search, onlyOutdated]);

  const byVersion = useMemo(() => {
    const counts = new Map();
    for (const pc of pcs) {
      const key = pc.reported ? pc.version : '2.3.9 or older';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => {
      if (a[0] === '2.3.9 or older') return 1;
      if (b[0] === '2.3.9 or older') return -1;
      return compareVersions(b[0], a[0]);
    });
  }, [pcs]);

  return (
    <div className="dashboard-card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ margin: 0 }}>Agent PCs</h3>
        <button type="button" className="btn-secondary" onClick={load} disabled={loading}>Refresh</button>
      </div>
      <p style={{ fontSize: 13, color: '#555' }}>
        The version each PC runs. PCs on 2.3.10 or newer report themselves while they are on; older PCs are listed
        from their activity in the last 30 days and update to the published version at their next logout.
      </p>
      {error && <div className="error">{error}</div>}

      {byVersion.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {byVersion.map(([version, count]) => (
            <span key={version} style={{
              fontSize: 13, padding: '4px 10px', borderRadius: 999,
              background: version === latestVersion ? '#ecfdf5' : '#f3f4f6',
              color: version === latestVersion ? '#065f46' : '#374151',
              border: '1px solid #e5e7eb',
            }}>
              <strong>{version}</strong>: {count} {count === 1 ? 'PC' : 'PCs'}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search PC, agent or version" style={{ ...inputStyle, width: 260 }} />
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={onlyOutdated} onChange={(e) => setOnlyOutdated(e.target.checked)} />
          Only PCs that still need the update
        </label>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 14 }}>{pcs.length === 0 ? 'No PCs have been seen yet.' : 'No PCs match.'}</p>
      ) : (
        <div className="report-table-wrap" style={{ maxHeight: 480, overflowY: 'auto' }}>
          <table className="report-table">
            <thead>
              <tr><th>PC</th><th>Version</th><th>Status</th><th>Last Agent</th><th>Location</th><th>Last Seen</th></tr>
            </thead>
            <tbody>
              {rows.map((pc) => (
                <tr key={pc.machineName}>
                  <td>{pc.machineName}</td>
                  <td>{pc.version || <em style={{ color: '#999' }}>2.3.9 or older</em>}</td>
                  <td style={{ fontWeight: 600, color: pc.status.color }}>{pc.status.label}</td>
                  <td>{pc.agentName ? `${pc.agentName} (${pc.agentId})` : pc.agentId || ''}</td>
                  <td>{pc.workSetup === 'remote' ? 'Remote' : pc.workSetup === 'onsite' ? 'Onsite' : ''}</td>
                  <td title={pc.lastSeenAt ? new Date(pc.lastSeenAt).toLocaleString() : ''}>{formatSeen(pc.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
