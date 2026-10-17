import {
  INTEGRATION_TOKEN_MAX_DAYS,
  type IntegrationTokenSummary,
  type IssuedIntegrationToken,
} from '@datasentinel/contracts';
import { useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import { ConfirmActionDialog } from '../components/ConfirmActionDialog.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { formatTime } from '../format.ts';
import './DestinationsPanel.css';

const problemText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? (caught.detail ?? caught.message) : fallback;

const expiryChoices = [30, 90, INTEGRATION_TOKEN_MAX_DAYS];

const isExpired = (t: IntegrationTokenSummary) =>
  t.expiresAt !== null && new Date(t.expiresAt).getTime() <= Date.now();

/** Integration tokens for one pipeline-event source (admins and owners; the
 * API enforces it too). A token is shown once, when it is created. */
export function IntegrationTokensPanel({
  workspaceId,
  sourceId,
  archived = false,
}: {
  workspaceId: string;
  sourceId: string;
  archived?: boolean;
}) {
  const base = `/workspaces/${workspaceId}/sources/${sourceId}/integration-tokens`;
  const list = useApiData<IntegrationTokenSummary[]>(base);
  const [revoking, setRevoking] = useState<IntegrationTokenSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [showForm, setShowForm] = useState(false);
  const [newToken, setNewToken] = useState<string | undefined>();

  async function confirmRevoke() {
    if (revoking === undefined) return;
    setError(undefined);
    try {
      await apiFetch(`${base}/${revoking.id}`, { method: 'DELETE' });
    } catch (caught) {
      setError(problemText(caught, 'The token was not revoked.'));
    }
    setRevoking(undefined);
    list.retry();
  }

  const columns: Column<IntegrationTokenSummary>[] = [
    { key: 'name', header: 'Name', cell: (t) => t.name },
    { key: 'created', header: 'Created', cell: (t) => formatTime(t.createdAt) },
    {
      key: 'lastUsed',
      header: 'Last used',
      cell: (t) => (t.lastUsedAt === null ? 'Never' : formatTime(t.lastUsedAt)),
    },
    {
      key: 'expires',
      header: 'Expires',
      cell: (t) => (t.expiresAt === null ? 'Never' : formatTime(t.expiresAt)),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (t) =>
        t.revokedAt !== null ? (
          <StatusMark tone="neutral" label="Revoked" />
        ) : isExpired(t) ? (
          <StatusMark tone="warning" label="Expired" />
        ) : (
          <StatusMark tone="healthy" label="Active" />
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (t) =>
        t.revokedAt !== null || isExpired(t) ? null : (
          <button
            type="button"
            className="button"
            aria-label={`Revoke ${t.name}`}
            onClick={() => setRevoking(t)}
          >
            Revoke
          </button>
        ),
    },
  ];

  return (
    <section className="panel" aria-labelledby={`tokens-title-${sourceId}`}>
      <h2 id={`tokens-title-${sourceId}`} className="panel__title">
        Integration tokens
      </h2>
      <p>
        Tokens let a pipeline report runs to this source. A token works only for this source. It is
        shown once, so copy it when you create it.
      </p>
      <p>
        <code>
          POST /integrations/pipeline-runs with the header Authorization: Bearer {'<token>'}
        </code>
      </p>
      {list.status === 'error' ? (
        <ErrorState
          title="Could not load integration tokens"
          description={list.error.detail ?? list.error.message}
          onRetry={list.retry}
          retrying={list.retrying}
        />
      ) : (
        <DataTable
          caption="Integration tokens"
          columns={columns}
          rows={list.status === 'ready' ? list.data : []}
          rowKey={(t) => t.id}
          status={list.status === 'loading' ? 'loading' : 'ready'}
          empty={
            <EmptyState
              title="No integration tokens"
              description="Create one so a pipeline can report its runs."
            />
          }
        />
      )}
      {error !== undefined && (
        <p role="alert" className="destinations__error">
          {error}
        </p>
      )}
      {!archived &&
        (showForm ? (
          <CreateForm
            base={base}
            onCreated={(token) => {
              setNewToken(token);
              setShowForm(false);
              list.retry();
            }}
            onClose={() => setShowForm(false)}
          />
        ) : (
          <button type="button" className="button" onClick={() => setShowForm(true)}>
            Create token
          </button>
        ))}
      {newToken !== undefined && (
        <div className="destinations__secret" role="status">
          <p>New token (copy it now, it is not shown again):</p>
          <p>
            <code>{newToken}</code>
          </p>
          <button type="button" className="button" onClick={() => setNewToken(undefined)}>
            Done
          </button>
        </div>
      )}
      {revoking !== undefined && (
        <ConfirmActionDialog
          open
          title="Revoke this token?"
          target={revoking.name}
          effect="Pipelines using it stop being accepted at once. This cannot be undone."
          confirmLabel="Revoke token"
          onConfirm={confirmRevoke}
          onCancel={() => setRevoking(undefined)}
        />
      )}
    </section>
  );
}

function CreateForm({
  base,
  onCreated,
  onClose,
}: {
  base: string;
  onCreated: (token: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [days, setDays] = useState(INTEGRATION_TOKEN_MAX_DAYS);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      const issued = await apiFetch<IssuedIntegrationToken>(base, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), expiresInDays: days }),
      });
      onCreated(issued.token);
    } catch (caught) {
      setError(problemText(caught, 'The token was not created.'));
    }
  }

  return (
    <form className="destinations__form" noValidate onSubmit={(e) => void submit(e)}>
      <label className="destinations__field">
        Name
        <input
          className="text-input"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="destinations__field">
        Expires in
        <select
          className="text-input"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {expiryChoices.map((d) => (
            <option key={d} value={d}>
              {`${d} days`}
            </option>
          ))}
        </select>
      </label>
      {error !== undefined && (
        <p role="alert" className="destinations__error">
          {error}
        </p>
      )}
      <div className="destinations__actions">
        <button type="submit" className="button button--primary">
          Create token
        </button>
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
