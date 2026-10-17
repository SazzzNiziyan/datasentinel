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

describe('incident notifications', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function member(workspaceId: string, role: 'engineer' | 'analyst') {
    const user = await createUser();
    users.push(user.id);
    const membership = await prisma.membership.create({
      data: { workspaceId, userId: user.id, role },
    });
    let cached: string | undefined;
    return { membership, cookie: async () => (cached ??= await signInCookie(url, user.email)) };
  }

  async function tenant() {
    const w = await prisma.workspace.create({ data: { name: 'N', slug: `n-${randomUUID()}` } });
    workspaces.push(w.id);
    const engineer = await member(w.id, 'engineer');
    const analyst = await member(w.id, 'analyst');
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'csv', type: 'csv' },
    });
    const dataset = await prisma.dataset.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        stableKey: 'orders',
        name: 'orders',
        ownerMembershipId: analyst.membership.id,
      },
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
      },
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
    const patch = async (body: unknown) => {
      const res = await fetch(`${url}/workspaces/${w.id}/incidents/${incident.id}`, {
        method: 'PATCH',
        headers: {
          cookie: await engineer.cookie(),
          origin: WEB,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      return res.status;
    };
    const rows = () =>
      prisma.notificationOutbox.findMany({
        where: { workspaceId: w.id },
        orderBy: { createdAt: 'asc' },
      });
    return { engineer, analyst, patch, rows };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('notifies the assignee, but not someone who assigns themselves', async () => {
    const t = await tenant();
    assert.equal(await t.patch({ assignedMembershipId: t.engineer.membership.id }), 200);
    assert.deepEqual(await t.rows(), []);
    assert.equal(await t.patch({ assignedMembershipId: t.analyst.membership.id }), 200);
    const [row] = await t.rows();
    assert.equal(row?.kind, 'incident_assigned');
    assert.equal(row?.recipientMembershipId, t.analyst.membership.id);
    assert.deepEqual(row?.payload, {
      title: 'Orders are fresh failed on orders',
      severity: 'critical',
      datasetName: 'orders',
    });
  });

  it('notifies the owner on a manual reopen, and nobody for other changes', async () => {
    const t = await tenant();
    await t.patch({ status: 'acknowledged', expectedStatus: 'open' });
    await t.patch({ status: 'resolved', expectedStatus: 'acknowledged', resolutionNote: 'done' });
    assert.deepEqual(await t.rows(), []);
    await t.patch({ status: 'reopened', expectedStatus: 'resolved', reason: 'again' });
    const rows = await t.rows();
    assert.deepEqual(
      rows.map((r) => [r.kind, r.recipientMembershipId]),
      [['incident_reopened', t.analyst.membership.id]],
    );
  });
});
