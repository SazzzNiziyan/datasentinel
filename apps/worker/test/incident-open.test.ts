import { INCIDENT_REOPEN_WINDOW_MS } from '@datasentinel/contracts';
import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

describe('incident creation', { skip }, () => {
  let workspaces: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    workspaces = [];
  });
  after(() => prisma.$disconnect());

  async function fixture(severity: 'critical' | 'warning' = 'critical') {
    const w = await prisma.workspace.create({ data: { name: 'I', slug: `i-${randomUUID()}` } });
    workspaces.push(w.id);
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
        name: 'Orders are fresh',
        type: 'freshness',
        severity,
        currentVersion: 1,
        revisions: {
          create: {
            version: 1,
            definition: { version: 1, type: 'freshness', maxAgeMinutes: 60 },
            severity,
          },
        },
      },
      include: { revisions: true },
    });
    const check = (status: 'failed' | 'passed' | 'error' = 'failed') =>
      prisma.checkRun.create({
        data: {
          workspaceId: w.id,
          ruleId: rule.id,
          ruleRevisionId: rule.revisions[0]!.id,
          trigger: 'manual',
          status,
          expected: { maxAgeMinutes: 60 },
          actual: { ageMinutes: 600 },
          idempotencyKey: `k-${randomUUID()}`,
          endedAt: new Date(),
        },
      });
    const open = (checkRunId: string, now?: Date) =>
      openIncidentForCheck(prisma, w.id, checkRunId, now);
    const incidents = () => prisma.incident.findMany({ where: { workspaceId: w.id } });
    return { workspaceId: w.id, rule, check, open, incidents };
  }

  it('opens one incident with evidence and a history event for a failed critical check', async () => {
    const f = await fixture();
    const run = await f.check();
    const outcome = await f.open(run.id);
    assert.equal(outcome?.action, 'created');
    const [incident] = await f.incidents();
    assert.equal(incident?.status, 'open');
    assert.equal(incident?.severity, 'critical');
    assert.equal(incident?.dedupeKey, `rule:${f.rule.id}`);
    assert.equal(incident?.title, 'Orders are fresh failed on orders');
    assert.equal(incident?.failureCount, 1);
    const evidence = await prisma.evidence.findMany({ where: { incidentId: incident.id } });
    assert.deepEqual(
      evidence.map((e) => [e.kind, e.referenceId]),
      [['check_run', run.id]],
    );
    assert.deepEqual(evidence[0]?.summary, {
      ruleVersion: 1,
      expected: { maxAgeMinutes: 60 },
      actual: { ageMinutes: 600 },
    });
    const events = await prisma.incidentEvent.findMany({ where: { incidentId: incident.id } });
    assert.deepEqual(
      events.map((e) => [e.type, e.toStatus, e.actorType]),
      [['opened', 'open', 'system']],
    );
  });

  it('opens nothing for passed or error checks, or for warning rules', async () => {
    const f = await fixture();
    assert.equal(await f.open((await f.check('passed')).id), null);
    assert.equal(await f.open((await f.check('error')).id), null);
    const warn = await fixture('warning');
    assert.equal(await warn.open((await warn.check()).id), null);
    assert.equal(await f.open(randomUUID()), null);
    assert.deepEqual(await f.incidents(), []);
    assert.deepEqual(await warn.incidents(), []);
  });

  it('attaches repeated failures to the same incident, and a repeat of one check changes nothing', async () => {
    const f = await fixture();
    const first = await f.check();
    const second = await f.check();
    await f.open(first.id);
    const again = await f.open(first.id);
    assert.equal(again?.evidenceAdded, false);
    const appended = await f.open(second.id);
    assert.equal(appended?.action, 'appended');
    const incidents = await f.incidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.failureCount, 2);
    assert.equal(await prisma.evidence.count({ where: { incidentId: incidents[0].id } }), 2);
    assert.equal(await prisma.incidentEvent.count({ where: { incidentId: incidents[0].id } }), 1);
  });

  it('opens exactly one incident when many checks fail at once', async () => {
    const f = await fixture();
    const runs = await Promise.all(Array.from({ length: 6 }, () => f.check()));
    const outcomes = await Promise.all(runs.map((r) => f.open(r.id)));
    assert.equal(outcomes.filter((o) => o?.action === 'created').length, 1);
    const incidents = await f.incidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.failureCount, 6);
    assert.equal(await prisma.evidence.count({ where: { incidentId: incidents[0].id } }), 6);
  });

  it('reopens an incident resolved inside the window, and opens a new one after it', async () => {
    const f = await fixture();
    await f.open((await f.check()).id);
    const [first] = await f.incidents();
    await prisma.incident.update({
      where: { id: first!.id },
      data: { status: 'resolved', resolvedAt: new Date(), resolutionNote: 'fixed upstream' },
    });
    const reopened = await f.open((await f.check()).id);
    assert.equal(reopened?.action, 'reopened');
    assert.equal(reopened?.incidentId, first!.id);
    const after = await prisma.incident.findUniqueOrThrow({ where: { id: first!.id } });
    assert.equal(after.status, 'reopened');
    assert.equal(after.resolvedAt, null);
    assert.equal(after.resolutionNote, 'fixed upstream');
    const events = await prisma.incidentEvent.findMany({
      where: { incidentId: first!.id },
      orderBy: { createdAt: 'asc' },
    });
    assert.deepEqual(
      events.map((e) => e.type),
      ['opened', 'reopened'],
    );

    await prisma.incident.update({
      where: { id: first!.id },
      data: {
        status: 'resolved',
        resolvedAt: new Date(Date.now() - INCIDENT_REOPEN_WINDOW_MS - 60_000),
      },
    });
    const fresh = await f.open((await f.check()).id);
    assert.equal(fresh?.action, 'created');
    assert.notEqual(fresh?.incidentId, first!.id);
    const all = await f.incidents();
    assert.deepEqual(all.map((i) => i.status).sort(), ['open', 'resolved']);
  });

  it('refuses a second unresolved incident for the same key at the database', async () => {
    const f = await fixture();
    await f.open((await f.check()).id);
    const [incident] = await f.incidents();
    await assert.rejects(
      prisma.incident.create({
        data: {
          workspaceId: f.workspaceId,
          sourceId: incident!.sourceId,
          datasetId: incident!.datasetId,
          ruleId: incident!.ruleId,
          dedupeKey: incident!.dedupeKey,
          title: 'duplicate',
          severity: 'critical',
          lastFailureAt: new Date(),
        },
      }),
    );
  });
});
