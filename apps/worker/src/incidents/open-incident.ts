import {
  CORRELATION_AFTER_MS,
  CORRELATION_BEFORE_MS,
  correlatePipelineRuns,
  decideGrouping,
  incidentDedupeKey,
  qualifiesForIncident,
  type IncidentStatus,
} from '@datasentinel/contracts';
import type { Prisma, PrismaClient } from '@datasentinel/db';

export type IncidentOutcome = {
  incidentId: string;
  action: 'created' | 'appended' | 'reopened';
  /** False when this check was already attached (a repeated delivery). */
  evidenceAdded: boolean;
};

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/** Opens, feeds, or reopens the incident for a failed check (D-80). Does
 * nothing for checks that do not qualify (D-79). Safe to run again for the
 * same check run: the evidence row is unique, so nothing changes twice.
 * Two checks failing together cannot open two incidents: the partial
 * unique index refuses the second insert, which then retries as an append. */
export async function openIncidentForCheck(
  prisma: PrismaClient,
  workspaceId: string,
  checkRunId: string,
  now: Date = new Date(),
): Promise<IncidentOutcome | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => attach(tx, workspaceId, checkRunId, now));
    } catch (error) {
      if (attempt === 0 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

async function attach(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  checkRunId: string,
  now: Date,
): Promise<IncidentOutcome | null> {
  const run = await tx.checkRun.findFirst({
    where: { id: checkRunId, workspaceId },
    select: {
      id: true,
      status: true,
      endedAt: true,
      expected: true,
      actual: true,
      revision: { select: { version: true } },
      rule: {
        select: {
          id: true,
          name: true,
          type: true,
          severity: true,
          sourceId: true,
          datasetId: true,
          dataset: { select: { name: true } },
        },
      },
    },
  });
  if (
    run === null ||
    !qualifiesForIncident({ status: run.status, ruleSeverity: run.rule.severity })
  ) {
    return null;
  }
  const observedAt = run.endedAt ?? now;
  const key = incidentDedupeKey(run.rule.id);
  // The newest incident for the key, locked so a reopen cannot race a
  // resolve or another reopen.
  const [latest] = await tx.$queryRaw<
    { id: string; status: IncidentStatus; resolvedAt: Date | null; lastFailureAt: Date }[]
  >`SELECT id, status, resolved_at AS "resolvedAt", last_failure_at AS "lastFailureAt"
      FROM incidents
     WHERE workspace_id = ${workspaceId}::uuid AND dedupe_key = ${key}
     ORDER BY opened_at DESC
     LIMIT 1
       FOR UPDATE`;
  const decision = decideGrouping(latest ?? null, now);

  let incidentId: string;
  let lastFailureAt: Date;
  if (decision === 'create' || latest === undefined) {
    const created = await tx.incident.create({
      data: {
        workspaceId,
        sourceId: run.rule.sourceId,
        datasetId: run.rule.datasetId,
        ruleId: run.rule.id,
        dedupeKey: key,
        title: `${run.rule.name} failed on ${run.rule.dataset.name}`,
        severity: run.rule.severity,
        status: 'open',
        failureCount: 0,
        lastFailureAt: observedAt,
      },
      select: { id: true },
    });
    incidentId = created.id;
    lastFailureAt = observedAt;
    await tx.incidentEvent.create({
      data: {
        workspaceId,
        incidentId,
        actorType: 'system',
        type: 'opened',
        toStatus: 'open',
        details: { checkRunId, ruleId: run.rule.id },
      },
    });
  } else {
    incidentId = latest.id;
    lastFailureAt = latest.lastFailureAt;
    if (decision === 'reopen') {
      await tx.incident.update({
        where: { id: incidentId },
        data: { status: 'reopened', resolvedAt: null },
      });
      await tx.incidentEvent.create({
        data: {
          workspaceId,
          incidentId,
          actorType: 'system',
          type: 'reopened',
          fromStatus: 'resolved',
          toStatus: 'reopened',
          details: { reason: 'repeat_failure', automatic: true, checkRunId },
        },
      });
    }
  }

  const added = await tx.evidence.createManyAndReturn({
    data: [
      {
        workspaceId,
        incidentId,
        kind: 'check_run',
        referenceId: run.id,
        observedAt,
        summary: {
          ruleVersion: run.revision.version,
          expected: run.expected ?? null,
          actual: run.actual ?? null,
        },
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  if (added.length > 0) {
    await attachContext(tx, workspaceId, incidentId, run.rule.datasetId, observedAt);
    await tx.incident.update({
      where: { id: incidentId },
      data: {
        failureCount: { increment: 1 },
        lastFailureAt: observedAt > lastFailureAt ? observedAt : lastFailureAt,
      },
    });
  }
  return {
    incidentId,
    action: decision === 'create' ? 'created' : decision === 'reopen' ? 'reopened' : 'appended',
    evidenceAdded: added.length > 0,
  };
}

/** Attaches the context a responder needs next to a newly attached failed
 * check (D-81): the latest successful profile and schema snapshot taken
 * before it, and the pipeline runs the D-76 rules link to the dataset. A
 * record already attached is skipped, so repeated failures add only what
 * is new. */
async function attachContext(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  incidentId: string,
  datasetId: string,
  observedAt: Date,
): Promise<void> {
  const rows: Prisma.EvidenceCreateManyInput[] = [];
  const profile = await tx.profileSnapshot.findFirst({
    where: { workspaceId, datasetId, status: 'succeeded', observedAt: { lte: observedAt } },
    orderBy: { observedAt: 'desc' },
    select: { id: true, observedAt: true, rowCount: true, rowCountMethod: true },
  });
  if (profile !== null) {
    rows.push({
      workspaceId,
      incidentId,
      kind: 'profile_snapshot',
      referenceId: profile.id,
      observedAt: profile.observedAt,
      summary: {
        rowCount: profile.rowCount === null ? null : Number(profile.rowCount),
        rowCountMethod: profile.rowCountMethod,
      },
    });
  }
  const schema = await tx.schemaSnapshot.findFirst({
    where: { workspaceId, datasetId, observedAt: { lte: observedAt } },
    orderBy: { observedAt: 'desc' },
    select: { id: true, observedAt: true, schemaHash: true, rowCount: true },
  });
  if (schema !== null) {
    rows.push({
      workspaceId,
      incidentId,
      kind: 'schema_snapshot',
      referenceId: schema.id,
      observedAt: schema.observedAt,
      summary: { schemaHash: schema.schemaHash, rowCount: Number(schema.rowCount) },
    });
  }
  const candidates = await tx.pipelineRun.findMany({
    where: {
      workspaceId,
      OR: [{ datasetId }, { correlationId: datasetId }],
      lastEventAt: { gte: new Date(observedAt.getTime() - CORRELATION_BEFORE_MS) },
      AND: [
        {
          OR: [
            { startedAt: null },
            { startedAt: { lte: new Date(observedAt.getTime() + CORRELATION_AFTER_MS) } },
          ],
        },
      ],
    },
    orderBy: { lastEventAt: 'desc' },
    take: 50,
    select: {
      id: true,
      name: true,
      status: true,
      datasetId: true,
      correlationId: true,
      startedAt: true,
      endedAt: true,
      lastEventAt: true,
      source: { select: { name: true } },
    },
  });
  for (const { run, reason, distanceMinutes } of correlatePipelineRuns(
    { datasetId, at: observedAt },
    candidates,
  )) {
    rows.push({
      workspaceId,
      incidentId,
      kind: 'pipeline_run',
      referenceId: run.id,
      observedAt: run.lastEventAt,
      summary: {
        name: run.name,
        status: run.status,
        sourceName: run.source.name,
        reason,
        distanceMinutes,
      },
    });
  }
  if (rows.length > 0) {
    await tx.evidence.createMany({ data: rows, skipDuplicates: true });
  }
}
