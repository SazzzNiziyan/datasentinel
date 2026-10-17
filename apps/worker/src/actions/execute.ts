import {
  ACTION_BACKOFF_MS,
  ACTION_MAX_ATTEMPTS,
  ACTION_POLICY,
  actionHashInput,
  actionPayloadSchemas,
  actionTypes,
  roleAtLeast,
  RUN_CHECK_JOB,
  type ActionFailureCode,
  type ActionType,
  type ParseUploadJobData,
  type RunCheckJobData,
} from '@datasentinel/contracts';
import { Prisma, type PrismaClient } from '@datasentinel/db';
import { createHash, randomUUID } from 'node:crypto';
import type { Enqueue } from '../scheduler/dispatch.js';

/** Recovery action execution (D-118). By design this module can reach only
 * DataSentinel's own database and two job queues, through the functions it is
 * given: it has no connection to any monitored source, no network client, and
 * no way to run a query on one (D-119). */
export interface ActionDeps {
  prisma: PrismaClient;
  /** Adds a check job to the sources queue. */
  enqueue: Enqueue;
  /** Adds a parse job to the uploads queue under the given job id. */
  enqueueParse: (data: ParseUploadJobData, jobId: string) => Promise<void>;
  /** Which optional destination types this deployment allows (D-96). */
  features: { github: boolean; n8n: boolean };
}

export const hashAction = (input: {
  type: string;
  workspaceId: string;
  incidentId: string;
  payload: unknown;
}): string => createHash('sha256').update(actionHashInput(input)).digest('hex');

export type ClaimedAction = {
  id: string;
  workspaceId: string;
  incidentId: string;
  type: string;
  payload: unknown;
  payloadHash: string;
  approvedPayloadHash: string | null;
  approvalExpiresAt: Date | null;
  proposedBy: string;
  decidedBy: string | null;
  attempts: number;
};

/** A claimed action that is never finished becomes claimable again after this. */
const LEASE_MS = 10 * 60_000;

/** Takes one approved action that is due, or one whose worker died (D-118).
 * SKIP LOCKED lets several workers share the work; nothing is taken twice. */
export async function claimAction(
  prisma: PrismaClient,
  now: Date,
  /** Tests only: take from this workspace alone. */
  workspaceId: string | null = null,
): Promise<ClaimedAction | null> {
  const rows = await prisma.$queryRaw<ClaimedAction[]>`
    UPDATE action_proposals
       SET status = 'running', attempts = attempts + 1,
           lease_until = ${new Date(now.getTime() + LEASE_MS)}
     WHERE id = (
       SELECT id FROM action_proposals
        WHERE ((status = 'approved' AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}))
               OR (status = 'running' AND lease_until < ${now}))
          AND (${workspaceId}::uuid IS NULL OR workspace_id = ${workspaceId}::uuid)
        ORDER BY created_at
        LIMIT 1
          FOR UPDATE SKIP LOCKED)
    RETURNING id, workspace_id AS "workspaceId", incident_id AS "incidentId", type, payload,
              payload_hash AS "payloadHash", approved_payload_hash AS "approvedPayloadHash",
              approval_expires_at AS "approvalExpiresAt",
              proposed_by_membership_id AS "proposedBy", decided_by_membership_id AS "decidedBy",
              attempts`;
  return rows[0] ?? null;
}

async function log(
  db: PrismaClient | Prisma.TransactionClient,
  action: ClaimedAction,
  type: string,
  data: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  await db.actionEvent.create({
    data: {
      workspaceId: action.workspaceId,
      actionId: action.id,
      type,
      actorType: 'system',
      // Attributable: who proposed it and who approved it travel with every result.
      data: { proposedBy: action.proposedBy, approvedBy: action.decidedBy, ...data },
    },
  });
  await db.auditEvent.create({
    data: {
      action: `action.${type}`,
      actorType: 'system',
      workspaceId: action.workspaceId,
      targetType: 'incident',
      targetId: action.incidentId,
      summary: { actionId: action.id, type: action.type, ...data },
    },
  });
}

/** A failure the action cannot recover from. */
class Refused extends Error {
  constructor(readonly code: ActionFailureCode) {
    super(code);
  }
}

const isType = (value: string): value is ActionType =>
  (actionTypes as readonly string[]).includes(value);

/** Everything that must still be true at the moment of execution (D-118):
 * the approval exists and is bound to this exact payload, it has not
 * expired, the proposer and approver still hold the roles the policy needs
 * and are still active, the workspace's second-approver rule still holds,
 * and the incident still exists. Throws `Refused` with the reason. */
async function recheck(deps: ActionDeps, action: ClaimedAction, now: Date): Promise<ActionType> {
  const { prisma } = deps;
  if (!isType(action.type)) throw new Refused('approval_invalid');
  const type = action.type;
  if (
    action.approvedPayloadHash === null ||
    action.decidedBy === null ||
    action.approvalExpiresAt === null
  ) {
    throw new Refused('approval_invalid');
  }
  const current = hashAction({
    type: action.type,
    workspaceId: action.workspaceId,
    incidentId: action.incidentId,
    payload: action.payload,
  });
  if (current !== action.payloadHash || current !== action.approvedPayloadHash) {
    throw new Refused('payload_changed');
  }
  if (action.approvalExpiresAt.getTime() <= now.getTime()) throw new Refused('approval_expired');

  const [proposer, approver, workspace, incident] = await Promise.all([
    prisma.membership.findFirst({
      where: { id: action.proposedBy, workspaceId: action.workspaceId },
      select: { role: true, status: true },
    }),
    prisma.membership.findFirst({
      where: { id: action.decidedBy, workspaceId: action.workspaceId },
      select: { role: true, status: true },
    }),
    prisma.workspace.findUnique({
      where: { id: action.workspaceId },
      select: { requireSecondApprover: true },
    }),
    prisma.incident.findFirst({
      where: { id: action.incidentId, workspaceId: action.workspaceId },
      select: { id: true },
    }),
  ]);
  if (incident === null || workspace === null) throw new Refused('incident_not_found');
  if (
    proposer?.status !== 'active' ||
    approver?.status !== 'active' ||
    !roleAtLeast(proposer.role, ACTION_POLICY[type].propose) ||
    !roleAtLeast(approver.role, ACTION_POLICY[type].approve)
  ) {
    throw new Refused('permission_lost');
  }
  if (workspace.requireSecondApprover && action.proposedBy === action.decidedBy) {
    throw new Refused('self_approval');
  }
  return type;
}

type Outcome = Record<string, string>;

/** Runs one rechecked action. Each executor is idempotent: running it again
 * after a crash changes nothing more (D-118). */
async function execute(
  deps: ActionDeps,
  action: ClaimedAction,
  type: ActionType,
): Promise<Outcome> {
  const { prisma } = deps;
  const parsed = actionPayloadSchemas[type].safeParse(action.payload);
  if (!parsed.success) throw new Refused('approval_invalid');
  const payload = parsed.data as Record<string, string>;
  const incident = await prisma.incident.findFirstOrThrow({
    where: { id: action.incidentId, workspaceId: action.workspaceId },
    select: {
      datasetId: true,
      sourceId: true,
      title: true,
      severity: true,
      dataset: { select: { name: true } },
    },
  });

  if (type === 'rerun_validation') {
    const rule = await prisma.qualityRule.findFirst({
      where: {
        id: payload.ruleId,
        workspaceId: action.workspaceId,
        datasetId: incident.datasetId,
        enabled: true,
      },
      select: {
        id: true,
        currentVersion: true,
        revisions: { select: { id: true, version: true } },
      },
    });
    const revision = rule?.revisions.find((r) => r.version === rule.currentVersion);
    if (rule === null || revision === undefined) throw new Refused('target_unavailable');
    const idempotencyKey = `action:${action.id}`;
    const where = {
      workspaceId_idempotencyKey: { workspaceId: action.workspaceId, idempotencyKey },
    };
    const run =
      (await prisma.checkRun.findUnique({ where })) ??
      (await prisma.checkRun.create({
        data: {
          workspaceId: action.workspaceId,
          ruleId: rule.id,
          ruleRevisionId: revision.id,
          trigger: 'manual',
          idempotencyKey,
        },
      }));
    if (run.status === 'queued') {
      const data: RunCheckJobData = { workspaceId: action.workspaceId, checkRunId: run.id };
      await deps.enqueue([{ name: RUN_CHECK_JOB, data, jobId: `check-${run.id}` }]);
    }
    return { checkRunId: run.id };
  }

  if (type === 'retry_import') {
    const upload = await prisma.upload.findFirst({
      where: { id: payload.uploadId, workspaceId: action.workspaceId, sourceId: incident.sourceId },
      select: { id: true, status: true },
    });
    if (upload === null) throw new Refused('target_unavailable');
    if (upload.status === 'failed') {
      await prisma.upload.updateMany({
        where: { id: upload.id, status: 'failed' },
        data: { status: 'queued', error: Prisma.DbNull },
      });
    } else if (
      upload.status !== 'queued' &&
      upload.status !== 'parsing' &&
      upload.status !== 'succeeded'
    ) {
      throw new Refused('target_unavailable');
    }
    // The job id carries the action id, so a repeated delivery queues it once.
    await deps.enqueueParse(
      { workspaceId: action.workspaceId, uploadId: upload.id },
      `${upload.id}-retry-${action.id}`,
    );
    return { uploadId: upload.id };
  }

  // Notification, GitHub issue, n8n call: one delivery through a destination
  // that is checked again now. The delivery id is the action id, so the
  // delivery table's unique key makes a repeat harmless.
  const wanted = type === 'create_github_issue' ? 'github' : type === 'trigger_n8n' ? 'n8n' : null;
  if ((wanted === 'github' && !deps.features.github) || (wanted === 'n8n' && !deps.features.n8n)) {
    throw new Refused('target_unavailable');
  }
  const destination = await prisma.destination.findFirst({
    where: {
      id: payload.destinationId,
      workspaceId: action.workspaceId,
      status: 'active',
      type: wanted === null ? { in: ['email', 'slack', 'webhook'] } : wanted,
    },
    select: { id: true },
  });
  if (destination === null) throw new Refused('target_unavailable');
  await prisma.notificationDelivery.createMany({
    data: [
      {
        workspaceId: action.workspaceId,
        incidentId: action.incidentId,
        incidentEventId: action.id,
        destinationId: destination.id,
        kind: 'incident_notice',
        // Safe values only (D-97).
        payload: {
          title: incident.title,
          severity: incident.severity,
          datasetName: incident.dataset.name,
        },
      },
    ],
    skipDuplicates: true,
  });
  const delivery = await prisma.notificationDelivery.findFirstOrThrow({
    where: { incidentEventId: action.id, destinationId: destination.id },
    select: { id: true },
  });
  return { deliveryId: delivery.id };
}

/** Runs one claimed action start to finish and records the outcome (D-117,
 * D-118). It never throws. A refusal ends the action as failed (or expired)
 * with a short code; a transient failure puts it back for a later try, as
 * long as its approval is still valid. */
export async function processAction(
  deps: ActionDeps,
  action: ClaimedAction,
  now: Date = new Date(),
): Promise<void> {
  const { prisma } = deps;
  const finish = async (
    status: 'succeeded' | 'failed' | 'expired',
    data: { failureCode?: string; output?: Outcome },
    event: string,
  ) => {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.actionProposal.updateMany({
        where: { id: action.id, status: 'running' },
        data: {
          status,
          finishedAt: new Date(),
          ...(data.failureCode === undefined ? {} : { failureCode: data.failureCode }),
          ...(data.output === undefined ? {} : { output: data.output }),
        },
      });
      if (moved.count === 1) {
        await log(tx, action, event, {
          ...(data.failureCode === undefined ? {} : { code: data.failureCode }),
          ...(data.output ?? {}),
        });
      }
    });
  };
  try {
    if (action.attempts > ACTION_MAX_ATTEMPTS) {
      return await finish('failed', { failureCode: 'worker_interrupted' }, 'failed');
    }
    await log(prisma, action, 'started', { attempt: action.attempts });
    const type = await recheck(deps, action, now);
    const output = await execute(deps, action, type);
    await finish('succeeded', { output }, 'succeeded');
  } catch (error) {
    if (error instanceof Refused) {
      if (error.code === 'approval_expired') {
        return await finish('expired', { failureCode: error.code }, 'expired');
      }
      return await finish('failed', { failureCode: error.code }, 'failed');
    }
    // Anything else is treated as transient: try again later while the
    // approval is valid, then give up.
    if (action.attempts < ACTION_MAX_ATTEMPTS) {
      const wait =
        ACTION_BACKOFF_MS[Math.min(action.attempts - 1, ACTION_BACKOFF_MS.length - 1)] ?? 0;
      await prisma.$transaction(async (tx) => {
        const moved = await tx.actionProposal.updateMany({
          where: { id: action.id, status: 'running' },
          data: {
            status: 'approved',
            nextAttemptAt: new Date(now.getTime() + wait),
            leaseUntil: null,
          },
        });
        if (moved.count === 1)
          await log(tx, action, 'retry_scheduled', { attempt: action.attempts });
      });
      return;
    }
    await finish('failed', { failureCode: 'execution_failed' }, 'failed').catch(() => undefined);
  }
}

/** A fresh id for the log, kept here so tests can stub nothing else. */
export const newId = (): string => randomUUID();
