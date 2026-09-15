import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Handles BOTH create and edit - pass existingAgent to edit, omit it
// to create. Agent ID is only editable/shown when creating - it's the
// login credential's identity and shouldn't change once set. No
// password field at all here - a temp password is always auto-
// generated and emailed, either on creation or via the separate Reset
// Password action on the Agents table.
export default function AgentFormModal({ existingAgent, onClose, onSaved }) {
  const isEditing = Boolean(existingAgent);

  const [agentId, setAgentId] = useState(existingAgent?.agent_id || '');
  const [displayName, setDisplayName] = useState(existingAgent?.display_name || '');
  const [email, setEmail] = useState(existingAgent?.email || '');
  const [groupId, setGroupId] = useState(existingAgent?.group_id || '');
  const [groups, setGroups] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.listGroups().then(setGroups).catch(() => {
      // Non-fatal - group assignment is optional, the rest of the form
      // still works fine if this fails for some reason.
    });
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setMessage('');
    setSubmitting(true);

    try {
      if (isEditing) {
        const saved = await api.updateAgent(existingAgent.agent_id, {
          displayName: displayName.trim(),
          email: email.trim(),
          groupId: groupId || null,
        });
        onSaved(saved);
        onClose();
      } else {
        const result = await api.createAgent({
          agentId: agentId.trim(),
          displayName: displayName.trim(),
          email: email.trim(),
          groupId: groupId || null,
        });
        // Show the "temp password sent" confirmation before closing,
        // rather than closing immediately - the admin should actually
        // see that it worked.
        setMessage(result.message);
        onSaved(result);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>{isEditing ? 'Edit Agent' : 'Add Agent'}</h2>
        {error && <div className="error">{error}</div>}
        {message && !error && <div className="message">{message}</div>}

        <form onSubmit={handleSubmit}>
          {!isEditing && (
            <>
              <label htmlFor="agentId">Agent ID (numbers only)</label>
              <input
                id="agentId"
                type="text"
                inputMode="numeric"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                disabled={Boolean(message)}
              />
            </>
          )}

          <label htmlFor="displayName">Display Name</label>
          <input
            id="displayName"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={Boolean(message)}
          />

          <label htmlFor="email">Email (temporary password is sent here)</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={Boolean(message)}
          />

          <label htmlFor="group">Group (website restrictions)</label>
          <select
            id="group"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            disabled={Boolean(message)}
          >
            <option value="">No group - no restrictions</option>
            {groups.map((g) => (
              <option key={g.group_id} value={g.group_id}>{g.group_name}</option>
            ))}
          </select>

          <div className="modal-actions">
            {message ? (
              <button type="button" className="btn" onClick={onClose}>Done</button>
            ) : (
              <>
                <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                <button type="submit" className="btn" disabled={submitting}>
                  {submitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Agent'}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
