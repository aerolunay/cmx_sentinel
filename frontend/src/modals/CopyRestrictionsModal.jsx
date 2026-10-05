import { useState } from 'react';
import { api } from '../api.js';

// Copies every restriction from sourceGroup into another existing group.
// Rules the target already has are skipped server-side, so this never
// creates duplicates.
export default function CopyRestrictionsModal({ sourceGroup, groups, onClose }) {
  const targets = groups.filter((g) => g.group_id !== sourceGroup.group_id);
  const [targetGroupId, setTargetGroupId] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const targetName = targets.find((g) => String(g.group_id) === targetGroupId)?.group_name;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      setResult(await api.copyRestrictions(sourceGroup.group_id, Number(targetGroupId)));
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>Copy Restrictions</h2>
        {error && <div className="error">{error}</div>}

        {result ? (
          <>
            <p>
              Copied {result.copied} restriction{result.copied === 1 ? '' : 's'} to <strong>{targetName}</strong>.
              {result.skipped > 0 && ` ${result.skipped} already existed there and were skipped.`}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <p style={{ marginTop: 0 }}>
              Copy every restriction from <strong>{sourceGroup.group_name}</strong> into another group.
              Rules the other group already has are skipped.
            </p>

            <label htmlFor="targetGroup">Copy to</label>
            <select id="targetGroup" value={targetGroupId} onChange={(e) => setTargetGroupId(e.target.value)}>
              <option value="">Select a group...</option>
              {targets.map((g) => (
                <option key={g.group_id} value={g.group_id}>{g.group_name}</option>
              ))}
            </select>

            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn" disabled={submitting || !targetGroupId}>
                {submitting ? 'Copying...' : 'Copy Restrictions'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
