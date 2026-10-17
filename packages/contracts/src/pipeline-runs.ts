import { z } from 'zod';

/** FR-07 run states (docs/01). */
export const pipelineRunStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'unknown',
] as const;
export type PipelineRunStatus = (typeof pipelineRunStatuses)[number];

export const terminalRunStatuses: readonly PipelineRunStatus[] = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
];

export const pipelineRunTriggers = ['schedule', 'manual', 'upstream', 'unknown'] as const;

/** Events older than this are refused as replays (D-73). */
export const EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Allowed clock skew for event times ahead of the server. */
export const EVENT_MAX_SKEW_MS = 5 * 60_000;
/** Requests per integration token per minute; more get 429. */
export const PIPELINE_EVENTS_PER_MINUTE = 60;
export const RUN_SUMMARY_MAX = 2000;

/** Runs only move forward: queued or unknown, then running, then one
 * terminal state that never changes. Repeating the current status is
 * allowed, so a retried event is a no-op. */
export function canMoveRun(from: PipelineRunStatus, to: PipelineRunStatus): boolean {
  if (from === to) return true;
  if (terminalRunStatuses.includes(from)) return false;
  if (to === 'queued' || to === 'unknown') return false;
  return !(from === 'running' && to === 'running');
}

/** `dsp_{token ID, 32 hex}_{secret, 43 base64url characters}`. Only a
 * SHA-256 hash of the secret is stored; the ID finds the row. */
export const INTEGRATION_TOKEN_PATTERN = /^dsp_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

/** Reads `Authorization: Bearer dsp_…`; null for anything else. */
export function parseIntegrationToken(
  authorization: string | undefined,
): { tokenId: string; secret: string } | null {
  const match = /^Bearer (\S+)$/.exec(authorization ?? '');
  const parts = match?.[1] === undefined ? null : INTEGRATION_TOKEN_PATTERN.exec(match[1]);
  if (parts?.[1] === undefined || parts[2] === undefined) return null;
  const hex = parts[1];
  const tokenId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { tokenId, secret: parts[2] };
}

/** Whether an event time is inside the replay window at `now`. */
export function checkEventTime(occurredAt: string, now: Date): 'ok' | 'too_old' | 'in_future' {
  const at = Date.parse(occurredAt);
  if (at < now.getTime() - EVENT_MAX_AGE_MS) return 'too_old';
  if (at > now.getTime() + EVENT_MAX_SKEW_MS) return 'in_future';
  return 'ok';
}

/** Removes secrets an external job may print into its summary: URL
 * logins, bearer tokens, DataSentinel tokens, and key=value secrets. */
export function redactRunSummary(text: string): string {
  return text
    .replace(/dsp_[0-9a-f]{32}_[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(
      /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      '$1$2[redacted]',
    )
    .slice(0, RUN_SUMMARY_MAX);
}

const reference = z.string().regex(/^[\w.:/@-]{1,200}$/);
const time = z.iso.datetime({ offset: true });

/** POST …/pipeline-runs with a source's integration token (D-73). The
 * source and workspace come from the token, never from the body.
 * `externalRunId` is the idempotency key: a repeat for the same source
 * returns the existing run and applies the status if it moves forward. */
export const PipelineRunEvent = z.strictObject({
  externalRunId: reference,
  name: z.string().trim().min(1).max(200),
  status: z.enum(pipelineRunStatuses),
  trigger: z.enum(pipelineRunTriggers).default('unknown'),
  /** When the job reported this state; checked against the replay window. */
  occurredAt: time,
  startedAt: time.optional(),
  endedAt: time.optional(),
  /** A dataset of the token's source the run writes. */
  datasetId: z.uuid().optional(),
  correlationId: reference.optional(),
  /** Redacted and cut to RUN_SUMMARY_MAX before storage. */
  summary: z.string().max(20_000).optional(),
});
export type PipelineRunEvent = z.infer<typeof PipelineRunEvent>;

/** PATCH …/pipeline-runs/{id}: a later state of the same run. */
export const PipelineRunUpdate = z.strictObject({
  status: z.enum(pipelineRunStatuses),
  occurredAt: time,
  endedAt: time.optional(),
  summary: z.string().max(20_000).optional(),
});
export type PipelineRunUpdate = z.infer<typeof PipelineRunUpdate>;

export type PipelineRunSummary = {
  id: string;
  sourceId: string;
  datasetId: string | null;
  externalRunId: string;
  name: string;
  status: PipelineRunStatus;
  trigger: (typeof pipelineRunTriggers)[number];
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string;
  correlationId: string | null;
  summary: string | null;
  createdAt: string;
};

/** POST …/sources/{sourceId}/integration-tokens (admin+, audited, D-74). */
export const CreateIntegrationTokenRequest = z.strictObject({
  name: z.string().trim().min(1).max(100),
});

export type IntegrationTokenSummary = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** Returned once, at creation; the token cannot be read again. */
export type IssuedIntegrationToken = IntegrationTokenSummary & { token: string };
