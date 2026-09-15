import { useState } from 'react';
import { api } from '../api.js';

// Handles both create and edit - pass existingGroup to edit.
export default function GroupFormModal({ existingGroup, onClose, onSaved }) {
  const isEditing = Boolean(existingGroup);
  const [groupName, setGroupName] = useState(existingGroup?.group_name || '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const saved = isEditing
        ? await api.updateGroup(existingGroup.group_id, groupName.trim())
        : await api.createGroup(groupName.trim());
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
        <h2>{isEditing ? 'Rename Group' : 'Add Group'}</h2>
        {error && <div className="error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label htmlFor="groupName">Group Name</label>
          <input
            id="groupName"
            type="text"
            autoFocus
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
          />

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Group'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
