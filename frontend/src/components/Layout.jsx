import { useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useAppVersion } from '../hooks/useAppVersion.js';
import AboutModal from '../modals/AboutModal.jsx';
import logoWhite from '../assets/callmax_cover_removebg.png';
import { formatRole } from '../utils/roles.js';

export default function Layout() {
  const { user, logout } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const canManageAgents = user?.role === 'admin' || user?.role === 'super_admin';
  // Med / Clinic users only have the Clinic Visits page - every other
  // path (the Dashboard home included) sends them there. The server
  // blocks the role from every other API too (server.js).
  const isClinic = user?.role === 'clinic';
  const location = useLocation();
  const appVersion = useAppVersion();
  const [showAbout, setShowAbout] = useState(false);

  if (isClinic && location.pathname !== '/clinic-visits') {
    return <Navigate to="/clinic-visits" replace />;
  }

  return (
    <div className="app-shell">
      <header>
        <img src={logoWhite} alt="CallMax" className="header-logo" />
        <div className="user-info">
          {user?.displayName} ({formatRole(user?.role)})
          <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>Log out</a>
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <span className="sidebar-title">SENTINEL</span>
            <span className="app-version">v {appVersion}</span>
          </div>

          {isClinic ? (
            <NavLink to="/clinic-visits" className={({ isActive }) => (isActive ? 'active' : '')}>
              Clinic Visits
            </NavLink>
          ) : (
            <>
              <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
                Dashboard
              </NavLink>
              {/* Super Admin only - Users and Groups & Restrictions are no
                  longer reachable by regular Admin (enforced server-side
                  too via requireRole, this is just hiding links someone
                  couldn't use anyway). */}
              {isSuperAdmin && (
                <>
                  <NavLink to="/users" className={({ isActive }) => (isActive ? 'active' : '')}>
                    Users
                  </NavLink>
                  <NavLink to="/groups" className={({ isActive }) => (isActive ? 'active' : '')}>
                    Groups &amp; Restrictions
                  </NavLink>
                </>
              )}
              {/* Admin AND Super Admin both keep Agents. */}
              {canManageAgents && (
                <>
                  <NavLink to="/agents" className={({ isActive }) => (isActive ? 'active' : '')}>
                    Agents
                  </NavLink>
                  <NavLink to="/scheduler" className={({ isActive }) => (isActive ? 'active' : '')}>
                    Shift Scheduler
                  </NavLink>
                  <NavLink to="/violations" className={({ isActive }) => (isActive ? 'active' : '')}>
                    Violations
                  </NavLink>
                </>
              )}
              <NavLink to="/recordings" className={({ isActive }) => (isActive ? 'active' : '')}>
                Recordings
              </NavLink>
              <NavLink to="/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
                Reports
              </NavLink>
              {/* Super Admin can add/edit clinic visits too; everyone
                  else with Reports reads them under Reports. */}
              {isSuperAdmin && (
                <>
                  <NavLink to="/clinic-visits" className={({ isActive }) => (isActive ? 'active' : '')}>
                    Clinic Visits
                  </NavLink>
                  <NavLink to="/audit-log" className={({ isActive }) => (isActive ? 'active' : '')}>
                    Audit Log
                  </NavLink>
                </>
              )}

              <a href="#" onClick={(e) => { e.preventDefault(); setShowAbout(true); }} style={{ marginTop: 12 }}>
                About
              </a>
            </>
          )}
        </aside>

        <main>
          <Outlet />
        </main>
      </div>

      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    </div>
  );
}
