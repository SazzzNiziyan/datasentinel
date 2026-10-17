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

describe('destination test action', { skip }, () => {
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
    const w = await prisma.workspace.create({ data: { name: 'T', slug: `t-${randomUUID()}` } });
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
    const test = async (
      who: { cookie: () => Promise<string> },
      body: unknown = { confirm: true },
      id = destination.id,
      workspace = w.id,
    ) => {
      const res = await fetch(`${url}/workspaces/${workspace}/destinations/${id}/test`, {
        method: 'POST',
        headers: { cookie: await who.cookie(), origin: WEB, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, string> };
    };
    const deliveries = () => prisma.notificationDelivery.findMany({ where: { workspaceId: w.id } });
    return { workspaceId: w.id, admin, engineer, destination, test, deliveries };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('sends nothing without an explicit confirmation', async () => {
    const t = await tenant();
    for (const bad of [{}, { confirm: false }, { confirm: 'yes' }, { confirm: true, extra: 1 }]) {
      const res = await t.test(t.admin, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.code, 'confirmation_required');
    }
    assert.equal((await t.deliveries()).length, 0);
  });

  it('queues one labelled test delivery, audited, for admins only', async () => {
    const t = await tenant();
    assert.equal((await t.test(t.engineer)).status, 403);
    const res = await t.test(t.admin);
    assert.equal(res.status, 202);
    assert.equal(res.body.status, 'pending');
    const [delivery, ...rest] = await t.deliveries();
    assert.equal(rest.length, 0);
    assert.equal(delivery?.id, res.body.deliveryId);
    assert.equal(delivery?.kind, 'destination_test');
    assert.equal(delivery?.destinationId, t.destination.id);
    assert.equal(delivery?.status, 'pending');
    assert.equal((delivery?.payload as { severity: string }).severity, 'info');
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'destination.tested', targetId: t.destination.id },
    });
  });

  it('allows one test a minute per destination', async () => {
    const t = await tenant();
    assert.equal((await t.test(t.admin)).status, 202);
    const again = await t.test(t.admin);
    assert.equal(again.status, 429);
    assert.equal(again.body.code, 'test_too_soon');
    assert.equal((await t.deliveries()).length, 1);
  });

  it('refuses paused, unknown, and foreign destinations', async () => {
    const t = await tenant();
    const other = await tenant();
    assert.equal((await t.test(t.admin, { confirm: true }, randomUUID())).status, 404);
    assert.equal(
      (await other.test(other.admin, { confirm: true }, t.destination.id, other.workspaceId))
        .status,
      404,
    );
    await prisma.destination.update({
      where: { id: t.destination.id },
      data: { status: 'paused' },
    });
    const paused = await t.test(t.admin);
    assert.equal(paused.status, 409);
    assert.equal(paused.body.code, 'destination_not_active');
    assert.equal((await t.deliveries()).length, 0);
  });
});
