import { useState } from 'react';
import { api } from '../api.js';

const TEMPLATE_HEADERS = ['Agent ID', 'Agent Name', 'Email', 'Group'];
// Group is illustrative only - blank is valid (no group / no website
// restrictions), same as the single Add Agent form's default.
const TEMPLATE_EXAMPLE_ROW = ['0000001', 'Jane Doe', 'jane.doe@example.com', ''];

function downloadTemplate() {
  const csv = [TEMPLATE_HEADERS.join(','), TEMPLATE_EXAMPLE_ROW.join(',')].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'agent_roster_template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// Same result-table shape and rendering as SchedulerPage's
// MassUploadTab (the backend's /api/agents/bulk-upload response is
// deliberately shaped to match /api/schedules/bulk-upload) - kept as
// its own modal here rather than a page tab like the Scheduler,
// because every other Agents-page action (Add, Edit) is already a
// modal, not a tab.
export default function AgentBulkUploadModal({ onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError('');
    setResult(null);
    try {
      const data = await api.bulkUploadAgents(file);
      setResult(data);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h2>Bulk Upload Agents</h2>
        {error && <div className="error">{error}</div>}

        <h3 style={{ marginTop: 0 }}>1. Download the template</h3>
        <p style={{ color: '#666', fontSize: 13 }}>
          One row per agent. <strong>Agent ID</strong>, <strong>Agent Name</strong> and{' '}
          <strong>Email</strong> are required - <strong>Group</strong> is optional (must match an
          existing group name exactly, or leave blank for no restrictions). A new temporary
          password is generated and emailed for each brand-new Agent ID.
        </p>
        <button type="button" className="btn-secondary" onClick={downloadTemplate}>
          Download Template (.csv)
        </button>

        <h3 style={{ marginTop: 24 }}>2. Upload the filled-in file</h3>
        <p style={{ color: '#666', fontSize: 13 }}>
          Safe to re-upload - a row whose Agent ID already exists just updates that agent's name,
          email and group in place. It does <strong>not</strong> reset their password or send
          another email, so fixing a typo later won't spam anyone.
        </p>
        <input
          type="file"
          accept=".csv"
          onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); setError(''); }}
        />

        {result && (
          <div style={{ marginTop: 20 }}>
            <div className="message">
              Saved {result.savedRows} of {result.totalRows} row(s).
              {result.errors.length > 0 && ` ${result.errors.length} row(s) had problems - see below.`}
            </div>
            {result.errors.length > 0 && (
              <table style={{ marginTop: 12 }}>
                <thead>
                  <tr><th>Row</th><th>Problem</th></tr>
                </thead>
                <tbody>
                  {result.errors.map((e) => (
                    <tr key={e.row}><td>{e.row}</td><td>{e.message}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <div className="modal-actions">
          {result ? (
            <button type="button" className="btn" onClick={onClose}>Done</button>
          ) : (
            <>
              <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
              <button type="button" className="btn" onClick={handleUpload} disabled={!file || uploading}>
                {uploading ? 'Uploading...' : 'Upload'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
