import type { Role } from '@datasentinel/contracts';
import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createUser,
  databaseSkipReason,
  FakeUploadStorage,
  prisma,
  RecordingUploadQueue,
  signInCookie,
  startApi,
  WEB,
} from './helpers.js';

const skip = await databaseSkipReason();

const SHA = 'a'.repeat(64);

describe('upload API', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const storage = new FakeUploadStorage();
  const queue = new RecordingUploadQueue();
  const users: string[] = [];
  const workspaces: string[] = [];

  /** A workspace with one member of `role`, a CSV source, and one dataset. */
  async function tenant(role: Role = 'engineer') {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'T', slug: `t-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'files', type: 'csv' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'orders', name: 'Orders' },
    });
    const cookie = await signInCookie(url, user.email);
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${url}/workspaces/${w.id}${path}`, {
        method,
        headers: { cookie, origin: WEB, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const start = (body: Record<string, unknown> = {}) =>
      call('POST', `/sources/${source.id}/uploads`, {
        filename: 'orders.csv',
        sizeBytes: 120,
        checksumSha256: SHA,
        datasetId: dataset.id,
        ...body,
      });
    return { workspaceId: w.id, source, dataset, call, start };
  }

  /** Starts an upload and returns its ID and stored object key. */
  async function started(t: Awaited<ReturnType<typeof tenant>>, body = {}) {
    const res = await t.start(body);
    assert.equal(res.status, 201, await res.clone().text());
    const { upload } = (await res.json()) as { upload: { id: string } };
    const row = await prisma.upload.findUniqueOrThrow({ where: { id: upload.id } });
    return { id: upload.id, key: row.objectKey };
  }

  before(async () => ({ app, url } = await startApi({ storage, queue })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('starts an upload with signed instructions and a random object key', async () => {
    const t = await tenant();
    const res = await t.start({ filename: '../../etc/‮evil\u0007.csv' });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      upload: { id: string; status: string; filename: string; datasetId: string };
      instructions: { method: string; url: string };
    };
    assert.equal(body.upload.status, 'awaiting_upload');
    assert.equal(body.upload.filename, 'evil.csv');
    assert.equal(body.upload.datasetId, t.dataset.id);
    assert.equal(body.instructions.method, 'PUT');
    const row = await prisma.upload.findUniqueOrThrow({ where: { id: body.upload.id } });
    assert.match(row.objectKey, new RegExp(`^workspaces/${t.workspaceId}/uploads/[0-9a-f-]{36}$`));
    assert.ok(row.retainUntil.getTime() > Date.now() + 29 * 24 * 60 * 60 * 1000);
  });

  it('refuses analysts, non-CSV sources, oversized files, and bad bodies', async () => {
    const analyst = await tenant('analyst');
    assert.equal((await analyst.start()).status, 403);

    const t = await tenant();
    assert.equal((await t.start({ sizeBytes: 50 * 1024 * 1024 + 1 })).status, 400);
    assert.equal((await t.start({ checksumSha256: 'xyz' })).status, 400);
    assert.equal((await t.start({ newDatasetName: 'Both' })).status, 400);

    const pg = await prisma.dataSource.create({
      data: { workspaceId: t.workspaceId, name: 'pg', type: 'postgres' },
    });
    const res = await t.call('POST', `/sources/${pg.id}/uploads`, {
      filename: 'a.csv',
      sizeBytes: 1,
      checksumSha256: SHA,
      newDatasetName: 'A',
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, 'source_not_csv');
  });

  it('hides other workspaces’ sources, datasets, and uploads', async () => {
    const a = await tenant();
    const b = await tenant();
    assert.equal((await a.call('POST', `/sources/${b.source.id}/uploads`, {})).status, 404);
    assert.equal((await a.start({ datasetId: b.dataset.id })).status, 404);
    const upload = await started(b);
    assert.equal((await a.call('GET', `/uploads/${upload.id}`)).status, 404);
    assert.equal((await a.call('POST', `/uploads/${upload.id}/complete`)).status, 404);
    assert.equal((await a.call('GET', '/uploads/not-a-uuid')).status, 404);
  });

  it('completes once the file is stored, queues parsing once, and audits', async () => {
    const t = await tenant();
    const upload = await started(t);
    assert.equal((await t.call('POST', `/uploads/${upload.id}/complete`)).status, 409);

    storage.objects.set(upload.key, { sizeBytes: 120, sha256: SHA });
    const first = await t.call('POST', `/uploads/${upload.id}/complete`);
    assert.equal(first.status, 202);
    assert.equal(((await first.json()) as { status: string }).status, 'queued');
    const again = await t.call('POST', `/uploads/${upload.id}/complete`);
    assert.equal(again.status, 202);

    const jobs = queue.jobs.filter((j) => j.uploadId === upload.id);
    assert.ok(jobs.length >= 1);
    assert.deepEqual(jobs[0], { workspaceId: t.workspaceId, uploadId: upload.id });
    const status = (await (await t.call('GET', `/uploads/${upload.id}`)).json()) as {
      status: string;
    };
    assert.equal(status.status, 'queued');
    const actions = await prisma.auditEvent.findMany({
      where: { workspaceId: t.workspaceId, targetId: upload.id },
      select: { action: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    assert.deepEqual(
      actions.map((a) => a.action),
      ['upload.started', 'upload.completed'],
    );
  });

  it('fails an upload whose stored size or checksum differs', async () => {
    const t = await tenant();
    const upload = await started(t);
    storage.objects.set(upload.key, { sizeBytes: 120, sha256: 'b'.repeat(64) });
    const res = await t.call('POST', `/uploads/${upload.id}/complete`);
    assert.equal(res.status, 202);
    const body = (await res.json()) as { status: string; error: { code: string } };
    assert.equal(body.status, 'failed');
    assert.equal(body.error.code, 'malformed');
    assert.equal(
      queue.jobs.some((j) => j.uploadId === upload.id),
      false,
    );
  });

  it('creates the requested new dataset on completion', async () => {
    const t = await tenant();
    const upload = await started(t, { datasetId: undefined, newDatasetName: 'Daily Sales' });
    storage.objects.set(upload.key, { sizeBytes: 120, sha256: SHA });
    const res = await t.call('POST', `/uploads/${upload.id}/complete`);
    const body = (await res.json()) as { datasetId: string; newDatasetName: string | null };
    assert.equal(body.newDatasetName, null);
    const dataset = await prisma.dataset.findUniqueOrThrow({ where: { id: body.datasetId } });
    assert.equal(dataset.stableKey, 'daily-sales');
    assert.equal(dataset.name, 'Daily Sales');

    const clash = await t.start({ datasetId: undefined, newDatasetName: 'daily sales' });
    assert.equal(clash.status, 409);
  });

  it('lists recent uploads, newest first, for a dataset or source', async () => {
    const t = await tenant();
    const first = await started(t);
    const second = await started(t, { filename: 'second.csv' });
    const list = async (query: string) =>
      ((await (await t.call('GET', `/uploads${query}`)).json()) as { id: string }[]).map(
        (u) => u.id,
      );
    assert.deepEqual(await list(`?datasetId=${t.dataset.id}`), [second.id, first.id]);
    assert.deepEqual(await list(`?sourceId=${t.source.id}`), [second.id, first.id]);
    assert.deepEqual(await list(`?datasetId=${randomUUID()}`), []);
    assert.deepEqual(await list('?datasetId=nope'), []);
  });
});
