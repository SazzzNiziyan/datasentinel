import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createUser,
  databaseSkipReason,
  prisma,
  RecordingSourceJobs,
  signInCookie,
  startApi,
  WEB,
} from './helpers.js';

const skip = await databaseSkipReason();
type Related = {
  windowFrom: string;
  runs: { externalRunId: string; reason: string; distanceMinutes: number; sourceName: string }[];
};

describe('related pipeline runs', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant() {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'C', slug: `c-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({
      data: { workspaceId: w.id, userId: user.id, role: 'viewer' },
    });
    const csv = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'csv', type: 'csv' },
    });
    const pipes = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'airflow', type: 'pipeline_event' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: csv.id, stableKey: 'orders', name: 'orders' },
    });
    const rule = await prisma.qualityRule.create({
      data: {
        workspaceId: w.id,
        sourceId: csv.id,
        datasetId: dataset.id,
        name: 'r',
        type: 'freshness',
        severity: 'warning',
        currentVersion: 1,
        revisions: {
          create: {
            version: 1,
            definition: { version: 1, type: 'freshness', maxAgeMinutes: 60 },
            severity: 'warning',
          },
        },
      },
      include: { revisions: true },
    });
    const check = await prisma.checkRun.create({
      data: {
        workspaceId: w.id,
        ruleId: rule.id,
        ruleRevisionId: rule.revisions[0]!.id,
        trigger: 'manual',
        status: 'failed',
        idempotencyKey: `k-${randomUUID()}`,
        startedAt: new Date(),
      },
    });
    const cookie = await signInCookie(url, user.email);
    const related = async (id: string) => {
      const res = await fetch(`${url}/workspaces/${w.id}/check-runs/${id}/related-pipeline-runs`, {
        headers: { cookie, origin: WEB },
      });
      return { status: res.status, body: (await res.json()) as Related };
    };
    const pipeRun = (externalRunId: string, over: Record<string, unknown>) =>
      prisma.pipelineRun.create({
        data: {
          workspaceId: w.id,
          sourceId: pipes.id,
          externalRunId,
          name: externalRunId,
          status: 'succeeded',
          trigger: 'schedule',
          lastEventAt: new Date(Date.now() - 20 * 60_000),
          ...over,
        },
      });
    return { workspaceId: w.id, dataset, check, related, pipeRun };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('returns linked runs near a failed check with the rule that matched', async () => {
    const t = await tenant();
    await t.pipeRun('linked', { correlationId: t.dataset.id });
    await t.pipeRun('unlinked', {});
    await t.pipeRun('too-old', {
      correlationId: t.dataset.id,
      lastEventAt: new Date(Date.now() - 7 * 3_600_000),
    });
    const res = await t.related(t.check.id);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.runs.map((r) => [r.externalRunId, r.reason, r.sourceName]),
      [['linked', 'correlation_id', 'airflow']],
    );
  });

  it('is workspace-scoped and answers 404 for unknown checks', async () => {
    const t = await tenant();
    const other = await tenant();
    await other.pipeRun('theirs', { correlationId: other.dataset.id });
    assert.deepEqual((await t.related(t.check.id)).body.runs, []);
    assert.equal((await t.related(other.check.id)).status, 404);
    assert.equal((await t.related('not-a-uuid')).status, 404);
  });
});
