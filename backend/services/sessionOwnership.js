"use strict";

// In-memory registry of "which machine currently owns this agent's
// active desktop session". This is intentionally NOT the same thing as
// aux_events (that's a durable report/audit log of completed and open
// segments) - this is live, ephemeral, per-process state answering one
// question: "if a second machine logs in right now, who do we need to
// push a force-logout to, and can we?"
//
// Safe to keep in-memory (not Redis/DB-backed) because the backend
// runs as a single pm2 process (ecosystem.config.js has no `instances`
// set, i.e. fork mode, one process) - see server.js. If this ever
// moves to pm2 cluster mode or multiple hosts, this registry would
// need to move to something shared (Redis pub/sub is the natural
// choice) or session claims from different instances could disagree
// about who currently owns a session. Flagging that here so it isn't
// missed later.
//
// entries: Map<agentId, { machineName: string, res: http.ServerResponse|null, connectedAtUtc: Date }>
const entries = new Map();

/**
 * Claims ownership of `agentId`'s session for `machineName`, evicting
 * whatever machine held it before (if any and if different).
 *
 * Returns { previousMachineName, pushed } where:
 *   - previousMachineName is null if nobody held the session, or if
 *     the same machine is re-claiming its own session (a reconnect)
 *   - pushed is true only if there WAS a previous different machine
 *     AND it had a live SSE connection to push a force-logout down.
 *     false (not an error) just means that machine wasn't reachable
 *     right now (offline/asleep/never subscribed) - the caller should
 *     still proceed; there's nothing live left to notify.
 */
function claim(agentId, machineName) {
  const existing = entries.get(agentId);

  let previousMachineName = null;
  let pushed = false;

  if (existing && existing.machineName !== machineName) {
    previousMachineName = existing.machineName;
    if (existing.res && !existing.res.writableEnded) {
      try {
        existing.res.write(
          `event: force_logout\ndata: ${JSON.stringify({ reason: "signed_in_elsewhere", newMachineName: machineName })}\n\n`
        );
        existing.res.end();
        pushed = true;
      } catch (err) {
        console.error(`Error pushing force_logout to agent ${agentId}'s previous machine (${previousMachineName}):`, err);
      }
    }
  }

  entries.set(agentId, { machineName, res: existing && existing.machineName === machineName ? existing.res : null, connectedAtUtc: new Date() });

  return { previousMachineName, pushed };
}

/**
 * Registers the live SSE connection for `agentId`/`machineName` so
 * future claim() calls against a DIFFERENT machine can push to it.
 * Returns false (caller should reject the subscription with 409) if
 * this machine isn't the current owner - e.g. its claim() already got
 * superseded by another machine between claiming and subscribing.
 */
function attachConnection(agentId, machineName, res) {
  const existing = entries.get(agentId);
  if (!existing || existing.machineName !== machineName) {
    return false;
  }
  existing.res = res;
  return true;
}

/**
 * Called when an SSE connection closes (agent logged out normally,
 * tray/service stopped, network dropped). Only clears the connection,
 * NOT ownership - a dropped connection doesn't mean the agent logged
 * out, and we don't want a flaky network to make claim() think nobody
 * owns the session (that would skip closing the stale aux_events row
 * on next login elsewhere). If this machine genuinely logs out, the
 * next different-machine claim() will just find `res` null and no-op
 * the push, which is the correct "fail open, nothing live to notify"
 * behavior already used elsewhere in this codebase (see /restrictions).
 */
function detachConnection(agentId, machineName, res) {
  const existing = entries.get(agentId);
  if (existing && existing.machineName === machineName && existing.res === res) {
    existing.res = null;
  }
}

/**
 * Explicitly releases ownership - called on a normal (non-superseded)
 * logout so a stale entry doesn't linger claiming a machine that's no
 * longer logged in at all.
 */
function release(agentId, machineName) {
  const existing = entries.get(agentId);
  if (existing && existing.machineName === machineName) {
    entries.delete(agentId);
  }
}

module.exports = { claim, attachConnection, detachConnection, release };
