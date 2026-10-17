import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createUser, databaseSkipReason, prisma, signInCookie, startApi } from './helpers.js';

const skip = await databaseSkipReason();

describe('source and dataset read API', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  /** A workspace with one viewer, one source with a credential, one dataset. */
  async function tenant() {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'T', slug: `t-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({
      data: { workspaceId: w.id, userId: user.id, role: 'viewer' },
    });
    const source = await prisma.dataSource.create({
      data: {
        workspaceId: w.id,
        name: 'warehouse',
        type: 'postgres',
        settings: { host: 'db.internal' },
      },
    });
    await prisma.sourceCredential.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        ciphertext: Buffer.from('SECRET-BYTES'),
        keyVersion: 1,
      },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'public.orders', name: 'orders' },
    });
    const cookie = await signInCookie(url, user.email);
    const get = (path: string) =>
      fetch(`${url}/workspaces/${w.id}${path}`, { headers: { cookie } });
    return { workspaceId: w.id, source, dataset, get };
  }

  before(async () => ({ app, url } = await startApi()));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('lists the workspace’s sources without any secret', async () => {
    const t = await tenant();
    const res = await t.get('/sources');
    assert.equal(res.status, 200);
    const text = await res.text();
    const list = JSON.parse(text) as { id: string; datasetCount: number }[];
    assert.deepEqual(
      list.map((s) => [s.id, s.datasetCount]),
      [[t.source.id, 1]],
    );
    assert.doesNotMatch(text, /SECRET|ciphertext/);
  });

  it('shows source detail with settings and whether a credential exists', async () => {
    const t = await tenant();
    const body = (await (await t.get(`/sources/${t.source.id}`)).json()) as Record<string, unknown>;
    assert.equal(body.hasCredential, true);
    assert.deepEqual(body.settings, { host: 'db.internal' });
    assert.equal('ciphertext' in body, false);
  });

  it('answers 404 for another workspace’s source or dataset', async () => {
    const mine = await tenant();
    const theirs = await tenant();
    assert.equal((await mine.get(`/sources/${theirs.source.id}`)).status, 404);
    assert.equal((await mine.get(`/datasets/${theirs.dataset.id}`)).status, 404);
    assert.equal((await mine.get('/sources/not-a-uuid')).status, 404);
  });

  it('hides archived sources unless asked', async () => {
    const t = await tenant();
    await prisma.dataSource.update({
      where: { id: t.source.id },
      data: { status: 'archived', archivedAt: new Date() },
    });
    assert.deepEqual(await (await t.get('/sources')).json(), []);
    const archived = (await (await t.get('/sources?status=archived')).json()) as unknown[];
    assert.equal(archived.length, 1);
  });

  it('lists datasets, optionally for one source, and shows detail', async () => {
    const t = await tenant();
    const all = (await (await t.get('/datasets')).json()) as { id: string; sourceName: string }[];
    assert.deepEqual(
      all.map((d) => [d.id, d.sourceName]),
      [[t.dataset.id, 'warehouse']],
    );
    const filtered = (await (
      await t.get(`/datasets?sourceId=${randomUUID()}`)
    ).json()) as unknown[];
    assert.equal(filtered.length, 0);
    const detail = (await (await t.get(`/datasets/${t.dataset.id}`)).json()) as {
      stableKey: string;
    };
    assert.equal(detail.stableKey, 'public.orders');
  });
});
