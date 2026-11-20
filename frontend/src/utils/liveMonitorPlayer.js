// Plays a live monitoring stream (see backend/services/liveMonitor.js)
// in a <video> element with the browser's MediaSource API.
//
// The stream is framed as [type u8][length u32 BE][payload]:
//   1 = init segment of a new ffmpeg run on the agent's PC -> reset the player
//   2 = media fragment (starts on a keyframe, ~2s each)
//   3 = status JSON {status, message}
// The PC encodes H.264 baseline + AAC-LC, so the codec string is fixed.

const MIME = 'video/mp4; codecs="avc1.42C01F, mp4a.40.2"';
const FRAME_INIT = 1;
const FRAME_MEDIA = 2;
const FRAME_STATUS = 3;
const MAX_LAG_SECONDS = 3; // further behind live than this -> jump to live
const KEEP_SECONDS = 30; // buffer kept behind the playhead

export function liveMonitoringSupported() {
  return typeof window.MediaSource !== 'undefined' && window.MediaSource.isTypeSupported(MIME);
}

/**
 * Starts playing sessionId into video. onStatus(status, message) gets
 * 'waiting' | 'streaming' | 'paused' | 'ended' | 'error'. Returns a
 * stop() function.
 */
export function playLiveMonitor(sessionId, video, onStatus) {
  const abort = new AbortController();
  let mediaSource = null;
  let sourceBuffer = null;
  let objectUrl = null;
  let queue = [];
  let generation = 0;

  function resetPlayer(init) {
    generation += 1;
    const myGeneration = generation;
    queue = [init];
    sourceBuffer = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    mediaSource = new MediaSource();
    objectUrl = URL.createObjectURL(mediaSource);
    video.src = objectUrl;
    mediaSource.addEventListener('sourceopen', () => {
      if (myGeneration !== generation) return;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(MIME);
        sourceBuffer.mode = 'segments';
        sourceBuffer.addEventListener('updateend', () => {
          if (myGeneration !== generation) return;
          keepLive();
          pump();
        });
        pump();
      } catch (err) {
        onStatus('error', `This browser can't play the stream: ${err.message}`);
      }
    }, { once: true });
  }

  function pump() {
    if (!sourceBuffer || sourceBuffer.updating || queue.length === 0) return;
    try {
      sourceBuffer.appendBuffer(queue.shift());
    } catch (err) {
      // QuotaExceeded or a decode error: drop what's queued, the next
      // fragment (a keyframe) carries on.
      queue = [];
    }
  }

  function keepLive() {
    const buffered = video.buffered;
    if (buffered.length === 0) return;
    const end = buffered.end(buffered.length - 1);
    if (end - video.currentTime > MAX_LAG_SECONDS || video.currentTime < buffered.start(0)) {
      video.currentTime = Math.max(buffered.start(buffered.length - 1), end - 0.5);
    }
    if (video.paused && !video.ended) video.play().catch(() => {});
    const start = buffered.start(0);
    if (video.currentTime - start > KEEP_SECONDS && !sourceBuffer.updating) {
      try { sourceBuffer.remove(start, video.currentTime - 10); } catch { /* next time */ }
    }
  }

  function handleFrame(type, payload) {
    if (type === FRAME_INIT) {
      resetPlayer(payload);
    } else if (type === FRAME_MEDIA) {
      if (!mediaSource) return; // no init yet
      queue.push(payload);
      pump();
    } else if (type === FRAME_STATUS) {
      const { status, message } = JSON.parse(new TextDecoder().decode(payload));
      if (status !== 'ping') onStatus(status, message);
    }
  }

  (async () => {
    try {
      const response = await fetch(`/api/monitor/sessions/${encodeURIComponent(sessionId)}/stream`, {
        credentials: 'include',
        signal: abort.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        onStatus('ended', data.error || `Could not open the stream (${response.status}).`);
        return;
      }
      const reader = response.body.getReader();
      let pending = new Uint8Array(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const merged = new Uint8Array(pending.length + value.length);
        merged.set(pending);
        merged.set(value, pending.length);
        pending = merged;

        let offset = 0;
        while (pending.length - offset >= 5) {
          const view = new DataView(pending.buffer, pending.byteOffset + offset);
          const type = view.getUint8(0);
          const length = view.getUint32(1);
          if (pending.length - offset - 5 < length) break;
          handleFrame(type, pending.slice(offset + 5, offset + 5 + length));
          offset += 5 + length;
        }
        pending = pending.slice(offset);
      }
      onStatus('ended', 'The live session ended.');
    } catch (err) {
      if (!abort.signal.aborted) onStatus('error', `The stream was interrupted: ${err.message}`);
    }
  })();

  return function stop() {
    abort.abort();
    generation += 1;
    video.removeAttribute('src');
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}
