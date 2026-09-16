"use strict";

const { DateTime } = require("luxon");

// Mirrors CmxSentinelService's own EasternTime.cs exactly - the _est
// columns store a plain wall-clock value (no timezone info in the
// DATETIME column itself), so this must produce the correct Eastern
// wall-clock string DIRECTLY, not construct a JS Date object and let
// something else interpret it - that's exactly the class of bug this
// whole project has been careful to avoid (see recordingRoutes.js's
// own comment about the same issue).
function toEasternSqlString(utcDate) {
  return DateTime.fromJSDate(utcDate, { zone: "utc" })
    .setZone("America/New_York")
    .toFormat("yyyy-MM-dd HH:mm:ss");
}

// Returns the UTC start/end instants corresponding to "today" in
// Eastern time - mirrors EasternTime.GetTodayUtcRange() on the desktop
// side.
function getTodayUtcRangeEastern() {
  const nowEastern = DateTime.now().setZone("America/New_York");
  const startEastern = nowEastern.startOf("day");
  const startUtc = startEastern.toUTC().toJSDate();
  const endUtc = startEastern.plus({ days: 1 }).toUTC().toJSDate();
  return { startUtc, endUtc };
}

module.exports = { toEasternSqlString, getTodayUtcRangeEastern };
