import type {
  AiSettings,
  IncidentEvidenceItem,
  InvestigationConfidence,
  InvestigationReportItem,
  Role,
} from '@datasentinel/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import { formatTime } from '../format.ts';
import { canArchive, canComment } from '../pages/labels.ts';

const failureText: Record<string, string> = {
  ai_disabled: 'AI investigation was turned off',
  budget_exceeded: 'This workspace has used its daily AI budget',
  input_too_large: 'The incident has too much information to send',
  unavailable: 'The AI provider is not available right now',
  timeout: 'The AI provider took too long to answer',
  rate_limited: 'The AI provider asked us to slow down',
  rejected: 'The AI provider refused the request',
  invalid_response: 'The AI reply did not pass our checks, so it was not used',
  not_json: 'The AI reply did not pass our checks, so it was not used',
  invalid_report: 'The AI reply did not pass our checks, so it was not used',
  redaction_failed: 'The incident facts could not be safely prepared',
  worker_interrupted: 'The report could not be finished',
  incident_not_found: 'The incident was not found',
};

const statusWord = { ready: 'Ready', failed: 'Failed', pending: 'Writing' } as const;

const confidenceWord: Record<InvestigationConfidence, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const problemText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? (caught.detail ?? caught.message) : fallback;

/** The "AI investigation" section of an incident. Everything the model wrote
 * is shown as plain text: never markup, never a link. It is advice only. */
export function InvestigationPanel({
  workspaceId,
  incidentId,
  role,
  evidence,
  pollMs = 3000,
}: {
  workspaceId: string;
  incidentId: string;
  role: Role;
  evidence: IncidentEvidenceItem[];
  pollMs?: number;
}) {
  const settings = useApiData<AiSettings>(`/workspaces/${workspaceId}/ai-settings`);
  const on = settings.status === 'ready' && settings.data.available && settings.data.enabled;

  return (
    <section className="panel" aria-labelledby="investigation-title">
      <h2 id="investigation-title" className="panel__title">
        AI investigation
      </h2>
      {settings.status === 'loading' && <p role="status">Loading AI investigation</p>}
      {settings.status === 'error' && (
        <p>Could not load AI settings. {settings.error.detail ?? settings.error.message}</p>
      )}
      {settings.status === 'ready' && !on && (
        <>
          <p>AI investigation is off for this workspace.</p>
          {canArchive(role) && <p>Turn it on in Settings.</p>}
        </>
      )}
      {on && (
        <Reports
          workspaceId={workspaceId}
          incidentId={incidentId}
          role={role}
          evidence={evidence}
          pollMs={pollMs}
        />
      )}
    </section>
  );
}

function Reports({
  workspaceId,
  incidentId,
  role,
  evidence,
  pollMs,
}: {
  workspaceId: string;
  incidentId: string;
  role: Role;
  evidence: IncidentEvidenceItem[];
  pollMs: number;
}) {
  const base = `/workspaces/${workspaceId}/incidents/${incidentId}/investigations`;
  const [items, setItems] = useState<InvestigationReportItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const load = useCallback(async () => {
    try {
      setItems(await apiFetch<InvestigationReportItem[]>(base));
      setLoadError(null);
    } catch (caught) {
      setLoadError(problemText(caught, 'The reports could not be loaded.'));
    }
  }, [base]);

  useEffect(() => {
    let current = true;
    apiFetch<InvestigationReportItem[]>(base).then(
      (list) => {
        if (current) {
          setItems(list);
          setLoadError(null);
        }
      },
      (caught: unknown) => {
        if (current) setLoadError(problemText(caught, 'The reports could not be loaded.'));
      },
    );
    return () => {
      current = false;
    };
  }, [base]);

  const newest = items?.[0];
  const isPending = newest?.status === 'pending';
  useEffect(() => {
    if (!isPending) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [isPending, load, pollMs]);

  async function generate() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const created = await apiFetch<InvestigationReportItem>(base, { method: 'POST' });
      setItems((current) => [created, ...(current ?? [])]);
      setSelected(null);
      setThanks(false);
    } catch (caught) {
      setError(problemText(caught, 'The report could not be requested.'));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function rate(report: InvestigationReportItem, rating: 'helpful' | 'not_helpful') {
    setError(null);
    setThanks(false);
    try {
      const updated = await apiFetch<InvestigationReportItem>(`${base}/${report.id}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ rating }),
      });
      setItems((current) => (current ?? []).map((r) => (r.id === updated.id ? updated : r)));
      setThanks(true);
    } catch (caught) {
      setError(problemText(caught, 'The feedback was not saved.'));
    }
  }

  if (items === null) {
    return loadError === null ? (
      <p role="status">Loading reports</p>
    ) : (
      <p role="alert">{loadError}</p>
    );
  }

  const shown = items.find((r) => r.id === selected) ?? items[0];
  const canAct = canComment(role);
  const generateButton = (label: string) => (
    <button
      type="button"
      className="button button--primary"
      disabled={busy || isPending}
      onClick={() => void generate()}
    >
      {label}
    </button>
  );

  return (
    <>
      {items.length === 0 && <p>No report has been written for this incident yet.</p>}
      {canAct && generateButton(items.length === 0 ? 'Generate report' : 'Regenerate report')}
      {error !== null && <p role="alert">{error}</p>}
      {loadError !== null && <p role="alert">{loadError}</p>}
      {items.length > 1 && (
        <label>
          Report version
          <select
            className="text-input"
            value={shown?.id}
            onChange={(e) => {
              setSelected(e.target.value);
              setThanks(false);
            }}
          >
            {items.map((r) => (
              <option key={r.id} value={r.id}>
                {`Version ${r.version}, ${formatTime(r.createdAt)}, ${statusWord[r.status]}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {shown?.status === 'pending' && (
        <p role="status">Writing the report. The incident does not wait for this.</p>
      )}
      {shown?.status === 'failed' && (
        <>
          <p>{failureText[shown.failureCode ?? ''] ?? 'The report could not be written'}</p>
          {canAct && generateButton('Try again')}
        </>
      )}
      {shown?.status === 'ready' && shown.report !== null && (
        <ReadyReport
          item={shown}
          evidence={evidence}
          canAct={canAct}
          thanks={thanks}
          onRate={(rating) => void rate(shown, rating)}
        />
      )}
    </>
  );
}

function ReadyReport({
  item,
  evidence,
  canAct,
  thanks,
  onRate,
}: {
  item: InvestigationReportItem;
  evidence: IncidentEvidenceItem[];
  canAct: boolean;
  thanks: boolean;
  onRate: (rating: 'helpful' | 'not_helpful') => void;
}) {
  const report = item.report;
  if (report === null) return null;
  const refs = (ids: string[]): string => {
    const numbers = ids
      .map((id) => evidence.findIndex((e) => e.id === id) + 1)
      .filter((n) => n > 0);
    return numbers.length === 0 ? '' : `Evidence ${numbers.join(', ')}`;
  };
  const footer = [
    `Version ${item.version}`,
    [item.providerName, item.model].filter(Boolean).join(' ') || null,
    `prompt v${item.templateVersion}`,
    `${item.excerptCount} document excerpts used`,
    item.completedAt === null ? null : formatTime(item.completedAt),
  ]
    .filter((part) => part !== null && part !== '')
    .join(' · ');

  return (
    <div>
      <p>
        <strong>AI-generated advice. Check it against the evidence.</strong>
      </p>
      <h3>Summary</h3>
      <p>{report.summary}</p>
      <h3>Facts (from the evidence)</h3>
      {report.facts.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {report.facts.map((f, n) => (
            <li key={n}>
              {f.statement} {refs(f.evidenceIds) !== '' && <span>({refs(f.evidenceIds)})</span>}
            </li>
          ))}
        </ul>
      )}
      <h3>Possible explanations (not facts)</h3>
      {report.hypotheses.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {report.hypotheses.map((h, n) => (
            <li key={n}>
              {h.statement} <span>{confidenceWord[h.confidence]} confidence</span>{' '}
              {refs(h.evidenceIds) !== '' && <span>({refs(h.evidenceIds)})</span>}
            </li>
          ))}
        </ul>
      )}
      <h3>Suggested checks (read-only)</h3>
      {report.suggestedChecks.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {report.suggestedChecks.map((c, n) => (
            <li key={n}>{c.description}</li>
          ))}
        </ul>
      )}
      <h3>What this report cannot know</h3>
      <ul>
        {report.limitations.map((l, n) => (
          <li key={n}>{l}</li>
        ))}
      </ul>
      <p>
        <strong>Overall confidence: {confidenceWord[report.confidence]}</strong>
      </p>
      <p>{footer}</p>
      {canAct && (
        <div className="destinations__actions">
          <button
            type="button"
            className="button"
            aria-pressed={item.feedback.mine === 'helpful'}
            onClick={() => onRate('helpful')}
          >
            Helpful
          </button>
          <button
            type="button"
            className="button"
            aria-pressed={item.feedback.mine === 'not_helpful'}
            onClick={() => onRate('not_helpful')}
          >
            Not helpful
          </button>
        </div>
      )}
      <p>
        {item.feedback.helpful} found this helpful · {item.feedback.notHelpful} found this not
        helpful
      </p>
      {thanks && <p role="status">Thanks for the feedback.</p>}
    </div>
  );
}
