import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import GroupFormModal from '../modals/GroupFormModal.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { isReadOnlyRole } from '../utils/roles.js';

const MAX_RETENTION_HOURS = 87600;

// Hours a group's recordings stay in S3 (saved when the box loses focus
// or on Enter). 0 and disabled while the group's recordings are off.
function RetentionHoursInput({ group, disabled, onSave }) {
  const hours = group.recording_retention_hours ?? 0;
  const [draft, setDraft] = useState(String(hours));
  useEffect(() => setDraft(String(hours)), [hours]);

  function commit() {
    const n = Number(draft);
    if (String(n) === String(hours)) return;
    if (!Number.isInteger(n) || n < 1 || n > MAX_RETENTION_HOURS) {
      setDraft(String(hours));
      onSave(null, `Enter a whole number of hours from 1 to ${MAX_RETENTION_HOURS.toLocaleString()}.`);
      return;
    }
    onSave(n);
  }

  const off = group.recording_enabled === false;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        type="number"
        min={1}
        max={MAX_RETENTION_HOURS}
        step={1}
        value={off ? '0' : draft}
        disabled={disabled || off}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        aria-label={`Hours to keep recordings for ${group.group_name}`}
        title={off ? 'Recordings are off - nothing is kept' : 'How many hours recordings are kept before they are deleted'}
        style={{ width: 78, margin: 0, padding: '2px 6px' }}
      />
      <span style={{ fontSize: 12, color: '#666' }}>h</span>
    </span>
  );
}

// "90 days" next to 2160 h, for whole days of 2 or more.
function describeHours(hours) {
  if (hours && hours % 24 === 0 && hours >= 48) return `${hours / 24} days`;
  return '';
}

export default function GroupsPage() {
  const { user } = useAuth();
  const readOnly = isReadOnlyRole(user?.role);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalGroup, setModalGroup] = useState(undefined); // undefined = closed, null = add, object = edit

  useEffect(() => {
    loadGroups();
  }, []);

  async function loadGroups() {
    setLoading(true);
    setError('');
    try {
      const data = await api.listGroups();
      setGroups(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Ticking Recordings / Monitoring in the table saves straight away.
  // Shown ticked at once; put back if the save fails. Recording changes
  // reach an agent at their next desktop login; turning monitoring off
  // ends any live view of the group's agents right away.
  const [savingKey, setSavingKey] = useState(null);

  async function handleToggle(group, column, bodyKey) {
    const next = !group[column];
    if (column === 'recording_enabled' && !next && !window.confirm(
      `Turn recordings off for "${group.group_name}"? Agents in this group stop being recorded at their next login, `
      + 'and its recordings already in storage are deleted at the next clean-up (kept for 0 hours).'
    )) {
      return;
    }
    const key = `${group.group_id}:${column}`;
    setError('');
    setSavingKey(key);
    setGroups((gs) => gs.map((g) => (g.group_id === group.group_id ? { ...g, [column]: next } : g)));
    try {
      const saved = await api.updateGroup(group.group_id, group.group_name, { [bodyKey]: next });
      // The server sets the hours (0 when off; the previous hours or 24 when on).
      setGroups((gs) => gs.map((g) => (g.group_id === group.group_id
        ? { ...g, recording_retention_hours: saved.recording_retention_hours ?? g.recording_retention_hours }
        : g)));
    } catch (err) {
      setGroups((gs) => gs.map((g) => (g.group_id === group.group_id ? { ...g, [column]: !next } : g)));
      setError(`Could not update "${group.group_name}": ${err.message}`);
    } finally {
      setSavingKey(null);
    }
  }

  async function handleHours(group, hours, problem) {
    setError('');
    if (problem) {
      setError(`"${group.group_name}": ${problem}`);
      return;
    }
    const key = `${group.group_id}:recording_retention_hours`;
    setSavingKey(key);
    try {
      const saved = await api.updateGroup(group.group_id, group.group_name, { recordingRetentionHours: hours });
      setGroups((gs) => gs.map((g) => (g.group_id === group.group_id
        ? { ...g, recording_retention_hours: saved.recording_retention_hours }
        : g)));
    } catch (err) {
      setError(`Could not update "${group.group_name}": ${err.message}`);
    } finally {
      setSavingKey(null);
    }
  }

  // Called as a function, not rendered as <FlagCell/>: a component
  // defined inside this one would remount on every render.
  function flagCell(group, column, bodyKey, label, extra = null) {
    const checked = group[column] !== false;
    return (
      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={readOnly || savingKey === `${group.group_id}:${column}`}
          onChange={() => handleToggle(group, column, bodyKey)}
          title={`${label} ${checked ? 'enabled' : 'disabled'} for ${group.group_name}`}
          aria-label={`${label} for ${group.group_name}`}
          style={{ width: 'auto', margin: 0, cursor: readOnly ? 'default' : 'pointer', verticalAlign: 'middle' }}
        />
        {extra}
      </td>
    );
  }

  async function handleDelete(group) {
    if (!window.confirm(
      `Delete "${group.group_name}"? This also deletes its ${group.restriction_count} restriction(s). Agents assigned to it will become unassigned, not deleted.`
    )) {
      return;
    }
    setError('');
    try {
      await api.deleteGroup(group.group_id);
      loadGroups();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Groups &amp; Restrictions</h2>
        {!readOnly && <button className="btn" onClick={() => setModalGroup(null)}>+ Add Group</button>}
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Group ID</th>
              <th>Group Name</th>
              <th>Restrictions</th>
              <th style={{ textAlign: 'center' }}>Recordings (kept for)</th>
              <th style={{ textAlign: 'center' }}>Monitoring</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr><td colSpan={6}>No groups yet.</td></tr>
            ) : (
              groups.map((g) => (
                <tr key={g.group_id}>
                  <td>{g.group_id}</td>
                  <td><Link to={`/groups/${g.group_id}`}>{g.group_name}</Link></td>
                  <td>{g.restriction_count}</td>
                  {flagCell(g, 'recording_enabled', 'recordingEnabled', 'Recordings', (
                    <span style={{ marginLeft: 10 }}>
                      <RetentionHoursInput
                        group={g}
                        disabled={readOnly || savingKey === `${g.group_id}:recording_retention_hours`}
                        onSave={(hours, problem) => handleHours(g, hours, problem)}
                      />
                      {describeHours(g.recording_retention_hours) && (
                        <span style={{ fontSize: 11, color: '#888', marginLeft: 4 }}>
                          ({describeHours(g.recording_retention_hours)})
                        </span>
                      )}
                    </span>
                  ))}
                  {flagCell(g, 'monitoring_enabled', 'monitoringEnabled', 'Monitoring')}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!readOnly && (
                      <>
                        <button className="btn-link" onClick={() => setModalGroup(g)}>Edit</button>
                        {' | '}
                        <button className="btn-link" onClick={() => handleDelete(g)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {modalGroup !== undefined && (
        <GroupFormModal
          existingGroup={modalGroup}
          onClose={() => setModalGroup(undefined)}
          onSaved={loadGroups}
        />
      )}
    </>
  );
}
