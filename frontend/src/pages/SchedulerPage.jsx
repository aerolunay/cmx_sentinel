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

function getTodayEastern() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function defaultMonthRange() {
  const today = getTodayEastern();
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastDayNum = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  return { dateFrom: monthStart, dateTo: `${today.slice(0, 7)}-${String(lastDayNum).padStart(2, '0')}` };
}

export default function SchedulerPage() {
  const [tab, setTab] = useState('upload'); // 'upload' | 'schedules'

  return (
    <>
      <h2 style={{ marginBottom: 16 }}>Shift Scheduler</h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid #ddd' }}>
        <button className={tab === 'upload' ? 'btn-tab active' : 'btn-tab'} onClick={() => setTab('upload')}>
          Mass Upload
        </button>
        <button className={tab === 'schedules' ? 'btn-tab active' : 'btn-tab'} onClick={() => setTab('schedules')}>
          Agent Schedules
        </button>
      </div>

      {tab === 'upload' ? <MassUploadTab /> : <AgentSchedulesTab />}
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

// One unified table: every agent's shifts in a date range, optionally
// narrowed by an Agent ID/Name filter, with Edit/Delete directly on
// each row (opens ScheduleFormModal) and a single "+ Add Shift"
// button that lets you pick the agent as part of adding, rather than
// requiring you to search for an agent BEFORE seeing any schedule
// data (the old two-tab split this replaces).
function AgentSchedulesTab() {
  const [range, setRange] = useState(defaultMonthRange());
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalShift, setModalShift] = useState(undefined); // undefined = closed, null = add (no agent yet), object = edit

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.dateFrom, range.dateTo]);

  // Debounced, same as the agent search elsewhere - filters the
  // already-date-scoped rows further by agent, without a full
  // separate request per keystroke.
  useEffect(() => {
    const timer = setTimeout(load, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api.listSchedules({ dateFrom: range.dateFrom, dateTo: range.dateTo, q: query.trim() });
      setRows(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(shift) {
    if (!window.confirm(`Delete ${shift.displayName}'s ${shift.shiftType} shift on ${shift.shiftDate}?`)) return;
    setError('');
    try {
      await api.deleteSchedule(shift.scheduleId);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label htmlFor="scheduleDateFrom">From</label>
            <input id="scheduleDateFrom" type="date" value={range.dateFrom} onChange={(e) => setRange({ ...range, dateFrom: e.target.value })} />
          </div>
          <div>
            <label htmlFor="scheduleDateTo">To</label>
            <input id="scheduleDateTo" type="date" value={range.dateTo} onChange={(e) => setRange({ ...range, dateTo: e.target.value })} />
          </div>
          <div style={{ minWidth: 220 }}>
            <label htmlFor="scheduleAgentFilter">Filter by Agent ID or Name (optional)</label>
            <input
              id="scheduleAgentFilter"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Leave blank for all agents"
            />
          </div>
        </div>
        <button className="btn" onClick={() => setModalShift(null)}>+ Add Shift</button>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Agent ID</th>
              <th>Group</th>
              <th>Shift Date</th>
              <th>Shift Type</th>
              <th>Start</th>
              <th>End</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8}>No shifts scheduled in this date range.</td></tr>
            ) : (
              rows.map((s) => (
                <tr key={s.scheduleId}>
                  <td>{s.displayName}</td>
                  <td>{s.agentId}</td>
                  <td>{s.groupName || <em style={{ color: '#999' }}>none</em>}</td>
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

      {modalShift !== undefined && (
        <ScheduleFormModal
          agentId={modalShift?.agentId}
          agentName={modalShift?.displayName}
          existingShift={modalShift}
          onClose={() => setModalShift(undefined)}
          onSaved={load}
        />
      )}
    </div>
  );
}
