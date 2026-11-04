import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { addDays } from '../utils/dateRanges.js';
import { downloadClinicVisitsCsv, getTodayManila } from '../utils/clinic.js';
import ClinicVisitsTable from '../components/ClinicVisitsTable.jsx';

const selectStyle = { padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 };

// Reports > Clinic Visits: the clinic's visit log, read-only (Med / Clinic
// users add visits on their own page). Supervisors only get their groups'
// agents - the server filters that.
export default function ClinicVisitsReport() {
  const today = getTodayManila();
  const [dateFrom, setDateFrom] = useState(addDays(today, -6));
  const [dateTo, setDateTo] = useState(today);
  const [groupFilter, setGroupFilter] = useState('');
  const [visits, setVisits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadReport() {
    setLoading(true);
    setError('');
    try {
      setVisits(await api.listClinicVisits({ dateFrom, dateTo }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groupOptions = useMemo(
    () => [...new Set(visits.map((v) => v.groupName).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [visits]
  );
  const shown = useMemo(
    () => (groupFilter ? visits.filter((v) => v.groupName === groupFilter) : visits),
    [visits, groupFilter]
  );
  const employeeCount = useMemo(() => new Set(shown.map((v) => v.employeeId)).size, [shown]);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#555', maxWidth: 520 }}>
          Employee visits recorded by the clinic. Dates and times are Philippine time.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 13, color: '#555' }}>From</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={selectStyle} />
          <label style={{ fontSize: 13, color: '#555' }}>To</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={selectStyle} />

          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={selectStyle}>
            <option value="">All Groups</option>
            {groupOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>

          <button type="button" className="btn" onClick={loadReport} disabled={loading}>
            {loading ? 'Loading...' : 'Run Report'}
          </button>
          {shown.length > 0 && (
            <button type="button" className="btn-secondary" onClick={() => downloadClinicVisitsCsv(shown, dateFrom, dateTo)}>
              Export CSV
            </button>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {!loading && shown.length === 0 && !error && <p>No clinic visits for this filter.</p>}

      {shown.length > 0 && (
        <>
          <p style={{ fontSize: 13, color: '#555' }}>
            {shown.length} {shown.length === 1 ? 'visit' : 'visits'} by {employeeCount} {employeeCount === 1 ? 'employee' : 'employees'}.
          </p>
          <ClinicVisitsTable visits={shown} />
        </>
      )}
    </>
  );
}
