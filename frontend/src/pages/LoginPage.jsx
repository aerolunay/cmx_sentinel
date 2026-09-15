import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Setup2FAModal from '../modals/Setup2FAModal.jsx';
import { useAppVersion } from '../hooks/useAppVersion.js';
import logo from '../assets/cmxlogo.png';

// Flow: identifier -> choose (email code, or authenticator if enrolled)
// -> code (email OTP) or totp (authenticator code). Mirrors
// cmx_callsuite_v2's check-user-first pattern, adapted to accept
// either Employee ID or email as the identifier.
export default function LoginPage() {
  const [step, setStep] = useState('identifier'); // 'identifier' | 'choose' | 'code' | 'totp'
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [totpAvailable, setTotpAvailable] = useState(false);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [show2FAPrompt, setShow2FAPrompt] = useState(false);
  const { requestOtp, verifyOtp, checkUser, loginTotp } = useAuth();
  const navigate = useNavigate();
  const appVersion = useAppVersion();

  async function handleIdentifierSubmit(e) {
    e.preventDefault();
    setError('');
    setMessage('');

    if (!loginIdentifier.trim()) {
      setError('Enter your Employee ID or email address.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await checkUser(loginIdentifier.trim());
      setTotpAvailable(result.totpEnabled);
      if (result.totpEnabled) {
        // Both options available - let them pick, rather than assuming
        // they have their phone handy right now.
        setStep('choose');
      } else {
        // Only one real option - skip straight to it instead of
        // showing a "choose" screen with a single button.
        await sendEmailCode();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function sendEmailCode() {
    setError('');
    setMessage('');
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
      const result = await verifyOtp(loginIdentifier.trim(), code.trim());
      if (!result.totpEnabled) {
        // Offer enrollment right after a fresh email-OTP login - same
        // moment cmx_callsuite_v2 prompts for it. Skipped entirely if
        // they logged in WITH the authenticator already (nothing to
        // offer - see handleVerifyTotp below).
        setShow2FAPrompt(true);
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyTotp(e) {
    e.preventDefault();
    setError('');

    if (!code.trim()) {
      setError('Enter the code from your authenticator app.');
      return;
    }

    setSubmitting(true);
    try {
      await loginTotp(loginIdentifier.trim(), code.trim());
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function resetToIdentifier() {
    setStep('identifier');
    setCode('');
    setError('');
    setMessage('');
  }

  return (
    <div className="login-page">
      <div className="login-box">
        <img src={logo} alt="CallMax" className="login-logo" />
        <p className="login-subtitle">Sentinel</p>
        <p className="app-version">{appVersion}</p>
        {error && <div className="error">{error}</div>}
        {message && !error && <div className="message">{message}</div>}

        {step === 'identifier' && (
          <form onSubmit={handleIdentifierSubmit}>
            <label htmlFor="identifier">Employee ID or Email</label>
            <input
              id="identifier"
              type="text"
              autoFocus
              value={loginIdentifier}
              onChange={(e) => setLoginIdentifier(e.target.value)}
            />
            <button type="submit" disabled={submitting}>
              {submitting ? 'Checking...' : 'Continue'}
            </button>
          </form>
        )}

        {step === 'choose' && (
          <>
            <button type="button" onClick={sendEmailCode} disabled={submitting}>
              {submitting ? 'Sending code...' : 'Send Login Code'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('totp'); setError(''); setMessage(''); }}
              disabled={submitting}
              style={{ marginTop: 10 }}
            >
              Log In with Authenticator
            </button>
            <button type="button" className="link-button" onClick={resetToIdentifier}>
              Use a different Employee ID or email
            </button>
          </>
        )}

        {step === 'code' && (
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
            <button type="button" className="link-button" onClick={resetToIdentifier}>
              Use a different Employee ID or email
            </button>
          </form>
        )}

        {step === 'totp' && (
          <form onSubmit={handleVerifyTotp}>
            <label htmlFor="totpCode">Enter the 6-digit code from your authenticator app</label>
            <input
              id="totpCode"
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
              onClick={() => { setStep('choose'); setCode(''); setError(''); setMessage(''); }}
            >
              Back
            </button>
          </form>
        )}
      </div>

      {show2FAPrompt && (
        <Setup2FAModal
          onClose={() => { setShow2FAPrompt(false); navigate('/'); }}
          onComplete={() => { setShow2FAPrompt(false); navigate('/'); }}
        />
      )}
    </div>
  );
}
