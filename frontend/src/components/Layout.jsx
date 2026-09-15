import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useAppVersion } from '../hooks/useAppVersion.js';
import logoWhite from '../assets/callmax_cover_removebg.png';

export default function Layout() {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';
  const appVersion = useAppVersion();

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
          {/* Admin-only sections - TQA/Supervisor/Manager only get
              Recordings + Reports, matching each role's actual access
              (enforced server-side too via requireRole, this is just
              hiding links someone couldn't use anyway). */}
          {isAdmin && (
            <>
              <NavLink to="/users" className={({ isActive }) => (isActive ? 'active' : '')}>
                Users
              </NavLink>
              <NavLink to="/groups" className={({ isActive }) => (isActive ? 'active' : '')}>
                Groups &amp; Restrictions
              </NavLink>
              <NavLink to="/agents" className={({ isActive }) => (isActive ? 'active' : '')}>
                Agents
              </NavLink>
            </>
          )}
          <NavLink to="/recordings" className={({ isActive }) => (isActive ? 'active' : '')}>
            Recordings
          </NavLink>
          <NavLink to="/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
            Reports
          </NavLink>
        </aside>

        <main>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
