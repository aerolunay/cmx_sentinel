import { useState } from 'react';
import { api } from '../api.js';

// Handles BOTH add and edit for one shift row, same pattern as
// AgentFormModal - pass existingShift to edit, omit it to add a new
// one for agentId/agentName. agentId is fixed either way (a shift
// always belongs to whichever agent this modal was opened for) -
// moving a shift to a different agent isn't a real edit, it's a
// delete-and-recreate, so there's no agent picker here at all.
const SHIFT_TYPE_SUGGESTIONS = ['Regular', 'OT', 'RestDayOT'];

export default function ScheduleFormModal({ agentId, agentName, existingShift, onClose, onSaved }) {
  const isEditing = Boolean(existingShift);

  const [shiftDate, setShiftDate] = useState(existingShift?.shiftDate || '');
  const [shiftType, setShiftType] = useState(existingShift?.shiftType || 'Regular');
  const [startTime, setStartTime] = useState(existingShift?.startTime || '');
  const [endTime, setEndTime] = useState(existingShift?.endTime || '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const crossesMidnight = startTime && endTime && endTime <= startTime;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const payload = { shiftDate, shiftType: shiftType.trim(), startTime, endTime };
      if (isEditing) {
        const saved = await api.updateSchedule(existingShift.scheduleId, payload);
        onSaved({ ...saved, agentId });
      } else {
        const saved = await api.createSchedule({ agentId, ...payload });
        onSaved(saved);
      }
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
        <h2>{isEditing ? 'Edit Shift' : 'Add Shift'}</h2>
        <p style={{ margin: '0 0 16px', color: '#666', fontSize: 13 }}>{agentName} ({agentId})</p>
        {error && <div className="error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label htmlFor="shiftDate">Shift Date</label>
          <input
            id="shiftDate"
            type="date"
            value={shiftDate}
            onChange={(e) => setShiftDate(e.target.value)}
          />

          <label htmlFor="shiftType">Shift Type</label>
          <input
            id="shiftType"
            type="text"
            list="shift-type-suggestions"
            value={shiftType}
            onChange={(e) => setShiftType(e.target.value)}
            maxLength={32}
          />
          <datalist id="shift-type-suggestions">
            {SHIFT_TYPE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}
          </datalist>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="startTime">Start Time</label>
              <input
                id="startTime"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="endTime">End Time</label>
              <input
                id="endTime"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
          </div>

          {crossesMidnight && (
            <p style={{ fontSize: 12, color: '#666', marginTop: -4 }}>
              End time is before start time, so this shift is treated as ending the following day.
            </p>
          )}

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Shift'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
