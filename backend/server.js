"use strict";

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const MySQLStoreFactory = require("express-mysql-session");

require("dotenv").config();

const db = require("./config/db");
const authRoutes = require("./routes/authRoutes");

const app = express();

const PORT = Number(process.env.PORT) || 5051;

// Bind to localhost only - this app is never exposed directly to the
// internet. Caddy (already running on this server) reverse-proxies
// admin.yourdomain.com's /api/* requests to this port and serves the
// React build's static files itself - same pattern as whatever else
// Caddy already fronts.

// Only needed for local dev, where the React dev server (Vite, port
// 5173) is a different origin than this API - in production, Caddy
// serves both under the same origin, so no CORS is needed there at
// all. CORS_ORIGIN is left unset in production's .env for that reason.
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

app.use(express.json());

const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({}, db);

app.use(
  session({
    key: "connect.sid",
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // Caddy terminates TLS and proxies over plain HTTP to this
      // localhost port - the cookie is still only ever sent over
      // HTTPS from the BROWSER's perspective (Caddy's the one talking
      // HTTP to us, on the same machine, not the browser). Set to
      // false only if testing locally over plain http://.
      secure: process.env.COOKIE_SECURE !== "false",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

app.use("/api/auth", authRoutes);

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "A server error occurred." });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`CMX Sentinel Admin backend listening on http://127.0.0.1:${PORT}`);
});
