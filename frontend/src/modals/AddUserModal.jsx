import { useState } from 'react';
import { api } from '../api.js';

const ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'tqa', label: 'TQA' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'manager', label: 'Manager' },
];

export default function AddUserModal({ onClose, onCreated }) {
  const [role, setRole] = useState('tqa');
  const [employeeId, setEmployeeId] = useState(''); // admin-only field
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = role === 'admin';
  // For non-admin roles, login identifier and email are the same
  // thing - no reason to make someone type it twice.
  const loginIdentifier = isAdmin ? employeeId : email;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const created = await api.createUser({
        role,
        loginIdentifier: loginIdentifier.trim(),
        email: email.trim(),
        displayName: displayName.trim(),
      });
      onCreated(created);
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
        <h2>Add User</h2>
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
              {submitting ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
