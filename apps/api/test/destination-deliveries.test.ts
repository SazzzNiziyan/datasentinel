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
  kind: string;
  status: string;
  attempts: number;
  lastError: string | null;
  incidentId: string | null;
  code?: string;
};

describe('destination delivery history and retry', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function member(workspaceId: string, role: 'engineer' | 'admin') {
    const user = await createUser();
    users.push(user.id);
    await prisma.membership.create({ data: { workspaceId, userId: user.id, role } });
    let cached: string | undefined;
    return { cookie: async () => (cached ??= await signInCookie(url, user.email)) };
  }

  async function tenant() {
    const w = await prisma.workspace.create({ data: { name: 'H', slug: `h-${randomUUID()}` } });
    workspaces.push(w.id);
    const admin = await member(w.id, 'admin');
    const engineer = await member(w.id, 'engineer');
    const destination = await prisma.destination.create({
      data: {
        workspaceId: w.id,
        name: 'On call',
        type: 'email',
        events: ['incident_opened'],
        settings: { recipients: ['ops@example.com'] },
      },
    });
    const delivery = (
      data: Partial<{ status: 'pending' | 'sent' | 'failed'; kind: string; attempts: number }> = {},
    ) =>
      prisma.notificationDelivery.create({
        data: {
          workspaceId: w.id,
          destinationId: destination.id,
          incidentId: randomUUID(),
          incidentEventId: randomUUID(),
          kind: data.kind ?? 'incident_opened',
          status: data.status ?? 'failed',
          attempts: data.attempts ?? 5,
          lastError: data.status === 'sent' ? null : 'send_failed',
          sentAt: data.status === 'sent' ? new Date() : null,
        },
      });
    const call = async (
      who: { cookie: () => Promise<string> },
      method: string,
      path: string,
      workspace = w.id,
    ) => {
      const res = await fetch(`${url}/workspaces/${workspace}/destinations/${path}`, {
        method,
        headers: { cookie: await who.cookie(), origin: WEB },
      });
      const text = await res.text();
      return { status: res.status, body: (text === '' ? null : JSON.parse(text)) as unknown };
    };
    return { workspaceId: w.id, admin, engineer, destination, delivery, call };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('lists recent deliveries newest first, hiding the incident of a test', async () => {
    const t = await tenant();
    const older = await t.delivery({ status: 'sent', attempts: 1 });
    const test = await t.delivery({ kind: 'destination_test', status: 'failed', attempts: 1 });
    const res = await t.call(t.admin, 'GET', `${t.destination.id}/deliveries`);
    assert.equal(res.status, 200);
    const items = res.body as Item[];
    assert.deepEqual(
      items.map((i) => i.id),
      [test.id, older.id],
    );
    assert.equal(items[0]?.incidentId, null);
    assert.equal(items[1]?.incidentId, older.incidentId);
    assert.equal(items[0]?.lastError, 'send_failed');
    assert.equal(JSON.stringify(items).includes('payload'), false);
  });

  it('is admin only and workspace scoped', async () => {
    const t = await tenant();
    const other = await tenant();
    assert.equal((await t.call(t.engineer, 'GET', `${t.destination.id}/deliveries`)).status, 403);
    assert.equal(
      (await other.call(other.admin, 'GET', `${t.destination.id}/deliveries`, other.workspaceId))
        .status,
      404,
    );
    const failed = await t.delivery();
    assert.equal(
      (
        await other.call(
          other.admin,
          'POST',
          `${other.destination.id}/deliveries/${failed.id}/retry`,
          other.workspaceId,
        )
      ).status,
      404,
    );
    assert.equal(
      (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: failed.id } })).status,
      'failed',
    );
  });

  it('requeues a failed delivery with a fresh budget, audited', async () => {
    const t = await tenant();
    const failed = await t.delivery();
    const res = await t.call(t.admin, 'POST', `${t.destination.id}/deliveries/${failed.id}/retry`);
    assert.equal(res.status, 202);
    const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: failed.id } });
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0);
    assert.ok(row.nextAttemptAt.getTime() <= Date.now() + 1000);
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'destination.delivery_retried', targetId: t.destination.id },
    });
    // Already pending now: a second retry is a conflict, not a duplicate.
    const again = await t.call(
      t.admin,
      'POST',
      `${t.destination.id}/deliveries/${failed.id}/retry`,
    );
    assert.equal(again.status, 409);
    assert.equal((again.body as Item).code, 'delivery_not_failed');
  });

  it('refuses sent deliveries, unknown ids, and paused destinations', async () => {
    const t = await tenant();
    const sent = await t.delivery({ status: 'sent', attempts: 1 });
    assert.equal(
      (await t.call(t.admin, 'POST', `${t.destination.id}/deliveries/${sent.id}/retry`)).status,
      409,
    );
    assert.equal(
      (await t.call(t.admin, 'POST', `${t.destination.id}/deliveries/${randomUUID()}/retry`))
        .status,
      404,
    );
    const failed = await t.delivery();
    await prisma.destination.update({
      where: { id: t.destination.id },
      data: { status: 'paused' },
    });
    const paused = await t.call(
      t.admin,
      'POST',
      `${t.destination.id}/deliveries/${failed.id}/retry`,
    );
    assert.equal(paused.status, 409);
    assert.equal((paused.body as Item).code, 'destination_not_active');
  });
});
