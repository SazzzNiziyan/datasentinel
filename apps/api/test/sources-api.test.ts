import type { Role } from '@datasentinel/contracts';
import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createUser, databaseSkipReason, prisma, signInCookie, startApi, WEB } from './helpers.js';

const skip = await databaseSkipReason();

describe('source and dataset read API', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  /** A workspace with one viewer, one source with a credential, one dataset. */
  async function tenant(role: Role = 'viewer') {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'T', slug: `t-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({
      data: { workspaceId: w.id, userId: user.id, role },
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
    const post = (path: string, body: unknown) =>
      fetch(`${url}/workspaces/${w.id}${path}`, {
        method: 'POST',
        headers: { cookie, origin: WEB, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { workspaceId: w.id, source, dataset, get, post };
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

  it('shows no profile for a dataset that was never profiled', async () => {
    const t = await tenant();
    const detail = (await (await t.get(`/datasets/${t.dataset.id}`)).json()) as {
      latestProfile: unknown;
      lastSuccessfulProfile: unknown;
    };
    assert.equal(detail.latestProfile, null);
    assert.equal(detail.lastSuccessfulProfile, null);
  });

  it('shows the latest profile with its columns, and a failed one with its error', async () => {
    const t = await tenant();
    const at = { workspaceId: t.workspaceId, sourceId: t.source.id, datasetId: t.dataset.id };
    const older = await prisma.profileSnapshot.create({
      data: {
        ...at,
        status: 'succeeded',
        observedAt: new Date('2026-10-01T00:00:00Z'),
        rowCount: 3,
        rowCountMethod: 'exact',
        lastUpdatedAt: new Date('2026-10-01T00:00:00Z'),
        durationMs: 12,
        metrics: {
          columns: [
            { name: 'id', type: 'integer', nullCount: 0 },
            { name: 'note', type: 'text', nullCount: 2 },
          ],
        },
      },
    });
    type Profiles = {
      latestProfile: Record<string, unknown> | null;
      lastSuccessfulProfile: Record<string, unknown> | null;
    };
    const profiles = async () =>
      (await (await t.get(`/datasets/${t.dataset.id}`)).json()) as Profiles;
    const detail = async () => (await profiles()).latestProfile;
    assert.deepEqual(await detail(), {
      id: older.id,
      status: 'succeeded',
      observedAt: '2026-10-01T00:00:00.000Z',
      rowCount: 3,
      lastUpdatedAt: '2026-10-01T00:00:00.000Z',
      error: null,
      columns: [
        { name: 'id', type: 'integer', nullCount: 0, ordinal: 1 },
        { name: 'note', type: 'text', nullCount: 2, ordinal: 2 },
      ],
    });

    const error = {
      code: 'malformed',
      message: 'Line 3 is bad.',
      hint: 'Fix it.',
      retryable: false,
    };
    await prisma.profileSnapshot.create({
      data: {
        ...at,
        status: 'failed',
        observedAt: new Date('2026-10-02T00:00:00Z'),
        durationMs: 5,
        error,
      },
    });
    const latest = await detail();
    assert.equal(latest?.status, 'failed');
    assert.equal(latest?.rowCount, null);
    assert.deepEqual(latest?.error, error);
    assert.deepEqual(latest?.columns, []);
    // The last good profile stays available next to the failure.
    assert.equal((await profiles()).lastSuccessfulProfile?.id, older.id);
  });

  it('lets engineers add a CSV source, and nobody add other types yet', async () => {
    const t = await tenant('engineer');
    const created = await t.post('/sources', { name: 'Finance exports', type: 'csv' });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { id: string; type: string; status: string };
    assert.equal(body.type, 'csv');
    assert.equal(body.status, 'active');
    const audit = await prisma.auditEvent.findFirst({
      where: { workspaceId: t.workspaceId, action: 'source.created', targetId: body.id },
    });
    assert.ok(audit);

    const again = await t.post('/sources', { name: 'Finance exports', type: 'csv' });
    assert.equal(again.status, 409);
    assert.equal((await t.post('/sources', { name: 'pg', type: 'postgres' })).status, 400);
    assert.equal((await t.post('/sources', { name: ' ', type: 'csv' })).status, 400);

    const analyst = await tenant('analyst');
    assert.equal((await analyst.post('/sources', { name: 'x', type: 'csv' })).status, 403);
  });
});
