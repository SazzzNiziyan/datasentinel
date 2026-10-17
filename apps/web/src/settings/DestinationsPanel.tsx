import {
  DESTINATION_RECIPIENTS_MAX,
  notificationKinds,
  type CreatedDestination,
  type DeliveryItem,
  type DestinationOptions,
  type DestinationSummary,
  type DestinationType,
  type NotificationKind,
} from '@datasentinel/contracts';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import { ConfirmActionDialog } from '../components/ConfirmActionDialog.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { formatTime } from '../format.ts';
import { kindText, reasonText, typeLabel, whereText } from './destinationDisplay.ts';
import '../pages/RegisterTableDialog.css';
import './DestinationsPanel.css';

const baseTypes: DestinationType[] = ['email', 'slack', 'webhook'];

const problemText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? (caught.detail ?? caught.message) : fallback;

type Pending = { kind: 'test' | 'archive' | 'rotate'; destination: DestinationSummary };

/** Alert destinations: list, add, pause, test, archive, and delivery history
 * (admins and owners; the API enforces it too). */
export function DestinationsPanel({ workspaceId }: { workspaceId: string }) {
  const base = `/workspaces/${workspaceId}/destinations`;
  const list = useApiData<DestinationSummary[]>(base);
  const [pending, setPending] = useState<Pending | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [showForm, setShowForm] = useState(false);
  const [newSecret, setNewSecret] = useState<string | undefined>();
  const [slackFor, setSlackFor] = useState<DestinationSummary | undefined>();
  const [deliveriesFor, setDeliveriesFor] = useState<DestinationSummary | undefined>();

  async function setStatus(d: DestinationSummary, status: 'active' | 'paused') {
    setNotice(undefined);
    setError(undefined);
    try {
      await apiFetch(`${base}/${d.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    } catch (caught) {
      setError(problemText(caught, 'The change was not saved.'));
    }
    list.retry();
  }

  async function confirm() {
    if (pending === undefined) return;
    const { kind, destination } = pending;
    setNotice(undefined);
    setError(undefined);
    try {
      if (kind === 'test') {
        await apiFetch(`${base}/${destination.id}/test`, {
          method: 'POST',
          body: JSON.stringify({ confirm: true }),
        });
        setNotice('Test message queued. Its result appears under Deliveries.');
      } else if (kind === 'rotate') {
        const rotated = await apiFetch<CreatedDestination>(
          `${base}/${destination.id}/rotate-secret`,
          { method: 'POST', body: JSON.stringify({}) },
        );
        setNewSecret(rotated.signingSecret);
        list.retry();
      } else {
        await apiFetch(`${base}/${destination.id}`, { method: 'DELETE' });
        if (deliveriesFor?.id === destination.id) setDeliveriesFor(undefined);
        list.retry();
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 429
          ? 'A test was sent a moment ago. Wait a minute.'
          : problemText(caught, 'The action did not run.'),
      );
    }
    setPending(undefined);
  }

  const columns: Column<DestinationSummary>[] = [
    { key: 'name', header: 'Name', cell: (d) => d.name },
    { key: 'type', header: 'Type', cell: (d) => typeLabel[d.type] },
    { key: 'where', header: 'Where', cell: whereText },
    {
      key: 'alerts',
      header: 'Alerts',
      cell: (d) => (d.type === 'github' ? 'Opened' : d.events.map(kindText).join(', ')),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (d) =>
        d.status === 'active' ? (
          <StatusMark tone="healthy" label="Active" />
        ) : d.status === 'paused' ? (
          <StatusMark tone="warning" label="Paused" />
        ) : (
          <StatusMark tone="neutral" label="Archived" />
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (d) =>
        d.status === 'archived' ? null : (
          <div className="destinations__actions">
            <button
              type="button"
              className="button"
              aria-label={`${d.status === 'active' ? 'Pause' : 'Resume'} ${d.name}`}
              onClick={() => void setStatus(d, d.status === 'active' ? 'paused' : 'active')}
            >
              {d.status === 'active' ? 'Pause' : 'Resume'}
            </button>
            <button
              type="button"
              className="button"
              aria-label={`Send test to ${d.name}`}
              onClick={() => setPending({ kind: 'test', destination: d })}
            >
              Send test
            </button>
            <button
              type="button"
              className="button"
              aria-label={`Deliveries for ${d.name}`}
              aria-expanded={deliveriesFor?.id === d.id}
              onClick={() => setDeliveriesFor(deliveriesFor?.id === d.id ? undefined : d)}
            >
              Deliveries
            </button>
            {d.type !== 'email' && (
              <button
                type="button"
                className="button"
                aria-label={`Rotate secret for ${d.name}`}
                onClick={() =>
                  d.type === 'slack' || d.type === 'github'
                    ? setSlackFor(d)
                    : setPending({ kind: 'rotate', destination: d })
                }
              >
                Rotate secret
              </button>
            )}
            <button
              type="button"
              className="button"
              aria-label={`Archive ${d.name}`}
              onClick={() => setPending({ kind: 'archive', destination: d })}
            >
              Archive
            </button>
          </div>
        ),
    },
  ];

  return (
    <section className="panel" aria-labelledby="destinations-title">
      <h2 id="destinations-title" className="panel__title">
        Alert destinations
      </h2>
      <p>Where incident alerts are sent. Secrets are stored encrypted and are never shown again.</p>
      {list.status === 'error' ? (
        <ErrorState
          title="Could not load alert destinations"
          description={list.error.detail ?? list.error.message}
          onRetry={list.retry}
          retrying={list.retrying}
        />
      ) : (
        <DataTable
          caption="Alert destinations"
          columns={columns}
          rows={list.status === 'ready' ? list.data : []}
          rowKey={(d) => d.id}
          status={list.status === 'loading' ? 'loading' : 'ready'}
          empty={
            <EmptyState
              title="No alert destinations"
              description="Add one to be told when an incident opens."
            />
          }
        />
      )}
      {notice !== undefined && <p role="status">{notice}</p>}
      {error !== undefined && (
        <p role="alert" className="destinations__error">
          {error}
        </p>
      )}
      {showForm ? (
        <AddForm base={base} onCreated={list.retry} onClose={() => setShowForm(false)} />
      ) : (
        <button type="button" className="button" onClick={() => setShowForm(true)}>
          Add destination
        </button>
      )}
      {newSecret !== undefined && (
        <SecretNotice
          heading="New signing secret (copy it now, it is not shown again):"
          secret={newSecret}
          onDone={() => setNewSecret(undefined)}
        />
      )}
      {slackFor !== undefined && (
        <RotateSecretDialog
          base={base}
          destination={slackFor}
          onRotated={() => {
            setNotice('Secret rotated.');
            list.retry();
          }}
          onClose={() => setSlackFor(undefined)}
        />
      )}
      {deliveriesFor !== undefined && (
        <Deliveries key={deliveriesFor.id} base={base} destination={deliveriesFor} />
      )}
      {pending !== undefined && (
        <ConfirmActionDialog
          open
          title={
            pending.kind === 'test'
              ? 'Send a test message?'
              : pending.kind === 'rotate'
                ? 'Rotate the signing secret?'
                : `Archive ${pending.destination.name}?`
          }
          target={pending.destination.name}
          effect={
            pending.kind === 'test'
              ? `This sends one clearly labelled test message to ${pending.destination.name}. It leaves DataSentinel, so only continue if you mean it.`
              : pending.kind === 'rotate'
                ? 'The current secret stops working at once. Update your receiver with the new one.'
                : 'Alerts stop, the stored secret is erased, and it cannot be changed. Its delivery history stays.'
          }
          confirmLabel={
            pending.kind === 'test'
              ? 'Send test message'
              : pending.kind === 'rotate'
                ? 'Rotate secret'
                : 'Archive destination'
          }
          onConfirm={confirm}
          onCancel={() => setPending(undefined)}
        />
      )}
    </section>
  );
}

function Deliveries({ base, destination }: { base: string; destination: DestinationSummary }) {
  const path = `${base}/${destination.id}/deliveries`;
  const items = useApiData<DeliveryItem[]>(path);
  const [error, setError] = useState<string | undefined>();

  async function retryDelivery(item: DeliveryItem) {
    setError(undefined);
    try {
      await apiFetch(`${path}/${item.id}/retry`, { method: 'POST' });
    } catch (caught) {
      setError(problemText(caught, 'The retry was not queued.'));
    }
    items.retry();
  }

  const columns: Column<DeliveryItem>[] = [
    {
      key: 'status',
      header: 'Status',
      cell: (i) =>
        i.status === 'sent'
          ? 'Sent'
          : i.status === 'failed'
            ? 'Failed'
            : i.status === 'suppressed'
              ? 'Skipped'
              : i.attempts === 0
                ? 'Waiting'
                : `Retrying, next try ${formatTime(i.nextAttemptAt)}`,
    },
    { key: 'alert', header: 'Alert', cell: (i) => kindText(i.kind) },
    { key: 'tries', header: 'Tries', cell: (i) => i.attempts },
    { key: 'reason', header: 'Reason', cell: (i) => reasonText(i.lastError) },
    { key: 'when', header: 'When', cell: (i) => formatTime(i.createdAt) },
    {
      key: 'action',
      header: 'Action',
      cell: (i) =>
        i.status === 'failed' ? (
          <button
            type="button"
            className="button"
            aria-label={`Retry ${kindText(i.kind)}`}
            onClick={() => void retryDelivery(i)}
          >
            Retry
          </button>
        ) : null,
    },
  ];

  return (
    <div>
      {items.status === 'error' ? (
        <ErrorState
          title="Could not load deliveries"
          description={items.error.detail ?? items.error.message}
          onRetry={items.retry}
          retrying={items.retrying}
        />
      ) : (
        <DataTable
          caption={`Deliveries for ${destination.name}`}
          columns={columns}
          rows={items.status === 'ready' ? items.data : []}
          rowKey={(i) => i.id}
          status={items.status === 'loading' ? 'loading' : 'ready'}
          empty={
            <EmptyState
              title="No deliveries yet"
              description="Alerts sent here are listed once they are queued."
            />
          }
        />
      )}
      {error !== undefined && (
        <p role="alert" className="destinations__error">
          {error}
        </p>
      )}
    </div>
  );
}

function AddForm({
  base,
  onCreated,
  onClose,
}: {
  base: string;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<DestinationType>('email');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [events, setEvents] = useState<NotificationKind[]>([...notificationKinds]);
  const [error, setError] = useState<string | undefined>();
  const [eventsError, setEventsError] = useState(false);
  const [secret, setSecret] = useState<string | undefined>();
  const [token, setToken] = useState('');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [labels, setLabels] = useState('');
  const options = useApiData<DestinationOptions>(`${base}/options`);
  const types = options.status === 'ready' ? options.data.types : baseTypes;
  const github = type === 'github';

  function toggle(kind: NotificationKind, on: boolean) {
    setEvents((current) => (on ? [...current, kind] : current.filter((k) => k !== kind)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (!github && events.length === 0) {
      setEventsError(true);
      return;
    }
    setEventsError(false);
    const value = target.trim();
    const body =
      type === 'email'
        ? {
            type,
            name,
            recipients: value
              .split(',')
              .map((r) => r.trim())
              .filter((r) => r !== ''),
            events,
          }
        : type === 'slack'
          ? { type, name, webhookUrl: value, events }
          : type === 'github'
            ? {
                type,
                name,
                owner: owner.trim(),
                repo: repo.trim(),
                token: token.trim(),
                labels: labels
                  .split(',')
                  .map((l) => l.trim())
                  .filter((l) => l !== ''),
              }
            : { type, name, url: value, events };
    try {
      const created = await apiFetch<CreatedDestination>(base, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setName('');
      setTarget('');
      setToken('');
      onCreated();
      if (created.signingSecret !== undefined) setSecret(created.signingSecret);
      else onClose();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 409 && caught.code !== 'feature_disabled'
          ? 'A destination with this name already exists.'
          : problemText(caught, 'The destination was not created.'),
      );
    }
  }

  if (secret !== undefined) {
    return (
      <SecretNotice
        heading="Signing secret (copy it now, it is not shown again):"
        secret={secret}
        onDone={() => {
          setSecret(undefined);
          onClose();
        }}
      />
    );
  }

  const targetLabel =
    type === 'email'
      ? `Recipients (comma separated, up to ${DESTINATION_RECIPIENTS_MAX})`
      : type === 'slack'
        ? 'Slack incoming webhook URL'
        : type === 'n8n'
          ? 'n8n webhook address (https)'
          : 'Webhook address (https)';

  return (
    <form className="destinations__form" noValidate onSubmit={(e) => void submit(e)}>
      <label className="destinations__field">
        Type
        <select
          className="text-input"
          value={type}
          onChange={(e) => {
            setType(e.target.value as DestinationType);
            setTarget('');
          }}
        >
          {types.map((t) => (
            <option key={t} value={t}>
              {typeLabel[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="destinations__field">
        Name
        <input
          className="text-input"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {github ? (
        <>
          <label className="destinations__field">
            Repository owner
            <input
              className="text-input"
              required
              autoComplete="off"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
          </label>
          <label className="destinations__field">
            Repository name
            <input
              className="text-input"
              required
              autoComplete="off"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
          </label>
          <label className="destinations__field">
            GitHub access token
            <input
              className="text-input"
              required
              type="password"
              autoComplete="off"
              aria-describedby="destinations-token-help"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <span id="destinations-token-help">
              Use a fine-grained token limited to this one repository with only Issues: write.
            </span>
          </label>
          <label className="destinations__field">
            Labels (comma separated, up to 5, optional)
            <input
              className="text-input"
              autoComplete="off"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
            />
          </label>
          <p>Opens one issue for each new incident.</p>
        </>
      ) : (
        <label className="destinations__field">
          {targetLabel}
          <input
            className="text-input"
            required
            type={type === 'slack' ? 'password' : 'text'}
            autoComplete="off"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
      )}
      {!github && (
        <fieldset>
          <legend>Send alerts for</legend>
          {notificationKinds.map((kind) => (
            <label key={kind} className="destinations__check">
              <input
                type="checkbox"
                checked={events.includes(kind)}
                onChange={(e) => toggle(kind, e.target.checked)}
              />
              {kindText(kind)}
            </label>
          ))}
          {eventsError && (
            <p role="alert" className="destinations__error">
              Choose at least one alert.
            </p>
          )}
        </fieldset>
      )}
      {error !== undefined && (
        <p role="alert" className="destinations__error">
          {error}
        </p>
      )}
      <div className="destinations__actions">
        <button type="submit" className="button button--primary">
          Create destination
        </button>
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SecretNotice({
  heading,
  secret,
  onDone,
}: {
  heading: string;
  secret: string;
  onDone: () => void;
}) {
  return (
    <div className="destinations__secret" role="status">
      <p>{heading}</p>
      <p>
        <code>{secret}</code>
      </p>
      <button type="button" className="button" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

function RotateSecretDialog({
  base,
  destination,
  onRotated,
  onClose,
}: {
  base: string;
  destination: DestinationSummary;
  onRotated: () => void;
  onClose: () => void;
}) {
  const github = destination.type === 'github';
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const fieldId = useId();
  const helpId = useId();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await apiFetch(`${base}/${destination.id}/rotate-secret`, {
        method: 'POST',
        body: JSON.stringify(github ? { token: url.trim() } : { webhookUrl: url.trim() }),
      });
      onRotated();
      onClose();
    } catch (caught) {
      setError(problemText(caught, 'The secret was not rotated.'));
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="register-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!saving) onClose();
      }}
    >
      <h2 id={titleId} className="register-dialog__title">
        {`Rotate the secret for ${destination.name}`}
      </h2>
      <form className="register-dialog__form" noValidate onSubmit={(e) => void submit(e)}>
        <div className="register-dialog__field">
          <label htmlFor={fieldId}>
            {github ? 'New GitHub access token' : 'New Slack incoming webhook URL'}
          </label>
          <input
            id={fieldId}
            className="text-input"
            type="password"
            autoComplete="off"
            required
            aria-describedby={helpId}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <span id={helpId} className="register-dialog__help">
            {github
              ? 'The current token stops working at once.'
              : 'The current URL stops working at once.'}
          </span>
        </div>
        {error !== undefined && (
          <p role="alert" className="register-dialog__error">
            {error}
          </p>
        )}
        <div className="register-dialog__actions">
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            aria-disabled={saving || undefined}
          >
            Rotate secret
          </button>
        </div>
      </form>
    </dialog>
  );
}
