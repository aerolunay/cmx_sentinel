import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

function formatWhen(isoString) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(isoString));
}

export default function ViolationsPage() {
  const { user } = useAuth();
  // Only Super Admin can turn alerts on/off (enforced server-side too);
  // Admin sees the current state read-only.
  const canToggleAlerts = user?.role === 'super_admin';
  const [violations, setViolations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [alertEmails, setAlertEmails] = useState(null); // null = not loaded yet
  const [savingAlerts, setSavingAlerts] = useState(false);

  useEffect(() => {
    api.listViolations()
      .then(setViolations)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    api.getViolationSettings()
      .then((s) => setAlertEmails(s.alertEmails))
      .catch((err) => setError(err.message));
  }, []);

  async function handleToggleAlerts() {
    const next = !alertEmails;
    if (!next && !window.confirm('Turn off violation email alerts? Violations will still be recorded on this page.')) {
      return;
    }
    setError('');
    setSavingAlerts(true);
    try {
      const saved = await api.setViolationAlertEmails(next);
      setAlertEmails(saved.alertEmails);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingAlerts(false);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Restriction Violations</h2>
        {alertEmails !== null && (
          <label className="toggle" title={canToggleAlerts ? undefined : 'Only Super Admin can change this.'}>
            <input
              type="checkbox"
              checked={alertEmails}
              disabled={!canToggleAlerts || savingAlerts}
              onChange={handleToggleAlerts}
            />
            <span className="toggle-track" aria-hidden="true" />
            <span>Email alerts {alertEmails ? 'on' : 'off'}</span>
          </label>
        )}
      </div>
      <p style={{ fontSize: 13, color: '#666', marginTop: 0 }}>
        Attempts to visit a restricted site
        {alertEmails === false
          ? ' - email alerts are off, so these are only recorded here.'
          : ' - each one also emails every Admin and Super Admin.'}
        {' '}Most recent 500.
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
