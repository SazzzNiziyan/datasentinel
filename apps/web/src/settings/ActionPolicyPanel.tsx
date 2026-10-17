import type { Role } from '@datasentinel/contracts';
import { useState } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import './DestinationsPanel.css';

const problemText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? (caught.detail ?? caught.message) : fallback;

/** Whether a second person must approve recovery actions. Only owners change
 * it; the API enforces that too. */
export function ActionPolicyPanel({ workspaceId, role }: { workspaceId: string; role: Role }) {
  const path = `/workspaces/${workspaceId}/action-policy`;
  const policy = useApiData<{ requireSecondApprover: boolean }>(path);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function update(requireSecondApprover: boolean) {
    setError(undefined);
    setBusy(true);
    try {
      await apiFetch(path, { method: 'PUT', body: JSON.stringify({ requireSecondApprover }) });
    } catch (caught) {
      setError(problemText(caught, 'The setting was not changed.'));
    }
    setBusy(false);
    policy.retry();
  }

  return (
    <section className="panel" aria-labelledby="action-policy-title">
      <h2 id="action-policy-title" className="panel__title">
        Action approvals
      </h2>
      <p>
        When on, the person who proposes a recovery action cannot approve it, so two people are
        always behind it.
      </p>
      {policy.status === 'loading' && <p>Loading action approvals</p>}
      {policy.status === 'error' && (
        <p>Could not load action approvals. {policy.error.detail ?? policy.error.message}</p>
      )}
      {policy.status === 'ready' && (
        <>
          <p>
            {policy.data.requireSecondApprover
              ? 'Two people required'
              : 'One person may propose and approve'}
          </p>
          {role === 'owner' && (
            <label>
              <input
                type="checkbox"
                checked={policy.data.requireSecondApprover}
                disabled={busy}
                onChange={(e) => void update(e.target.checked)}
              />{' '}
              Require a second person to approve actions
            </label>
          )}
        </>
      )}
      {error !== undefined && (
        <p role="alert" className="destinations__error">
          {error}
        </p>
      )}
    </section>
  );
}
