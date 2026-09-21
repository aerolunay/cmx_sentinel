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

function addDaysToDateString(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  // Built from local getFullYear/getMonth/getDate, NOT toISOString() -
  // toISOString() converts through UTC, which would shift the date by
  // one for any admin whose browser timezone is AHEAD of UTC. Staying
  // in local components the whole way avoids that entirely, matching
  // the pure local-arithmetic approach DashboardPage.jsx's own
  // getMonthRange already uses.
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Mirrors the backend's own default window for the per-agent view
// (see scheduleRoutes.js) - used here just to PRE-FILL the date
// inputs, not to enforce anything; the person can widen or narrow
// them freely from there, which is exactly what fixes a shift that
// was loaded (e.g. directly via Workbench) for a date outside this
// default range not showing up.
function defaultAgentRange() {
  const today = getTodayEastern();
  return { dateFrom: addDaysToDateString(today, -30), dateTo: addDaysToDateString(today, 90) };
}

function defaultMonthRange() {
  const today = getTodayEastern();
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastDayNum = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  return { dateFrom: monthStart, dateTo: `${today.slice(0, 7)}-${String(lastDayNum).padStart(2, '0')}` };
}

export default function SchedulerPage() {
  const [tab, setTab] = useState('upload'); // 'upload' | 'edit' | 'browse'

  return (
    <>
      <h2 style={{ marginBottom: 16 }}>Shift Scheduler</h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid #ddd' }}>
        <button className={tab === 'upload' ? 'btn-tab active' : 'btn-tab'} onClick={() => setTab('upload')}>
          Mass Upload
        </button>
        <button className={tab === 'edit' ? 'btn-tab active' : 'btn-tab'} onClick={() => setTab('edit')}>
          Edit Agent Schedule
        </button>
        <button className={tab === 'browse' ? 'btn-tab active' : 'btn-tab'} onClick={() => setTab('browse')}>
          All Schedules
        </button>
      </div>

      {tab === 'upload' && <MassUploadTab />}
      {tab === 'edit' && <EditScheduleTab />}
      {tab === 'browse' && <BrowseSchedulesTab />}
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
  const [range, setRange] = useState(defaultAgentRange());
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
    await loadShifts(agent.agent_id, range);
  }

  async function loadShifts(agentId, r) {
    setLoadingShifts(true);
    setError('');
    try {
      const data = await api.listSchedules({ agentId, dateFrom: r.dateFrom, dateTo: r.dateTo });
      setShifts(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingShifts(false);
    }
  }

  function handleRangeChange(field, value) {
    const next = { ...range, [field]: value };
    setRange(next);
    if (selectedAgent && next.dateFrom && next.dateTo) {
      loadShifts(selectedAgent.agent_id, next);
    }
  }

  async function handleDelete(shift) {
    if (!window.confirm(`Delete the ${shift.shiftType} shift on ${shift.shiftDate}?`)) return;
    setError('');
    try {
      await api.deleteSchedule(shift.scheduleId);
      loadShifts(selectedAgent.agent_id, range);
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
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

          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
            <div>
              <label htmlFor="agentDateFrom">From</label>
              <input id="agentDateFrom" type="date" value={range.dateFrom} onChange={(e) => handleRangeChange('dateFrom', e.target.value)} />
            </div>
            <div>
              <label htmlFor="agentDateTo">To</label>
              <input id="agentDateTo" type="date" value={range.dateTo} onChange={(e) => handleRangeChange('dateTo', e.target.value)} />
            </div>
            {/* Widens to a 2-year window either side of today - a quick
                escape hatch for exactly the situation that prompted this:
                a shift loaded (e.g. directly via Workbench) for a date
                outside the -30/+90 default not showing up because the
                default window, not the search, was the reason it was
                missing. */}
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                const today = getTodayEastern();
                const wide = { dateFrom: addDaysToDateString(today, -730), dateTo: addDaysToDateString(today, 730) };
                setRange(wide);
                loadShifts(selectedAgent.agent_id, wide);
              }}
            >
              Show everything (±2 years)
            </button>
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
                  <tr><td colSpan={5}>No shifts for this agent in the selected date range.</td></tr>
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
          onSaved={() => loadShifts(selectedAgent.agent_id, range)}
        />
      )}
    </div>
  );
}

// Browse every agent's shifts in a date range, optionally narrowed by
// an agent search term - this is the "show me the schedule table,
// filterable by date" view, separate from the per-agent Edit tab.
// Editing/deleting a row here works the same way (each row already
// carries its own agent, so no agent picker is needed for that), but
// adding a brand NEW shift stays on the Edit Agent Schedule tab, which
// already has the agent search built in - avoiding a second agent
// picker duplicated here.
function BrowseSchedulesTab() {
  const [range, setRange] = useState(defaultMonthRange());
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalShift, setModalShift] = useState(undefined); // undefined = closed, object = edit

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
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <label htmlFor="browseDateFrom">From</label>
          <input id="browseDateFrom" type="date" value={range.dateFrom} onChange={(e) => setRange({ ...range, dateFrom: e.target.value })} />
        </div>
        <div>
          <label htmlFor="browseDateTo">To</label>
          <input id="browseDateTo" type="date" value={range.dateTo} onChange={(e) => setRange({ ...range, dateTo: e.target.value })} />
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <label htmlFor="browseAgentFilter">Filter by Agent ID or Name (optional)</label>
          <input
            id="browseAgentFilter"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Leave blank for all agents"
          />
        </div>
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
          agentId={modalShift.agentId}
          agentName={modalShift.displayName}
          existingShift={modalShift}
          onClose={() => setModalShift(undefined)}
          onSaved={load}
        />
      )}
    </div>
  );
}
