"use strict";

// Whether a desktop is onsite, judged by the public IP its requests come
// from (req.ip - server.js trusts Caddy's X-Forwarded-For). Onsite agents'
// shifts start and end with their biometric punches; everyone else's with
// the desktop app's own login/logout (see /biometric-status).
//
// OFFICE_PUBLIC_IPS in backend/.env: comma-separated IPv4 addresses or
// CIDR ranges - the office internet connection(s) as this server sees
// them, e.g. "203.0.113.10, 198.51.100.0/28". Unset or empty: everyone
// counts as onsite, the behaviour before this setting existed.

function toInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseRanges(value) {
  const ranges = [];
  for (const entry of (value || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [address, bitsText] = entry.split("/");
    const base = toInt(address);
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      console.error(`OFFICE_PUBLIC_IPS: ignoring "${entry}" - not an IPv4 address or CIDR range.`);
      continue;
    }
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    ranges.push({ network: (base & mask) >>> 0, mask });
  }
  return ranges;
}

const officeRanges = parseRanges(process.env.OFFICE_PUBLIC_IPS);

function officeNetworkConfigured() {
  return officeRanges.length > 0;
}

// "::ffff:203.0.113.10" (IPv4 over an IPv6 socket) counts as 203.0.113.10.
function isOfficeIp(ip) {
  if (!officeNetworkConfigured()) return true;
  const value = toInt(String(ip || "").replace(/^::ffff:/, ""));
  return value !== null && officeRanges.some((r) => ((value & r.mask) >>> 0) === r.network);
}

module.exports = { isOfficeIp, officeNetworkConfigured, parseRanges };
