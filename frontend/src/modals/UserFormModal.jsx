import { useEffect, useState } from 'react';
import { api } from '../api.js';

const ROLES = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'admin', label: 'Admin' },
  { value: 'tqa', label: 'TQA' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'manager', label: 'Manager' },
];

const GROUP_SCOPED_ROLES = ['supervisor', 'manager'];

// Handles BOTH create and edit - pass existingUser to edit, omit it to
// create. The form itself is identical either way, just a different
// API call on submit.
export default function UserFormModal({ existingUser, onClose, onSaved }) {
  const isEditing = Boolean(existingUser);

  const [role, setRole] = useState(existingUser?.role || 'tqa');
  const usesEmployeeId = role === 'admin' || role === 'super_admin';
  const [employeeId, setEmployeeId] = useState(
    (existingUser?.role === 'admin' || existingUser?.role === 'super_admin') ? existingUser.login_identifier : ''
  );
  const [email, setEmail] = useState(existingUser?.email || '');
  const [displayName, setDisplayName] = useState(existingUser?.display_name || '');
  const [groups, setGroups] = useState([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState(
    (existingUser?.groups || []).map((g) => g.group_id)
  );
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loginIdentifier = usesEmployeeId ? employeeId : email;
  const isGroupScoped = GROUP_SCOPED_ROLES.includes(role);

  useEffect(() => {
    if (isGroupScoped) {
      api.listGroups().then(setGroups).catch(() => {
        // Non-fatal - the rest of the form still works if this fails.
      });
    }
  }, [isGroupScoped]);

  function toggleGroup(groupId) {
    setSelectedGroupIds((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId]
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    const payload = {
      role,
      loginIdentifier: loginIdentifier.trim(),
      email: email.trim(),
      displayName: displayName.trim(),
      groupIds: isGroupScoped ? selectedGroupIds : [],
    };

    try {
      const saved = isEditing
        ? await api.updateUser(existingUser.user_id, payload)
        : await api.createUser(payload);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>{isEditing ? 'Edit User' : 'Add User'}</h2>
        {error && <div className="error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label htmlFor="role">Role</label>
          <select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>

          <label htmlFor="displayName">Display Name</label>
          <input
            id="displayName"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />

          {usesEmployeeId && (
            <>
              <label htmlFor="employeeId">Employee ID (numbers only, used to log in)</label>
              <input
                id="employeeId"
                type="text"
                inputMode="numeric"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
              />
            </>
          )}

          <label htmlFor="email">
            {usesEmployeeId ? 'Email (where the OTP code is sent)' : 'Email (used to log in and receive the OTP code)'}
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          {isGroupScoped && (
            <>
              <label>Groups (this user only sees these groups' agents/recordings/reports)</label>
              <div style={{
                border: '1px solid #ccc', borderRadius: 6, padding: 8, maxHeight: 140,
                overflowY: 'auto', marginBottom: 14,
              }}>
                {groups.length === 0 ? (
                  <div style={{ fontSize: 13, color: '#999' }}>No groups exist yet.</div>
                ) : (
                  groups.map((g) => (
                    <label key={g.group_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 14 }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={selectedGroupIds.includes(g.group_id)}
                        onChange={() => toggleGroup(g.group_id)}
                      />
                      {g.group_name}
                    </label>
                  ))
                )}
              </div>
            </>
          )}

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
