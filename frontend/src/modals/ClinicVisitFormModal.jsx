import { useState } from 'react';
import { api } from '../api.js';
import { getNowTimeManila, getTodayManila } from '../utils/clinic.js';

// Add or edit a clinic visit - pass existingVisit to edit. Date and time
// of visit default to now (Philippine time). Typing an Employee ID fills
// in the name from the agents list; anyone else's name is typed in.
// "Seen by" is whoever is logged in when the visit is added (server-side).
export default function ClinicVisitFormModal({ existingVisit, onClose, onSaved }) {
  const isEditing = Boolean(existingVisit);
  const [visitDate, setVisitDate] = useState(existingVisit?.visitDate || getTodayManila());
  const [employeeId, setEmployeeId] = useState(existingVisit?.employeeId || '');
  const [employeeName, setEmployeeName] = useState(existingVisit?.employeeName || '');
  const [timeOfVisit, setTimeOfVisit] = useState(existingVisit?.timeOfVisit || getNowTimeManila());
  const [chiefComplaint, setChiefComplaint] = useState(existingVisit?.chiefComplaint || '');
  const [treatment, setTreatment] = useState(existingVisit?.treatment || '');
  const [timeReleased, setTimeReleased] = useState(existingVisit?.timeReleased || '');
  const [lookupNote, setLookupNote] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function lookUpEmployee() {
    const id = employeeId.trim();
    setLookupNote('');
    if (!id) return;
    try {
      const result = await api.lookupClinicEmployee(id);
      if (result.found) {
        setEmployeeName(result.employeeName);
      } else {
        setLookupNote('Not in the agents list - type the name.');
      }
    } catch {
      // Lookup is only a convenience - the name can always be typed.
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    const payload = {
      visitDate, employeeId: employeeId.trim(), employeeName: employeeName.trim(), timeOfVisit,
      chiefComplaint: chiefComplaint.trim(), treatment: treatment.trim(), timeReleased,
    };
    try {
      if (isEditing) await api.updateClinicVisit(existingVisit.visitId, payload);
      else await api.createClinicVisit(payload);
      onSaved();
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
        <h2>{isEditing ? 'Edit Clinic Visit' : 'Add Clinic Visit'}</h2>
        {error && <div className="error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="clinic-form-row">
            <div>
              <label htmlFor="visitDate">Date of Visit</label>
              <input id="visitDate" type="date" value={visitDate} onChange={(e) => setVisitDate(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="timeOfVisit">Time of Visit (PH time)</label>
              <input id="timeOfVisit" type="time" value={timeOfVisit} onChange={(e) => setTimeOfVisit(e.target.value)} required />
            </div>
          </div>

          <div className="clinic-form-row">
            <div>
              <label htmlFor="employeeId">Employee ID</label>
              <input
                id="employeeId"
                type="text"
                inputMode="numeric"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                onBlur={lookUpEmployee}
                required
              />
            </div>
            <div>
              <label htmlFor="employeeName">Employee Name</label>
              <input id="employeeName" type="text" value={employeeName} onChange={(e) => setEmployeeName(e.target.value)} required />
            </div>
          </div>
          {lookupNote && <p className="clinic-form-note">{lookupNote}</p>}

          <label htmlFor="chiefComplaint">Chief Complaint</label>
          <textarea
            id="chiefComplaint"
            rows={2}
            maxLength={1000}
            value={chiefComplaint}
            onChange={(e) => setChiefComplaint(e.target.value)}
            placeholder="e.g. Headache, fever, dizziness"
            required
          />

          <label htmlFor="treatment">Treatment / Intervention</label>
          <textarea
            id="treatment"
            rows={2}
            maxLength={1000}
            value={treatment}
            onChange={(e) => setTreatment(e.target.value)}
            placeholder="e.g. Paracetamol 500mg given, rested 20 mins, advised to go home"
          />

          <label htmlFor="timeReleased">Time Released (PH time - leave blank if still in the clinic)</label>
          <input id="timeReleased" type="time" value={timeReleased} onChange={(e) => setTimeReleased(e.target.value)} />

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Visit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
