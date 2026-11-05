import { useEffect, useState } from 'react';
import { api } from '../api.js';

const inputStyle = { padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 };

// Super Admin: employee IDs whose recordings aren't shown in the web app
// (list, playback and download - for every user). The recordings
// themselves are kept as they are; removing an ID shows them again.
export default function RecordingExemptionsModal({ onClose, onChanged }) {
  const [exemptions, setExemptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [employeeId, setEmployeeId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setExemptions(await api.listRecordingExemptions());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e) {
    e.preventDefault();
    const id = employeeId.trim();
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      await api.addRecordingExemption({ employeeId: id, note: note.trim() });
      setEmployeeId('');
      setNote('');
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(exemption) {
    const who = exemption.displayName ? `${exemption.displayName} (${exemption.employeeId})` : exemption.employeeId;
    if (!window.confirm(`Show recordings of ${who} again?`)) return;
    setBusy(true);
    setError('');
    try {
      await api.removeRecordingExemption(exemption.employeeId);
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <h2>Recording Exemptions</h2>
        <p style={{ fontSize: 13, color: '#555', marginTop: 0 }}>
          Recordings of these employees are hidden from the Recordings page for everyone, including
          playback and download. They are still recorded and kept - remove an ID to show them again.
        </p>
        {error && <div className="error">{error}</div>}

        <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <input
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            placeholder="Employee ID"
            maxLength={32}
            style={{ ...inputStyle, width: 130 }}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reason (optional)"
            maxLength={255}
            style={{ ...inputStyle, flex: '1 1 200px' }}
          />
          <button type="submit" className="btn" disabled={busy || !employeeId.trim()}>Add</button>
        </form>

        {loading ? (
          <p>Loading...</p>
        ) : exemptions.length === 0 ? (
          <p style={{ fontSize: 14 }}>No employees are exempted.</p>
        ) : (
          <div className="report-table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="report-table">
              <thead>
                <tr>
                  <th>Employee ID</th>
                  <th>Name</th>
                  <th>Reason</th>
                  <th>Added By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {exemptions.map((x) => (
                  <tr key={x.employeeId}>
                    <td>{x.employeeId}</td>
                    <td>{x.displayName || <em style={{ color: '#999' }}>not an agent</em>}</td>
                    <td>{x.note}</td>
                    <td>{x.addedBy || ''}</td>
                    <td>
                      <button type="button" className="btn-secondary" disabled={busy} onClick={() => handleRemove(x)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
