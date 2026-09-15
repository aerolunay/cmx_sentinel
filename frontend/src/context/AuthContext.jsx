import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // On first load, check for an existing session (e.g. page refresh)
  // rather than assuming the user is logged out.
  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function requestOtp(loginIdentifier) {
    return api.requestOtp(loginIdentifier);
  }

  async function verifyOtp(loginIdentifier, code) {
    const result = await api.verifyOtp(loginIdentifier, code);
    setUser(result);
    return result;
  }

  async function checkUser(loginIdentifier) {
    return api.checkUser(loginIdentifier);
  }

  async function loginTotp(loginIdentifier, code) {
    const result = await api.loginTotp(loginIdentifier, code);
    setUser(result);
    return result;
  }

  async function logout() {
    await api.logout();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, requestOtp, verifyOtp, checkUser, loginTotp, logout, refreshUser: () => api.me().then(setUser) }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
