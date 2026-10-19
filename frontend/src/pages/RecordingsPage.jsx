import { useEffect, useMemo, useState } from 'react';
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

export default function RecordingsPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [recordings, setRecordings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [dateFrom, setDateFrom] = useState(getTodayEastern());
  const [dateTo, setDateTo] = useState(getTodayEastern());
  const [playingRecording, setPlayingRecording] = useState(null);
  const [downloadingKey, setDownloadingKey] = useState(null);

  // Reloaded whenever the date range changes - the server only returns
  // recordings inside it (the full bucket is far too many files to send
  // to the browser).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .listRecordings({ dateFrom, dateTo })
      .then((data) => { if (!cancelled) setRecordings(data); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dateFrom, dateTo]);

  // Derived from whatever recordings are actually loaded, rather than
  // a separate agents API call - Recordings is open to all four web
  // roles, but /api/agents is admin-only, so this avoids a permissions
  // mismatch while still giving a real, accurate dropdown.
  const agentOptions = useMemo(() => {
    const seen = new Map();
    for (const r of recordings) {
      if (!seen.has(r.agentId)) seen.set(r.agentId, agentName(r));
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [recordings]);

  // Client-side filter for now - fine at current volume, see
  // recordingRoutes.js's comment about revisiting this if the list
  // grows large enough to need server-side filtering instead.
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return recordings.filter((r) => {
      if (agentFilter && r.agentId !== agentFilter) return false;
      // String comparison works correctly here since recordedDateEastern
      // is always YYYY-MM-DD (zero-padded ISO format) - lexicographic
      // order matches chronological order. Either bound can be empty,
      // meaning "no lower/upper limit" independently of the other.
      if (dateFrom && r.recordedDateEastern < dateFrom) return false;
      if (dateTo && r.recordedDateEastern > dateTo) return false;
      if (term && !agentName(r).toLowerCase().includes(term) && !r.sanitizedName.includes(term) && !r.agentId.includes(term)) {
        return false;
      }
      return true;
    });
  }, [recordings, search, agentFilter, dateFrom, dateTo]);

  function clearDates() {
    setDateFrom('');
    setDateTo('');
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Recordings</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
          >
            <option value="">All Agents</option>
            {agentOptions.map(([id, name]) => (
              <option key={id} value={id}>{name} ({id})</option>
            ))}
          </select>

          <label style={{ fontSize: 13, color: '#555' }}>From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
          />
          <label style={{ fontSize: 13, color: '#555' }}>To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
          />
          {(dateFrom || dateTo) && (
            <button type="button" className="btn-link" onClick={clearDates}>Clear dates</button>
          )}

          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', width: 160, fontSize: 14 }}
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
              <th>Date/Time</th>
              <th>Size</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={5}>No recordings found for this filter.</td></tr>
            ) : (
              filtered.map((r) => (
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
