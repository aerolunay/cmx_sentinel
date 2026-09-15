import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import GroupFormModal from '../modals/GroupFormModal.jsx';

export default function GroupsPage() {
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
        <button className="btn" onClick={() => setModalGroup(null)}>+ Add Group</button>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Group Name</th>
              <th>Restrictions</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr><td colSpan={3}>No groups yet.</td></tr>
            ) : (
              groups.map((g) => (
                <tr key={g.group_id}>
                  <td><Link to={`/groups/${g.group_id}`}>{g.group_name}</Link></td>
                  <td>{g.restriction_count}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn-link" onClick={() => setModalGroup(g)}>Rename</button>
                    {' | '}
                    <button className="btn-link" onClick={() => handleDelete(g)}>Delete</button>
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
