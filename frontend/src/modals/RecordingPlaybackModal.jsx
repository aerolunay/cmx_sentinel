import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function RecordingPlaybackModal({ recording, onClose }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .getRecordingUrl(recording.key)
      .then((result) => {
        if (!cancelled) setUrl(result.url);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => { cancelled = true; };
  }, [recording.key]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-wide" onClick={(e) => e.stopPropagation()}>
        <h2>{recording.sanitizedName} &middot; {recording.agentId}</h2>
        <p style={{ fontSize: 13, color: '#666', marginTop: -12 }}>
          {new Date(recording.recordedAt).toLocaleString()}
        </p>

        {error && <div className="error">{error}</div>}

        {url ? (
          <video src={url} controls autoPlay style={{ width: '100%', borderRadius: 6, background: '#000' }} />
        ) : !error ? (
          <p>Loading video...</p>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
