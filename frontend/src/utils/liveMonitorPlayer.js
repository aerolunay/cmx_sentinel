// Plays a live monitoring stream (see backend/services/liveMonitor.js)
// in a <video> element with the browser's MediaSource API - following
// live, or replaying from a point in the session (at, ms epoch).
//
// The stream is framed as [type u8][length u32 BE][payload]:
//   1 = init segment of an ffmpeg run on the agent's PC -> reset the player
//   2 = [float64 BE: ms epoch the fragment reached the server][media fragment]
//   3 = status JSON {status, message}
//   4 = timeline JSON {startedAt, oldest, latest} (ms epoch)
// The PC encodes H.264 baseline + AAC-LC, so the codec string is fixed.

const MIME = 'video/mp4; codecs="avc1.42C01F, mp4a.40.2"';
const FRAME_INIT = 1;
const FRAME_MEDIA = 2;
const FRAME_STATUS = 3;
const FRAME_TIMELINE = 4;
// Following live, play this far behind the newest video: the PC sends
// ~2s fragments, so sitting any closer means stalling for each one.
const LIVE_DELAY_SECONDS = 4;
const LIVE_MAX_LAG_SECONDS = 10; // further behind than this -> catch up
const KEEP_SECONDS = 120; // buffer kept behind the playhead

export function liveMonitoringSupported() {
  return typeof window.MediaSource !== 'undefined' && window.MediaSource.isTypeSupported(MIME);
}

/**
 * Plays sessionId into video. options:
 *   at        - ms epoch to replay from; omit to follow live
 *   onStatus(status, message) - 'waiting' | 'streaming' | 'paused' | 'ended' | 'error'
 *   onTimeline({startedAt, oldest, latest})
 * Returns { stop(), wallTime(), follow } - wallTime() is the ms epoch of
 * what's on screen (null before anything plays); set follow = false to
 * stop snapping to live (e.g. the user paused).
 */
export function playLiveMonitor(sessionId, video, { at = null, onStatus = () => {}, onTimeline = () => {} } = {}) {
  const abort = new AbortController();
  let mediaSource = null;
  let sourceBuffer = null;
  let objectUrl = null;
  let queue = []; // {data, t} - t null for the init segment
  let segments = []; // {start, end, t} - where each fragment landed in the buffer
  let generation = 0;

  const controller = {
    follow: at == null,
    stop,
    wallTime() {
      const now = video.currentTime;
      const seg = segments.find((s) => now >= s.start && now <= s.end + 0.25);
      if (!seg) return null;
      // t is when the fragment's last bit arrived - its end.
      return seg.t - (seg.end - now) * 1000;
    },
  };

  function resetPlayer(init) {
    generation += 1;
    const myGeneration = generation;
    queue = [{ data: init, t: null }];
    segments = [];
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
          afterAppend();
          pump();
        });
        pump();
      } catch (err) {
        onStatus('error', `This browser can't play the stream: ${err.message}`);
      }
    }, { once: true });
  }

  let appending = null;

  function bufferedEnd() {
    const b = sourceBuffer && sourceBuffer.buffered;
    return b && b.length ? b.end(b.length - 1) : 0;
  }

  function pump() {
    if (!sourceBuffer || sourceBuffer.updating || queue.length === 0) return;
    const item = queue.shift();
    appending = { t: item.t, start: bufferedEnd() };
    try {
      sourceBuffer.appendBuffer(item.data);
    } catch {
      // QuotaExceeded or a decode error: drop what's queued, the next
      // fragment (a keyframe) carries on.
      queue = [];
      appending = null;
    }
  }

  function afterAppend() {
    if (appending && appending.t != null) {
      const end = bufferedEnd();
      if (end > appending.start) segments.push({ start: appending.start, end, t: appending.t });
    }
    appending = null;

    const buffered = sourceBuffer.buffered;
    if (buffered.length === 0) return;
    const start = buffered.start(0);
    const end = buffered.end(buffered.length - 1);

    if (controller.follow) {
      const target = Math.max(start, end - LIVE_DELAY_SECONDS);
      if (end - video.currentTime > LIVE_MAX_LAG_SECONDS || video.currentTime < start) {
        video.currentTime = target;
      }
      if (video.paused && !video.ended) video.play().catch(() => {});
    } else if (video.currentTime < start) {
      video.currentTime = start;
      // A replay starts playing on its own; a paused one stays paused.
      if (video.paused && !controller.userPaused) video.play().catch(() => {});
    } else if (video.paused && !controller.userPaused && segments.length <= 2) {
      video.play().catch(() => {});
    }

    if (video.currentTime - start > KEEP_SECONDS && !sourceBuffer.updating) {
      const cut = video.currentTime - 60;
      try {
        sourceBuffer.remove(start, cut);
        segments = segments.filter((s) => s.end > cut);
      } catch { /* next time */ }
    }
  }

  function handleFrame(type, payload) {
    if (type === FRAME_INIT) {
      resetPlayer(payload);
    } else if (type === FRAME_MEDIA) {
      if (!mediaSource) return; // no init yet
      const t = new DataView(payload.buffer, payload.byteOffset, 8).getFloat64(0);
      queue.push({ data: payload.subarray(8), t });
      pump();
    } else if (type === FRAME_STATUS) {
      const { status, message } = JSON.parse(new TextDecoder().decode(payload));
      onStatus(status, message);
    } else if (type === FRAME_TIMELINE) {
      onTimeline(JSON.parse(new TextDecoder().decode(payload)));
    }
  }

  (async () => {
    try {
      const query = at != null ? `?at=${Math.round(at)}` : '';
      const response = await fetch(`/api/monitor/sessions/${encodeURIComponent(sessionId)}/stream${query}`, {
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
      if (!abort.signal.aborted) onStatus('ended', 'The live session ended.');
    } catch (err) {
      if (!abort.signal.aborted) onStatus('error', `The stream was interrupted: ${err.message}`);
    }
  })();

  function stop() {
    abort.abort();
    generation += 1;
    video.removeAttribute('src');
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  return controller;
}
