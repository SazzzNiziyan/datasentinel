import { z } from 'zod';

/** FR-09 incident states (docs/01 section 7). Transitions are validated in
 * the API, never set by the browser. */
export const incidentStatuses = [
  'open',
  'acknowledged',
  'investigating',
  'resolved',
  'reopened',
] as const;
export type IncidentStatus = (typeof incidentStatuses)[number];

/** A repeat failure within this long after resolution reopens the same
 * incident; later ones open a new incident (D-79, answers Q-03). */
export const INCIDENT_REOPEN_WINDOW_MS = 24 * 60 * 60_000;

/** One incident per rule: repeated failures of a rule group together
 * (D-79). The workspace and dataset follow from the rule. */
export const incidentDedupeKey = (ruleId: string): string => `rule:${ruleId}`;

/** Which check results open or feed an incident (D-79, Q-02, D-58): a
 * failed check of a critical rule. Warning and info rules show on the
 * dashboard only. An `error` result means the check could not run (access
 * or timeout), which is a source or system problem, not evidence about the
 * data, so it stays on the rule and source health. */
export function qualifiesForIncident(check: {
  status: string;
  ruleSeverity: 'critical' | 'warning' | 'info';
}): boolean {
  return check.status === 'failed' && check.ruleSeverity === 'critical';
}

export type GroupingDecision = 'create' | 'append' | 'reopen';

/** What to do with a qualifying failure, given the newest incident that
 * has the same dedupe key (or null). `append`: add the check as evidence.
 * `reopen`: set the incident to `reopened`, then append. `create`: open a
 * new incident. */
export function decideGrouping(
  latest: { status: IncidentStatus; resolvedAt: Date | null } | null,
  now: Date,
): GroupingDecision {
  if (latest === null) return 'create';
  if (latest.status !== 'resolved') return 'append';
  const resolvedAt = latest.resolvedAt?.getTime();
  return resolvedAt !== undefined && now.getTime() - resolvedAt <= INCIDENT_REOPEN_WINDOW_MS
    ? 'reopen'
    : 'create';
}

/** What an incident's evidence can point to (D-81). Each row references an
 * existing record of the same workspace and stores a small safe summary. */
export const evidenceKinds = [
  'check_run',
  'profile_snapshot',
  'schema_snapshot',
  'pipeline_run',
] as const;
export type EvidenceKind = (typeof evidenceKinds)[number];

const severityRank = { critical: 0, warning: 1, info: 2 } as const;
/** Needs attention first: new and reopened, then being handled, then done. */
const statusRank: Record<IncidentStatus, number> = {
  open: 0,
  reopened: 0,
  acknowledged: 1,
  investigating: 1,
  resolved: 2,
};

/** The list's priority order (D-82): severity first (critical, warning,
 * info), then status (open and reopened, then acknowledged and
 * investigating, then resolved), then the newest failure, then ID. */
export function compareIncidentsByPriority(
  a: {
    id: string;
    severity: 'critical' | 'warning' | 'info';
    status: IncidentStatus;
    lastFailureAt: Date;
  },
  b: {
    id: string;
    severity: 'critical' | 'warning' | 'info';
    status: IncidentStatus;
    lastFailureAt: Date;
  },
): number {
  return (
    severityRank[a.severity] - severityRank[b.severity] ||
    statusRank[a.status] - statusRank[b.status] ||
    b.lastFailureAt.getTime() - a.lastFailureAt.getTime() ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

export const INCIDENT_LIST_MAX_OFFSET = 5000;

/** GET …/incidents filters (D-82). `status=active` means every state
 * except resolved. `assignee` is `me`, `unassigned`, or a membership ID.
 * Times filter on the last failure. */
export const IncidentQuery = z.strictObject({
  status: z.enum([...incidentStatuses, 'active']).optional(),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  datasetId: z.uuid().optional(),
  assignee: z.union([z.enum(['me', 'unassigned']), z.uuid()]).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  sort: z.enum(['priority', 'recent']).default('priority'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(INCIDENT_LIST_MAX_OFFSET).default(0),
});
export type IncidentQuery = z.infer<typeof IncidentQuery>;

export type IncidentListItem = {
  id: string;
  title: string;
  severity: 'critical' | 'warning' | 'info';
  status: IncidentStatus;
  datasetId: string;
  datasetName: string;
  ruleId: string;
  assignedMembershipId: string | null;
  assigneeName: string | null;
  /** Failed checks attached as evidence (D-80). */
  failureCount: number;
  lastFailureAt: string;
  openedAt: string;
  resolvedAt: string | null;
};

export type IncidentPage = {
  incidents: IncidentListItem[];
  /** All incidents matching the filters, not only this page. */
  total: number;
  /** Where the next page starts, or null on the last page. */
  nextOffset: number | null;
};

export type IncidentEvidenceItem = {
  id: string;
  kind: EvidenceKind;
  /** The ID of the check run, snapshot, or pipeline run (D-81). */
  referenceId: string;
  observedAt: string;
  /** Counts and names only, never row samples. */
  summary: Record<string, unknown>;
};

/** A pipeline run attached as evidence, with why it was linked (D-76). */
export type IncidentRelatedRun = {
  pipelineRunId: string;
  name: string;
  status: string;
  sourceName: string;
  reason: CorrelationReasonName;
  /** Minutes between the run and the failed check; 0 while it was active. */
  distanceMinutes: number;
  observedAt: string;
};
export type CorrelationReasonName = 'dataset_id' | 'correlation_id';

export type IncidentHistoryItem = {
  id: string;
  type: string;
  /** `system` or `user`. */
  actorType: string;
  actorName: string | null;
  fromStatus: IncidentStatus | null;
  toStatus: IncidentStatus | null;
  details: Record<string, unknown>;
  createdAt: string;
};

/** GET …/incidents/{incidentId} (D-83). */
export type IncidentDetail = IncidentListItem & {
  sourceId: string;
  ruleName: string;
  ruleType: string;
  resolutionNote: string | null;
  /** The newest failed check attached: what was expected and what was
   * measured. Null if no check evidence exists. */
  latestCheck: {
    checkRunId: string;
    observedAt: string;
    ruleVersion: number | null;
    expected: Record<string, unknown> | null;
    actual: Record<string, unknown> | null;
  } | null;
  relatedRuns: IncidentRelatedRun[];
  /** Every evidence row, newest first. */
  evidence: IncidentEvidenceItem[];
  /** Oldest first. */
  history: IncidentHistoryItem[];
  /** Oldest first. */
  comments: IncidentCommentItem[];
};

/** Which status changes a person may make (D-84). Open and reopened are
 * entered by the system or by reopening, never chosen directly; resolved
 * can only be reopened; nothing goes back to an earlier working state. */
export const incidentTransitions: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ['acknowledged', 'investigating', 'resolved'],
  reopened: ['acknowledged', 'investigating', 'resolved'],
  acknowledged: ['investigating', 'resolved'],
  investigating: ['resolved'],
  resolved: ['reopened'],
};

export function canTransitionIncident(from: IncidentStatus, to: IncidentStatus): boolean {
  return incidentTransitions[from].includes(to);
}

export const RESOLUTION_NOTE_MAX = 2000;
export const REOPEN_REASON_MAX = 500;

/** PATCH …/incidents/{incidentId} (engineer or above, audited, D-84).
 * `status` needs `expectedStatus`, the status the person saw, so two people
 * cannot silently overwrite each other. Resolving needs a resolution note
 * and reopening needs a reason; both are kept in the history. `assignedMembershipId`
 * assigns a workspace member, or `null` unassigns. */
export const UpdateIncidentRequest = z
  .strictObject({
    status: z.enum(['acknowledged', 'investigating', 'resolved', 'reopened']).optional(),
    expectedStatus: z.enum(incidentStatuses).optional(),
    resolutionNote: z.string().trim().min(1).max(RESOLUTION_NOTE_MAX).optional(),
    reason: z.string().trim().min(1).max(REOPEN_REASON_MAX).optional(),
    assignedMembershipId: z.uuid().nullable().optional(),
  })
  .superRefine((r, ctx) => {
    const problem = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (r.status === undefined && r.assignedMembershipId === undefined) {
      problem('status', 'Send a status change, an assignee, or both.');
    }
    if (r.status !== undefined && r.expectedStatus === undefined) {
      problem('expectedStatus', 'Send the status you saw.');
    }
    if (r.status === 'resolved' && r.resolutionNote === undefined) {
      problem('resolutionNote', 'A resolution note is required to resolve.');
    }
    if (r.status === 'reopened' && r.reason === undefined) {
      problem('reason', 'A reason is required to reopen.');
    }
    if (r.resolutionNote !== undefined && r.status !== 'resolved') {
      problem('resolutionNote', 'A resolution note belongs only with resolving.');
    }
    if (r.reason !== undefined && r.status !== 'reopened') {
      problem('reason', 'A reason belongs only with reopening.');
    }
  });
export type UpdateIncidentRequest = z.infer<typeof UpdateIncidentRequest>;

export const INCIDENT_COMMENT_MAX = 2000;

/** POST …/incidents/{incidentId}/comments (analyst or above, audited,
 * D-85). Plain text; comments cannot be edited or deleted. */
export const CreateIncidentCommentRequest = z.strictObject({
  text: z.string().trim().min(1).max(INCIDENT_COMMENT_MAX),
});
export type CreateIncidentCommentRequest = z.infer<typeof CreateIncidentCommentRequest>;

export type IncidentCommentItem = {
  id: string;
  authorMembershipId: string | null;
  authorName: string | null;
  text: string;
  createdAt: string;
};
