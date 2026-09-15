import { useState } from 'react';
import { api } from '../api.js';

// Reusable TOTP enrollment modal - used both right after a fresh OTP
// login (from LoginPage's "set up now?" prompt) and later from the
// Dashboard's "Set up an authenticator app" link. Kept as one
// component so both call sites share the same QR/confirm logic
// instead of drifting apart over time - same reasoning
// cmx_callsuite_v2's own version of this documents.
export default function Setup2FAModal({ onClose, onComplete }) {
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function startSetup() {
    setError('');
    setBusy(true);
    try {
      const data = await api.totpSetup();
      setQrDataUrl(data.qrDataUrl);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.totpConfirm(code.trim());
      setDone(true);
      onComplete && onComplete();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={done ? onClose : undefined}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>Set up an authenticator app</h2>

        {!qrDataUrl && !done && (
          <>
            <p style={{ fontSize: 14, color: '#444' }}>
              Scan a QR code with Google Authenticator, Authy, or a similar app, then confirm
              with the code it generates. Once set up, you can log in instantly without waiting
              for an email.
            </p>
            {error && <div className="error">{error}</div>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={onClose}>Not now</button>
              <button type="button" className="btn" onClick={startSetup} disabled={busy}>
                {busy ? 'Starting...' : 'Start Setup'}
              </button>
            </div>
          </>
        )}

        {qrDataUrl && !done && (
          <>
            <img
              src={qrDataUrl}
              alt="Scan this QR code with your authenticator app"
              style={{ display: 'block', margin: '16px auto', width: 200, height: 200 }}
            />
            {error && <div className="error">{error}</div>}
            <form onSubmit={confirmSetup}>
              <label htmlFor="totpCode">6-digit code from your app</label>
              <input
                id="totpCode"
                type="text"
                inputMode="numeric"
                maxLength={6}
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                <button type="submit" className="btn" disabled={busy}>
                  {busy ? 'Confirming...' : 'Confirm'}
                </button>
              </div>
            </form>
          </>
        )}

        {done && (
          <>
            <div className="message">Authenticator enabled. You can sign in with it next time.</div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
