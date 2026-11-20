import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { liveMonitoringSupported, playLiveMonitor } from '../utils/liveMonitorPlayer.js';

const STATUS_TEXT = {
  starting: 'Connecting to the agent\'s PC...',
  waiting: 'Waiting for the agent\'s PC to start streaming...',
  streaming: null,
  paused: 'Stream paused.',
  ended: 'Live monitoring ended.',
  error: 'Live monitoring stopped.',
};

// How long to wait for the first picture before saying something's wrong.
const NO_STREAM_WARNING_MS = 25000;

// Live view of one agent: their screen, and their PC's audio - what the
// caller says, plus the agent's mic while a call is active.
export default function LiveMonitorModal({ agent, onClose }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('starting');
  const [message, setMessage] = useState('');
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!liveMonitoringSupported()) {
      setStatus('error');
      setMessage('This browser can\'t play live streams - use a current Chrome, Edge or Firefox.');
      return undefined;
    }

    let stop = null;
    let cancelled = false;
    const slowTimer = setTimeout(() => setSlow(true), NO_STREAM_WARNING_MS);

    api.startLiveMonitor(agent.agentId)
      .then(({ sessionId }) => {
        if (cancelled) return;
        stop = playLiveMonitor(sessionId, videoRef.current, (s, m) => {
          setStatus(s);
          setMessage(m || '');
          if (s === 'streaming') setSlow(false);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setMessage(err.message);
      });

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      if (stop) stop();
    };
  }, [agent.agentId]);

  const overlay = STATUS_TEXT[status];
  const stillWaiting = slow && (status === 'starting' || status === 'waiting');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box"
        style={{ width: 'min(1100px, calc(100vw - 32px))', maxWidth: 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {status === 'streaming' && <span className="live-dot" aria-hidden="true" />}
          Live: {agent.displayName}
        </h2>
        <p style={{ fontSize: 13, color: '#666', marginTop: -12 }}>
          {agent.agentId}{agent.groupName && ` · ${agent.groupName}`} · {agent.machineName}
        </p>

        <div style={{ position: 'relative', background: '#000', borderRadius: 6, overflow: 'hidden' }}>
          <video
            ref={videoRef}
            controls
            autoPlay
            playsInline
            style={{ width: '100%', display: 'block', minHeight: 240, maxHeight: '70vh', background: '#000' }}
          />
          {overlay && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', color: '#fff', textAlign: 'center', padding: 16, pointerEvents: 'none',
              background: 'rgba(0,0,0,0.55)',
            }}>
              <div style={{ fontSize: 16 }}>{overlay}</div>
              {message && message !== overlay && <div style={{ fontSize: 13, marginTop: 6, opacity: 0.85 }}>{message}</div>}
              {stillWaiting && (
                <div style={{ fontSize: 13, marginTop: 10, opacity: 0.85 }}>
                  Still nothing from the PC. It may be offline, or the agent left Production.
                </div>
              )}
            </div>
          )}
        </div>

        <p style={{ fontSize: 12, color: '#666', margin: '8px 0 0' }}>
          Audio: what plays on the agent's PC (the caller), plus the agent's microphone while a call is active.
          Use the player's volume control if you can't hear anything. Nothing is recorded.
        </p>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Stop watching</button>
        </div>
      </div>
    </div>
  );
}
