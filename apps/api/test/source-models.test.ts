import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { databaseSkipReason, prisma } from './helpers.js';

const skip = await databaseSkipReason();

// The database itself keeps tenants apart (D-36), so a bug in a query
// cannot attach one workspace's rows to another's.
describe('source and dataset constraints', { skip }, () => {
  const workspaces: string[] = [];

  async function workspace() {
    const w = await prisma.workspace.create({ data: { name: 'W', slug: `w-${randomUUID()}` } });
    workspaces.push(w.id);
    return w.id;
  }

  const source = (workspaceId: string, name = 'warehouse') =>
    prisma.dataSource.create({ data: { workspaceId, name, type: 'postgres' } });

  after(() => prisma.workspace.deleteMany({ where: { id: { in: workspaces } } }));

  it('refuses a dataset that points at another workspace’s source', async () => {
    const [a, b] = [await workspace(), await workspace()];
    const sourceInB = await source(b);
    await assert.rejects(
      prisma.dataset.create({
        data: {
          workspaceId: a,
          sourceId: sourceInB.id,
          stableKey: 'public.orders',
          name: 'orders',
        },
      }),
    );
  });

  it('keeps source names unique per workspace only', async () => {
    const [a, b] = [await workspace(), await workspace()];
    await source(a, 'same');
    await assert.rejects(source(a, 'same'));
    await source(b, 'same');
  });

  it('allows one active credential per source', async () => {
    const s = await source(await workspace());
    const data = {
      workspaceId: s.workspaceId,
      sourceId: s.id,
      ciphertext: Buffer.from('x'),
      keyVersion: 1,
    };
    const first = await prisma.sourceCredential.create({ data });
    await assert.rejects(prisma.sourceCredential.create({ data }));
    await prisma.sourceCredential.update({
      where: { id: first.id },
      data: { revokedAt: new Date() },
    });
    await prisma.sourceCredential.create({ data });
  });
});
