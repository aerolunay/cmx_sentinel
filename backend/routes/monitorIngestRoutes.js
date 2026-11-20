"use strict";

const express = require("express");
const liveMonitor = require("../services/liveMonitor");

// Where an agent's PC uploads its live monitoring stream (desktop
// 2.4.16+). Not behind the web login or the desktop API key: the tray
// sends it, and the tray never holds the API key (same reason recordings
// go up with presigned URLs). Instead each session has its own random
// token, pushed to that PC only, sent back in X-Cmx-Monitor-Token.
// See services/liveMonitor.js.

const router = express.Router();

router.post("/:sessionId", (req, res) => liveMonitor.acceptIngest(req, res));

module.exports = router;
