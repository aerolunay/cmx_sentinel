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
  checkUser: (loginIdentifier) =>
    request('/api/auth/check-user', { method: 'POST', body: JSON.stringify({ loginIdentifier }) }),
  loginTotp: (loginIdentifier, code) =>
    request('/api/auth/login-totp', { method: 'POST', body: JSON.stringify({ loginIdentifier, code }) }),
  totpSetup: () => request('/api/auth/totp/setup', { method: 'POST' }),
  totpConfirm: (code) => request('/api/auth/totp/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),
  getBackendVersion: () => request('/api/auth/version'),

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
  // Same non-JSON multipart pattern as bulkUploadSchedules below.
  async bulkUploadAgents(file) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch('/api/agents/bulk-upload', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  },

  listRecordingAgents: () => request('/api/recordings/agents'),
  // dateFrom/dateTo (YYYY-MM-DD, Eastern) and agentId - empty ones are
  // left off so the backend doesn't filter on them.
  listRecordings: (params = {}) => {
    const defined = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
    return request(`/api/recordings?${new URLSearchParams(defined)}`);
  },
  getRecordingUrl: (key) => request(`/api/recordings/url?key=${encodeURIComponent(key)}`),
  // super_admin only (enforced server-side too) - returns a presigned
  // URL that prompts an actual file save rather than playing inline.
  getRecordingDownloadUrl: (key) => request(`/api/recordings/download?key=${encodeURIComponent(key)}`),

  listGroups: () => request('/api/groups'),
  createGroup: (groupName) => request('/api/groups', { method: 'POST', body: JSON.stringify({ groupName }) }),
  updateGroup: (groupId, groupName) =>
    request(`/api/groups/${groupId}`, { method: 'PUT', body: JSON.stringify({ groupName }) }),
  deleteGroup: (groupId) => request(`/api/groups/${groupId}`, { method: 'DELETE' }),

  listRestrictions: (groupId) => request(`/api/groups/${groupId}/restrictions`),
  createRestriction: (groupId, restriction) =>
    request(`/api/groups/${groupId}/restrictions`, { method: 'POST', body: JSON.stringify(restriction) }),
  updateRestriction: (groupId, restrictionId, restriction) =>
    request(`/api/groups/${groupId}/restrictions/${restrictionId}`, { method: 'PUT', body: JSON.stringify(restriction) }),
  deleteRestriction: (groupId, restrictionId) =>
    request(`/api/groups/${groupId}/restrictions/${restrictionId}`, { method: 'DELETE' }),
  copyRestrictions: (groupId, targetGroupId) =>
    request(`/api/groups/${groupId}/restrictions/copy`, { method: 'POST', body: JSON.stringify({ targetGroupId }) }),

  getEfficiencyReport: (params) => request(`/api/reports/efficiency?${new URLSearchParams(params)}`),
  getHourlyAux: () => request('/api/reports/hourly-aux'),
  listLiveAgents: () => request('/api/reports/live-agents'),
  getLiveAgent: (agentId) => request(`/api/reports/live-agents/${encodeURIComponent(agentId)}`),

  searchScheduleAgents: (q) => request(`/api/schedules/search-agents?${new URLSearchParams({ q })}`),
  // params can include any of: agentId, dateFrom, dateTo, q - only
  // defined ones are sent, so each caller (per-agent Edit tab vs. the
  // all-agents Browse tab) can omit whichever don't apply and let the
  // backend's own defaults kick in.
  listSchedules: (params = {}) => {
    const defined = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
    return request(`/api/schedules?${new URLSearchParams(defined)}`);
  },
  createSchedule: (schedule) => request('/api/schedules', { method: 'POST', body: JSON.stringify(schedule) }),
  updateSchedule: (scheduleId, schedule) =>
    request(`/api/schedules/${scheduleId}`, { method: 'PUT', body: JSON.stringify(schedule) }),
  deleteSchedule: (scheduleId) => request(`/api/schedules/${scheduleId}`, { method: 'DELETE' }),
  // Doesn't go through the shared request() helper above - this is a
  // multipart file upload, not JSON, so it needs its own fetch call
  // without the 'Content-Type: application/json' header (the browser
  // sets the correct multipart boundary header itself when the body
  // is a FormData).
  async bulkUploadSchedules(file) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch('/api/schedules/bulk-upload', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  },

  listAuditLog: () => request('/api/audit-log'),

  listViolations: () => request('/api/violations'),
  getViolationSettings: () => request('/api/violations/settings'),
  setViolationAlertEmails: (alertEmails) =>
    request('/api/violations/settings', { method: 'PUT', body: JSON.stringify({ alertEmails }) }),
};