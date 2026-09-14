import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import logoWhite from '../assets/callmax_cover_removebg.png';

export default function Layout() {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';

  return (
    <div>
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          <img src={logoWhite} alt="CallMax" className="header-logo" />
          <nav>
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
          </nav>
        </div>
        <div className="user-info">
          {user?.displayName} ({user?.role})
          <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>Log out</a>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
