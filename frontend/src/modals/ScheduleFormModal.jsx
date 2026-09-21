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
const SHIFT_TYPE_SUGGESTIONS = ['Regular', 'Pre/Post Shift OT', 'Rest Day OT'];

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
  const [showShiftTypeOptions, setShowShiftTypeOptions] = useState(false);
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
              {/* A plain text input, so the field still accepts any
                  ad hoc value (shift_type is free text, not a fixed
                  enum - see the comment on SHIFT_TYPE_SUGGESTIONS
                  above and shift_type's own column comment in
                  sql/002_add_agent_schedules.sql). Deliberately NOT
                  a native <input list> + <datalist> combo: browsers
                  filter datalist suggestions by whatever text is
                  ALREADY in the box, so on an edit (pre-filled with
                  e.g. "Regular") every OTHER suggestion gets silently
                  filtered out and only the current value shows -
                  looking like there's only ever one option. This
                  custom dropdown always shows the full suggestion
                  list on focus/click, click-to-fill like the agent
                  picker above, regardless of what's currently typed. */}
              <div style={{ position: 'relative' }}>
                <input
                  id="shiftType"
                  type="text"
                  value={shiftType}
                  onChange={(e) => setShiftType(e.target.value)}
                  onFocus={() => setShowShiftTypeOptions(true)}
                  onBlur={() => setTimeout(() => setShowShiftTypeOptions(false), 150)}
                  maxLength={32}
                  autoComplete="off"
                />
                {showShiftTypeOptions && (
                  <table style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1, marginTop: 2 }}>
                    <tbody>
                      {SHIFT_TYPE_SUGGESTIONS.map((t) => (
                        <tr
                          key={t}
                          style={{ cursor: 'pointer' }}
                          onMouseDown={(e) => e.preventDefault()} // keeps the input's onBlur from firing before the click registers
                          onClick={() => { setShiftType(t); setShowShiftTypeOptions(false); }}
                        >
                          <td>{t}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

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
