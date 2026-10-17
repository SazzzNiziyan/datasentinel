import { PROFILE_DATASET_JOB, RUN_CHECK_JOB } from '@datasentinel/contracts';
import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, it } from 'node:test';
import { claimDueOccurrences, strandedOccurrences } from '../src/scheduler/claim.js';
import {
  dispatchOccurrence,
  queueScheduledChecks,
  type SourceJob,
} from '../src/scheduler/dispatch.js';
import { SchedulerService } from '../src/scheduler/scheduler.service.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');
const skip =
  databaseUrl === ''
    ? 'DATABASE_URL is not set'
    : await prisma.$queryRaw`SELECT 1`.then(
        () => false,
        () => 'local database is not running (pnpm services:up)',
      );

/** Far in the past: at T0 only these tests' schedules are due, never the
 * real-time schedules other test files create in parallel. */
const T0 = new Date('2001-01-01T00:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const every15 = { version: 1, kind: 'interval', everyMinutes: 15 };

describe('scheduler', { skip }, () => {
  let workspaces: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    workspaces = [];
  });
  after(() => prisma.$disconnect());

  /** One workspace with a source, a dataset, `rules` enabled rules, and a
   * schedule due at T0. */
  async function fixture(
    options: {
      sourceType?: 'csv' | 'postgres';
      datasetStatus?: 'active' | 'paused';
      definition?: object;
      enabled?: boolean;
      rules?: number;
      target?: 'dataset' | 'rule';
    } = {},
  ) {
    const w = await prisma.workspace.create({ data: { name: 'S', slug: `s-${randomUUID()}` } });
    workspaces.push(w.id);
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'src', type: options.sourceType ?? 'csv', settings: {} },
    });
    const dataset = await prisma.dataset.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        stableKey: 'public.orders',
        name: 'orders',
        status: options.datasetStatus ?? 'active',
      },
    });
    const ruleIds: string[] = [];
    for (let i = 0; i < (options.rules ?? 2); i += 1) {
      const rule = await prisma.qualityRule.create({
        data: {
          workspaceId: w.id,
          sourceId: source.id,
          datasetId: dataset.id,
          name: `rule ${i}`,
          type: 'not_null',
          severity: 'warning',
          currentVersion: 1,
          revisions: {
            create: {
              version: 1,
              definition: { version: 1, type: 'not_null', column: 'id' },
              severity: 'warning',
            },
          },
        },
      });
      ruleIds.push(rule.id);
    }
    const target = options.target ?? 'dataset';
    const schedule = await prisma.schedule.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        ruleId: target === 'rule' ? ruleIds[0] : null,
        targetType: target,
        definition: options.definition ?? every15,
        enabled: options.enabled ?? true,
        anchorAt: T0,
        nextRunAt: T0,
      },
    });
    return { workspaceId: w.id, scheduleId: schedule.id, ruleIds };
  }

  const scheduleRow = (id: string) => prisma.schedule.findUniqueOrThrow({ where: { id } });
  const mine = <T extends { scheduleId: string }>(claims: T[], scheduleId: string): T[] =>
    claims.filter((c) => c.scheduleId === scheduleId);

  /** A fake queue that records every batch it is given. */
  function recorder() {
    const batches: SourceJob[][] = [];
    return {
      batches,
      jobs: () => batches.flat(),
      enqueue: (jobs: readonly SourceJob[]) => {
        batches.push([...jobs]);
        return Promise.resolve();
      },
    };
  }

  describe('claim', () => {
    it('claims a due schedule once and moves it to the next due time', async () => {
      const f = await fixture();
      const first = mine(await claimDueOccurrences(prisma, at(1)), f.scheduleId);
      assert.equal(first.length, 1);
      assert.equal(first[0]?.scheduledFor.toISOString(), T0.toISOString());
      assert.equal(first[0]?.missedBefore, 0);
      const row = await scheduleRow(f.scheduleId);
      assert.equal(row.nextRunAt?.toISOString(), at(15).toISOString());
      assert.equal(row.lastRunAt?.toISOString(), at(1).toISOString());
      assert.deepEqual(mine(await claimDueOccurrences(prisma, at(1)), f.scheduleId), []);
    });

    it('counts due times missed during an outage instead of running them', async () => {
      const f = await fixture();
      const [claim] = mine(await claimDueOccurrences(prisma, at(50)), f.scheduleId);
      assert.equal(claim?.missedBefore, 3);
      assert.equal(
        (await scheduleRow(f.scheduleId)).nextRunAt?.toISOString(),
        at(60).toISOString(),
      );
    });

    it('never claims the same due time twice, also in parallel', async () => {
      const f = await fixture();
      const [a, b] = await Promise.all([
        claimDueOccurrences(prisma, at(1)),
        claimDueOccurrences(prisma, at(1)),
      ]);
      assert.equal(mine([...a, ...b], f.scheduleId).length, 1);
      // Rewinding the schedule cannot create a second occurrence for T0.
      await prisma.schedule.update({ where: { id: f.scheduleId }, data: { nextRunAt: T0 } });
      assert.deepEqual(mine(await claimDueOccurrences(prisma, at(1)), f.scheduleId), []);
      assert.equal(
        await prisma.scheduleOccurrence.count({ where: { scheduleId: f.scheduleId } }),
        1,
      );
      assert.equal(
        (await scheduleRow(f.scheduleId)).nextRunAt?.toISOString(),
        at(15).toISOString(),
      );
    });

    it('claims many due schedules in one pass', async () => {
      const fs = await Promise.all([
        fixture({ rules: 0 }),
        fixture({ rules: 0 }),
        fixture({ rules: 0 }),
      ]);
      const claims = await claimDueOccurrences(prisma, at(1));
      for (const f of fs) assert.equal(mine(claims, f.scheduleId).length, 1);
    });

    it('pauses a schedule whose stored definition no longer validates', async () => {
      const f = await fixture({
        definition: { version: 1, kind: 'cron', expression: '* * * * *' },
      });
      assert.deepEqual(mine(await claimDueOccurrences(prisma, at(1)), f.scheduleId), []);
      const row = await scheduleRow(f.scheduleId);
      assert.equal(row.nextRunAt, null);
      assert.equal(row.lastRunAt, null);
    });

    it('leaves disabled schedules alone', async () => {
      const f = await fixture({ enabled: false });
      assert.deepEqual(mine(await claimDueOccurrences(prisma, at(1)), f.scheduleId), []);
      assert.equal((await scheduleRow(f.scheduleId)).nextRunAt?.toISOString(), T0.toISOString());
    });
  });

  describe('dispatch', () => {
    async function claimed(options: Parameters<typeof fixture>[0] = {}) {
      const f = await fixture(options);
      const [occurrence] = mine(await claimDueOccurrences(prisma, at(1)), f.scheduleId);
      assert.ok(occurrence);
      const row = () =>
        prisma.scheduleOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } });
      return { ...f, occurrence, row };
    }

    it('queues every enabled rule of a file dataset in one batch', async () => {
      const c = await claimed({ rules: 3 });
      const queue = recorder();
      await dispatchOccurrence({ prisma, enqueue: queue.enqueue }, c.occurrence);
      assert.equal((await c.row()).status, 'enqueued');
      assert.equal(queue.batches.length, 1);
      const runs = await prisma.checkRun.findMany({ where: { occurrenceId: c.occurrence.id } });
      assert.equal(runs.length, 3);
      assert.deepEqual(
        queue
          .jobs()
          .map((j) => [j.name, j.jobId])
          .sort(),
        runs.map((r) => [RUN_CHECK_JOB, `check-${r.id}`]).sort(),
      );
      assert.ok(runs.every((r) => r.trigger === 'schedule' && r.status === 'queued'));
      // Running it again creates and queues nothing new.
      assert.equal(
        await queueScheduledChecks({ prisma, enqueue: queue.enqueue }, c.occurrence.id),
        3,
      );
      assert.equal(await prisma.checkRun.count({ where: { occurrenceId: c.occurrence.id } }), 3);
    });

    it('runs only the scheduled rule for a rule target', async () => {
      const c = await claimed({ rules: 2, target: 'rule' });
      const queue = recorder();
      await dispatchOccurrence({ prisma, enqueue: queue.enqueue }, c.occurrence);
      const runs = await prisma.checkRun.findMany({ where: { occurrenceId: c.occurrence.id } });
      assert.deepEqual(
        runs.map((r) => r.ruleId),
        [c.ruleIds[0]],
      );
    });

    it('profiles a database dataset first, keyed by the occurrence', async () => {
      const c = await claimed({ sourceType: 'postgres' });
      const queue = recorder();
      await dispatchOccurrence({ prisma, enqueue: queue.enqueue }, c.occurrence);
      const [job] = queue.jobs();
      assert.equal(queue.jobs().length, 1);
      assert.equal(job?.name, PROFILE_DATASET_JOB);
      assert.deepEqual(job?.data, {
        workspaceId: c.workspaceId,
        datasetId: (await scheduleRow(c.scheduleId)).datasetId,
        occurrenceId: c.occurrence.id,
      });
      assert.equal(await prisma.checkRun.count({ where: { occurrenceId: c.occurrence.id } }), 0);
    });

    it('skips an occurrence whose dataset is not active', async () => {
      const c = await claimed({ datasetStatus: 'paused' });
      const queue = recorder();
      await dispatchOccurrence({ prisma, enqueue: queue.enqueue }, c.occurrence);
      const row = await c.row();
      assert.equal(row.status, 'skipped');
      assert.equal(row.skipReason, 'dataset_not_active');
      assert.deepEqual(queue.jobs(), []);
    });

    it('skips while a check from an earlier occurrence is still queued', async () => {
      const c = await claimed();
      const queue = recorder();
      await dispatchOccurrence({ prisma, enqueue: queue.enqueue }, c.occurrence);
      const [next] = mine(await claimDueOccurrences(prisma, at(16)), c.scheduleId);
      assert.ok(next);
      await dispatchOccurrence({ prisma, enqueue: queue.enqueue }, next);
      const row = await prisma.scheduleOccurrence.findUniqueOrThrow({ where: { id: next.id } });
      assert.equal(row.status, 'skipped');
      assert.equal(row.skipReason, 'previous_still_running');
    });

    it('dispatches the same occurrence again without skipping it as busy', async () => {
      const c = await claimed();
      const queue = recorder();
      await dispatchOccurrence({ prisma, enqueue: queue.enqueue }, c.occurrence);
      await prisma.scheduleOccurrence.update({
        where: { id: c.occurrence.id },
        data: { status: 'pending' },
      });
      await dispatchOccurrence({ prisma, enqueue: queue.enqueue }, c.occurrence);
      assert.equal((await c.row()).status, 'enqueued');
      assert.equal(await prisma.checkRun.count({ where: { occurrenceId: c.occurrence.id } }), 2);
    });
  });

  describe('stranded occurrences', () => {
    it('finds claimed occurrences that were never queued', async () => {
      const f = await fixture();
      const [occurrence] = mine(await claimDueOccurrences(prisma, at(1)), f.scheduleId);
      const soon = new Date(Date.now() + 60_000);
      assert.deepEqual(
        (await strandedOccurrences(prisma, soon)).filter((o) => o.id === occurrence?.id),
        [occurrence],
      );
      assert.deepEqual(
        (await strandedOccurrences(prisma, new Date(Date.now() - 60_000))).filter(
          (o) => o.id === occurrence?.id,
        ),
        [],
      );
    });

    it('a scheduler pass retries them after a failed dispatch', async () => {
      const f = await fixture();
      const seen: string[] = [];
      let fail = true;
      const service = new SchedulerService({
        prisma,
        dispatch: (o) => {
          if (o.scheduleId !== f.scheduleId) return Promise.resolve();
          seen.push(o.id);
          return fail ? Promise.reject(new Error('queue down')) : Promise.resolve();
        },
      });
      await service.tick(at(1));
      assert.equal(seen.length, 1);
      fail = false;
      // Age the claim past the stranded cutoff of a T0-era pass.
      await prisma.scheduleOccurrence.updateMany({
        where: { scheduleId: f.scheduleId },
        data: { createdAt: new Date('2000-01-01T00:00:00.000Z') },
      });
      await service.tick(at(2));
      assert.deepEqual(seen, [seen[0], seen[0]]);
    });
  });
});
