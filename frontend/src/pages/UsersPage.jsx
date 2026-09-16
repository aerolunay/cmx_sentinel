import { useEffect, useState } from 'react';
import { api } from '../api.js';
import UserFormModal from '../modals/UserFormModal.jsx';

function formatRole(role) {
  if (role === 'super_admin') return 'Super Admin';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalUser, setModalUser] = useState(undefined); // undefined = closed, null = add mode, object = edit mode

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    setLoading(true);
    setError('');
    try {
      const data = await api.listUsers();
      setUsers(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleStatus(user) {
    try {
      await api.setUserStatus(user.user_id, !user.is_active);
      loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Users</h2>
        <button className="btn" onClick={() => setModalUser(null)}>+ Add User</button>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Display Name</th>
              <th>Role</th>
              <th>Groups</th>
              <th>Login Identifier</th>
              <th>Email</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr><td colSpan={7}>No users yet.</td></tr>
            ) : (
              users.map((u) => (
                <tr key={u.user_id}>
                  <td>{u.display_name}</td>
                  <td>{formatRole(u.role)}</td>
                  <td>
                    {u.groups && u.groups.length > 0
                      ? u.groups.map((g) => g.group_name).join(', ')
                      : <em style={{ color: '#999' }}>-</em>}
                  </td>
                  <td>{u.login_identifier}</td>
                  <td>{u.email}</td>
                  <td>{u.is_active ? 'Active' : 'Disabled'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn-link" onClick={() => setModalUser(u)}>Edit</button>
                    {' | '}
                    <button className="btn-link" onClick={() => handleToggleStatus(u)}>
                      {u.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {modalUser !== undefined && (
        <UserFormModal
          existingUser={modalUser}
          onClose={() => setModalUser(undefined)}
          onSaved={loadUsers}
        />
      )}
    </>
  );
}
