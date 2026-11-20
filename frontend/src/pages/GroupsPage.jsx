import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import GroupFormModal from '../modals/GroupFormModal.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { isReadOnlyRole } from '../utils/roles.js';

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
    const key = `${group.group_id}:${column}`;
    setError('');
    setSavingKey(key);
    setGroups((gs) => gs.map((g) => (g.group_id === group.group_id ? { ...g, [column]: next } : g)));
    try {
      await api.updateGroup(group.group_id, group.group_name, { [bodyKey]: next });
    } catch (err) {
      setGroups((gs) => gs.map((g) => (g.group_id === group.group_id ? { ...g, [column]: !next } : g)));
      setError(`Could not update "${group.group_name}": ${err.message}`);
    } finally {
      setSavingKey(null);
    }
  }

  function FlagCell({ group, column, bodyKey, label }) {
    const checked = group[column] !== false;
    return (
      <td style={{ textAlign: 'center' }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={readOnly || savingKey === `${group.group_id}:${column}`}
          onChange={() => handleToggle(group, column, bodyKey)}
          title={`${label} ${checked ? 'enabled' : 'disabled'} for ${group.group_name}`}
          aria-label={`${label} for ${group.group_name}`}
          style={{ width: 'auto', margin: 0, cursor: readOnly ? 'default' : 'pointer' }}
        />
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
              <th style={{ textAlign: 'center' }}>Recordings</th>
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
                  <FlagCell group={g} column="recording_enabled" bodyKey="recordingEnabled" label="Recordings" />
                  <FlagCell group={g} column="monitoring_enabled" bodyKey="monitoringEnabled" label="Monitoring" />
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
