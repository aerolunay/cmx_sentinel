import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { addDays } from '../utils/dateRanges.js';
import { downloadClinicVisitsCsv, getTodayManila } from '../utils/clinic.js';
import ClinicVisitsTable from '../components/ClinicVisitsTable.jsx';
import ClinicVisitFormModal from '../modals/ClinicVisitFormModal.jsx';

const inputStyle = { padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 };

// The clinic's visit log, where Med / Clinic users (their only page) and
// Super Admins add visits and edit them (e.g. to fill in the time
// released). Everyone else reads the same log on the Reports page.
export default function ClinicVisitsPage() {
  const today = getTodayManila();
  const [dateFrom, setDateFrom] = useState(addDays(today, -6));
  const [dateTo, setDateTo] = useState(today);
  const [visits, setVisits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // undefined = closed, null = adding, a visit = editing it.
  const [editing, setEditing] = useState(undefined);

  async function load() {
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
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo]);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Clinic Visits</h2>
        <button type="button" className="btn" onClick={() => setEditing(null)}>+ Add Clinic Visit</button>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <label style={{ fontSize: 13, color: '#555' }}>From</label>
        <input type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} style={inputStyle} />
        <label style={{ fontSize: 13, color: '#555' }}>To</label>
        <input type="date" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} style={inputStyle} />
        {visits.length > 0 && (
          <button type="button" className="btn-secondary" onClick={() => downloadClinicVisitsCsv(visits, dateFrom, dateTo)}>
            Export CSV
          </button>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : visits.length === 0 ? (
        <p>No clinic visits recorded for these dates.</p>
      ) : (
        <>
          <p style={{ fontSize: 13, color: '#555' }}>{visits.length} {visits.length === 1 ? 'visit' : 'visits'}.</p>
          <ClinicVisitsTable visits={visits} onEdit={setEditing} />
        </>
      )}

      {editing !== undefined && (
        <ClinicVisitFormModal existingVisit={editing} onClose={() => setEditing(undefined)} onSaved={load} />
      )}
    </>
  );
}
