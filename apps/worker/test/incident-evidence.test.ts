import { evidenceKinds } from '@datasentinel/contracts';
import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, afterEach, describe, it } from 'node:test';
import { openIncidentForCheck } from '../src/incidents/open-incident.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');
const skip =
  databaseUrl === ''
    ? 'DATABASE_URL is not set'
    : await prisma.$queryRaw`SELECT 1`.then(
        () => false,
        () => 'local database is not running (pnpm services:up)',
      );

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('incident evidence', { skip }, () => {
  let workspaces: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    workspaces = [];
  });
  after(() => prisma.$disconnect());

  async function fixture() {
    const w = await prisma.workspace.create({ data: { name: 'E', slug: `e-${randomUUID()}` } });
    workspaces.push(w.id);
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'csv', type: 'csv' },
    });
    const pipes = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'airflow', type: 'pipeline_event' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'orders', name: 'orders' },
    });
    const rule = await prisma.qualityRule.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        name: 'Orders are fresh',
        type: 'freshness',
        severity: 'critical',
        currentVersion: 1,
        revisions: {
          create: {
            version: 1,
            definition: { version: 1, type: 'freshness', maxAgeMinutes: 60 },
            severity: 'critical',
          },
        },
      },
      include: { revisions: true },
    });
    const check = () =>
      prisma.checkRun.create({
        data: {
          workspaceId: w.id,
          ruleId: rule.id,
          ruleRevisionId: rule.revisions[0]!.id,
          trigger: 'manual',
          status: 'failed',
          idempotencyKey: `k-${randomUUID()}`,
          endedAt: new Date(),
        },
      });
    const profile = async (observedAt: Date, status: 'succeeded' | 'failed' = 'succeeded') => {
      const p = await prisma.profileSnapshot.create({
        data: {
          workspaceId: w.id,
          sourceId: source.id,
          datasetId: dataset.id,
          status,
          observedAt,
          ...(status === 'succeeded'
            ? { rowCount: 1200n, rowCountMethod: 'exact' }
            : { error: { code: 'timeout' } }),
          durationMs: 5,
        },
      });
      if (status === 'failed') return { profile: p, schema: null };
      const s = await prisma.schemaSnapshot.create({
        data: {
          workspaceId: w.id,
          sourceId: source.id,
          datasetId: dataset.id,
          profileSnapshotId: p.id,
          observedAt,
          schemaHash: createHash('sha256').update(p.id).digest('hex'),
          columns: [],
          rowCount: 1200n,
        },
      });
      return { profile: p, schema: s };
    };
    const pipeRun = (name: string, over: Record<string, unknown>) =>
      prisma.pipelineRun.create({
        data: {
          workspaceId: w.id,
          sourceId: pipes.id,
          externalRunId: `${name}-${randomUUID()}`,
          name,
          status: 'failed',
          trigger: 'schedule',
          lastEventAt: minutesAgo(20),
          ...over,
        },
      });
    const evidence = async (incidentId: string) =>
      (await prisma.evidence.findMany({ where: { incidentId } })).map((e) => ({
        kind: e.kind,
        referenceId: e.referenceId,
        summary: e.summary as Record<string, unknown>,
      }));
    return { workspaceId: w.id, source, dataset, rule, check, profile, pipeRun, evidence };
  }

  const open = (f: { workspaceId: string }, checkRunId: string) =>
    openIncidentForCheck(prisma, f.workspaceId, checkRunId);

  it('attaches the latest earlier profile and schema, and the linked nearby pipeline runs', async () => {
    const f = await fixture();
    await f.profile(minutesAgo(300));
    const latest = await f.profile(minutesAgo(30));
    await f.profile(minutesAgo(20), 'failed');
    await f.profile(new Date(Date.now() + 3_600_000));
    const linked = await f.pipeRun('linked', { correlationId: f.dataset.id });
    await f.pipeRun('unlinked', {});
    await f.pipeRun('too-old', {
      correlationId: f.dataset.id,
      lastEventAt: minutesAgo(8 * 60),
    });
    const run = await f.check();
    const outcome = await open(f, run.id);
    const evidence = await f.evidence(outcome!.incidentId);
    assert.deepEqual(evidence.map((e) => e.kind).sort(), [
      'check_run',
      'pipeline_run',
      'profile_snapshot',
      'schema_snapshot',
    ]);
    const byKind = Object.fromEntries(evidence.map((e) => [e.kind, e]));
    assert.equal(byKind.profile_snapshot?.referenceId, latest.profile.id);
    assert.deepEqual(byKind.profile_snapshot?.summary, { rowCount: 1200, rowCountMethod: 'exact' });
    assert.equal(byKind.schema_snapshot?.referenceId, latest.schema!.id);
    assert.equal(byKind.pipeline_run?.referenceId, linked.id);
    assert.deepEqual(byKind.pipeline_run?.summary, {
      name: 'linked',
      status: 'failed',
      sourceName: 'airflow',
      reason: 'correlation_id',
      distanceMinutes: 20,
    });
    assert.ok(
      evidenceKinds.every((k) =>
        ['check_run', 'profile_snapshot', 'schema_snapshot', 'pipeline_run'].includes(k),
      ),
    );
  });

  it('adds only what is new when the failure repeats', async () => {
    const f = await fixture();
    await f.profile(minutesAgo(30));
    const first = await open(f, (await f.check()).id);
    await open(f, (await f.check()).id);
    const same = await f.evidence(first!.incidentId);
    assert.equal(same.filter((e) => e.kind === 'check_run').length, 2);
    assert.equal(same.filter((e) => e.kind === 'profile_snapshot').length, 1);
    assert.equal(same.filter((e) => e.kind === 'schema_snapshot').length, 1);
    await f.profile(minutesAgo(5));
    await open(f, (await f.check()).id);
    const after = await f.evidence(first!.incidentId);
    assert.equal(after.filter((e) => e.kind === 'profile_snapshot').length, 2);
    assert.equal(after.filter((e) => e.kind === 'check_run').length, 3);
  });

  it('is immutable: no update, no direct delete, but it goes with its incident', async () => {
    const f = await fixture();
    const outcome = await open(f, (await f.check()).id);
    const incidentId = outcome!.incidentId;
    const [row] = await prisma.evidence.findMany({ where: { incidentId } });
    await assert.rejects(
      prisma.evidence.update({ where: { id: row!.id }, data: { summary: { tampered: true } } }),
      /immutable/,
    );
    await assert.rejects(prisma.evidence.deleteMany({ where: { incidentId } }), /immutable/);
    assert.equal(await prisma.evidence.count({ where: { incidentId } }), 1);
    await prisma.incident.delete({ where: { id: incidentId } });
    assert.equal(await prisma.evidence.count({ where: { incidentId } }), 0);
  });

  it('refuses evidence that points nowhere, into another workspace, or at an unknown kind', async () => {
    const f = await fixture();
    const other = await fixture();
    const outcome = await open(f, (await f.check()).id);
    const theirs = await other.check();
    const base = {
      workspaceId: f.workspaceId,
      incidentId: outcome!.incidentId,
      observedAt: new Date(),
    };
    await assert.rejects(
      prisma.evidence.create({ data: { ...base, kind: 'check_run', referenceId: randomUUID() } }),
      /existing record/,
    );
    await assert.rejects(
      prisma.evidence.create({ data: { ...base, kind: 'check_run', referenceId: theirs.id } }),
      /existing record/,
    );
    await assert.rejects(
      prisma.evidence.create({ data: { ...base, kind: 'log_excerpt', referenceId: randomUUID() } }),
    );
  });
});
