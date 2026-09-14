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
};
