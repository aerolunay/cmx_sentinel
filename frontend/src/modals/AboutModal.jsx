import { useAppVersion } from '../hooks/useAppVersion.js';
import logo from '../assets/cmxlogo.png';

export default function AboutModal({ onClose }) {
  const appVersion = useAppVersion();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
        <img src={logo} alt="CallMax" style={{ height: 48, width: 'auto', margin: '0 auto 12px' }} />
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1a2b4a', letterSpacing: 0.5 }}>
          SENTINEL &copy;
        </div>
        <div className="app-version" style={{ margin: '4px 0 16px' }}>v {appVersion}</div>

        <p style={{ fontSize: 13, color: '#444', lineHeight: 1.5, margin: '0 0 20px' }}>
          CMX Sentinel Admin is the management console for CMX Sentinel, a call
          center agent monitoring platform - covering agent and website
          restriction management, screen recording review, and efficiency
          reporting.
        </p>

        <div style={{ fontSize: 12, color: '#666', lineHeight: 1.6 }}>
          <div>Designed and Developed by: Aerol Unay || DREAM + Dev OPS</div>
          <div>Callmax Solutions</div>
          <div>9/15/2026</div>
        </div>

        <div className="modal-actions" style={{ justifyContent: 'center' }}>
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
