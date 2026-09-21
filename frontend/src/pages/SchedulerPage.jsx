import { useEffect, useState } from 'react';
import { api } from '../api.js';
import ScheduleFormModal from '../modals/ScheduleFormModal.jsx';

const TEMPLATE_HEADERS = ['Agent ID', 'Agent Name', 'Shift Date', 'Shift Type', 'Start Time', 'End Time'];
// One example row, purely illustrative - Agent Name here is for the
// person filling the sheet in to double check they've got the right
// agent; it's never read by the upload itself, only Agent ID is.
const TEMPLATE_EXAMPLE_ROW = ['0000001', 'Jane Doe', '2026-09-20', 'Regular', '09:00', '18:00'];

function downloadTemplate() {
  const csv = [TEMPLATE_HEADERS.join(','), TEMPLATE_EXAMPLE_ROW.join(',')].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'shift_schedule_template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function formatShiftDate(shiftDate) {
  // Deliberately NOT `new Date(shiftDate)` - a plain 'YYYY-MM-DD'
  // string handed to the Date constructor is parsed as UTC midnight,
  // which then renders as the PREVIOUS day in any timezone behind
  // UTC (including Eastern) - a classic off-by-one. Building the Date
  // from explicit Y/M/D components instead uses local time, so the
  // calendar day displayed always matches the string.
  const [y, m, d] = shiftDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function SchedulerPage() {
  const [tab, setTab] = useState('upload'); // 'upload' | 'edit'

  return (
    <>
      <h2 style={{ marginBottom: 16 }}>Shift Scheduler</h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid #ddd' }}>
        <button
          className={tab === 'upload' ? 'btn-tab active' : 'btn-tab'}
          onClick={() => setTab('upload')}
        >
          Mass Upload
        </button>
        <button
          className={tab === 'edit' ? 'btn-tab active' : 'btn-tab'}
          onClick={() => setTab('edit')}
        >
          Edit Agent Schedule
        </button>
      </div>

      {tab === 'upload' ? <MassUploadTab /> : <EditScheduleTab />}
    </>
  );
}

function MassUploadTab() {
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
      const data = await api.bulkUploadSchedules(file);
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="dashboard-card" style={{ maxWidth: 640 }}>
      <h3 style={{ marginTop: 0 }}>1. Download the template</h3>
      <p style={{ color: '#666', fontSize: 13 }}>
        Fill in one row per shift. <strong>Agent ID</strong> is the only column actually used to match the
        agent - Agent Name is just there so whoever fills the sheet in can double check they've got the
        right person. Shift Date is YYYY-MM-DD, times are 24-hour HH:MM. If End Time is earlier than or
        equal to Start Time, the shift is treated as crossing midnight into the next day automatically.
      </p>
      <button type="button" className="btn-secondary" onClick={downloadTemplate}>
        Download Template (.csv)
      </button>

      <h3 style={{ marginTop: 28 }}>2. Upload the filled-in file</h3>
      <p style={{ color: '#666', fontSize: 13 }}>
        Re-uploading a file you've already loaded is safe - matching rows (same Agent ID, Shift Date and
        Shift Type) just update in place rather than duplicating.
      </p>
      <input
        type="file"
        accept=".csv"
        onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); setError(''); }}
      />
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={handleUpload} disabled={!file || uploading}>
          {uploading ? 'Uploading...' : 'Upload'}
        </button>
      </div>

      {error && <div className="error" style={{ marginTop: 16 }}>{error}</div>}

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
    </div>
  );
}

function EditScheduleTab() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null); // { agent_id, display_name }
  const [shifts, setShifts] = useState([]);
  const [loadingShifts, setLoadingShifts] = useState(false);
  const [error, setError] = useState('');
  const [modalShift, setModalShift] = useState(undefined); // undefined = closed, null = add, object = edit

  // Debounced search-as-you-type by Agent ID or Agent Name, same
  // 300ms pattern that avoids firing a request on every keystroke.
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await api.searchScheduleAgents(query.trim());
        setResults(data);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  async function selectAgent(agent) {
    setSelectedAgent(agent);
    setResults([]);
    setQuery('');
    await loadShifts(agent.agent_id);
  }

  async function loadShifts(agentId) {
    setLoadingShifts(true);
    setError('');
    try {
      const data = await api.listAgentSchedule(agentId);
      setShifts(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingShifts(false);
    }
  }

  async function handleDelete(shift) {
    if (!window.confirm(`Delete the ${shift.shiftType} shift on ${shift.shiftDate}?`)) return;
    setError('');
    try {
      await api.deleteSchedule(shift.scheduleId);
      loadShifts(selectedAgent.agent_id);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      {!selectedAgent ? (
        <div style={{ maxWidth: 480 }}>
          <label htmlFor="agentSearch">Search by Agent ID or Name</label>
          <input
            id="agentSearch"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. 0000001 or Jane"
            autoFocus
          />
          {searching && <p style={{ color: '#999', fontSize: 13 }}>Searching...</p>}
          {results.length > 0 && (
            <table style={{ marginTop: 12 }}>
              <tbody>
                {results.map((a) => (
                  <tr key={a.agent_id} style={{ cursor: 'pointer' }} onClick={() => selectAgent(a)}>
                    <td>{a.display_name}</td>
                    <td>{a.agent_id}</td>
                    <td>{a.group_name || <em style={{ color: '#999' }}>no group</em>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!searching && query.trim() && results.length === 0 && (
            <p style={{ color: '#999', fontSize: 13 }}>No agents match "{query.trim()}".</p>
          )}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h3 style={{ margin: 0 }}>{selectedAgent.display_name} ({selectedAgent.agent_id})</h3>
              <button
                type="button"
                className="btn-link"
                style={{ padding: 0 }}
                onClick={() => { setSelectedAgent(null); setShifts([]); }}
              >
                &laquo; Search a different agent
              </button>
            </div>
            <button className="btn" onClick={() => setModalShift(null)}>+ Add Shift</button>
          </div>

          {error && <div className="error">{error}</div>}

          {loadingShifts ? (
            <p>Loading...</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Shift Date</th>
                  <th>Shift Type</th>
                  <th>Start</th>
                  <th>End</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shifts.length === 0 ? (
                  <tr><td colSpan={5}>No shifts in the next/last few months for this agent.</td></tr>
                ) : (
                  shifts.map((s) => (
                    <tr key={s.scheduleId}>
                      <td>{formatShiftDate(s.shiftDate)}</td>
                      <td>{s.shiftType}</td>
                      <td>{s.startTime}</td>
                      <td>{s.endTime}{s.crossesMidnight && <span title="Ends the next day"> (+1)</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn-link" onClick={() => setModalShift(s)}>Edit</button>
                        {' | '}
                        <button className="btn-link" onClick={() => handleDelete(s)}>Delete</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </>
      )}

      {modalShift !== undefined && selectedAgent && (
        <ScheduleFormModal
          agentId={selectedAgent.agent_id}
          agentName={selectedAgent.display_name}
          existingShift={modalShift}
          onClose={() => setModalShift(undefined)}
          onSaved={() => loadShifts(selectedAgent.agent_id)}
        />
      )}
    </div>
  );
}
