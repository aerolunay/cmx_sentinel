import { useEffect, useState } from 'react';
import { api } from '../api.js';

function formatWhen(isoString) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(isoString));
}

export default function AuditLogPage() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listAuditLog()
      .then(setEntries)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <h2>Audit Log</h2>
      <p style={{ fontSize: 13, color: '#666', marginTop: -8 }}>
        Credential, group, and restriction changes - most recent 500 entries.
      </p>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Type</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr><td colSpan={5}>No audit entries yet.</td></tr>
            ) : (
              entries.map((e) => (
                <tr key={e.log_id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatWhen(e.created_at)}</td>
                  <td>{e.actor_display_name}</td>
                  <td style={{ textTransform: 'capitalize' }}>{e.action}</td>
                  <td>{e.entity_type.replace('_', ' ')}</td>
                  <td>{e.details}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </>
  );
}
