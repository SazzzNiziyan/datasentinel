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

type Detail = {
  id: string;
  title: string;
  ruleName: string;
  datasetName: string;
  resolutionNote: string | null;
  latestCheck: {
    checkRunId: string;
    ruleVersion: number | null;
    expected: Record<string, unknown> | null;
    actual: Record<string, unknown> | null;
  } | null;
  relatedRuns: {
    pipelineRunId: string;
    name: string;
    status: string;
    sourceName: string;
    reason: string;
    distanceMinutes: number;
  }[];
  evidence: { kind: string; referenceId: string }[];
  history: { type: string; actorType: string; actorName: string | null; toStatus: string | null }[];
};

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('incident detail', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant() {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'D', slug: `d-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({
      data: { workspaceId: w.id, userId: user.id, role: 'viewer' },
    });
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
    const incident = await prisma.incident.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        ruleId: rule.id,
        dedupeKey: `rule:${rule.id}`,
        title: 'Orders are fresh failed on orders',
        severity: 'critical',
        failureCount: 2,
        lastFailureAt: minutesAgo(5),
      },
    });
    const check = (actual: object) =>
      prisma.checkRun.create({
        data: {
          workspaceId: w.id,
          ruleId: rule.id,
          ruleRevisionId: rule.revisions[0]!.id,
          trigger: 'manual',
          status: 'failed',
          expected: { maxAgeMinutes: 60 },
          actual,
          idempotencyKey: `k-${randomUUID()}`,
          endedAt: new Date(),
        },
      });
    const attach = (kind: string, referenceId: string, observedAt: Date, summary: object) =>
      prisma.evidence.create({
        data: {
          workspaceId: w.id,
          incidentId: incident.id,
          kind,
          referenceId,
          observedAt,
          summary,
        },
      });
    const cookie = await signInCookie(url, user.email);
    const get = async (id: string) => {
      const res = await fetch(`${url}/workspaces/${w.id}/incidents/${id}`, {
        headers: { cookie, origin: WEB },
      });
      return { status: res.status, body: (await res.json()) as Detail };
    };
    return { workspaceId: w.id, pipes, dataset, incident, check, attach, get };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('shows the latest failed check, related runs, evidence, and history', async () => {
    const t = await tenant();
    const older = await t.check({ ageMinutes: 90 });
    const newer = await t.check({ ageMinutes: 600 });
    await t.attach('check_run', older.id, minutesAgo(60), {
      ruleVersion: 1,
      expected: { maxAgeMinutes: 60 },
      actual: { ageMinutes: 90 },
    });
    await t.attach('check_run', newer.id, minutesAgo(5), {
      ruleVersion: 1,
      expected: { maxAgeMinutes: 60 },
      actual: { ageMinutes: 600 },
    });
    const run = await prisma.pipelineRun.create({
      data: {
        workspaceId: t.workspaceId,
        sourceId: t.pipes.id,
        externalRunId: 'r1',
        name: 'orders_daily',
        status: 'failed',
        trigger: 'schedule',
        lastEventAt: minutesAgo(20),
      },
    });
    await t.attach('pipeline_run', run.id, minutesAgo(20), {
      name: 'orders_daily',
      status: 'failed',
      sourceName: 'airflow',
      reason: 'correlation_id',
      distanceMinutes: 15,
    });
    await prisma.incidentEvent.create({
      data: {
        workspaceId: t.workspaceId,
        incidentId: t.incident.id,
        actorType: 'system',
        type: 'opened',
        toStatus: 'open',
      },
    });
    const res = await t.get(t.incident.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.ruleName, 'Orders are fresh');
    assert.equal(res.body.datasetName, 'orders');
    assert.equal(res.body.latestCheck?.checkRunId, newer.id);
    assert.equal(res.body.latestCheck?.ruleVersion, 1);
    assert.deepEqual(res.body.latestCheck?.expected, { maxAgeMinutes: 60 });
    assert.deepEqual(res.body.latestCheck?.actual, { ageMinutes: 600 });
    assert.deepEqual(
      res.body.relatedRuns.map((r) => [
        r.pipelineRunId,
        r.name,
        r.status,
        r.sourceName,
        r.reason,
        r.distanceMinutes,
      ]),
      [[run.id, 'orders_daily', 'failed', 'airflow', 'correlation_id', 15]],
    );
    assert.deepEqual(
      res.body.evidence.map((e) => e.kind),
      ['check_run', 'pipeline_run', 'check_run'],
    );
    assert.deepEqual(
      res.body.history.map((h) => [h.type, h.actorType, h.actorName, h.toStatus]),
      [['opened', 'system', null, 'open']],
    );
  });

  it('has no latest check when no check evidence exists', async () => {
    const t = await tenant();
    const res = await t.get(t.incident.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.latestCheck, null);
    assert.deepEqual(res.body.relatedRuns, []);
  });

  it('answers 404 for unknown IDs and for other workspaces', async () => {
    const t = await tenant();
    const other = await tenant();
    assert.equal((await t.get(randomUUID())).status, 404);
    assert.equal((await t.get('not-a-uuid')).status, 404);
    assert.equal((await t.get(other.incident.id)).status, 404);
  });
});
