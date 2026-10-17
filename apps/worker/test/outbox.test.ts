import { createPrismaClient, enqueueIncidentNotification } from '@datasentinel/db';
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

describe('notification outbox', { skip }, () => {
  let workspaces: string[] = [];
  let users: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    workspaces = [];
    users = [];
  });
  after(() => prisma.$disconnect());

  async function fixture() {
    const w = await prisma.workspace.create({ data: { name: 'O', slug: `o-${randomUUID()}` } });
    workspaces.push(w.id);
    const member = async (role: 'owner' | 'engineer' | 'analyst') => {
      const user = await prisma.user.create({
        data: { email: `ob-${randomUUID()}@test.example`, displayName: role },
      });
      users.push(user.id);
      return prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
    };
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
    const open = async () => openIncidentForCheck(prisma, w.id, (await check()).id);
    const rows = () =>
      prisma.notificationOutbox.findMany({
        where: { workspaceId: w.id },
        orderBy: { createdAt: 'asc' },
      });
    return { workspaceId: w.id, member, source, dataset, open, rows };
  }

  it('tells the dataset owner when an incident opens, with a safe payload', async () => {
    const f = await fixture();
    const owner = await f.member('engineer');
    await prisma.dataset.update({
      where: { id: f.dataset.id },
      data: { ownerMembershipId: owner.id },
    });
    await f.open();
    const [row] = await f.rows();
    assert.equal(row?.recipientMembershipId, owner.id);
    assert.equal(row?.kind, 'incident_opened');
    assert.equal(row?.status, 'pending');
    assert.equal(row?.attempts, 0);
    assert.deepEqual(row?.payload, {
      title: 'Orders are fresh failed on orders',
      severity: 'critical',
      datasetName: 'orders',
    });
    const event = await prisma.incidentEvent.findUniqueOrThrow({
      where: { id: row.incidentEventId },
    });
    assert.equal(event.type, 'opened');
  });

  it('falls back to the source owner, then the workspace owners, skipping removed members', async () => {
    const f = await fixture();
    const removed = await f.member('engineer');
    await prisma.membership.update({ where: { id: removed.id }, data: { status: 'removed' } });
    const sourceOwner = await f.member('engineer');
    await prisma.dataset.update({
      where: { id: f.dataset.id },
      data: { ownerMembershipId: removed.id },
    });
    await prisma.dataSource.update({
      where: { id: f.source.id },
      data: { ownerMembershipId: sourceOwner.id },
    });
    await f.open();
    assert.deepEqual(
      (await f.rows()).map((r) => r.recipientMembershipId),
      [sourceOwner.id],
    );

    const g = await fixture();
    const first = await g.member('owner');
    const second = await g.member('owner');
    await g.member('engineer');
    await g.open();
    assert.deepEqual(
      (await g.rows()).map((r) => r.recipientMembershipId).sort(),
      [first.id, second.id].sort(),
    );
  });

  it('writes nothing again for a repeated delivery or a repeated failure', async () => {
    const f = await fixture();
    const owner = await f.member('owner');
    const run = await prisma.checkRun.create({
      data: {
        workspaceId: f.workspaceId,
        ruleId: (
          await prisma.qualityRule.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })
        ).id,
        ruleRevisionId: (
          await prisma.ruleRevision.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })
        ).id,
        trigger: 'manual',
        status: 'failed',
        idempotencyKey: `k-${randomUUID()}`,
        endedAt: new Date(),
      },
    });
    await openIncidentForCheck(prisma, f.workspaceId, run.id);
    await openIncidentForCheck(prisma, f.workspaceId, run.id);
    await f.open();
    const rows = await f.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.recipientMembershipId, owner.id);
  });

  it('tells the owner and the assignee when an incident reopens', async () => {
    const f = await fixture();
    const owner = await f.member('owner');
    const assignee = await f.member('analyst');
    await f.open();
    const incident = await prisma.incident.findFirstOrThrow({
      where: { workspaceId: f.workspaceId },
    });
    await prisma.incident.update({
      where: { id: incident.id },
      data: { status: 'resolved', resolvedAt: new Date(), assignedMembershipId: assignee.id },
    });
    await f.open();
    const reopened = (await f.rows()).filter((r) => r.kind === 'incident_reopened');
    assert.deepEqual(
      reopened.map((r) => r.recipientMembershipId).sort(),
      [owner.id, assignee.id].sort(),
    );
  });

  it('commits with the change or not at all, skips the actor, and is unique per event and person', async () => {
    const f = await fixture();
    const owner = await f.member('owner');
    const other = await f.member('engineer');
    await f.open();
    await prisma.notificationOutbox.deleteMany({ where: { workspaceId: f.workspaceId } });
    const incident = await prisma.incident.findFirstOrThrow({
      where: { workspaceId: f.workspaceId },
    });
    const input = (incidentEventId: string, actor: string | null) => ({
      workspaceId: f.workspaceId,
      incidentId: incident.id,
      incidentEventId,
      kind: 'incident_opened' as const,
      datasetId: f.dataset.id,
      assignedMembershipId: null,
      actorMembershipId: actor,
      payload: { title: 't', severity: 'critical', datasetName: 'orders' },
    });
    const event = (type: string) =>
      prisma.incidentEvent.create({
        data: { workspaceId: f.workspaceId, incidentId: incident.id, actorType: 'system', type },
      });

    const eventCountBefore = await prisma.incidentEvent.count({
      where: { incidentId: incident.id },
    });
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        const e = await tx.incidentEvent.create({
          data: {
            workspaceId: f.workspaceId,
            incidentId: incident.id,
            actorType: 'system',
            type: 'x',
          },
        });
        await enqueueIncidentNotification(tx, input(e.id, null));
        throw new Error('rolled back');
      }),
      /rolled back/,
    );
    assert.equal(
      await prisma.notificationOutbox.count({ where: { workspaceId: f.workspaceId } }),
      0,
    );
    assert.equal(
      await prisma.incidentEvent.count({ where: { incidentId: incident.id } }),
      eventCountBefore,
    );

    const e = await event('probe');
    assert.equal(
      await prisma.$transaction((tx) => enqueueIncidentNotification(tx, input(e.id, owner.id))),
      0,
    );
    assert.equal(
      await prisma.$transaction((tx) => enqueueIncidentNotification(tx, input(e.id, other.id))),
      1,
    );
    assert.equal(
      await prisma.$transaction((tx) => enqueueIncidentNotification(tx, input(e.id, other.id))),
      0,
    );
    assert.equal(
      await prisma.notificationOutbox.count({ where: { workspaceId: f.workspaceId } }),
      1,
    );
  });
});
