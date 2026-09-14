import { useAuth } from '../context/AuthContext.jsx';

export default function DashboardPage() {
  const { user } = useAuth();

  return (
    <>
      <h2>Dashboard</h2>
      <p>Logged in as <strong>{user?.displayName}</strong> ({user?.role}).</p>
      <p>This is a placeholder - Users, Groups &amp; Restrictions, Agents, Recordings, and Reports pages are built in the next stages.</p>
    </>
  );
}
