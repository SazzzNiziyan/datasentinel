import { z } from 'zod';

/** Recovery actions (D-113). An action is a typed proposal with an exact
 * payload; nothing runs until someone allowed approves that exact payload,
 * and the worker checks the approval again at the moment it runs. No action
 * can write to a monitored source: every action only re-queues work
 * DataSentinel already does or sends a notification through a configured
 * destination. */
export const actionTypes = [
  'rerun_validation',
  'retry_import',
  'send_notification',
  'create_github_issue',
  'trigger_n8n',
] as const;
export type ActionType = (typeof actionTypes)[number];

const id = z.uuid();

/** The exact payload of each action type. Strict: nothing extra can ride along. */
export const actionPayloadSchemas = {
  /** Runs one rule's check again. Read-only on the source. */
  rerun_validation: z.strictObject({ ruleId: id }),
  /** Parses a failed CSV upload again from the stored file. */
  retry_import: z.strictObject({ uploadId: id }),
  /** Sends an incident notice through one email, Slack, or webhook destination. */
  send_notification: z.strictObject({ destinationId: id }),
  /** Opens a GitHub issue for the incident through one GitHub destination. */
  create_github_issue: z.strictObject({ destinationId: id }),
  /** Calls one n8n destination with the incident notice. */
  trigger_n8n: z.strictObject({ destinationId: id }),
} as const satisfies Record<ActionType, z.ZodType>;

export type ActionPayload<T extends ActionType = ActionType> = z.infer<
  (typeof actionPayloadSchemas)[T]
>;

/** POST …/incidents/{id}/actions. */
export const ProposeActionRequest = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('rerun_validation'),
    payload: actionPayloadSchemas.rerun_validation,
    note: z.string().trim().max(300).optional(),
  }),
  z.strictObject({
    type: z.literal('retry_import'),
    payload: actionPayloadSchemas.retry_import,
    note: z.string().trim().max(300).optional(),
  }),
  z.strictObject({
    type: z.literal('send_notification'),
    payload: actionPayloadSchemas.send_notification,
    note: z.string().trim().max(300).optional(),
  }),
  z.strictObject({
    type: z.literal('create_github_issue'),
    payload: actionPayloadSchemas.create_github_issue,
    note: z.string().trim().max(300).optional(),
  }),
  z.strictObject({
    type: z.literal('trigger_n8n'),
    payload: actionPayloadSchemas.trigger_n8n,
    note: z.string().trim().max(300).optional(),
  }),
]);
export type ProposeActionRequest = z.infer<typeof ProposeActionRequest>;

/** Approve or reject; a rejection should say why. */
export const DecideActionRequest = z.strictObject({
  note: z.string().trim().max(300).optional(),
});
export type DecideActionRequest = z.infer<typeof DecideActionRequest>;

/** PUT …/action-policy (owner). When on, whoever proposed an action cannot
 * approve it, so every action has two people behind it (D-116). */
export const UpdateActionPolicyRequest = z.strictObject({
  requireSecondApprover: z.boolean(),
});
export type UpdateActionPolicyRequest = z.infer<typeof UpdateActionPolicyRequest>;

export const actionStatuses = [
  'proposed',
  'approved',
  'rejected',
  'expired',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type ActionStatus = (typeof actionStatuses)[number];

export type ActionRole = 'viewer' | 'analyst' | 'engineer' | 'admin' | 'owner';

/** Who may propose and who may approve each action (D-115). Rejecting and
 * approving need the same role. The worker, not a person, executes. */
export const ACTION_POLICY: Record<ActionType, { propose: ActionRole; approve: ActionRole }> = {
  rerun_validation: { propose: 'analyst', approve: 'engineer' },
  retry_import: { propose: 'engineer', approve: 'engineer' },
  send_notification: { propose: 'analyst', approve: 'engineer' },
  create_github_issue: { propose: 'engineer', approve: 'admin' },
  trigger_n8n: { propose: 'engineer', approve: 'admin' },
};

const ROLE_RANK: Record<ActionRole, number> = {
  viewer: 0,
  analyst: 1,
  engineer: 2,
  admin: 3,
  owner: 4,
};
export const roleAtLeast = (role: string, needed: ActionRole): boolean =>
  (ROLE_RANK[role as ActionRole] ?? -1) >= ROLE_RANK[needed];

/** An approval is good for this long, then the action expires (D-114). */
export const APPROVAL_VALID_MS = 60 * 60_000;
/** A proposal nobody decides on expires after this. */
export const PROPOSAL_VALID_MS = 24 * 60 * 60_000;
/** An approved action is tried at most this many times (D-117). */
export const ACTION_MAX_ATTEMPTS = 3;
export const ACTION_BACKOFF_MS = [30_000, 120_000] as const;

/** JSON with keys sorted at every level, so the same payload always gives
 * the same text (and the same hash) whatever order its keys arrived in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The text that is hashed (D-114): the type, the workspace, the incident, and
 * the payload, canonically. Changing any of them changes the hash. */
export const actionHashInput = (input: {
  type: string;
  workspaceId: string;
  incidentId: string;
  payload: unknown;
}): string => canonicalJson(input);

/** Legal moves of an action's status (D-117). Terminal states do not move. */
const MOVES: Record<ActionStatus, readonly ActionStatus[]> = {
  proposed: ['approved', 'rejected', 'expired', 'cancelled'],
  approved: ['running', 'expired', 'cancelled'],
  running: ['succeeded', 'failed', 'approved', 'expired'],
  succeeded: [],
  failed: [],
  rejected: [],
  expired: [],
  cancelled: [],
};
export const canMoveAction = (from: ActionStatus, to: ActionStatus): boolean =>
  MOVES[from].includes(to);

/** What approvers see before deciding (D-113): the facts of the action,
 * resolved to names, in plain words. Never a secret or a row. */
export type ActionPreview = {
  title: string;
  /** Plain-language steps, in order. */
  steps: string[];
  /** True when something leaves DataSentinel (a message, an issue, a call). */
  leavesDataSentinel: boolean;
};

export type ActionNames = {
  ruleName?: string;
  datasetName?: string;
  uploadFilename?: string;
  destinationName?: string;
  destinationType?: string;
  repository?: string | null;
  webhookHost?: string | null;
};

/** Plain-language description of exactly what an approved action will do. */
export function describeAction(type: ActionType, names: ActionNames): ActionPreview {
  const where = names.destinationName ?? 'the chosen destination';
  switch (type) {
    case 'rerun_validation':
      return {
        title: `Run the rule "${names.ruleName ?? 'selected rule'}" again`,
        steps: [
          `Queue one new check of "${names.ruleName ?? 'the rule'}" on ${names.datasetName ?? 'its dataset'}.`,
          'The check only reads the data, as every check does. Nothing is changed in the source.',
        ],
        leavesDataSentinel: false,
      };
    case 'retry_import':
      return {
        title: `Process the failed file "${names.uploadFilename ?? 'selected file'}" again`,
        steps: [
          'Read the stored file again and rebuild its profile.',
          'Only a file whose first attempt failed can be retried. Nothing is written to any source database.',
        ],
        leavesDataSentinel: false,
      };
    case 'send_notification':
      return {
        title: `Send an incident notice to ${where}`,
        steps: [
          `Send one message to ${where} (${names.destinationType ?? 'destination'}).`,
          'The message holds the incident title, severity, dataset name, and a link back. No table rows or secrets.',
        ],
        leavesDataSentinel: true,
      };
    case 'create_github_issue':
      return {
        title: `Open a GitHub issue in ${names.repository ?? 'the chosen repository'}`,
        steps: [
          `Create one issue in ${names.repository ?? 'the repository'} through ${where}.`,
          'The issue holds the incident title, severity, dataset name, and a link back. No table rows or secrets.',
        ],
        leavesDataSentinel: true,
      };
    case 'trigger_n8n':
      return {
        title: `Call the n8n workflow ${where}`,
        steps: [
          `Send one signed request to ${names.webhookHost ?? 'the workflow address'} through ${where}.`,
          'The request holds the incident title, severity, dataset name, and a link back. No table rows or secrets.',
        ],
        leavesDataSentinel: true,
      };
  }
}

export type ActionEventItem = {
  id: string;
  type: string;
  actorType: 'user' | 'system';
  actorName: string | null;
  data: Record<string, string | number | boolean | null>;
  createdAt: string;
};

export type ActionItem = {
  id: string;
  type: ActionType;
  status: ActionStatus;
  payload: Record<string, string>;
  /** First 12 characters of the payload hash an approval is bound to. */
  payloadHash: string;
  preview: ActionPreview;
  note: string | null;
  proposedByName: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  proposalExpiresAt: string;
  approvalExpiresAt: string | null;
  attempts: number;
  failureCode: string | null;
  /** Safe result ids, e.g. the new check run or delivery. */
  output: Record<string, string> | null;
  createdAt: string;
  finishedAt: string | null;
  events: ActionEventItem[];
  /** What the caller may do now, so the UI never guesses. */
  can: { approve: boolean; reject: boolean; cancel: boolean };
};

/** GET …/incidents/{id}/actions/options: what a proposal can point at. */
export type ActionOptions = {
  rules: { id: string; name: string }[];
  uploads: { id: string; filename: string }[];
  destinations: { id: string; name: string; type: string }[];
};

export type ActionFailureCode =
  | 'approval_invalid'
  | 'approval_expired'
  | 'payload_changed'
  | 'permission_lost'
  | 'self_approval'
  | 'target_unavailable'
  | 'incident_not_found'
  | 'execution_failed'
  | 'worker_interrupted';
