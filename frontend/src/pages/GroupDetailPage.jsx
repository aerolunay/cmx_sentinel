import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import RestrictionFormModal from '../modals/RestrictionFormModal.jsx';

export default function GroupDetailPage() {
  const { groupId } = useParams();
  const [groups, setGroups] = useState([]);
  const [restrictions, setRestrictions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalRestriction, setModalRestriction] = useState(undefined); // undefined = closed, null = add, object = edit

  const group = groups.find((g) => String(g.group_id) === groupId);

  useEffect(() => {
    load();
  }, [groupId]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [groupsData, restrictionsData] = await Promise.all([
        api.listGroups(),
        api.listRestrictions(groupId),
      ]);
      setGroups(groupsData);
      setRestrictions(restrictionsData);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(restriction) {
    if (!window.confirm(`Remove restriction on ${restriction.domain}${restriction.path_prefix}?`)) return;
    setError('');
    try {
      await api.deleteRestriction(groupId, restriction.restriction_id);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <p><Link to="/groups">&larr; Back to Groups</Link></p>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{group ? group.group_name : 'Group'} - Restrictions</h2>
        <button className="btn" onClick={() => setModalRestriction(null)}>+ Add Restriction</button>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Path Prefix</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {restrictions.length === 0 ? (
              <tr><td colSpan={4}>No restrictions in this group yet.</td></tr>
            ) : (
              restrictions.map((r) => (
                <tr key={r.restriction_id}>
                  <td>{r.domain}</td>
                  <td>{r.path_prefix}</td>
                  <td>{r.is_active ? 'Active' : 'Disabled'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn-link" onClick={() => setModalRestriction(r)}>Edit</button>
                    {' | '}
                    <button className="btn-link" onClick={() => handleDelete(r)}>Delete</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {modalRestriction !== undefined && (
        <RestrictionFormModal
          groupId={groupId}
          existingRestriction={modalRestriction}
          onClose={() => setModalRestriction(undefined)}
          onSaved={load}
        />
      )}
    </>
  );
}
