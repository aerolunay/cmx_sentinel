import { useEffect, useState } from 'react';
import { api } from '../api.js';
import RecordingPlaybackModal from '../modals/RecordingPlaybackModal.jsx';
import { useAuth } from '../context/AuthContext.jsx';

// Full name from the agents table when the agent still exists there,
// otherwise the lowercase name baked into the recording's filename.
function agentName(r) {
  return r.displayName || r.sanitizedName;
}

function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Today's date in EASTERN time specifically, not the browser's own
// local timezone (which could be different) - en-CA locale
// conveniently formats as YYYY-MM-DD, matching what <input type="date">
// expects directly, no manual string building needed.
function getTodayEastern() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Always shown in Eastern, regardless of the viewer's own browser
// timezone - these are Eastern-business-hours call recordings, an
// admin reviewing from a different timezone should still see the time
// it actually happened locally at the call center, not their own.
function formatEastern(isoString) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(isoString));
}

const ALL_AGENTS = '__all__';
// Each search is one S3 lookup per agent per day (see
// MAX_DAYS_PER_LOOKUP in recordingRoutes.js), so "All agents" (~85
// lookups a day, ~1,000+ files a day) gets a much shorter limit than a
// single agent.
const MAX_RANGE_DAYS = 62;
const MAX_RANGE_DAYS_ALL_AGENTS = 7;

// Inclusive day count between two YYYY-MM-DD dates.
function daysBetween(from, to) {
  const toUtc = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86400000) + 1;
}

export default function RecordingsPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [agents, setAgents] = useState([]);
  const [agentChoice, setAgentChoice] = useState(''); // '' = not chosen yet, ALL_AGENTS, or an agent ID
  const [dateFrom, setDateFrom] = useState(getTodayEastern());
  const [dateTo, setDateTo] = useState(getTodayEastern());
  const [recordings, setRecordings] = useState([]);
  const [searched, setSearched] = useState(null); // what the shown results are for
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [playingRecording, setPlayingRecording] = useState(null);
  const [downloadingKey, setDownloadingKey] = useState(null);

  // Only the agent list loads automatically (from the database, not S3).
  // Recordings are fetched from S3 only when Search is clicked.
  useEffect(() => {
    api.listRecordingAgents()
      .then(setAgents)
      .catch((err) => setError(err.message));
  }, []);

  const maxDays = agentChoice === ALL_AGENTS ? MAX_RANGE_DAYS_ALL_AGENTS : MAX_RANGE_DAYS;
  const rangeProblem = !dateFrom || !dateTo
    ? 'Choose a From and To date.'
    : dateFrom > dateTo
      ? 'From must be on or before To.'
      : daysBetween(dateFrom, dateTo) > maxDays
        ? `Choose a range of ${maxDays} days or less${agentChoice === ALL_AGENTS ? ' for All agents' : ''}.`
        : '';
  const canSearch = Boolean(agentChoice) && !rangeProblem && !loading;

  async function handleSearch(e) {
    e.preventDefault();
    if (!canSearch) return;
    setLoading(true);
    setError('');
    try {
      const agentId = agentChoice === ALL_AGENTS ? '' : agentChoice;
      const data = await api.listRecordings({ agentId, dateFrom, dateTo });
      setRecordings(data);
      const agent = agents.find((a) => a.agentId === agentChoice);
      setSearched({ label: agent ? agent.displayName : 'All agents', dateFrom, dateTo });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload(recording) {
    setError('');
    setDownloadingKey(recording.key);
    try {
      const { url } = await api.getRecordingDownloadUrl(recording.key);
      // Presigned URL already carries ResponseContentDisposition:
      // attachment (set server-side), so navigating to it triggers a
      // real file save rather than playing inline - no need for an
      // <a download> attribute, which wouldn't work cross-origin
      // against S3 anyway.
      window.location.href = url;
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloadingKey(null);
    }
  }

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Recordings</h2>

      <form
        onSubmit={handleSearch}
        style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}
      >
        <select
          value={agentChoice}
          onChange={(e) => setAgentChoice(e.target.value)}
          style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14, maxWidth: 280 }}
        >
          <option value="" disabled>Select agent...</option>
          <option value={ALL_AGENTS}>All agents</option>
          {agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>{a.displayName} ({a.agentId})</option>
          ))}
        </select>

        <label style={{ fontSize: 13, color: '#555' }}>From</label>
        <input
          type="date"
          value={dateFrom}
          max={dateTo || undefined}
          onChange={(e) => setDateFrom(e.target.value)}
          style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
        />
        <label style={{ fontSize: 13, color: '#555' }}>To</label>
        <input
          type="date"
          value={dateTo}
          min={dateFrom || undefined}
          onChange={(e) => setDateTo(e.target.value)}
          style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
        />

        <button type="submit" className="btn" disabled={!canSearch}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {agentChoice && rangeProblem && <div className="error" style={{ textAlign: 'left' }}>{rangeProblem}</div>}
      {error && <div className="error">{error}</div>}

      {searched && !loading && (
        <p style={{ fontSize: 13, color: '#666', margin: '0 0 12px' }}>
          {recordings.length} recording{recordings.length === 1 ? '' : 's'} for <strong>{searched.label}</strong>,{' '}
          {searched.dateFrom === searched.dateTo ? searched.dateFrom : `${searched.dateFrom} to ${searched.dateTo}`}.
        </p>
      )}

      {loading ? (
        <p>Searching...</p>
      ) : !searched ? (
        <p style={{ color: '#666' }}>Select an agent and date range, then click Search.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Agent ID</th>
              <th>Date/Time</th>
              <th>Size</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {recordings.length === 0 ? (
              <tr><td colSpan={5}>No recordings found for this agent and date range.</td></tr>
            ) : (
              recordings.map((r) => (
                <tr key={r.key}>
                  <td style={r.displayName ? undefined : { textTransform: 'capitalize' }}>{agentName(r)}</td>
                  <td>{r.agentId}</td>
                  <td>{formatEastern(r.recordedAt)}</td>
                  <td>{formatSize(r.sizeBytes)}</td>
                  <td>
                    {r.isArchived ? (
                      // Per explicit request - once archived, a
                      // recording is genuinely gone from this app's
                      // reach for every role, including super_admin.
                      // No Play/Download control at all, just a
                      // record of what happened to it.
                      <span style={{ fontSize: 13, color: '#888' }}>
                        Archived to local storage on {formatEastern(r.archivedAt)}
                      </span>
                    ) : (
                      <>
                        <button className="btn-link" onClick={() => setPlayingRecording(r)}>Play</button>
                        {isSuperAdmin && (
                          <>
                            {' | '}
                            <button
                              className="btn-link"
                              onClick={() => handleDownload(r)}
                              disabled={downloadingKey === r.key}
                            >
                              {downloadingKey === r.key ? 'Preparing...' : 'Download'}
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {playingRecording && (
        <RecordingPlaybackModal
          recording={playingRecording}
          onClose={() => setPlayingRecording(null)}
        />
      )}
    </>
  );
}
