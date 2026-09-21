import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Handles adding OR editing one shift row.
//
// - Editing (existingShift given): agentId/agentName are fixed and
//   shown read-only - moving a shift to a different agent isn't a
//   real edit, it's a delete-and-recreate, so there's no agent picker
//   in this mode at all.
// - Adding for a KNOWN agent (agentId/agentName given, no
//   existingShift): same as before, agent shown read-only.
// - Adding with NO agent context (neither given - the Agent Schedules
//   table's own "+ Add Shift" button, which isn't scoped to any one
//   agent): shows an inline agent search/picker first; the rest of
//   the form only appears once an agent is chosen.
const SHIFT_TYPE_SUGGESTIONS = ['Regular', 'OT', 'RestDayOT'];

export default function ScheduleFormModal({ agentId, agentName, existingShift, onClose, onSaved }) {
  const isEditing = Boolean(existingShift);
  const needsAgentPicker = !isEditing && !agentId;

  const [pickedAgent, setPickedAgent] = useState(
    agentId ? { agent_id: agentId, display_name: agentName } : null
  );
  const [agentQuery, setAgentQuery] = useState('');
  const [agentResults, setAgentResults] = useState([]);
  const [searchingAgent, setSearchingAgent] = useState(false);

  const [shiftDate, setShiftDate] = useState(existingShift?.shiftDate || '');
  const [shiftType, setShiftType] = useState(existingShift?.shiftType || 'Regular');
  const [startTime, setStartTime] = useState(existingShift?.startTime || '');
  const [endTime, setEndTime] = useState(existingShift?.endTime || '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const crossesMidnight = startTime && endTime && endTime <= startTime;

  // Debounced agent search, same 300ms pattern used elsewhere in this
  // feature - only runs at all when there's no agent context yet.
  useEffect(() => {
    if (!needsAgentPicker || pickedAgent || !agentQuery.trim()) {
      setAgentResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearchingAgent(true);
      try {
        setAgentResults(await api.searchScheduleAgents(agentQuery.trim()));
      } catch {
        setAgentResults([]);
      } finally {
        setSearchingAgent(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [agentQuery, needsAgentPicker, pickedAgent]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const payload = { shiftDate, shiftType: shiftType.trim(), startTime, endTime };
      if (isEditing) {
        const saved = await api.updateSchedule(existingShift.scheduleId, payload);
        onSaved({ ...saved, agentId: existingShift.agentId });
      } else {
        const saved = await api.createSchedule({ agentId: pickedAgent.agent_id, ...payload });
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
        {error && <div className="error">{error}</div>}

        {needsAgentPicker && !pickedAgent ? (
          <>
            <label htmlFor="shiftAgentSearch">Agent</label>
            <input
              id="shiftAgentSearch"
              type="text"
              value={agentQuery}
              onChange={(e) => setAgentQuery(e.target.value)}
              placeholder="Search by Agent ID or Name"
              autoFocus
            />
            {searchingAgent && <p style={{ color: '#999', fontSize: 13 }}>Searching...</p>}
            {agentResults.length > 0 && (
              <table style={{ marginTop: 8 }}>
                <tbody>
                  {agentResults.map((a) => (
                    <tr key={a.agent_id} style={{ cursor: 'pointer' }} onClick={() => setPickedAgent(a)}>
                      <td>{a.display_name}</td>
                      <td>{a.agent_id}</td>
                      <td>{a.group_name || <em style={{ color: '#999' }}>no group</em>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!searchingAgent && agentQuery.trim() && agentResults.length === 0 && (
              <p style={{ color: '#999', fontSize: 13 }}>No agents match "{agentQuery.trim()}".</p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: '0 0 16px', color: '#666', fontSize: 13 }}>
              {isEditing ? agentName : pickedAgent.display_name} ({isEditing ? agentId : pickedAgent.agent_id})
              {needsAgentPicker && (
                <button
                  type="button"
                  className="btn-link"
                  style={{ marginLeft: 8, fontSize: 12 }}
                  onClick={() => { setPickedAgent(null); setAgentQuery(''); }}
                >
                  change
                </button>
              )}
            </p>

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
          </>
        )}
      </div>
    </div>
  );
}
