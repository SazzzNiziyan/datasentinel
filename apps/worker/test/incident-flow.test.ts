import { keyRing } from '@datasentinel/connectors';
import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, describe, it } from 'node:test';
import { handleRunCheck } from '../src/jobs/run-check.js';
import { profileMetrics } from '../src/jobs/profile-metrics.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');
const skip =
  databaseUrl === ''
    ? 'DATABASE_URL is not set'
    : await prisma.$queryRaw`SELECT 1`.then(
        () => false,
        () => 'local database is not running (pnpm services:up)',
      );

const deps = {
  prisma,
  ring: keyRing({ key: randomBytes(32), version: 3 }),
  policy: 'allow-private' as const,
  timeoutMs: 3000,
};

/** Checks through the real handler: repeated failures must grow one
 * incident's evidence, never spawn a second incident (D-80, D-81). */
describe('incident flow through the check handler', { skip }, () => {
  let workspaces: string[] = [];
  let users: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    workspaces = [];
    users = [];
  });
  after(() => prisma.$disconnect());

  /** A CSV dataset whose profile has 1 empty city in 4 rows, and a
   * not-null rule: at most `maxNullPercent` empty. 25% empty fails 20. */
  async function fixture(
    options: { severity?: 'critical' | 'warning'; maxNullPercent?: number } = {},
  ) {
    const severity = options.severity ?? 'critical';
    const w = await prisma.workspace.create({ data: { name: 'F', slug: `f-${randomUUID()}` } });
    workspaces.push(w.id);
    const user = await prisma.user.create({
      data: { email: `flow-${randomUUID()}@test.example`, displayName: 'Owner' },
    });
    users.push(user.id);
    const owner = await prisma.membership.create({
      data: { workspaceId: w.id, userId: user.id, role: 'owner' },
    });
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'files', type: 'csv' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'orders', name: 'orders' },
    });
    const observedAt = new Date(Date.now() - 60_000);
    const profile = await prisma.profileSnapshot.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        status: 'succeeded',
        observedAt,
        durationMs: 1,
        rowCount: 4,
        rowCountMethod: 'exact',
        metrics: profileMetrics({
          observedAt,
          rowCount: 4,
          rowCountMethod: 'exact',
          columns: [{ name: 'city', type: 'text', nullCount: 1 }],
        }),
      },
    });
    const rule = await prisma.qualityRule.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        name: 'Orders have a city',
        type: 'not_null',
        severity,
        currentVersion: 1,
        revisions: {
          create: {
            version: 1,
            definition: {
              version: 1,
              type: 'not_null',
              column: 'city',
              maxNullPercent: options.maxNullPercent ?? 20,
            },
            severity,
          },
        },
      },
      include: { revisions: true },
    });
    const queued = () =>
      prisma.checkRun.create({
        data: {
          workspaceId: w.id,
          ruleId: rule.id,
          ruleRevisionId: rule.revisions[0]!.id,
          trigger: 'schedule',
          idempotencyKey: `k-${randomUUID()}`,
        },
      });
    const run = async () => {
      const check = await queued();
      const job = { workspaceId: w.id, checkRunId: check.id };
      await handleRunCheck(deps, job, { finalAttempt: false });
      return { check, job };
    };
    const incidents = () => prisma.incident.findMany({ where: { workspaceId: w.id } });
    return { workspaceId: w.id, owner, dataset, profile, rule, run, incidents };
  }

  it('runs a failing check three times into one incident with growing evidence', async () => {
    const f = await fixture();
    const runs = [await f.run(), await f.run(), await f.run()];
    for (const { check } of runs) {
      assert.equal(
        (await prisma.checkRun.findUniqueOrThrow({ where: { id: check.id } })).status,
        'failed',
      );
    }
    const [incident] = await f.incidents();
    assert.equal((await f.incidents()).length, 1);
    assert.equal(incident?.status, 'open');
    assert.equal(incident?.failureCount, 3);
    const evidence = await prisma.evidence.findMany({ where: { incidentId: incident.id } });
    assert.equal(evidence.filter((e) => e.kind === 'check_run').length, 3);
    // The same profile is attached once, not once per failure.
    assert.equal(evidence.filter((e) => e.kind === 'profile_snapshot').length, 1);
    assert.deepEqual(
      (await prisma.incidentEvent.findMany({ where: { incidentId: incident.id } })).map(
        (e) => e.type,
      ),
      ['opened'],
    );
    assert.equal(
      await prisma.notificationOutbox.count({ where: { workspaceId: f.workspaceId } }),
      1,
    );
  });

  it('traces a problem from rule revision through check, incident, evidence, owner, and resolution', async () => {
    const f = await fixture();
    const { check } = await f.run();
    const [incident] = await f.incidents();
    assert.equal(incident?.ruleId, f.rule.id);

    const attached = await prisma.evidence.findFirstOrThrow({
      where: { incidentId: incident.id, kind: 'check_run' },
    });
    assert.equal(attached.referenceId, check.id);
    const finished = await prisma.checkRun.findUniqueOrThrow({
      where: { id: attached.referenceId },
      include: { revision: true },
    });
    assert.equal(finished.revision.ruleId, f.rule.id);
    assert.deepEqual(finished.revision.definition, {
      version: 1,
      type: 'not_null',
      column: 'city',
      maxNullPercent: 20,
    });
    assert.deepEqual(finished.actual, { rowCount: 4, nullCount: 1, nullPercent: 25 });
    assert.deepEqual(attached.summary, {
      ruleVersion: 1,
      expected: finished.expected,
      actual: finished.actual,
    });
    const profileEvidence = await prisma.evidence.findFirstOrThrow({
      where: { incidentId: incident.id, kind: 'profile_snapshot' },
    });
    assert.equal(profileEvidence.referenceId, f.profile.id);

    const notice = await prisma.notificationOutbox.findFirstOrThrow({
      where: { incidentId: incident.id },
    });
    assert.equal(notice.recipientMembershipId, f.owner.id);

    await prisma.incident.update({
      where: { id: incident.id },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
        resolutionNote: 'Backfilled the city column.',
      },
    });
    const resolved = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
    assert.equal(resolved.resolutionNote, 'Backfilled the city column.');
  });

  it('opens nothing for a passing check or a warning rule', async () => {
    const passing = await fixture({ maxNullPercent: 50 });
    const { check } = await passing.run();
    assert.equal(
      (await prisma.checkRun.findUniqueOrThrow({ where: { id: check.id } })).status,
      'passed',
    );
    assert.deepEqual(await passing.incidents(), []);

    const warning = await fixture({ severity: 'warning' });
    await warning.run();
    await warning.run();
    assert.deepEqual(await warning.incidents(), []);
  });

  it('opens exactly one incident when many failing checks run at once', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 5 }, () => f.run()));
    const incidents = await f.incidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.failureCount, 5);
    assert.equal(
      await prisma.evidence.count({ where: { incidentId: incidents[0].id, kind: 'check_run' } }),
      5,
    );
  });

  it('changes nothing when a finished check job is delivered again', async () => {
    const f = await fixture();
    const { job } = await f.run();
    const before = await f.incidents();
    await handleRunCheck(deps, job, { finalAttempt: false });
    await handleRunCheck(deps, job, { finalAttempt: false });
    const after = await f.incidents();
    assert.equal(after.length, 1);
    assert.equal(after[0]?.failureCount, before[0]?.failureCount);
    assert.equal(await prisma.evidence.count({ where: { incidentId: after[0]!.id } }), 2);
  });

  it('repairs a missing incident when the finished check is delivered again', async () => {
    const f = await fixture();
    const { job, check } = await f.run();
    // Simulate the incident step failing after the check was saved.
    await prisma.incident.deleteMany({ where: { workspaceId: f.workspaceId } });
    assert.deepEqual(await f.incidents(), []);
    await handleRunCheck(deps, job, { finalAttempt: false });
    const [incident] = await f.incidents();
    assert.equal(incident?.failureCount, 1);
    const evidence = await prisma.evidence.findMany({
      where: { incidentId: incident.id, kind: 'check_run' },
    });
    assert.deepEqual(
      evidence.map((e) => e.referenceId),
      [check.id],
    );
    assert.equal(
      (await prisma.checkRun.findUniqueOrThrow({ where: { id: check.id } })).status,
      'failed',
    );
  });

  it('reopens the same incident when the problem returns after it was resolved', async () => {
    const f = await fixture();
    await f.run();
    const [first] = await f.incidents();
    await prisma.incident.update({
      where: { id: first!.id },
      data: { status: 'resolved', resolvedAt: new Date(), resolutionNote: 'fixed' },
    });
    await f.run();
    const incidents = await f.incidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.id, first!.id);
    assert.equal(incidents[0]?.status, 'reopened');
    assert.equal(incidents[0]?.failureCount, 2);
    assert.deepEqual(
      (
        await prisma.incidentEvent.findMany({
          where: { incidentId: first!.id },
          orderBy: { createdAt: 'asc' },
        })
      ).map((e) => e.type),
      ['opened', 'reopened'],
    );
  });
});
