// All requests go through here so cookies (the session) are always
// included and JSON handling/error shape is consistent everywhere.
async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'include', // always send the session cookie
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}

export const api = {
  requestOtp: (loginIdentifier) =>
    request('/api/auth/request-otp', { method: 'POST', body: JSON.stringify({ loginIdentifier }) }),
  verifyOtp: (loginIdentifier, code) =>
    request('/api/auth/verify-otp', { method: 'POST', body: JSON.stringify({ loginIdentifier, code }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),

  listUsers: () => request('/api/users'),
  createUser: (user) => request('/api/users', { method: 'POST', body: JSON.stringify(user) }),
  updateUser: (userId, user) => request(`/api/users/${userId}`, { method: 'PUT', body: JSON.stringify(user) }),
  setUserStatus: (userId, isActive) =>
    request(`/api/users/${userId}/status`, { method: 'PATCH', body: JSON.stringify({ isActive }) }),

  listAgents: () => request('/api/agents'),
  createAgent: (agent) => request('/api/agents', { method: 'POST', body: JSON.stringify(agent) }),
  updateAgent: (agentId, agent) => request(`/api/agents/${agentId}`, { method: 'PUT', body: JSON.stringify(agent) }),
  setAgentStatus: (agentId, isActive) =>
    request(`/api/agents/${agentId}/status`, { method: 'PATCH', body: JSON.stringify({ isActive }) }),
  resetAgentPassword: (agentId) => request(`/api/agents/${agentId}/reset-password`, { method: 'POST' }),

  listRecordings: () => request('/api/recordings'),
  getRecordingUrl: (key) => request(`/api/recordings/url?key=${encodeURIComponent(key)}`),
};