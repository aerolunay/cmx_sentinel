import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { version as frontendVersion } from '../../package.json';

// Format: <frontend package version>-<backend package version>, e.g.
// "1.0.0-1.0.2" - lets you tell at a glance whether frontend and
// backend are actually on matching/expected versions, which plain
// "1.0.0" alone couldn't show if they ever drift apart.
export function useAppVersion() {
  const [backendVersion, setBackendVersion] = useState(null);

  useEffect(() => {
    api
      .getBackendVersion()
      .then((data) => setBackendVersion(data.version))
      .catch(() => setBackendVersion('?')); // don't let a failed fetch break the page - just show "?" for the unknown half
  }, []);

  return `${frontendVersion}-${backendVersion ?? '...'}`;
}
