import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import UserFormModal from '../modals/UserFormModal.jsx';
import { formatRole } from '../utils/roles.js';
import SortableTh, { toggleSort } from '../components/SortableTh.jsx';
import { sortRows, matchesSearch } from '../utils/tableSort.js';

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalUser, setModalUser] = useState(undefined); // undefined = closed, null = add mode, object = edit mode
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: null, dir: 'asc' });

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

  // "Employee ID" per the request maps to login_identifier here - for
  // Admin/Super Admin that IS a numeric Employee ID; for every other
  // role it's their email instead (see UserFormModal's usesEmployeeId
  // logic), but it's still the one identifying field worth searching
  // regardless of which kind of value it holds.
  const visibleUsers = useMemo(() => {
    const filtered = users.filter((u) =>
      matchesSearch(search, [
        u.display_name,
        u.login_identifier,
        (u.groups || []).map((g) => g.group_name).join(' '),
      ])
    );
    return sortRows(filtered, sort, (u) => {
      switch (sort.key) {
        case 'display_name': return u.display_name;
        case 'role': return formatRole(u.role);
        case 'groups': return (u.groups || []).map((g) => g.group_name).join(', ');
        case 'login_identifier': return u.login_identifier;
        case 'email': return u.email;
        case 'is_active': return u.is_active;
        default: return null;
      }
    });
  }, [users, search, sort]);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Users</h2>
        <button className="btn" onClick={() => setModalUser(null)}>+ Add User</button>
      </div>

      {error && <div className="error">{error}</div>}

      <div style={{ marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search by Name, Employee ID, or Group..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14, width: 320, maxWidth: '100%' }}
        />
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <SortableTh label="Display Name" sortKey="display_name" sort={sort} onSort={(k) => toggleSort(sort, setSort, k)} />
              <SortableTh label="Role" sortKey="role" sort={sort} onSort={(k) => toggleSort(sort, setSort, k)} />
              <SortableTh label="Groups" sortKey="groups" sort={sort} onSort={(k) => toggleSort(sort, setSort, k)} />
              <SortableTh label="Login Identifier" sortKey="login_identifier" sort={sort} onSort={(k) => toggleSort(sort, setSort, k)} />
              <SortableTh label="Email" sortKey="email" sort={sort} onSort={(k) => toggleSort(sort, setSort, k)} />
              <SortableTh label="Status" sortKey="is_active" sort={sort} onSort={(k) => toggleSort(sort, setSort, k)} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibleUsers.length === 0 ? (
              <tr><td colSpan={7}>{users.length === 0 ? 'No users yet.' : 'No users match your search.'}</td></tr>
            ) : (
              visibleUsers.map((u) => (
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
