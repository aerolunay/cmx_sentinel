import { useEffect, useState } from 'react';
import { api } from '../api.js';
import AgentFormModal from '../modals/AgentFormModal.jsx';

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [resettingId, setResettingId] = useState(null);
  const [modalAgent, setModalAgent] = useState(undefined); // undefined = closed, null = add mode, object = edit mode

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

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Agents</h2>
        <button className="btn" onClick={() => setModalAgent(null)}>+ Add Agent</button>
      </div>

      {error && <div className="error">{error}</div>}
      {message && !error && <div className="message">{message}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Display Name</th>
              <th>Agent ID</th>
              <th>Email</th>
              <th>Group</th>
              <th>Status</th>
              <th>Must Reset Password</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {agents.length === 0 ? (
              <tr><td colSpan={7}>No agents yet.</td></tr>
            ) : (
              agents.map((a) => (
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
    </>
  );
}
