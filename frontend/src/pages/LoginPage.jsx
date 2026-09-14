import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import logo from '../assets/cmxlogo.png';

export default function LoginPage() {
  const [step, setStep] = useState('identifier'); // 'identifier' | 'code'
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { requestOtp, verifyOtp } = useAuth();
  const navigate = useNavigate();

  async function handleRequestOtp(e) {
    e.preventDefault();
    setError('');
    setMessage('');

    if (!loginIdentifier.trim()) {
      setError('Enter your Employee ID or email address.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await requestOtp(loginIdentifier.trim());
      setMessage(result.message);
      setStep('code');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyOtp(e) {
    e.preventDefault();
    setError('');

    if (!code.trim()) {
      setError('Enter the code from your email.');
      return;
    }

    setSubmitting(true);
    try {
      await verifyOtp(loginIdentifier.trim(), code.trim());
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-box">
        <img src={logo} alt="CallMax" className="login-logo" />
        <p className="login-subtitle">Sentinel</p>
        {error && <div className="error">{error}</div>}
        {message && !error && <div className="message">{message}</div>}

        {step === 'identifier' ? (
          <form onSubmit={handleRequestOtp}>
            <label htmlFor="identifier">Employee ID or Email</label>
            <input
              id="identifier"
              type="text"
              autoFocus
              value={loginIdentifier}
              onChange={(e) => setLoginIdentifier(e.target.value)}
            />
            <button type="submit" disabled={submitting}>
              {submitting ? 'Sending code...' : 'Send Login Code'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp}>
            <label htmlFor="code">Enter the 6-digit code sent to your email</label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button type="submit" disabled={submitting}>
              {submitting ? 'Verifying...' : 'Log In'}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => { setStep('identifier'); setCode(''); setError(''); setMessage(''); }}
            >
              Use a different Employee ID or email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
