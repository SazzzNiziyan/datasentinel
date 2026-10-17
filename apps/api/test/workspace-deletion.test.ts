import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createUser,
  databaseSkipReason,
  FakeUploadStorage,
  prisma,
  RecordingSourceJobs,
  signInCookie,
  startApi,
  WEB,
} from './helpers.js';

const skip = await databaseSkipReason();

describe('workspace deletion', { skip }, () => {
  let api: { app: INestApplication; url: string };
  const storage = new FakeUploadStorage();
  const users: string[] = [];
  const workspaces: string[] = [];

  before(async () => {
    api = await startApi({ sourceJobs: new RecordingSourceJobs(), storage });
  });
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await api.app.close();
  });

  async function tenant() {
    const slug = `del-${randomUUID()}`;
    const w = await prisma.workspace.create({ data: { name: 'Del', slug } });
    workspaces.push(w.id);
    const member = async (role: 'owner' | 'admin') => {
      const user = await createUser();
      users.push(user.id);
      const m = await prisma.membership.create({
        data: { workspaceId: w.id, userId: user.id, role },
      });
      return { user, membershipId: m.id, cookie: await signInCookie(api.url, user.email) };
    };
    const owner = await member('owner');
    const admin = await member('admin');
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'S', type: 'csv' },
    });
    const objectKey = `uploads/${randomUUID()}`;
    storage.objects.set(objectKey, { sizeBytes: 3, sha256: null });
    await prisma.upload.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        objectKey,
        newDatasetName: 'orders',
        filename: 'a.csv',
        sizeBytes: 3,
        checksumSha256: 'a'.repeat(64),
        createdByMembershipId: owner.membershipId,
        uploadUrlExpiresAt: new Date(),
        retainUntil: new Date(Date.now() + 86_400_000),
      },
    });
    const del = (who: { cookie: string }, body: unknown) =>
      fetch(`${api.url}/workspaces/${w.id}`, {
        method: 'DELETE',
        headers: { cookie: who.cookie, origin: WEB, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { w, slug, owner, admin, objectKey, del };
  }

  it('needs the owner role and the exact slug', async () => {
    const t = await tenant();
    assert.equal((await t.del(t.admin, { confirmSlug: t.slug })).status, 403);
    assert.equal((await t.del(t.owner, {})).status, 400);
    assert.equal((await t.del(t.owner, { confirmSlug: 'wrong' })).status, 400);
    assert.ok(await prisma.workspace.findUnique({ where: { id: t.w.id } }));
    assert.ok(storage.objects.has(t.objectKey));
  });

  it('removes the workspace, its data and its files, and keeps an audit record', async () => {
    const t = await tenant();
    const res = await t.del(t.owner, { confirmSlug: t.slug });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: true, objectsNotRemoved: 0 });
    assert.equal(await prisma.workspace.findUnique({ where: { id: t.w.id } }), null);
    assert.equal(await prisma.dataSource.count({ where: { workspaceId: t.w.id } }), 0);
    assert.equal(await prisma.upload.count({ where: { workspaceId: t.w.id } }), 0);
    assert.equal(await prisma.membership.count({ where: { workspaceId: t.w.id } }), 0);
    assert.equal(storage.objects.has(t.objectKey), false);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { workspaceId: t.w.id, action: 'workspace.deleted' },
    });
    assert.deepEqual(audit.summary, { objects: 1 });
    // The user accounts are not workspace data and remain.
    assert.ok(await prisma.user.findUnique({ where: { id: t.owner.user.id } }));
  });
});
