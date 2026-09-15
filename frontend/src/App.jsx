import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import LoginPage from './pages/LoginPage.jsx';
import Layout from './components/Layout.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import AgentsPage from './pages/AgentsPage.jsx';
import RecordingsPage from './pages/RecordingsPage.jsx';
import GroupsPage from './pages/GroupsPage.jsx';
import GroupDetailPage from './pages/GroupDetailPage.jsx';

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null; // avoid a flash of the login page while checking
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

// Client-side role gating is UX only (hides a page someone shouldn't
// see, avoids a confusing "server said no" flash) - the REAL
// enforcement is server-side via requireRole on every API route. This
// is not a substitute for that, just a nicer experience on top of it.
function RequireRole({ role, children }) {
  const { user } = useAuth();
  if (user?.role !== role) return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="users" element={<RequireRole role="admin"><UsersPage /></RequireRole>} />
        <Route path="agents" element={<RequireRole role="admin"><AgentsPage /></RequireRole>} />
        <Route path="recordings" element={<RecordingsPage />} />
        <Route path="groups" element={<RequireRole role="admin"><GroupsPage /></RequireRole>} />
        <Route path="groups/:groupId" element={<RequireRole role="admin"><GroupDetailPage /></RequireRole>} />
        {/* /reports route added in a later stage */}
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
