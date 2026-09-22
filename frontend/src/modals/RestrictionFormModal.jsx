import { useRef, useState } from 'react';
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
  const domainInputRef = useRef(null);

  const trimmedDomain = domain.trim();
  const domainTooBroad = trimmedDomain !== '' && isDangerouslyBroadPattern(trimmedDomain);

  // Shared by both "Save" and "Save & Add Another" - returns the saved
  // record on success, or null if validation failed (error already
  // set) or the request itself failed (error already set) - either
  // way the caller just checks truthiness rather than duplicating the
  // validation/error-handling logic twice.
  async function saveRestriction() {
    setError('');

    if (domainTooBroad) {
      setError('This pattern matches every possible domain - narrow it down (e.g. "*porn*.*", not just "*").');
      return null;
    }

    setSubmitting(true);
    const payload = { domain: trimmedDomain, pathPrefix: pathPrefix.trim() || '/', isActive };

    try {
      const saved = isEditing
        ? await api.updateRestriction(groupId, existingRestriction.restriction_id, payload)
        : await api.createRestriction(groupId, payload);
      return saved;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const saved = await saveRestriction();
    if (saved) {
      onSaved(saved);
      onClose();
    }
  }

  // Create-mode only (see the button itself, below) - saves, then
  // clears the form and keeps the modal open with focus back on
  // Domain, instead of closing, so adding several patterns in a row
  // (e.g. a batch of wildcard variants) doesn't mean reopening this
  // modal from scratch each time.
  async function handleSaveAndAddAnother() {
    const saved = await saveRestriction();
    if (saved) {
      onSaved(saved);
      setDomain('');
      setPathPrefix('/');
      domainInputRef.current?.focus();
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
            ref={domainInputRef}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          {domainTooBroad ? (
            <p style={{ fontSize: 12, color: '#b91c1c', marginTop: 6, marginBottom: 0 }}>
              This matches every possible domain - narrow it down (e.g. "*porn*.*", not just "*").
            </p>
          ) : (
            <p style={{ fontSize: 12, color: '#666', marginTop: 6, marginBottom: 0 }}>
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
            {!isEditing && (
              <button
                type="button"
                className="btn-secondary"
                onClick={handleSaveAndAddAnother}
                disabled={submitting || domainTooBroad}
              >
                Save &amp; Add Another
              </button>
            )}
            <button type="submit" className="btn" disabled={submitting || domainTooBroad}>
              {submitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Restriction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
