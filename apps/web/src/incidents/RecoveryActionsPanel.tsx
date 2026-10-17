import {
  ACTION_POLICY,
  actionTypes,
  roleAtLeast,
  type ActionItem,
  type ActionOptions,
  type ActionStatus,
  type ActionType,
  type Role,
} from '@datasentinel/contracts';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { ConfirmActionDialog } from '../components/ConfirmActionDialog.tsx';
import { StatusMark, type Tone } from '../components/StatusMark.tsx';
import { formatTime } from '../format.ts';
import { canComment } from '../pages/labels.ts';

const statusDisplay: Record<ActionStatus, { label: string; tone: Tone }> = {
  proposed: { label: 'Waiting for approval', tone: 'info' },
  approved: { label: 'Approved, waiting to run', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Done', tone: 'healthy' },
  failed: { label: 'Failed', tone: 'critical' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const failureText: Record<string, string> = {
  approval_invalid: 'The approval was not valid',
  approval_expired: 'The approval ran out before the action could run',
  payload_changed: 'The action no longer matched what was approved',
  permission_lost: 'Someone involved no longer has the needed role',
  self_approval: 'The same person proposed and approved it, which this workspace does not allow',
  target_unavailable: 'The thing it applies to is no longer available',
  incident_not_found: 'The incident was not found',
  worker_interrupted: 'The action could not be finished',
  execution_failed: 'The action could not be completed after several tries',
  other: 'The action did not run',
};

const eventLabel: Record<string, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  started: 'Started',
  succeeded: 'Succeeded',
  failed: 'Failed',
  expired: 'Expired',
  retry_scheduled: 'Will try again',
};

const typeLabel: Record<ActionType, string> = {
  rerun_validation: 'Run a rule again',
  retry_import: 'Process a failed file again',
  send_notification: 'Send an incident notice',
  create_github_issue: 'Open a GitHub issue',
  trigger_n8n: 'Call an n8n workflow',
};

const destinationTypes: Partial<Record<ActionType, string[]>> = {
  send_notification: ['email', 'slack', 'webhook'],
  create_github_issue: ['github'],
  trigger_n8n: ['n8n'],
};

function resultText(action: ActionItem): string | null {
  if (action.status !== 'succeeded' || action.output === null) return null;
  if ('checkRunId' in action.output) return 'A new check was queued';
  if ('uploadId' in action.output) return 'The file was queued for processing again';
  if ('deliveryId' in action.output) {
    return "A notice was queued for delivery. Its result is in the destination's delivery history";
  }
  return null;
}

const problemText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? (caught.detail ?? caught.message) : fallback;

type Deciding = { action: ActionItem; kind: 'approve' | 'reject' };

/** The "Recovery actions" section of an incident: propose, approve, and watch
 * actions. What each person may do comes from the server (`can`). */
export function RecoveryActionsPanel({
  workspaceId,
  incidentId,
  role,
  pollMs = 3000,
}: {
  workspaceId: string;
  incidentId: string;
  role: Role;
  pollMs?: number;
}) {
  const base = `/workspaces/${workspaceId}/incidents/${incidentId}/actions`;
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<Deciding | null>(null);
  const [proposing, setProposing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await apiFetch<ActionItem[]>(base));
      setLoadError(null);
    } catch (caught) {
      setLoadError(problemText(caught, 'The actions could not be loaded.'));
    }
  }, [base]);

  useEffect(() => {
    let current = true;
    apiFetch<ActionItem[]>(base).then(
      (list) => {
        if (current) {
          setItems(list);
          setLoadError(null);
        }
      },
      (caught: unknown) => {
        if (current) setLoadError(problemText(caught, 'The actions could not be loaded.'));
      },
    );
    return () => {
      current = false;
    };
  }, [base]);

  const active = items?.some((a) => a.status === 'approved' || a.status === 'running') ?? false;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [active, load, pollMs]);

  async function send(path: string, body?: object) {
    setError(null);
    try {
      await apiFetch(path, {
        method: 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (caught) {
      setError(problemText(caught, 'The request did not go through.'));
    }
    await load();
  }

  async function decide() {
    if (deciding === null) return;
    const { action, kind } = deciding;
    setDeciding(null);
    await send(`/workspaces/${workspaceId}/actions/${action.id}/${kind}`, {});
  }

  const canPropose = canComment(role);

  return (
    <section className="panel" aria-labelledby="actions-title">
      <h2 id="actions-title" className="panel__title">
        Recovery actions
      </h2>
      <p>
        Actions here never run on their own. Someone proposes one, an approver with the right role
        approves that exact action, and then DataSentinel runs it once. Nothing is ever written to
        your data sources.
      </p>
      {items === null && loadError === null && <p>Loading recovery actions</p>}
      {items === null && loadError !== null && <p>{loadError}</p>}
      {items !== null && (
        <>
          {canPropose && (
            <div className="destinations__actions">
              <button
                type="button"
                className="button"
                aria-expanded={proposing}
                onClick={() => setProposing((v) => !v)}
              >
                Propose an action
              </button>
            </div>
          )}
          {proposing && canPropose && (
            <ProposeForm
              workspaceId={workspaceId}
              base={base}
              role={role}
              onDone={() => {
                setProposing(false);
                void load();
              }}
            />
          )}
          {error !== null && <p role="alert">{error}</p>}
          {loadError !== null && <p>{loadError}</p>}
          {items.length === 0 && <p>No recovery action has been proposed for this incident.</p>}
          <ul className="recovery-actions" style={{ listStyle: 'none', padding: 0 }}>
            {items.map((action) => (
              <li key={action.id}>
                <ActionCard
                  action={action}
                  role={role}
                  onDecide={(kind) => setDeciding({ action, kind })}
                  onWithdraw={() =>
                    void send(`/workspaces/${workspaceId}/actions/${action.id}/cancel`)
                  }
                />
              </li>
            ))}
          </ul>
        </>
      )}
      {deciding !== null && (
        <ConfirmActionDialog
          open
          title={deciding.kind === 'approve' ? 'Approve this action?' : 'Reject this action?'}
          target={deciding.action.preview.title}
          effect={
            deciding.kind === 'approve'
              ? `${deciding.action.preview.steps.join(' ')} You are approving exactly this action (code ${deciding.action.payloadHash}). The approval is valid for 1 hour.`
              : 'The action will not run. Nothing is sent or changed.'
          }
          confirmLabel={deciding.kind === 'approve' ? 'Approve action' : 'Reject action'}
          onConfirm={decide}
          onCancel={() => setDeciding(null)}
        />
      )}
    </section>
  );
}

function ActionCard({
  action,
  role,
  onDecide,
  onWithdraw,
}: {
  action: ActionItem;
  role: Role;
  onDecide: (kind: 'approve' | 'reject') => void;
  onWithdraw: () => void;
}) {
  const { title, steps, leavesDataSentinel } = action.preview;
  const display = statusDisplay[action.status];
  const result = resultText(action);
  const waiting =
    action.status === 'proposed' && !action.can.approve && roleAtLeast(role, 'engineer');
  return (
    <article className="panel" aria-label={title}>
      <h3>{title}</h3>
      <p>
        <StatusMark tone={display.tone} label={display.label} />
      </p>
      <ul>
        {steps.map((step, n) => (
          <li key={n}>{step}</li>
        ))}
      </ul>
      {leavesDataSentinel && <p>This sends something outside DataSentinel.</p>}
      <p>
        Proposed by {action.proposedByName ?? 'DataSentinel'}
        {action.note !== null && action.note !== '' && `: ${action.note}`}
      </p>
      {action.decidedByName !== null && (
        <p>
          Approved by {action.decidedByName}
          {action.decisionNote !== null && action.decisionNote !== '' && `: ${action.decisionNote}`}
        </p>
      )}
      {action.status === 'proposed' && (
        <p>Proposal expires {formatTime(action.proposalExpiresAt)}.</p>
      )}
      {action.status === 'approved' && action.approvalExpiresAt !== null && (
        <p>
          Approval is only for this exact action (code {action.payloadHash}) and is valid until{' '}
          {formatTime(action.approvalExpiresAt)}.
        </p>
      )}
      {action.status === 'failed' && (
        <p>{failureText[action.failureCode ?? 'other'] ?? failureText.other}</p>
      )}
      {result !== null && <p>{result}</p>}
      {waiting && <p>Waiting for another person with the right role to approve.</p>}
      {(action.can.approve || action.can.reject || action.can.cancel) && (
        <div className="destinations__actions">
          {action.can.approve && (
            <button
              type="button"
              className="button button--primary"
              aria-label={`Approve ${title}`}
              onClick={() => onDecide('approve')}
            >
              Approve
            </button>
          )}
          {action.can.reject && (
            <button
              type="button"
              className="button"
              aria-label={`Reject ${title}`}
              onClick={() => onDecide('reject')}
            >
              Reject
            </button>
          )}
          {action.can.cancel && (
            <button
              type="button"
              className="button"
              aria-label={`Withdraw ${title}`}
              onClick={onWithdraw}
            >
              Withdraw
            </button>
          )}
        </div>
      )}
      <details>
        <summary>History</summary>
        <ul>
          {action.events.map((e) => (
            <li key={e.id}>
              {`${eventLabel[e.type] ?? e.type} · ${e.actorName ?? 'DataSentinel'} · ${formatTime(e.createdAt)}`}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

function ProposeForm({
  workspaceId,
  base,
  role,
  onDone,
}: {
  workspaceId: string;
  base: string;
  role: Role;
  onDone: () => void;
}) {
  const allowed = actionTypes.filter((t) => roleAtLeast(role, ACTION_POLICY[t].propose));
  const [type, setType] = useState<ActionType>(allowed[0] ?? 'rerun_validation');
  const [options, setOptions] = useState<ActionOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  useEffect(() => {
    let current = true;
    apiFetch<ActionOptions>(`${base}/options`).then(
      (loaded) => {
        if (current) setOptions(loaded);
      },
      (caught: unknown) => {
        if (current) setOptionsError(problemText(caught, 'The choices could not be loaded.'));
      },
    );
    return () => {
      current = false;
    };
  }, [base, workspaceId]);

  let choices: { id: string; name: string }[] = [];
  if (options !== null) {
    if (type === 'rerun_validation') choices = options.rules;
    else if (type === 'retry_import') {
      choices = options.uploads.map((u) => ({ id: u.id, name: u.filename }));
    } else {
      const wanted = destinationTypes[type] ?? [];
      choices = options.destinations.filter((d) => wanted.includes(d.type));
    }
  }
  const targetLabel =
    type === 'rerun_validation' ? 'Rule' : type === 'retry_import' ? 'Failed file' : 'Destination';
  const chosen = choices.some((c) => c.id === target) ? target : (choices[0]?.id ?? '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current || chosen === '') return;
    running.current = true;
    setBusy(true);
    setError(null);
    const payload =
      type === 'rerun_validation'
        ? { ruleId: chosen }
        : type === 'retry_import'
          ? { uploadId: chosen }
          : { destinationId: chosen };
    const why = note.trim();
    try {
      await apiFetch(base, {
        method: 'POST',
        body: JSON.stringify({ type, payload, ...(why === '' ? {} : { note: why }) }),
      });
      onDone();
    } catch (caught) {
      setError(problemText(caught, 'The action was not proposed.'));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)}>
      <label>
        Action
        <select
          className="text-input"
          value={type}
          onChange={(e) => {
            setType(e.target.value as ActionType);
            setTarget('');
          }}
        >
          {allowed.map((t) => (
            <option key={t} value={t}>
              {typeLabel[t]}
            </option>
          ))}
        </select>
      </label>
      {options === null && optionsError === null && <p>Loading choices</p>}
      {optionsError !== null && <p>{optionsError}</p>}
      {options !== null &&
        (choices.length === 0 ? (
          <p>Nothing is available for this action.</p>
        ) : (
          <label>
            {targetLabel}
            <select
              className="text-input"
              value={chosen}
              onChange={(e) => setTarget(e.target.value)}
            >
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      <label>
        Why (optional, up to 300 characters)
        <textarea
          className="text-input"
          rows={3}
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error !== null && <p role="alert">{error}</p>}
      <div className="destinations__actions">
        <button type="submit" className="button button--primary" disabled={busy || chosen === ''}>
          Propose action
        </button>
      </div>
    </form>
  );
}
