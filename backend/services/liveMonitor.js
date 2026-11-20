"use strict";

const crypto = require("crypto");
const sessionOwnership = require("./sessionOwnership");

// Live monitoring (desktop 2.4.16+): a web user watches an agent's screen
// and hears their PC's audio (call audio, plus the agent's mic while a
// call is active) as it happens.
//
//   1. start() pushes "monitor_start" {sessionId, token} down the agent's
//      existing SSE connection (sessionOwnership).
//   2. The agent's tray runs a separate ffmpeg (nothing saved on the PC)
//      and POSTs its fragmented MP4 to /api/monitor-ingest/:sessionId
//      with the token - acceptIngest() below.
//   3. Each viewer holds GET /api/monitor/sessions/:id/stream open and
//      gets the stream re-framed for the browser's MediaSource player.
//   4. Once the last viewer leaves, the session ends after a short grace
//      period and "monitor_stop" tells the PC to stop streaming.
//
// One session per agent, shared by every viewer. In memory only - a
// backend restart ends every session (the PC's next upload is refused
// and it stops). Requires a single backend process, as sessionOwnership
// already does.

// Frames sent to viewers: [type u8][length u32 BE][payload].
const FRAME_INIT = 1; // ftyp+moov of a new ffmpeg run - viewer resets its player
const FRAME_MEDIA = 2; // moof+mdat, each starting on a keyframe (~2s each)
const FRAME_STATUS = 3; // JSON {status, message}

const IDLE_END_MS = 20 * 1000; // no viewers this long -> end the session
const MAX_BOX_BYTES = 32 * 1024 * 1024;
const SLOW_VIEWER_BYTES = 2 * 1024 * 1024; // skip fragments for a viewer this far behind
const RESUME_VIEWER_BYTES = 256 * 1024;

const sessions = new Map(); // sessionId -> session
const byAgent = new Map(); // agentId -> sessionId

function frame(type, payload) {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function statusFrame(status, message) {
  return frame(FRAME_STATUS, Buffer.from(JSON.stringify({ status, message: message || null })));
}

function sendToViewer(viewer, buf, isMedia) {
  if (viewer.res.writableEnded) return;
  if (isMedia) {
    const queued = viewer.res.writableLength;
    if (viewer.skipping && queued < RESUME_VIEWER_BYTES) viewer.skipping = false;
    if (!viewer.skipping && queued > SLOW_VIEWER_BYTES) viewer.skipping = true;
    if (viewer.skipping) return;
  }
  viewer.res.write(buf);
}

function broadcast(session, buf, isMedia = false) {
  for (const viewer of session.viewers) sendToViewer(viewer, buf, isMedia);
}

function tokensMatch(expected, provided) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function scheduleIdleEnd(session) {
  clearTimeout(session.idleTimer);
  if (session.viewers.size > 0) return;
  session.idleTimer = setTimeout(() => endSession(session, "No one is watching."), IDLE_END_MS);
}

function endSession(session, reason) {
  if (session.ended) return;
  session.ended = true;
  clearTimeout(session.idleTimer);
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

  const session = {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(32).toString("hex"),
    agentId,
    machineName,
    startedBy,
    startedAt: new Date(),
    viewers: new Set(),
    ingest: null,
    init: null,
    idleTimer: null,
    ended: false,
  };
  sessions.set(session.id, session);
  byAgent.set(agentId, session.id);

  if (!sessionOwnership.push(agentId, "monitor_start", { sessionId: session.id, token: session.token })) {
    endSession(session, "The agent's PC is not connected.");
    return { error: "The agent's PC is not connected to Sentinel right now." };
  }
  scheduleIdleEnd(session); // ends it if no viewer ever attaches
  return { sessionId: session.id };
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/** Holds a viewer's response open and streams frames into it. */
function attachViewer(sessionId, res) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  const viewer = { res, skipping: false };
  session.viewers.add(viewer);
  clearTimeout(session.idleTimer);

  if (session.ingest && session.init) {
    res.write(frame(FRAME_INIT, session.init));
    res.write(statusFrame("streaming"));
  } else {
    res.write(statusFrame("waiting", "Waiting for the agent's PC to start streaming..."));
  }

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(statusFrame("ping"));
  }, 15000);

  res.on("close", () => {
    clearInterval(keepAlive);
    session.viewers.delete(viewer);
    scheduleIdleEnd(session);
  });
  return true;
}

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
 * (a restarted ffmpeg - e.g. the mic joining when a call starts)
 * replaces the previous one and viewers reset their player.
 */
function acceptIngest(req, res) {
  const session = sessions.get(req.params.sessionId);
  if (!session || !tokensMatch(session.token, req.get("X-Cmx-Monitor-Token"))) {
    return res.status(404).json({ error: "No such live monitoring session." });
  }

  if (session.ingest) session.ingest.destroy();
  session.ingest = req;
  session.init = null;

  const split = createMp4Splitter(
    (init) => {
      session.init = init;
      broadcast(session, frame(FRAME_INIT, init));
      broadcast(session, statusFrame("streaming"));
    },
    (fragment) => broadcast(session, frame(FRAME_MEDIA, fragment), true)
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
    session.init = null;
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
