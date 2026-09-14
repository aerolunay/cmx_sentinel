# CMX Sentinel Admin

Admin web app for CMX Sentinel - agent/group management, website
restrictions, screen recording playback, and reporting on top of the
same MySQL database the desktop agent app (CmxSentinelService/
CmxSentinelTray) writes to.

## Structure

```
backend/          Express API (CommonJS) - see backend/server.js
  config/          External service setup (db, ses)
  routes/          Express route handlers
  services/        Business logic (OTP, email, etc.)
  middleware/      requireAuth, requireRole
frontend/          React + Vite SPA
  src/
    pages/          Full routed pages (XPage.jsx)
    components/     Reusable pieces, admin/ for admin-only section UI
    context/         AuthContext
    styles/          theme.css
sql/               Numbered migrations, run in order against your
                   existing cmx_sentinel database
```

## Roles

- **admin** - full access: Users, Groups & Restrictions, Agents, Recordings, Reports
- **tqa / supervisor / manager** - Recordings + Reports only
- **agent** - NOT a web app role at all - agents log into the DESKTOP
  app (CmxSentinelTray) with username/password, unrelated to this
  OTP-based web login

## Login

Web app login is OTP-over-email, not passwords:
1. Enter your Employee ID (admins) or email (everyone else)
2. A 6-digit code is emailed via AWS SES
3. Enter the code to complete login

## Setup

See `backend/.env.example` and `sql/001_add_web_users_otp.sql` (includes
instructions for bootstrapping your first admin account, since there's
no UI yet to create the very first one).

## Deployment

Runs behind Caddy (see `Caddyfile.snippet`) via pm2 (see
`backend/ecosystem.config.js`) - Caddy serves the React build as static
files and reverse-proxies `/api/*` to the Express backend on
`127.0.0.1:5051`.
