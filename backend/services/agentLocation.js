"use strict";

// Where each logged-in agent is working from right now, for the live
// view: their desktop's ~10s /biometric-status check says whether its
// public IP is an office one (services/officeNetwork.js). Kept in memory
// only - nothing to store, and after a restart every logged-in desktop
// reports again within seconds. An agent not heard from for STALE_MS
// (desktop older than 2.3.3, or logged out) has no known location.
const STALE_MS = 2 * 60 * 1000;

const lastSeen = new Map(); // agentId -> { onsite, at }

function recordLocation(agentId, onsite) {
  lastSeen.set(String(agentId), { onsite: Boolean(onsite), at: Date.now() });
}

// "onsite", "remote", or null if unknown.
function getLocation(agentId) {
  const entry = lastSeen.get(String(agentId));
  if (!entry || Date.now() - entry.at > STALE_MS) return null;
  return entry.onsite ? "onsite" : "remote";
}

module.exports = { recordLocation, getLocation };
