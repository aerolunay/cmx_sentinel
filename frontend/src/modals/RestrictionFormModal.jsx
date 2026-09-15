import { useState } from 'react';
import { api } from '../api.js';

// Handles both create and edit - pass existingRestriction to edit.
export default function RestrictionFormModal({ groupId, existingRestriction, onClose, onSaved }) {
  const isEditing = Boolean(existingRestriction);
  const [domain, setDomain] = useState(existingRestriction?.domain || '');
  const [pathPrefix, setPathPrefix] = useState(existingRestriction?.path_prefix || '/');
  const [isActive, setIsActive] = useState(existingRestriction?.is_active ?? true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    const payload = { domain: domain.trim(), pathPrefix: pathPrefix.trim() || '/', isActive };

    try {
      const saved = isEditing
        ? await api.updateRestriction(groupId, existingRestriction.restriction_id, payload)
        : await api.createRestriction(groupId, payload);
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
        <h2>{isEditing ? 'Edit Restriction' : 'Add Restriction'}</h2>
        {error && <div className="error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label htmlFor="domain">Domain</label>
          <input
            id="domain"
            type="text"
            placeholder="e.g. youtube.com"
            autoFocus
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />

          <label htmlFor="pathPrefix">Path Prefix</label>
          <input
            id="pathPrefix"
            type="text"
            placeholder="/ blocks the whole domain, or e.g. /watch"
            value={pathPrefix}
            onChange={(e) => setPathPrefix(e.target.value)}
          />

          {isEditing && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
              />
              Active
            </label>
          )}

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Restriction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
