import {
  incidentTransitions,
  type IncidentDetail,
  type MemberSummary,
  type UpdateIncidentRequest,
} from '@datasentinel/contracts';
import { useState } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import { ReopenDialog } from './ReopenDialog.tsx';
import { ResolveDialog } from './ResolveDialog.tsx';
import './IncidentActions.css';

type Dialog = 'resolve' | 'reopen' | null;

/** The "Actions" panel: change status and assign. Engineer or above only;
 * the caller decides whether to render it, so members load only then. */
export function IncidentActions({
  workspaceId,
  incident,
  onUpdated,
  onReload,
}: {
  workspaceId: string;
  incident: IncidentDetail;
  onUpdated: (next: IncidentDetail) => void;
  onReload: () => void;
}) {
  const members = useApiData<MemberSummary[]>(`/workspaces/${workspaceId}/members`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const allowed = incidentTransitions[incident.status];
  const expectedStatus = incident.status;

  /** Sends one change. Returns an error text only when a dialog should stay open. */
  async function send(body: UpdateIncidentRequest, fromDialog = false): Promise<string | null> {
    if (busy) return null;
    setBusy(true);
    setError(null);
    try {
      const next = await apiFetch<IncidentDetail>(
        `/workspaces/${workspaceId}/incidents/${incident.id}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );
      onUpdated(next);
      return null;
    } catch (e) {
      const text =
        e instanceof ApiError ? (e.detail ?? e.message) : 'The change could not be saved.';
      const changed = e instanceof ApiError && e.code === 'incident_changed';
      if (changed) onReload();
      if (fromDialog && !changed) return text;
      setError(text);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const activeMembers =
    members.status === 'ready' ? members.data.filter((m) => m.status === 'active') : [];

  return (
    <section className="panel" aria-labelledby="actions-title">
      <h2 id="actions-title" className="panel__title">
        Actions
      </h2>
      <div className="incident-actions">
        {allowed.includes('acknowledged') && (
          <button
            type="button"
            className="button"
            aria-disabled={busy || undefined}
            onClick={() => void send({ status: 'acknowledged', expectedStatus })}
          >
            Acknowledge
          </button>
        )}
        {allowed.includes('investigating') && (
          <button
            type="button"
            className="button"
            aria-disabled={busy || undefined}
            onClick={() => void send({ status: 'investigating', expectedStatus })}
          >
            Start investigating
          </button>
        )}
        {allowed.includes('resolved') && (
          <button
            type="button"
            className="button button--primary"
            aria-disabled={busy || undefined}
            onClick={() => setDialog('resolve')}
          >
            Resolve
          </button>
        )}
        {allowed.includes('reopened') && (
          <button
            type="button"
            className="button"
            aria-disabled={busy || undefined}
            onClick={() => setDialog('reopen')}
          >
            Reopen
          </button>
        )}
      </div>
      {members.status === 'ready' && (
        <label className="register-dialog__field">
          Assigned to
          <select
            className="text-input"
            value={incident.assignedMembershipId ?? ''}
            aria-disabled={busy || undefined}
            onChange={(e) =>
              void send({ assignedMembershipId: e.target.value === '' ? null : e.target.value })
            }
          >
            <option value="">Unassigned</option>
            {activeMembers.map((m) => (
              <option key={m.membershipId} value={m.membershipId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
      {error !== null && <p role="alert">{error}</p>}
      {dialog === 'resolve' && (
        <ResolveDialog
          onSubmit={(resolutionNote) =>
            send({ status: 'resolved', expectedStatus, resolutionNote }, true)
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'reopen' && (
        <ReopenDialog
          onSubmit={(reason) => send({ status: 'reopened', expectedStatus, reason }, true)}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}
