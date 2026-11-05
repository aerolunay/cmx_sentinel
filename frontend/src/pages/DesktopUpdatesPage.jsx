import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Super Admin: publish a new CMX Sentinel Desktop version to agent PCs.
// Upload the two files build-release.ps1 writes (installer\Output\):
// the signed CmxSentinel_v_X.Y.Z_Setup.exe and updates\latest.json.
// The server checks they belong together, then uploads the installer
// and the manifest (in that order) to the S3 bucket's updates/ folder.
// PCs check hourly and install at the next logout.

function formatSize(bytes) {
  if (bytes == null) return '';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function DesktopUpdatesPage() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [installer, setInstaller] = useState(null);
  const [manifestFile, setManifestFile] = useState(null);
  const [manifest, setManifest] = useState(null); // parsed, for the preview
  const [manifestProblem, setManifestProblem] = useState('');
  const [progress, setProgress] = useState(null); // 0-100 while uploading, 'processing' after
  const [result, setResult] = useState(null);

  async function load() {
    setLoading(true);
    try {
      setStatus(await api.getDesktopUpdates());
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function chooseManifest(file) {
    setManifestFile(file);
    setManifest(null);
    setManifestProblem('');
    if (!file) return;
    try {
      setManifest(JSON.parse((await file.text()).replace(/^﻿/, '')));
    } catch {
      setManifestProblem('This file is not valid JSON - choose the latest.json from installer\\Output\\updates.');
    }
  }

  // Quick checks before uploading ~110 MB - the server checks again,
  // including the SHA-256.
  const versionFromName = installer ? (/^CmxSentinel_v_(\d+\.\d+\.\d+)_Setup\.exe$/.exec(installer.name) || [])[1] : null;
  let pairProblem = '';
  if (installer && !versionFromName) pairProblem = 'The installer must be named CmxSentinel_v_X.Y.Z_Setup.exe.';
  else if (installer && manifest && manifest.version !== versionFromName) {
    pairProblem = `The installer is version ${versionFromName} but latest.json is for ${manifest.version}.`;
  } else if (installer && manifest && manifest.installerKey !== `updates/${installer.name}`) {
    pairProblem = `latest.json points to ${manifest.installerKey}, not updates/${installer.name}.`;
  }
  const busy = progress !== null;
  const canPublish = installer && manifestFile && manifest && !pairProblem && !manifestProblem && !busy;
  const pilot = manifest && Array.isArray(manifest.machines) && manifest.machines.length > 0 ? manifest.machines : null;

  async function handlePublish(e) {
    e.preventDefault();
    if (!canPublish) return;
    const audience = pilot ? `only these PCs: ${pilot.join(', ')}` : 'ALL agent PCs';
    if (!window.confirm(`Publish CMX Sentinel Desktop ${manifest.version} to ${audience}?\n\nPCs install it at their next logout.`)) return;
    setError('');
    setResult(null);
    setProgress(0);
    try {
      const res = await api.publishDesktopUpdate(installer, manifestFile, (pct) => setProgress(pct >= 100 ? 'processing' : pct));
      setResult(res);
      setInstaller(null);
      setManifestFile(null);
      setManifest(null);
      e.target.reset();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setProgress(null);
    }
  }

  const published = status?.published;

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Desktop Updates</h2>
      <p style={{ fontSize: 13, color: '#555', maxWidth: 760 }}>
        Publish a new version of CMX Sentinel Desktop to agent PCs. Upload the two files from the same
        build-release.ps1 run (installer\Output): the signed installer and updates\latest.json. Agent PCs check
        every hour, then install silently at the next logout (or startup).
      </p>

      {error && <div className="error">{error}</div>}

      <div className="dashboard-card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Published now</h3>
        {loading ? (
          <p>Loading...</p>
        ) : published ? (
          <table className="report-table" style={{ maxWidth: 760 }}>
            <tbody>
              <tr><th style={{ width: 160 }}>Version</th><td><strong>{published.version}</strong></td></tr>
              <tr><th>Goes to</th><td>{published.machines.length ? `Pilot PCs only: ${published.machines.join(', ')}` : 'All agent PCs'}</td></tr>
              <tr><th>Installer</th><td>{published.installerKey}</td></tr>
              <tr><th>SHA-256</th><td style={{ fontFamily: 'Consolas, monospace', fontSize: 12, wordBreak: 'break-all' }}>{published.sha256}</td></tr>
              <tr><th>Published</th><td>{formatDateTime(published.publishedAt)}</td></tr>
            </tbody>
          </table>
        ) : !error ? (
          <p>No version has been published yet.</p>
        ) : null}
      </div>

      <div className="dashboard-card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Publish a new version</h3>
        <form onSubmit={handlePublish} style={{ display: 'grid', gap: 12, maxWidth: 760 }}>
          <label style={{ fontSize: 14 }}>
            Installer (CmxSentinel_v_X.Y.Z_Setup.exe)
            <input type="file" accept=".exe" disabled={busy} onChange={(e) => setInstaller(e.target.files[0] || null)} style={{ display: 'block', marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 14 }}>
            Manifest (latest.json)
            <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => chooseManifest(e.target.files[0] || null)} style={{ display: 'block', marginTop: 4 }} />
          </label>

          {manifestProblem && <div className="error">{manifestProblem}</div>}
          {pairProblem && <div className="error">{pairProblem}</div>}

          {manifest && !manifestProblem && (
            <div style={{ fontSize: 13, background: '#f5f7fb', borderRadius: 6, padding: 10 }}>
              <div>Version: <strong>{manifest.version}</strong>{published?.version && <> (published now: {published.version})</>}</div>
              <div>Goes to: <strong>{pilot ? `pilot PCs only - ${pilot.join(', ')}` : 'all agent PCs'}</strong></div>
              {installer && <div>Installer: {installer.name} ({formatSize(installer.size)})</div>}
            </div>
          )}

          {busy && (
            <div>
              <div style={{ height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progress === 'processing' ? 100 : progress}%`, background: '#1e88d2', transition: 'width .2s' }} />
              </div>
              <p style={{ fontSize: 13, margin: '6px 0 0' }}>
                {progress === 'processing'
                  ? 'Checking the files and uploading them to S3...'
                  : `Uploading... ${progress}%`}
              </p>
            </div>
          )}

          <div>
            <button type="submit" className="btn" disabled={!canPublish}>Upload and publish</button>
          </div>
        </form>

        {result && (
          <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: '#ecfdf5', color: '#065f46', fontSize: 14 }}>
            Published <strong>{result.version}</strong>
            {result.previousVersion ? ` (was ${result.previousVersion})` : ''} to{' '}
            {result.machines.length ? `pilot PCs: ${result.machines.join(', ')}` : 'all agent PCs'}. PCs pick it up within an hour and
            install it at their next logout.
          </div>
        )}
      </div>

      {status?.installers?.length > 0 && (
        <div className="dashboard-card">
          <h3 style={{ marginTop: 0 }}>Installers in S3 (updates/)</h3>
          <div className="report-table-wrap">
            <table className="report-table">
              <thead><tr><th>Version</th><th>File</th><th>Size</th><th>Uploaded</th></tr></thead>
              <tbody>
                {status.installers.map((x) => (
                  <tr key={x.key}>
                    <td>{x.version}{published?.installerKey === x.key ? ' (published)' : ''}</td>
                    <td>{x.fileName}</td>
                    <td>{formatSize(x.sizeBytes)}</td>
                    <td>{formatDateTime(x.uploadedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
