import { useState } from 'react';
import { api } from '../api.js';

// Mirrors the backend's own isDangerouslyBroadPattern check
// (groupRoutes.js) exactly - a pattern that strips down to nothing
// once '*', '.' and whitespace are removed matches literally every
// domain ("*", "*.*", "**", etc.), almost certainly a typo rather
// than an intentional "block the whole internet for this group" rule.
// Checked here too so the person sees this before they even submit,
// not just after a round-trip 400 - the server-side check stays as
// the real enforcement, this is just the front gate.
function isDangerouslyBroadPattern(domain) {
  return domain.replace(/[*.\s]/g, '').length === 0;
}

// Handles both create and edit - pass existingRestriction to edit.
export default function RestrictionFormModal({ groupId, existingRestriction, onClose, onSaved }) {
  const isEditing = Boolean(existingRestriction);
  const [domain, setDomain] = useState(existingRestriction?.domain || '');
  const [pathPrefix, setPathPrefix] = useState(existingRestriction?.path_prefix || '/');
  const [isActive, setIsActive] = useState(existingRestriction?.is_active ?? true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmedDomain = domain.trim();
  const domainTooBroad = trimmedDomain !== '' && isDangerouslyBroadPattern(trimmedDomain);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (domainTooBroad) {
      setError('This pattern matches every possible domain - narrow it down (e.g. "*porn*.*", not just "*").');
      return;
    }

    setSubmitting(true);
    const payload = { domain: trimmedDomain, pathPrefix: pathPrefix.trim() || '/', isActive };

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
            placeholder="e.g. youtube.com or *porn*.*"
            autoFocus
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          {domainTooBroad ? (
            <p style={{ fontSize: 12, color: '#b91c1c', marginTop: -8, marginBottom: 14 }}>
              This matches every possible domain - narrow it down (e.g. "*porn*.*", not just "*").
            </p>
          ) : (
            <p style={{ fontSize: 12, color: '#666', marginTop: -8, marginBottom: 14 }}>
              Wildcards supported: <code>*</code> matches anything. <code>*porn*.*</code> blocks any
              domain containing "porn", under any TLD, including its subdomains. A plain domain like{' '}
              <code>youtube.com</code> still blocks that domain and all its subdomains automatically.
            </p>
          )}

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
            <button type="submit" className="btn" disabled={submitting || domainTooBroad}>
              {submitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Restriction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
