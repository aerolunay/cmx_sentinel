"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const sessionOwnership = require("./sessionOwnership");

// Live monitoring (desktop 2.4.16+): a web user watches an agent's screen
// and hears their PC's audio (call audio, plus the agent's mic while a
// call is active) as it happens - and can go back to any point of the
// session so far.
//
//   1. start() pushes "monitor_start" {sessionId, token} down the agent's
//      existing SSE connection (sessionOwnership).
//   2. The agent's tray runs a separate ffmpeg (nothing saved on the PC)
//      and POSTs its fragmented MP4 to /api/monitor-ingest/:sessionId
//      with the token - acceptIngest() below.
//   3. Each ~2s fragment is kept in a temporary folder for the session
//      (the last MAX_HISTORY_MS of it). Each viewer holds GET
//      /api/monitor/sessions/:id/stream open - live, or from ?at=<ms>
//      for replay - and gets fragments re-framed for the browser's
//      MediaSource player.
//   4. Once the last viewer leaves, the session ends after a short grace
//      period: "monitor_stop" tells the PC to stop streaming and the
//      session's folder is deleted.
//
// One session per agent, shared by every viewer. A backend restart ends
// every session and clears the folder. Requires a single backend process,
// as sessionOwnership already does.

// Frames sent to viewers: [type u8][length u32 BE][payload].
const FRAME_INIT = 1; // ftyp+moov of an ffmpeg run - viewer resets its player
const FRAME_MEDIA = 2; // [float64 BE: ms epoch the fragment arrived][moof+mdat], each starting on a keyframe (~2s)
const FRAME_STATUS = 3; // JSON {status, message}
const FRAME_TIMELINE = 4; // JSON {startedAt, oldest, latest} (ms epoch) - also the keep-alive

const LEFT_END_MS = 3 * 1000; // last viewer left -> end (survives a page refresh)
const NEVER_JOINED_END_MS = 20 * 1000; // nobody opened it yet (page still loading)
const MAX_HISTORY_MS = 60 * 60 * 1000; // how far back viewers can go
const LIVE_BACKLOG_FRAGMENTS = 2; // a live viewer starts ~4s back, so playback has a cushion
const LIVE_MAX_LAG_MS = 15 * 1000; // a live viewer this far behind skips ahead
const REPLAY_LEAD_MS = 6 * 1000; // replay is sent this far ahead of playback
const MEMORY_CACHE_FRAGMENTS = 20;
const TIMELINE_EVERY_MS = 2000;
const MAX_BOX_BYTES = 32 * 1024 * 1024;

const STORAGE_ROOT = process.env.LIVE_MONITOR_DIR || path.join(os.tmpdir(), "cmx-sentinel-live");

// Leftovers from before a restart belong to sessions that no longer exist.
try {
  fs.rmSync(STORAGE_ROOT, { recursive: true, force: true });
} catch (err) {
  console.error("Could not clear old live monitoring files:", err.message);
}

const sessions = new Map(); // sessionId -> session
const byAgent = new Map(); // agentId -> sessionId

function frame(type, payload) {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function jsonFrame(type, obj) {
  return frame(type, Buffer.from(JSON.stringify(obj)));
}

function statusFrame(status, message) {
  return jsonFrame(FRAME_STATUS, { status, message: message || null });
}

function mediaFrame(t, data) {
  const stamp = Buffer.alloc(8);
  stamp.writeDoubleBE(t, 0);
  return frame(FRAME_MEDIA, Buffer.concat([stamp, data]));
}

function timelineFrame(session) {
  const first = session.frags[0];
  const last = session.frags[session.frags.length - 1];
  return jsonFrame(FRAME_TIMELINE, {
    startedAt: session.startedAt.getTime(),
    oldest: first ? first.t : null,
    latest: last ? last.t : null,
  });
}

function write(viewer, buf) {
  if (!viewer.closed && !viewer.res.writableEnded) return viewer.res.write(buf);
  return true;
}

function broadcast(session, buf) {
  for (const viewer of session.viewers) write(viewer, buf);
}

function tokensMatch(expected, provided) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- session lifecycle ------------------------------------------------------

function scheduleIdleEnd(session, delayMs = LEFT_END_MS) {
  clearTimeout(session.idleTimer);
  if (session.viewers.size > 0) return;
  session.idleTimer = setTimeout(() => endSession(session, "No one is watching."), delayMs);
}

function endSession(session, reason) {
  if (session.ended) return;
  session.ended = true;
  clearTimeout(session.idleTimer);
  clearInterval(session.timelineTimer);
  sessions.delete(session.id);
  if (byAgent.get(session.agentId) === session.id) byAgent.delete(session.agentId);

  sessionOwnership.push(session.agentId, "monitor_stop", { sessionId: session.id });
  if (session.ingest) session.ingest.destroy();
  for (const viewer of session.viewers) {
    if (!viewer.res.writableEnded) {
      viewer.res.write(statusFrame("ended", reason));
      viewer.res.end();
    }
  }
  session.viewers.clear();
  wake(session);
  session.cache.clear();
  fsp.rm(session.dir, { recursive: true, force: true }).catch((err) =>
    console.error(`Could not delete live monitoring files of ${session.id}:`, err.message));
}

/**
 * Starts (or joins) live monitoring of an agent. Returns {sessionId} or
 * {error} when the agent's PC isn't connected.
 */
function start(agentId, startedBy) {
  const existingId = byAgent.get(agentId);
  const existing = existingId && sessions.get(existingId);
  const machineName = sessionOwnership.connectedMachine(agentId);

  if (existing && existing.machineName === machineName) {
    // Re-send in case the PC reconnected since (harmless if it's streaming).
    sessionOwnership.push(agentId, "monitor_start", { sessionId: existing.id, token: existing.token });
    return { sessionId: existing.id };
  }
  if (existing) endSession(existing, "The agent moved to another PC.");
  if (!machineName) {
    return { error: "The agent's PC is not connected to Sentinel right now." };
  }

  const id = crypto.randomUUID();
  const session = {
    id,
    token: crypto.randomBytes(32).toString("hex"),
    agentId,
    machineName,
    startedBy,
    startedAt: new Date(),
    dir: path.join(STORAGE_ROOT, id),
    viewers: new Set(),
    ingest: null,
    streaming: false,
    gen: 0, // one per ffmpeg run on the PC (each has its own init segment)
    inits: new Map(), // gen -> init segment
    frags: [], // {seq, gen, t, file, written}, oldest first
    nextSeq: 0,
    cache: new Map(), // seq -> Buffer, the most recent fragments
    waiters: new Set(), // viewers waiting for the next fragment
    idleTimer: null,
    timelineTimer: null,
    ended: false,
  };
  fs.mkdirSync(session.dir, { recursive: true });
  sessions.set(id, session);
  byAgent.set(agentId, id);
  session.timelineTimer = setInterval(() => broadcast(session, timelineFrame(session)), TIMELINE_EVERY_MS);

  if (!sessionOwnership.push(agentId, "monitor_start", { sessionId: id, token: session.token })) {
    endSession(session, "The agent's PC is not connected.");
    return { error: "The agent's PC is not connected to Sentinel right now." };
  }
  scheduleIdleEnd(session, NEVER_JOINED_END_MS); // ends it if no viewer ever attaches
  return { sessionId: id };
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

// --- storing fragments -------------------------------------------------------

function wake(session) {
  for (const resolve of session.waiters) resolve();
  session.waiters.clear();
}

function addFragment(session, data) {
  const seq = session.nextSeq++;
  const file = path.join(session.dir, `${seq}.m4s`);
  const frag = { seq, gen: session.gen, t: Date.now(), file, written: null };
  frag.written = fsp.writeFile(file, data).then(() => true, (err) => {
    console.error(`Live monitor ${session.id}: could not store fragment ${seq}:`, err.message);
    return false;
  });
  session.frags.push(frag);
  session.cache.set(seq, data);
  if (session.cache.size > MEMORY_CACHE_FRAGMENTS) session.cache.delete(session.cache.keys().next().value);

  // Keep only the last MAX_HISTORY_MS.
  while (session.frags.length > 1 && session.frags[0].t < frag.t - MAX_HISTORY_MS) {
    const old = session.frags.shift();
    session.cache.delete(old.seq);
    old.written.then(() => fsp.unlink(old.file)).catch(() => {});
  }
  for (const gen of session.inits.keys()) {
    if (gen < session.frags[0].gen) session.inits.delete(gen);
  }
  wake(session);
}

async function readFragment(session, frag) {
  const cached = session.cache.get(frag.seq);
  if (cached) return cached;
  if (!(await frag.written)) return null;
  try {
    return await fsp.readFile(frag.file);
  } catch {
    return null; // expired meanwhile
  }
}

/** First stored fragment with seq >= cursor, or null. */
function fragmentAt(session, cursor) {
  const frags = session.frags;
  if (frags.length === 0) return null;
  const index = Math.max(0, cursor - frags[0].seq);
  return index < frags.length ? frags[index] : null;
}

// --- viewers -----------------------------------------------------------------

function startCursor(session, atMs) {
  const frags = session.frags;
  if (frags.length === 0) return session.nextSeq;
  if (atMs != null) {
    const match = frags.find((f) => f.t >= atMs);
    return match ? match.seq : frags[frags.length - 1].seq;
  }
  // Live: a couple of fragments back, within the current ffmpeg run.
  const last = frags[frags.length - 1];
  let start = last;
  for (let i = frags.length - 2; i >= 0 && frags.length - 1 - i <= LIVE_BACKLOG_FRAGMENTS - 1; i--) {
    if (frags[i].gen !== last.gen) break;
    start = frags[i];
  }
  return start.seq;
}

function waitForNext(session, viewer) {
  return new Promise((resolve) => {
    session.waiters.add(resolve);
    viewer.wake = resolve;
    setTimeout(resolve, 5000);
  });
}

function waitForDrain(viewer) {
  return new Promise((resolve) => {
    const done = () => {
      viewer.res.off("drain", done);
      viewer.res.off("close", done);
      resolve();
    };
    viewer.res.on("drain", done);
    viewer.res.on("close", done);
  });
}

// Sends one viewer its fragments in order: live ones as they arrive, or a
// replay paced to real time (REPLAY_LEAD_MS ahead) so the browser isn't
// handed an hour of video at once.
async function pumpViewer(session, viewer) {
  while (!viewer.closed && !session.ended) {
    const frag = fragmentAt(session, viewer.cursor);
    if (!frag) {
      await waitForNext(session, viewer);
      continue;
    }

    if (viewer.live) {
      const latest = session.frags[session.frags.length - 1];
      if (latest.t - frag.t > LIVE_MAX_LAG_MS) {
        viewer.cursor = startCursor(session, null); // fell behind - back to live
        continue;
      }
    } else {
      if (viewer.replayFirstT == null) {
        viewer.replayFirstT = frag.t;
        viewer.replayWallStart = Date.now();
      }
      const due = viewer.replayWallStart + (frag.t - viewer.replayFirstT) - REPLAY_LEAD_MS;
      if (due > Date.now()) {
        await sleep(Math.min(due - Date.now(), 1000));
        continue;
      }
    }

    const init = session.inits.get(frag.gen);
    if (!init) {
      viewer.cursor = frag.seq + 1;
      continue;
    }
    if (frag.gen !== viewer.sentGen) {
      write(viewer, frame(FRAME_INIT, init));
      viewer.sentGen = frag.gen;
    }
    const data = await readFragment(session, frag);
    viewer.cursor = frag.seq + 1;
    if (!data || viewer.closed) continue;
    if (!write(viewer, mediaFrame(frag.t, data))) await waitForDrain(viewer);
  }
}

/**
 * Holds a viewer's response open and streams into it - live, or from
 * atMs (ms epoch) for replay.
 */
function attachViewer(sessionId, res, atMs = null) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  const viewer = {
    res,
    live: atMs == null,
    cursor: startCursor(session, atMs),
    sentGen: null,
    replayFirstT: null,
    replayWallStart: null,
    closed: false,
    wake: null,
  };
  session.viewers.add(viewer);
  clearTimeout(session.idleTimer);

  write(viewer, timelineFrame(session));
  if (session.streaming) {
    write(viewer, statusFrame("streaming"));
  } else if (session.frags.length === 0) {
    write(viewer, statusFrame("waiting", "Waiting for the agent's PC to start streaming..."));
  } else {
    write(viewer, statusFrame("paused", "The agent's PC isn't streaming right now - earlier parts can still be played."));
  }

  res.on("close", () => {
    viewer.closed = true;
    session.viewers.delete(viewer);
    if (viewer.wake) viewer.wake();
    scheduleIdleEnd(session);
  });
  pumpViewer(session, viewer).catch((err) => {
    console.error(`Live monitor ${session.id}: viewer stream failed:`, err.message);
    if (!res.writableEnded) res.end();
  });
  return true;
}

// --- the PC's upload -----------------------------------------------------------

/**
 * Splits ffmpeg's fragmented MP4 into the init segment (everything
 * before the first moof) and moof+mdat fragments.
 */
function createMp4Splitter(onInit, onFragment) {
  let buffer = Buffer.alloc(0);
  let initParts = [];
  let gotInit = false;
  let pendingMoof = null;

  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 8) {
      let size = buffer.readUInt32BE(0);
      const type = buffer.toString("latin1", 4, 8);
      if (size === 1) {
        if (buffer.length < 16) return;
        size = Number(buffer.readBigUInt64BE(8));
      }
      if (size < 8 || size > MAX_BOX_BYTES) throw new Error(`Unexpected MP4 box ${type} of ${size} bytes.`);
      if (buffer.length < size) return;

      const box = buffer.subarray(0, size);
      buffer = buffer.subarray(size);

      if (!gotInit) {
        if (type === "moof") {
          gotInit = true;
          onInit(Buffer.concat(initParts));
          initParts = [];
          pendingMoof = Buffer.from(box);
        } else {
          initParts.push(Buffer.from(box));
        }
      } else if (type === "moof") {
        pendingMoof = Buffer.from(box);
      } else if (type === "mdat" && pendingMoof) {
        onFragment(Buffer.concat([pendingMoof, box]));
        pendingMoof = null;
      }
    }
  };
}

/**
 * The PC's upload: POST body is the live fragmented MP4. Each new upload
 * (a restarted ffmpeg - e.g. the mic joining when a call starts) is a new
 * "gen" with its own init segment; viewers reset their player there.
 */
function acceptIngest(req, res) {
  const session = sessions.get(req.params.sessionId);
  if (!session || !tokensMatch(session.token, req.get("X-Cmx-Monitor-Token"))) {
    return res.status(404).json({ error: "No such live monitoring session." });
  }

  if (session.ingest) session.ingest.destroy();
  session.ingest = req;
  const gen = ++session.gen;

  const split = createMp4Splitter(
    (init) => {
      session.inits.set(gen, init);
      session.streaming = true;
      broadcast(session, statusFrame("streaming"));
    },
    (fragment) => {
      if (session.gen === gen && !session.ended) addFragment(session, fragment);
    }
  );

  req.on("data", (chunk) => {
    try {
      split(chunk);
    } catch (err) {
      console.error(`Live monitor ${session.id}: bad stream from the PC:`, err.message);
      req.destroy();
    }
  });

  const finished = () => {
    if (session.ingest !== req) return; // already replaced by a newer upload
    session.ingest = null;
    session.streaming = false;
    if (!session.ended) {
      broadcast(session, statusFrame("paused",
        "The agent's PC stopped streaming (left Production, or reconnecting). It resumes automatically."));
    }
    if (!res.headersSent) res.status(200).end();
  };
  req.on("end", finished);
  req.on("close", finished);
}

/** Ends an agent's session (e.g. their group's monitoring was turned off). */
function stopForAgent(agentId, reason) {
  const id = byAgent.get(agentId);
  if (id && sessions.has(id)) endSession(sessions.get(id), reason);
}

function activeAgentIds() {
  return new Set(byAgent.keys());
}

module.exports = { start, getSession, attachViewer, acceptIngest, stopForAgent, activeAgentIds };
