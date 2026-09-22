import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import AgentFormModal from '../modals/AgentFormModal.jsx';
import AgentBulkUploadModal from '../modals/AgentBulkUploadModal.jsx';
import SortableTh, { toggleSort } from '../components/SortableTh.jsx';
import { sortRows, matchesSearch } from '../utils/tableSort.js';

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [resettingId, setResettingId] = useState(null);
  const [modalAgent, setModalAgent] = useState(undefined); // undefined = closed, null = add mode, object = edit mode
  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: null, dir: 'asc' });

  useEffect(() => {
    loadAgents();
  }, []);

  async function loadAgents() {
    setLoading(true);
    setError('');
    try {
      const data = await api.listAgents();
      setAgents(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleStatus(agent) {
    setError('');
    try {
      await api.setAgentStatus(agent.agent_id, !agent.is_active);
      loadAgents();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleResetPassword(agent) {
    setError('');
    setMessage('');
    if (!agent.email) {
      setError(`${agent.display_name} has no email on file - add one before resetting their password.`);
      return;
    }
    if (!window.confirm(`Send a new temporary password to ${agent.display_name} (${agent.email})?`)) {
      return;
    }

    setResettingId(agent.agent_id);
    try {
      const result = await api.resetAgentPassword(agent.agent_id);
      setMessage(result.message);
      loadAgents();
    } catch (err) {
      setError(err.message);
    } finally {
      setResettingId(null);
    }
  }

  // Search first (Name / Agent ID / Group, matching any one), then
  // sort - order between the two doesn't matter functionally since
  // sort doesn't change which rows are present, just their order.
  const visibleAgents = useMemo(() => {
    const filtered = agents.filter((a) =>
      matchesSearch(search, [a.display_name, a.agent_id, a.group_name])
    );
    return sortRows(filtered, sort, (a) => {
      switch (sort.key) {
        case 'display_name': return a.display_name;
        case 'agent_id': return a.agent_id;
        case 'email': return a.email;
        case 'group_name': return a.group_name;
        case 'is_active': return a.is_active;
        case 'must_reset_password': return a.must_reset_password;
        default: return null;
      }
    });
  }, [agents, search, sort]);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Agents</h2>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={() => setShowBulkUpload(true)}>Bulk Upload</button>
          <button className="btn" onClick={() => setModalAgent(null)}>+ Add Agent</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {message && !error && <div className="message">{message}</div>}

      <div style={{ marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search by Name, Agent ID, or Group..."
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
              <SortableTh label="Agent ID" sortKey="agent_id" sort={sort} onSort={(k) => toggleSort(sort, setSort, k)} />
              <SortableTh label="Email" sortKey="email" sort={sort} onSort={(k) => toggleSort(sort, setSort, k)} />
              <SortableTh label="Group" sortKey="group_name" sort={sort} onSort={(k) => toggleSort(sort, setSort, k)} />
              <SortableTh label="Status" sortKey="is_active" sort={sort} onSort={(k) => toggleSort(sort, setSort, k)} />
              <SortableTh label="Must Reset Password" sortKey="must_reset_password" sort={sort} onSort={(k) => toggleSort(sort, setSort, k)} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibleAgents.length === 0 ? (
              <tr><td colSpan={7}>{agents.length === 0 ? 'No agents yet.' : 'No agents match your search.'}</td></tr>
            ) : (
              visibleAgents.map((a) => (
                <tr key={a.agent_id}>
                  <td>{a.display_name}</td>
                  <td>{a.agent_id}</td>
                  <td>{a.email || <em style={{ color: '#999' }}>none on file</em>}</td>
                  <td>{a.group_name || <em style={{ color: '#999' }}>none</em>}</td>
                  <td>{a.is_active ? 'Active' : 'Disabled'}</td>
                  <td>{a.must_reset_password ? 'Yes' : 'No'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn-link" onClick={() => setModalAgent(a)}>Edit</button>
                    {' | '}
                    <button
                      className="btn-link"
                      onClick={() => handleResetPassword(a)}
                      disabled={resettingId === a.agent_id}
                    >
                      {resettingId === a.agent_id ? 'Sending...' : 'Reset Password'}
                    </button>
                    {' | '}
                    <button className="btn-link" onClick={() => handleToggleStatus(a)}>
                      {a.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {modalAgent !== undefined && (
        <AgentFormModal
          existingAgent={modalAgent}
          onClose={() => setModalAgent(undefined)}
          onSaved={loadAgents}
        />
      )}

      {showBulkUpload && (
        <AgentBulkUploadModal
          onClose={() => setShowBulkUpload(false)}
          onSaved={loadAgents}
        />
      )}
    </>
  );
}
