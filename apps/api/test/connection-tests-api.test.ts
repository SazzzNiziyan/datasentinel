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

  it('lists profile history with method, column count, and schema changes', async () => {
    const t = await tenant('analyst');
    const at = { workspaceId: t.csv.workspaceId, sourceId: t.csv.id };
    const d = await prisma.dataset.create({ data: { ...at, stableKey: 'h', name: 'h' } });
    const day = (n: number) => new Date(Date.UTC(2026, 9, n));
    for (const [n, hash, columns] of [
      [1, 'a', 2],
      [2, 'a', 2],
      [3, 'b', 3],
    ] as const) {
      const p = await prisma.profileSnapshot.create({
        data: {
          ...at,
          datasetId: d.id,
          status: 'succeeded',
          observedAt: day(n),
          durationMs: 5,
          rowCount: 10 * n,
          rowCountMethod: 'exact',
        },
      });
      await prisma.schemaSnapshot.create({
        data: {
          ...at,
          datasetId: d.id,
          profileSnapshotId: p.id,
          observedAt: day(n),
          rowCount: 10 * n,
          schemaHash: hash.repeat(64),
          columns: Array.from({ length: columns }, (_, i) => ({
            name: `c${i}`,
            type: 'text',
            nullable: true,
            ordinal: i + 1,
          })),
        },
      });
    }
    await prisma.profileSnapshot.create({
      data: {
        ...at,
        datasetId: d.id,
        status: 'failed',
        observedAt: day(4),
        durationMs: 1,
        error: { code: 'timeout', message: 'The source took too long to answer.', retryable: true },
      },
    });

    const res = await t.call('GET', `/datasets/${d.id}/profiles`);
    assert.equal(res.status, 200);
    const list = res.body as unknown as {
      status: string;
      rowCount: number | null;
      rowCountMethod: string | null;
      columnCount: number | null;
      schemaChanged: boolean | null;
    }[];
    assert.deepEqual(
      list.map((p) => [p.status, p.rowCount, p.rowCountMethod, p.columnCount, p.schemaChanged]),
      [
        ['failed', null, null, null, null],
        ['succeeded', 30, 'exact', 3, true],
        ['succeeded', 20, 'exact', 2, false],
        ['succeeded', 10, 'exact', 2, null],
      ],
    );
    const stranger = await tenant();
    assert.equal((await stranger.call('GET', `/datasets/${d.id}/profiles`)).status, 404);
  });
});
