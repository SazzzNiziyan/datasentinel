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

describe('workspace metrics', { skip }, () => {
  let api: { app: INestApplication; url: string };
  const users: string[] = [];
  const workspaces: string[] = [];

  before(async () => {
    api = await startApi({ sourceJobs: new RecordingSourceJobs() });
  });
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await api.app.close();
  });

  async function get(workspaceId: string, role: 'viewer' | 'admin') {
    const user = await createUser();
    users.push(user.id);
    await prisma.membership.create({ data: { workspaceId, userId: user.id, role } });
    const res = await fetch(`${api.url}/workspaces/${workspaceId}/metrics`, {
      headers: { cookie: await signInCookie(api.url, user.email), origin: WEB },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('gives an admin plain counts and refuses a viewer', async () => {
    const w = await prisma.workspace.create({ data: { name: 'M', slug: `m-${randomUUID()}` } });
    workspaces.push(w.id);
    const admin = await get(w.id, 'admin');
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.body.incidents, { open: 0 });
    assert.deepEqual(admin.body.notifications, { pending: 0, failed: 0 });
    assert.deepEqual(admin.body.actions, { awaitingApproval: 0, failedLast24h: 0 });
    assert.deepEqual(admin.body.queue, { failed: 0, stalled: 0 });
    assert.equal((await get(w.id, 'viewer')).status, 403);
  });
});
