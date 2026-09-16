import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useAppVersion } from '../hooks/useAppVersion.js';
import AboutModal from '../modals/AboutModal.jsx';
import logoWhite from '../assets/callmax_cover_removebg.png';

export default function Layout() {
  const { user, logout } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const canManageAgents = user?.role === 'admin' || user?.role === 'super_admin';
  const appVersion = useAppVersion();
  const [showAbout, setShowAbout] = useState(false);

  return (
    <div className="app-shell">
      <header>
        <img src={logoWhite} alt="CallMax" className="header-logo" />
        <div className="user-info">
          {user?.displayName} ({user?.role})
          <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>Log out</a>
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <span className="sidebar-title">SENTINEL</span>
            <span className="app-version">v {appVersion}</span>
          </div>

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
          {isSuperAdmin && (
            <NavLink to="/audit-log" className={({ isActive }) => (isActive ? 'active' : '')}>
              Audit Log
            </NavLink>
          )}

          <a href="#" onClick={(e) => { e.preventDefault(); setShowAbout(true); }} style={{ marginTop: 12 }}>
            About
          </a>
        </aside>

        <main>
          <Outlet />
        </main>
      </div>

      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    </div>
  );
}
