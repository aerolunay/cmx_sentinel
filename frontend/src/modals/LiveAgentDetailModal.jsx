import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { AUX_COLORS, getEfficiencyColor, getAdherenceColor, formatDuration, formatAuxLabel } from '../utils/metrics.js';

const REFRESH_MS = 5000;

const LOGOUT_TRIGGER_LABELS = {
  switched_machine: 'Logged in on another PC',
};

// The backend sends Eastern wall-clock strings ("2026-10-09 08:30:00"),
// so they're formatted by hand rather than through Date - Date would
// re-interpret them in the viewer's own timezone. The month/day is
// only shown when it's not the shift's own date (overnight shifts).
function formatEasternTime(sqlString, shiftDate) {
  if (!sqlString) return '';
  const [date, time] = sqlString.split(' ');
  const [hh, mm] = time.split(':').map(Number);
  const clock = `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  if (date === shiftDate) return clock;
  const [, month, day] = date.split('-').map(Number);
  return `${month}/${day} ${clock}`;
}

function formatShiftDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Noon UTC keeps the calendar day stable in any viewer timezone.
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}

// Opened by double-clicking an agent in the live agents panel. Shows the
// pieces behind their live efficiency/adherence numbers - the schedule,
// their actual desktop logins, and time per aux - refreshing every 5s
// like the panel itself.
export default function LiveAgentDetailModal({ agentId, onClose }) {
  const [agent, setAgent] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.getLiveAgent(agentId);
        if (!cancelled) {
          setAgent(data);
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    load();
    const refresh = setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(refresh);
    };
  }, [agentId]);

  const d = agent?.detail;
  const hasSchedule = d && d.schedule.length > 0;
  const outsideScheduleSeconds = d ? d.loggedSeconds - d.countedSeconds : 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-wide live-detail" onClick={(e) => e.stopPropagation()}>
        {!agent ? (
          <>
            <h2>Agent Details</h2>
            {error ? <div className="error">{error}</div> : <p>Loading...</p>}
          </>
        ) : (
          <>
            <h2 style={{ marginBottom: 4 }}>{agent.displayName}</h2>
            <div className="live-detail-sub">
              {agent.agentId}
              {agent.groupName && ` · ${agent.groupName}`}
              {` · Shift of ${formatShiftDate(d.shiftDate)} · as of ${formatEasternTime(d.asOf, d.shiftDate)} ET`}
            </div>
            {error && <div className="error">{error}</div>}

            <div className="live-detail-tiles">
              <div className="live-detail-tile">
                <div className="live-detail-label">Current State</div>
                <span className="aux-badge" style={{ background: AUX_COLORS[agent.auxCode] || '#6b7280' }}>{formatAuxLabel(agent.auxCode)}</span>
                <div className="live-detail-small">{formatDuration(agent.auxSeconds)}</div>
              </div>
              <div className="live-detail-tile">
                <div className="live-detail-label">Productive Hrs</div>
                <div className="live-detail-value" style={agent.efficiencyPct == null ? undefined : { color: getEfficiencyColor(agent.efficiencyPct) }}>
                  {agent.efficiencyPct == null ? 'N/A' : `${agent.efficiencyPct.toFixed(2)}%`}
                </div>
                <div className="live-detail-small">
                  {!hasSchedule
                    ? 'No schedule for this shift'
                    : d.expectedSeconds == null
                      ? 'Not logged in during scheduled hours yet'
                      : `(${formatDuration(Math.max(0, d.expectedSeconds))} expected − ${formatDuration(d.nonProductiveSeconds)} non-productive) ÷ ${formatDuration(Math.max(0, d.expectedSeconds))} expected`}
                  {hasSchedule && d.expectedSeconds != null && (
                    <div>
                      Expected = {formatDuration(d.countedSeconds)} logged − {formatDuration(d.breakAllowanceSeconds)} allowance.
                      {' '}Non-productive = Idle + Bio Break{d.excessBreakSeconds > 0 ? ` + ${formatDuration(d.excessBreakSeconds)} Lunch/Break over the allowance` : ''}.
                    </div>
                  )}
                </div>
              </div>
              <div className="live-detail-tile">
                <div className="live-detail-label">Adherence</div>
                <div className="live-detail-value" style={agent.adherencePct == null ? undefined : { color: getAdherenceColor(agent.adherencePct) }}>
                  {agent.adherencePct == null ? 'N/A' : `${agent.adherencePct.toFixed(2)}%`}
                </div>
                <div className="live-detail-small">
                  {!hasSchedule ? 'No schedule for this shift' : (
                    <>
                      ({formatDuration(d.countedSeconds)} logged
                      {d.creditedGapSeconds > 0 && ` + ${formatDuration(d.creditedGapSeconds)} reconnect gaps`}
                      {d.breakOverSeconds > 0 && ` − ${formatDuration(d.breakOverSeconds)} lunch/break over allowance`}
                      {d.breakShortSeconds > 0 && ` − ${formatDuration(d.breakShortSeconds)} lunch/break not taken`}
                      ) ÷ {formatDuration(d.elapsedScheduledSeconds)} scheduled so far
                      {d.countedSeconds > 0 && (
                        <div>
                          Lunch + Break: {formatDuration(d.breakTakenSeconds)} taken of {formatDuration(d.breakAdherenceAllowanceSeconds)} allowed
                          {!d.shiftOver && d.breakTakenSeconds < d.breakAdherenceAllowanceSeconds && ' (any shortfall counts once the shift ends)'}.
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            <h3>Schedule</h3>
            {hasSchedule ? (
              <table>
                <thead>
                  <tr><th>Shift Type</th><th>Start</th><th>End</th></tr>
                </thead>
                <tbody>
                  {d.schedule.map((s) => (
                    <tr key={`${s.shiftType}-${s.start}`}>
                      <td>{s.shiftType}</td>
                      <td>{formatEasternTime(s.start, d.shiftDate)}</td>
                      <td>{formatEasternTime(s.end, d.shiftDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="live-detail-note">
                No schedule loaded for this day - Productive Hrs and adherence can't be measured until one is added.
              </p>
            )}

            <h3>Sentinel Desktop Logins</h3>
            <table>
              <thead>
                <tr><th>PC</th><th>Login</th><th>Logout</th><th title="Time not logged in since the previous logout">Gap Before</th></tr>
              </thead>
              <tbody>
                {d.sessions.map((s) => (
                  <tr key={`${s.machineName}-${s.start}`}>
                    <td>{s.machineName || '-'}</td>
                    <td>{formatEasternTime(s.start, d.shiftDate)}</td>
                    <td>
                      {s.end == null ? (
                        <em style={{ color: '#166534' }}>Still logged in</em>
                      ) : (
                        <>
                          {formatEasternTime(s.end, d.shiftDate)}
                          {s.logoutTrigger && (
                            <span className="live-detail-small"> ({LOGOUT_TRIGGER_LABELS[s.logoutTrigger] || s.logoutTrigger})</span>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {!s.gapBefore ? (
                        '-'
                      ) : (
                        <>
                          {formatDuration(s.gapBefore.seconds)}
                          <span className="live-detail-small">
                            {s.gapBefore.afterIdle
                              ? ' (not credited - logged out from Idle)'
                              : s.gapBefore.creditedSeconds > 0 ? ' (credited)' : ''}
                          </span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hasSchedule && d.sessions.length > 1 && (
              <p className="live-detail-note">
                Gaps between logins count toward adherence, unless the agent was in Idle right before logging out.
              </p>
            )}

            <h3>Aux Time This Shift</h3>
            <table>
              <thead>
                <tr>
                  <th>Aux</th>
                  <th>Logged</th>
                  {hasSchedule && <th title="Part of the logged time that falls inside scheduled hours">Within Schedule</th>}
                </tr>
              </thead>
              <tbody>
                {d.aux.map((a) => (
                  <tr key={a.auxCode}>
                    <td>
                      <span className="aux-badge" style={{ background: AUX_COLORS[a.auxCode] || '#6b7280' }}>{formatAuxLabel(a.auxCode)}</span>
                      {a.isProductive && <span className="live-detail-small"> productive</span>}
                    </td>
                    <td>{formatDuration(a.loggedSeconds)}</td>
                    {hasSchedule && <td>{formatDuration(a.countedSeconds)}</td>}
                  </tr>
                ))}
                <tr style={{ fontWeight: 600 }}>
                  <td>Total</td>
                  <td>{formatDuration(d.loggedSeconds)}</td>
                  {hasSchedule && <td>{formatDuration(d.countedSeconds)}</td>}
                </tr>
              </tbody>
            </table>
            {hasSchedule && outsideScheduleSeconds > 0 && (
              <p className="live-detail-note">
                {formatDuration(outsideScheduleSeconds)} was logged outside scheduled hours and doesn't count toward Productive Hrs or adherence.
              </p>
            )}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
