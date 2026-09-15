import { useState } from 'react';
import { api } from '../api.js';

const ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'tqa', label: 'TQA' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'manager', label: 'Manager' },
];

// Handles BOTH create and edit - pass existingUser to edit, omit it to
// create. The form itself is identical either way, just a different
// API call on submit.
export default function UserFormModal({ existingUser, onClose, onSaved }) {
  const isEditing = Boolean(existingUser);

  const [role, setRole] = useState(existingUser?.role || 'tqa');
  const [employeeId, setEmployeeId] = useState(
    existingUser?.role === 'admin' ? existingUser.login_identifier : ''
  );
  const [email, setEmail] = useState(existingUser?.email || '');
  const [displayName, setDisplayName] = useState(existingUser?.display_name || '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = role === 'admin';
  const loginIdentifier = isAdmin ? employeeId : email;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    const payload = {
      role,
      loginIdentifier: loginIdentifier.trim(),
      email: email.trim(),
      displayName: displayName.trim(),
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

          {isAdmin && (
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
            {isAdmin ? 'Email (where the OTP code is sent)' : 'Email (used to log in and receive the OTP code)'}
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

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
