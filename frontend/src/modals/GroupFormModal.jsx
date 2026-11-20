import { useState } from 'react';
import { api } from '../api.js';

// Handles both create and edit - pass existingGroup to edit.
export default function GroupFormModal({ existingGroup, onClose, onSaved }) {
  const isEditing = Boolean(existingGroup);
  const [groupName, setGroupName] = useState(existingGroup?.group_name || '');
  // Only agents in a group with this ticked are screen-recorded by the
  // desktop app. New groups start ticked.
  const [recordingEnabled, setRecordingEnabled] = useState(existingGroup ? existingGroup.recording_enabled !== false : true);
  // Only agents in a group with this ticked can be watched live from the
  // Monitor page. New groups start ticked.
  const [monitoringEnabled, setMonitoringEnabled] = useState(existingGroup ? existingGroup.monitoring_enabled !== false : true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const saved = isEditing
        ? await api.updateGroup(existingGroup.group_id, groupName.trim(), { recordingEnabled, monitoringEnabled })
        : await api.createGroup(groupName.trim(), { recordingEnabled, monitoringEnabled });
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
        <h2>{isEditing ? 'Edit Group' : 'Add Group'}</h2>
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

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontWeight: 'normal' }}>
            <input
              type="checkbox"
              checked={recordingEnabled}
              onChange={(e) => setRecordingEnabled(e.target.checked)}
              style={{ width: 'auto', margin: 0 }}
            />
            Enable recordings
          </label>
          <p style={{ margin: '4px 0 0', fontSize: '0.85em', opacity: 0.75 }}>
            Unticked: agents in this group are not screen-recorded at all, from their next login.
          </p>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontWeight: 'normal' }}>
            <input
              type="checkbox"
              checked={monitoringEnabled}
              onChange={(e) => setMonitoringEnabled(e.target.checked)}
              style={{ width: 'auto', margin: 0 }}
            />
            Enable monitoring
          </label>
          <p style={{ margin: '4px 0 0', fontSize: '0.85em', opacity: 0.75 }}>
            Ticked: agents in this group can be watched live (screen and audio) from the Monitor page.
          </p>

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
