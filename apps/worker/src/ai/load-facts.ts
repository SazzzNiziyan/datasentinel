import type { PrismaClient } from '@datasentinel/db';
import type { IncidentFacts } from './facts.js';

type Scalar = number | boolean | string;

/** Keeps only flat scalar values (and short string lists), which is all a
 * rule definition or a measured result holds; anything nested is dropped. */
const flat = (value: unknown): Record<string, Scalar | string[]> => {
  const out: Record<string, Scalar | string[]> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[key] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[key] = v;
  }
  return out;
};
const scalars = (value: unknown): Record<string, Scalar> => {
  const out: Record<string, Scalar> = {};
  for (const [key, v] of Object.entries(flat(value))) if (!Array.isArray(v)) out[key] = v;
  return out;
};

/** Reads what the report is allowed to know about one incident (D-109):
 * the incident, its dataset and source names, the rule and its parameters,
 * the measured results of the failed checks attached as evidence, and the
 * ids and measured summaries of all its evidence. Profile metrics (which can
 * hold example values), row samples, connection settings, and credentials
 * are never read. Null when the incident does not exist in the workspace. */
export async function loadIncidentFacts(
  prisma: PrismaClient,
  workspaceId: string,
  incidentId: string,
): Promise<IncidentFacts | null> {
  const incident = await prisma.incident.findFirst({
    where: { id: incidentId, workspaceId },
    select: {
      id: true,
      title: true,
      severity: true,
      status: true,
      failureCount: true,
      openedAt: true,
      dataset: { select: { name: true, source: { select: { name: true, type: true } } } },
      rule: {
        select: {
          name: true,
          type: true,
          currentVersion: true,
          revisions: { select: { version: true, definition: true } },
        },
      },
    },
  });
  if (incident === null) return null;
  const evidence = await prisma.evidence.findMany({
    where: { workspaceId, incidentId },
    orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
    take: 60,
    select: { id: true, kind: true, referenceId: true, observedAt: true, summary: true },
  });
  const checkEvidence = evidence.filter((e) => e.kind === 'check_run').slice(0, 10);
  const runs = await prisma.checkRun.findMany({
    where: { workspaceId, id: { in: checkEvidence.map((e) => e.referenceId) } },
    select: { id: true, status: true, endedAt: true, expected: true, actual: true },
  });
  const runById = new Map(runs.map((r) => [r.id, r]));
  const pipelineEvidence = evidence.filter((e) => e.kind === 'pipeline_run').slice(0, 10);
  const pipeline = await prisma.pipelineRun.findMany({
    where: { workspaceId, id: { in: pipelineEvidence.map((e) => e.referenceId) } },
    select: { name: true, status: true, lastEventAt: true },
  });
  const definition = incident.rule.revisions.find(
    (r) => r.version === incident.rule.currentVersion,
  )?.definition;
  const { version: _version, type: _type, ...parameters } = flat(definition);
  return {
    incident: {
      id: incident.id,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      failureCount: incident.failureCount,
      openedAt: incident.openedAt.toISOString(),
      datasetName: incident.dataset.name,
      sourceName: incident.dataset.source.name,
      sourceType: incident.dataset.source.type,
    },
    rule: { name: incident.rule.name, type: incident.rule.type, parameters },
    checks: checkEvidence.flatMap((e) => {
      const run = runById.get(e.referenceId);
      return run === undefined
        ? []
        : [
            {
              // The evidence row's id is what a report cites.
              id: e.id,
              status: run.status,
              finishedAt: run.endedAt?.toISOString() ?? null,
              expected: scalars(run.expected),
              actual: scalars(run.actual),
            },
          ];
    }),
    schemaChanges: [],
    pipelineRuns: pipeline.map((p) => ({
      name: p.name,
      status: p.status,
      at: p.lastEventAt.toISOString(),
    })),
    evidence: evidence.map((e) => ({
      id: e.id,
      kind: e.kind,
      observedAt: e.observedAt.toISOString(),
      summary: scalars(e.summary),
    })),
  };
}
