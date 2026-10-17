import type { DatasetDetail } from '@datasentinel/contracts';
import { useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';

const POLL_MS = 1500;
const POLL_LIMIT = 40;

/** Queues a profile of a database dataset and reloads the page once a new
 * profile (or failure) is recorded (D-52). */
export function ProfileNow({
  workspaceId,
  datasetId,
  latestProfileId,
  onProfiled,
}: {
  workspaceId: string;
  datasetId: string;
  latestProfileId: string | null;
  onProfiled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);
  // Set on every mount: development mode mounts twice, and a flag left
  // false by the first unmount would stop the follow-up below for good.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function run() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const path = `/workspaces/${workspaceId}/datasets/${datasetId}`;
    try {
      await apiFetch(`${path}/profile-runs`, { method: 'POST' });
      for (let i = 0; i < POLL_LIMIT; i++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (!alive.current) return;
        const d = await apiFetch<DatasetDetail>(path);
        if (d.latestProfile !== null && d.latestProfile.id !== latestProfileId) {
          onProfiled();
          return;
        }
      }
      setMessage('Profiling is taking longer than usual. Reload the page later.');
    } catch (e) {
      if (alive.current) {
        setMessage(e instanceof ApiError ? e.message : 'The profile could not start.');
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="button button--primary"
        aria-disabled={busy}
        onClick={() => void run()}
      >
        {busy ? 'Profiling…' : 'Profile now'}
      </button>
      {message !== null && (
        <p role="alert" className="lifecycle-actions__error">
          {message}
        </p>
      )}
    </>
  );
}
