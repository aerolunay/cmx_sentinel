import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { liveMonitoringSupported, playLiveMonitor } from '../utils/liveMonitorPlayer.js';

const STATUS_TEXT = {
  starting: 'Connecting to the agent\'s PC...',
  waiting: 'Waiting for the agent\'s PC to start streaming...',
  streaming: null,
  paused: null, // shown as a note under the video - earlier parts still play
  ended: 'Live monitoring ended.',
  error: 'Live monitoring stopped.',
};

// How long to wait for the first picture before saying something's wrong.
const NO_STREAM_WARNING_MS = 25000;
// Dropping the slider this close to the newest video goes back to live.
const LIVE_SNAP_MS = 6000;

function formatClock(ms) {
  return ms == null ? '--:--:--' : new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function formatBehind(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// Live view of one agent: their screen, and their PC's audio - what the
// caller says, plus the agent's mic while a call is active. The session
// is kept on the server while it's open (last 60 minutes), so the viewer
// can go back with the timeline and return with "Go live".
export default function LiveMonitorModal({ agent, onClose }) {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const [sessionId, setSessionId] = useState(null);
  const [replayFrom, setReplayFrom] = useState({ at: null }); // new object = restart the player
  const [status, setStatus] = useState('starting');
  const [message, setMessage] = useState('');
  const [slow, setSlow] = useState(false);
  const [timeline, setTimeline] = useState(null);
  const [position, setPosition] = useState(null);
  const [dragValue, setDragValue] = useState(null);
  const [paused, setPaused] = useState(false);
  const [following, setFollowing] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);

  // Start (or join) the agent's session once.
  useEffect(() => {
    if (!liveMonitoringSupported()) {
      setStatus('error');
      setMessage('This browser can\'t play live streams - use a current Chrome, Edge or Firefox.');
      return undefined;
    }
    let cancelled = false;
    const slowTimer = setTimeout(() => setSlow(true), NO_STREAM_WARNING_MS);
    api.startLiveMonitor(agent.agentId)
      .then(({ sessionId: id }) => { if (!cancelled) setSessionId(id); })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setMessage(err.message);
      });
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
    };
  }, [agent.agentId]);

  // (Re)start the player - live, or from a point on the timeline.
  useEffect(() => {
    if (!sessionId) return undefined;
    const player = playLiveMonitor(sessionId, videoRef.current, {
      at: replayFrom.at,
      onStatus: (s, m) => {
        setStatus(s);
        setMessage(m || '');
        if (s === 'streaming') setSlow(false);
      },
      onTimeline: setTimeline,
    });
    playerRef.current = player;
    setFollowing(replayFrom.at == null);
    setPaused(false);
    return () => player.stop();
  }, [sessionId, replayFrom]);

  // Where playback is, as wall-clock time.
  useEffect(() => {
    const id = setInterval(() => {
      const t = playerRef.current && playerRef.current.wallTime();
      if (t != null) setPosition(t);
      const v = videoRef.current;
      if (v) setPaused(v.paused);
    }, 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.muted = muted;
      v.volume = volume;
    }
  }, [muted, volume]);

  function togglePlay() {
    const v = videoRef.current;
    const player = playerRef.current;
    if (!v || !player) return;
    if (v.paused) {
      player.userPaused = false;
      v.play().catch(() => {});
    } else {
      // Pausing leaves live - playing again carries on from here.
      player.userPaused = true;
      player.follow = false;
      setFollowing(false);
      v.pause();
    }
  }

  function goLive() {
    setDragValue(null);
    setReplayFrom({ at: null });
  }

  function commitSeek(value) {
    setDragValue(null);
    if (timeline?.latest != null && value >= timeline.latest - LIVE_SNAP_MS) {
      goLive();
    } else {
      setPosition(value);
      setReplayFrom({ at: value });
    }
  }

  const overlay = STATUS_TEXT[status];
  const stillWaiting = slow && (status === 'starting' || status === 'waiting');
  const min = timeline?.oldest ?? timeline?.startedAt ?? 0;
  const max = timeline?.latest ?? min;
  const hasHistory = timeline?.latest != null && max > min;
  const shown = dragValue ?? position ?? max;
  const behindMs = timeline?.latest != null && shown != null ? timeline.latest - shown : 0;
  const isLive = following && !paused;

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
            playsInline
            onClick={togglePlay}
            style={{ width: '100%', display: 'block', minHeight: 240, maxHeight: '65vh', background: '#000', cursor: 'pointer' }}
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" onClick={togglePlay} style={{ minWidth: 72 }} disabled={!sessionId}>
            {paused ? 'Play' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={goLive}
            disabled={!sessionId || isLive}
            title={isLive ? 'Watching live' : 'Jump to live'}
            style={{
              border: 'none', borderRadius: 12, padding: '4px 12px', fontWeight: 600, fontSize: 12,
              cursor: isLive ? 'default' : 'pointer',
              background: isLive ? '#e53935' : '#e0e0e0', color: isLive ? '#fff' : '#333',
            }}
          >
            {isLive ? '● LIVE' : 'Go live'}
          </button>
          <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', minWidth: 96 }}>{formatClock(shown)}</span>
          <input
            type="range"
            aria-label="Monitoring timeline"
            min={min}
            max={max}
            step={1000}
            value={Math.min(max, Math.max(min, shown ?? max))}
            disabled={!hasHistory}
            onChange={(e) => setDragValue(Number(e.target.value))}
            onPointerUp={(e) => commitSeek(Number(e.currentTarget.value))}
            onKeyUp={(e) => commitSeek(Number(e.currentTarget.value))}
            style={{ flex: '1 1 240px', margin: 0, width: 'auto' }}
          />
          <span style={{ fontSize: 12, color: '#666', minWidth: 90, textAlign: 'right' }}>
            {isLive ? 'live' : `${formatBehind(behindMs)} behind`}
          </span>
          <button type="button" className="btn-secondary" onClick={() => setMuted((m) => !m)} style={{ minWidth: 72 }}>
            {muted ? 'Unmute' : 'Mute'}
          </button>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => { setVolume(Number(e.target.value)); setMuted(false); }}
            style={{ width: 90, margin: 0 }}
          />
        </div>

        {status === 'paused' && message && (
          <p style={{ fontSize: 12, color: '#b26a00', margin: '8px 0 0' }}>{message}</p>
        )}
        <p style={{ fontSize: 12, color: '#666', margin: '8px 0 0' }}>
          Audio: what plays on the agent's PC (the caller), plus the agent's microphone while a call is active.
          Drag the timeline to go back (up to {formatClock(timeline?.oldest ?? null)}). The video is kept on the
          server only while someone is watching, and deleted when monitoring stops.
        </p>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Stop watching</button>
        </div>
      </div>
    </div>
  );
}
