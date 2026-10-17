import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { sweepExpiredUploads } from '../src/retention/sweep-uploads.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');
const skip =
  databaseUrl === ''
    ? 'DATABASE_URL is not set'
    : await prisma.$queryRaw`SELECT 1`.then(
        () => false,
        () => 'local database is not running (pnpm services:up)',
      );

describe('raw upload retention', { skip }, () => {
  const workspaces: string[] = [];
  const users: string[] = [];
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });

  async function fixture(retainDays: number[]) {
    const w = await prisma.workspace.create({ data: { name: 'R', slug: `r-${randomUUID()}` } });
    workspaces.push(w.id);
    const user = await prisma.user.create({
      data: { email: `${randomUUID()}@example.test`, displayName: 'R' },
    });
    users.push(user.id);
    const m = await prisma.membership.create({
      data: { workspaceId: w.id, userId: user.id, role: 'owner' },
    });
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'S', type: 'csv' },
    });
    const now = new Date('2026-10-18T12:00:00Z');
    const keys: string[] = [];
    for (const days of retainDays) {
      const objectKey = `uploads/${randomUUID()}`;
      keys.push(objectKey);
      await prisma.upload.create({
        data: {
          workspaceId: w.id,
          sourceId: source.id,
          objectKey,
          newDatasetName: 'orders',
          filename: 'a.csv',
          sizeBytes: 3,
          checksumSha256: 'a'.repeat(64),
          createdByMembershipId: m.id,
          uploadUrlExpiresAt: now,
          retainUntil: new Date(now.getTime() + days * 86_400_000),
        },
      });
    }
    return { w, keys, now };
  }

  it('removes only files past retention, once each', async () => {
    const f = await fixture([-2, -1, 5]);
    const removed: string[] = [];
    const remove = (key: string) => {
      removed.push(key);
      return Promise.resolve();
    };
    const first = await sweepExpiredUploads(prisma, remove, f.now, { workspaceId: f.w.id });
    assert.deepEqual(first, { removed: 2, failed: 0 });
    assert.deepEqual(removed.sort(), [f.keys[0], f.keys[1]].sort());
    const again = await sweepExpiredUploads(prisma, remove, f.now, { workspaceId: f.w.id });
    assert.deepEqual(again, { removed: 0, failed: 0 });
    const kept = await prisma.upload.findUniqueOrThrow({ where: { objectKey: f.keys[2] ?? '' } });
    assert.equal(kept.rawDeletedAt, null);
  });

  it('leaves a failed removal unmarked so the next pass retries it', async () => {
    const f = await fixture([-1]);
    const failing = () => Promise.reject(new Error('storage down'));
    assert.deepEqual(await sweepExpiredUploads(prisma, failing, f.now, { workspaceId: f.w.id }), {
      removed: 0,
      failed: 1,
    });
    const ok = () => Promise.resolve();
    assert.deepEqual(await sweepExpiredUploads(prisma, ok, f.now, { workspaceId: f.w.id }), {
      removed: 1,
      failed: 0,
    });
  });
});
