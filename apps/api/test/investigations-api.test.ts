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

type Item = {
  id: string;
  version: number;
  status: string;
  failureCode: string | null;
  report: { summary: string } | null;
  providerName: string | null;
  feedback: { mine: string | null; helpful: number; notHelpful: number };
  code?: string;
};

const goodReport = (id: string) => ({
  schemaVersion: 1,
  summary: 'Orders stopped updating.',
  facts: [{ statement: 'The check failed.', evidenceIds: [id] }],
  hypotheses: [],
  suggestedChecks: [{ description: 'Look at the loader log.' }],
  limitations: ['Cannot see the loader.'],
  confidence: 'low',
});

describe('investigation reports API', { skip }, () => {
  let on: { app: INestApplication; url: string };
  let off: { app: INestApplication; url: string };
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant(aiEnabled = true) {
    const w = await prisma.workspace.create({
      data: { name: 'R', slug: `r-${randomUUID()}`, aiEnabled },
    });
    workspaces.push(w.id);
    const member = async (role: 'viewer' | 'analyst') => {
      const user = await createUser();
      users.push(user.id);
      await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
      const cookies = new Map<string, string>();
      return async (server: { url: string }) => {
        let cookie = cookies.get(server.url);
        if (cookie === undefined) {
          cookie = await signInCookie(server.url, user.email);
          cookies.set(server.url, cookie);
        }
        return cookie;
      };
    };
    const viewer = await member('viewer');
    const analyst = await member('analyst');
    const analyst2 = await member('analyst');
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'csv', type: 'csv' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'orders', name: 'orders' },
    });
    const rule = await prisma.qualityRule.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        name: 'r',
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
        lastFailureAt: new Date(),
      },
    });
    const call = async (
      server: { url: string },
      who: (server: { url: string }) => Promise<string>,
      method: string,
      path = '',
      body?: unknown,
      incidentId = incident.id,
      workspace = w.id,
    ) => {
      const res = await fetch(
        `${server.url}/workspaces/${workspace}/incidents/${incidentId}/investigations${path}`,
        {
          method,
          headers: { cookie: await who(server), origin: WEB, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      const text = await res.text();
      return { status: res.status, text, body: (text === '' ? {} : JSON.parse(text)) as Item };
    };
    /** Finishes a pending report the way the worker would. */
    const finish = (id: string, evidenceId?: string) =>
      prisma.investigationReport.update({
        where: { id },
        data:
          evidenceId === undefined
            ? { status: 'failed', failureCode: 'unavailable', completedAt: new Date() }
            : {
                status: 'ready',
                report: goodReport(evidenceId),
                completedAt: new Date(),
                model: 'fake-1',
              },
      });
    return { workspaceId: w.id, rule, incident, viewer, analyst, analyst2, call, finish };
  }

  before(async () => {
    on = await startApi({ sourceJobs: new RecordingSourceJobs() });
    off = await startApi({
      sourceJobs: new RecordingSourceJobs(),
      ai: { available: false, provider: null, region: null, retention: null },
    });
  });
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await on.app.close();
    await off.app.close();
  });

  it('records a pending report, one at a time, and numbers new versions', async () => {
    const t = await tenant();
    const first = await t.call(on, t.analyst, 'POST');
    assert.equal(first.status, 202);
    assert.equal(first.body.version, 1);
    assert.equal(first.body.status, 'pending');
    assert.equal(first.body.report, null);
    assert.equal(first.body.providerName, 'Test Provider');
    const again = await t.call(on, t.analyst, 'POST');
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'investigation_running');
    await t.finish(first.body.id);
    const second = await t.call(on, t.analyst, 'POST');
    assert.equal(second.status, 202);
    assert.equal(second.body.version, 2);
    const list = await t.call(on, t.viewer, 'GET');
    assert.deepEqual(
      (JSON.parse(list.text) as Item[]).map((i) => [i.version, i.status]),
      [
        [2, 'pending'],
        [1, 'failed'],
      ],
    );
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'incident.investigation_requested', workspaceId: t.workspaceId },
    });
  });

  it('needs the workspace to have opted in and the deployment to allow AI', async () => {
    const closed = await tenant(false);
    const refused = await closed.call(on, closed.analyst, 'POST');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'ai_not_enabled');
    const open = await tenant(true);
    assert.equal((await open.call(off, open.analyst, 'POST')).body.code, 'ai_not_enabled');
    for (const t of [closed, open]) {
      assert.equal(
        await prisma.investigationReport.count({ where: { workspaceId: t.workspaceId } }),
        0,
      );
    }
  });

  it('lets viewers read, analysts request and rate, and keeps workspaces apart', async () => {
    const t = await tenant();
    const other = await tenant();
    assert.equal((await t.call(on, t.viewer, 'POST')).status, 403);
    const made = await t.call(on, t.analyst, 'POST');
    assert.equal((await t.call(on, t.viewer, 'GET')).status, 200);
    assert.equal(
      (await t.call(on, t.viewer, 'POST', `/${made.body.id}/feedback`, { rating: 'helpful' }))
        .status,
      403,
    );
    assert.equal(
      (await other.call(on, other.analyst, 'GET', '', undefined, t.incident.id, other.workspaceId))
        .status,
      404,
    );
    assert.equal((await t.call(on, t.analyst, 'GET', '', undefined, randomUUID())).status, 404);
  });

  it('shows a ready report with its details, and rates it once per member, replaceable', async () => {
    const t = await tenant();
    const made = await t.call(on, t.analyst, 'POST');
    const check = await prisma.checkRun.create({
      data: {
        workspaceId: t.workspaceId,
        ruleId: t.rule.id,
        ruleRevisionId: t.rule.revisions[0]!.id,
        trigger: 'manual',
        status: 'failed',
        idempotencyKey: `k-${randomUUID()}`,
        endedAt: new Date(),
      },
    });
    const evidence = await prisma.evidence.create({
      data: {
        workspaceId: t.workspaceId,
        incidentId: t.incident.id,
        kind: 'check_run',
        referenceId: check.id,
        observedAt: new Date(),
      },
    });
    // Not ready yet: nothing to rate.
    assert.equal(
      (await t.call(on, t.analyst, 'POST', `/${made.body.id}/feedback`, { rating: 'helpful' }))
        .status,
      409,
    );
    await t.finish(made.body.id, evidence.id);
    const ready = (JSON.parse((await t.call(on, t.viewer, 'GET')).text) as Item[])[0]!;
    assert.equal(ready.status, 'ready');
    assert.equal(ready.report?.summary, 'Orders stopped updating.');

    const rated = await t.call(on, t.analyst, 'POST', `/${made.body.id}/feedback`, {
      rating: 'helpful',
      note: 'Spot on.',
    });
    assert.deepEqual(rated.body.feedback, { mine: 'helpful', helpful: 1, notHelpful: 0 });
    await t.call(on, t.analyst2, 'POST', `/${made.body.id}/feedback`, { rating: 'not_helpful' });
    const changed = await t.call(on, t.analyst, 'POST', `/${made.body.id}/feedback`, {
      rating: 'not_helpful',
    });
    assert.deepEqual(changed.body.feedback, { mine: 'not_helpful', helpful: 0, notHelpful: 2 });
    assert.equal(
      await prisma.investigationFeedback.count({ where: { reportId: made.body.id } }),
      2,
    );
    for (const bad of [{}, { rating: 'great' }, { rating: 'helpful', note: 'x'.repeat(501) }]) {
      assert.equal(
        (await t.call(on, t.analyst, 'POST', `/${made.body.id}/feedback`, bad)).status,
        400,
      );
    }
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'incident.investigation_rated', workspaceId: t.workspaceId },
    });
  });

  it('shows a failed report with a short reason and no provider text', async () => {
    const t = await tenant();
    const made = await t.call(on, t.analyst, 'POST');
    await t.finish(made.body.id);
    const list = JSON.parse((await t.call(on, t.viewer, 'GET')).text) as Item[];
    assert.equal(list[0]?.status, 'failed');
    assert.equal(list[0]?.failureCode, 'unavailable');
    assert.equal(list[0]?.report, null);
  });

  it('stops regeneration after the daily limit, and only one request wins a race', async () => {
    const t = await tenant();
    await prisma.investigationReport.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        workspaceId: t.workspaceId,
        incidentId: t.incident.id,
        version: i + 1,
        status: 'failed' as const,
        failureCode: 'unavailable',
        completedAt: new Date(),
        schemaVersion: 1,
        templateVersion: 1,
      })),
    });
    const limited = await t.call(on, t.analyst, 'POST');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'investigation_limit');

    const racing = await tenant();
    const results = await Promise.all([
      racing.call(on, racing.analyst, 'POST'),
      racing.call(on, racing.analyst, 'POST'),
      racing.call(on, racing.analyst2, 'POST'),
    ]);
    assert.equal(results.filter((r) => r.status === 202).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 2);
    assert.equal(
      await prisma.investigationReport.count({ where: { workspaceId: racing.workspaceId } }),
      1,
    );
  });
});
