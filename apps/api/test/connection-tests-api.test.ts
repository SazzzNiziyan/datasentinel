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

describe('connection test API', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const queue = new RecordingSourceJobs();
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant(role: 'engineer' | 'analyst' = 'engineer') {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'T', slug: `t-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
    const pg = await prisma.dataSource.create({
      data: {
        workspaceId: w.id,
        name: 'pg',
        type: 'postgres',
        settings: { host: 'db.example.com' },
      },
    });
    await prisma.sourceCredential.create({
      data: { workspaceId: w.id, sourceId: pg.id, ciphertext: new Uint8Array([1]), keyVersion: 1 },
    });
    const csv = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'csv', type: 'csv' },
    });
    const cookie = await signInCookie(url, user.email);
    const call = async (method: string, path: string) => {
      const res = await fetch(`${url}/workspaces/${w.id}${path}`, {
        method,
        headers: { cookie, origin: WEB },
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { pg, csv, call };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: queue })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('queues one test per source at a time and shows it', async () => {
    const t = await tenant();
    const first = await t.call('POST', `/sources/${t.pg.id}/connection-tests`);
    assert.equal(first.status, 202);
    assert.equal(first.body.status, 'queued');
    const again = await t.call('POST', `/sources/${t.pg.id}/connection-tests`);
    assert.equal(again.body.id, first.body.id);
    assert.ok(queue.jobs.some((j) => j.connectionTestId === first.body.id));
    const detail = await t.call('GET', `/connection-tests/${String(first.body.id)}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.sourceId, t.pg.id);
  });

  it('refuses CSV sources, analysts, and other workspaces', async () => {
    const t = await tenant();
    const csv = await t.call('POST', `/sources/${t.csv.id}/connection-tests`);
    assert.equal(csv.status, 409);
    assert.equal(csv.body.code, 'not_testable');
    const analyst = await tenant('analyst');
    assert.equal(
      (await analyst.call('POST', `/sources/${analyst.pg.id}/connection-tests`)).status,
      403,
    );
    assert.equal((await t.call('POST', `/sources/${analyst.pg.id}/connection-tests`)).status, 404);
    assert.equal((await t.call('GET', '/connection-tests/not-a-uuid')).status, 404);
  });

  it('returns discovered tables, and safe problems when the source fails or is slow', async () => {
    const t = await tenant();
    const table = { schema: 'public', name: 'orders', kind: 'table' as const, estimatedRows: 10 };
    queue.discovery = { ok: true, discovery: { tables: [table], truncated: false } };
    const ok = await t.call('POST', `/sources/${t.pg.id}/discoveries`);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.tables, [table]);

    queue.discovery = {
      ok: false,
      error: {
        code: 'auth_failed',
        message: 'The source rejected the username or password.',
        hint: 'Check.',
        retryable: false,
      },
    };
    const failed = await t.call('POST', `/sources/${t.pg.id}/discoveries`);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, 'source_auth_failed');

    queue.discovery = null;
    assert.equal((await t.call('POST', `/sources/${t.pg.id}/discoveries`)).status, 504);
    assert.equal((await t.call('POST', `/sources/${t.csv.id}/discoveries`)).status, 409);
  });

  it('queues a profile of a database dataset, but not of CSV or archived ones', async () => {
    const t = await tenant();
    const at = { workspaceId: t.pg.workspaceId, sourceId: t.pg.id };
    const d = await prisma.dataset.create({
      data: {
        ...at,
        stableKey: 'public.orders',
        name: 'orders',
        locator: { schema: 'public', table: 'orders' },
      },
    });
    const res = await t.call('POST', `/datasets/${d.id}/profile-runs`);
    assert.equal(res.status, 202);
    assert.ok(queue.profiles.some((p) => p.datasetId === d.id));

    const csvDataset = await prisma.dataset.create({
      data: { workspaceId: t.csv.workspaceId, sourceId: t.csv.id, stableKey: 'c', name: 'c' },
    });
    assert.equal((await t.call('POST', `/datasets/${csvDataset.id}/profile-runs`)).status, 409);
    await prisma.dataset.update({ where: { id: d.id }, data: { status: 'archived' } });
    assert.equal((await t.call('POST', `/datasets/${d.id}/profile-runs`)).status, 409);
  });
});
