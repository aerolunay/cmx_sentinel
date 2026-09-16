import { useEffect, useState } from 'react';
import { api } from '../api.js';

function formatWhen(isoString) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(isoString));
}

export default function ViolationsPage() {
  const [violations, setViolations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listViolations()
      .then(setViolations)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <h2>Restriction Violations</h2>
      <p style={{ fontSize: 13, color: '#666', marginTop: -8 }}>
        Attempts to visit a restricted site - each one also triggers an email alert. Most recent 500.
      </p>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Agent</th>
              <th>Group</th>
              <th>Site</th>
            </tr>
          </thead>
          <tbody>
            {violations.length === 0 ? (
              <tr><td colSpan={4}>No violations recorded.</td></tr>
            ) : (
              violations.map((v) => (
                <tr key={v.violation_id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatWhen(v.blocked_at)}</td>
                  <td>{v.display_name || v.agent_id}</td>
                  <td>{v.group_name || <em style={{ color: '#999' }}>none</em>}</td>
                  <td><code>{v.domain}{v.path}</code></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </>
  );
}
