import type { Role } from '@datasentinel/contracts';
import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { credentialContext, openSecret } from '@datasentinel/connectors';
import {
  createUser,
  databaseSkipReason,
  prisma,
  signInCookie,
  startApi,
  testKeyRing,
  WEB,
} from './helpers.js';

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
      rowCountMethod: 'exact',
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

  it('lets engineers add a CSV source, and refuses incomplete ones', async () => {
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

  const pg = (settings: Record<string, unknown> = {}) => ({
    type: 'postgres',
    name: `warehouse-${randomUUID()}`,
    settings: { host: '203.0.113.10', port: 5432, database: 'analytics', ...settings },
    credentials: { username: 'ds_reader', password: 'S3cret-Pa55' },
  });

  it('adds a PostgreSQL source and keeps its password write-only', async () => {
    const t = await tenant('engineer');
    const res = await t.post('/sources', pg());
    assert.equal(res.status, 201);
    const created = (await res.json()) as { id: string; type: string };
    assert.equal(created.type, 'postgres');

    const detailText = await (await t.get(`/sources/${created.id}`)).text();
    assert.doesNotMatch(detailText, /S3cret|ds_reader/);
    const detail = JSON.parse(detailText) as { hasCredential: boolean; settings: unknown };
    assert.equal(detail.hasCredential, true);
    assert.deepEqual(detail.settings, {
      host: '203.0.113.10',
      port: 5432,
      database: 'analytics',
      sslMode: 'verify-full',
    });

    const row = await prisma.sourceCredential.findFirstOrThrow({ where: { sourceId: created.id } });
    assert.equal(row.keyVersion, testKeyRing.version);
    assert.equal(Buffer.from(row.ciphertext).includes(Buffer.from('S3cret')), false);
    assert.deepEqual(
      openSecret(
        testKeyRing,
        { ciphertext: Buffer.from(row.ciphertext), keyVersion: row.keyVersion },
        credentialContext(t.workspaceId, created.id),
      ),
      { username: 'ds_reader', password: 'S3cret-Pa55' },
    );
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { workspaceId: t.workspaceId, action: 'source.created', targetId: created.id },
    });
    assert.doesNotMatch(JSON.stringify(audit.summary), /S3cret|ds_reader/);
  });

  it('refuses PostgreSQL destinations outside the network policy', async () => {
    const t = await tenant('engineer');
    for (const settings of [
      { host: '10.0.0.5' },
      { host: '169.254.169.254' },
      { host: 'localhost' },
      { host: 'metadata.google.internal' },
      { host: 'postgres://db.example.com' },
      { host: 'db.example.com', port: 22 },
      { host: 'db.example.com', sslMode: 'disable' },
    ]) {
      const res = await t.post('/sources', pg(settings));
      assert.equal(res.status, 400, JSON.stringify(settings));
      const body = (await res.json()) as { code: string; title: string };
      assert.equal(body.code, 'invalid_destination', JSON.stringify(settings));
      assert.doesNotMatch(body.title, /10\.0\.0\.5|169\.254|metadata/);
    }
    assert.equal((await t.post('/sources', { ...pg(), credentials: undefined })).status, 400);
  });

  it('registers a table of a database source as a dataset, once', async () => {
    const t = await tenant('engineer');
    const pgSource = (await (await t.post('/sources', pg())).json()) as { id: string };
    const res = await t.post('/datasets', {
      sourceId: pgSource.id,
      schema: 'sales',
      table: 'Orders 2026',
    });
    assert.equal(res.status, 201);
    const d = (await res.json()) as { name: string; stableKey: string; locator: unknown };
    assert.equal(d.name, 'Orders 2026');
    assert.equal(d.stableKey, 'sales.Orders 2026');
    assert.deepEqual(d.locator, { schema: 'sales', table: 'Orders 2026' });
    const again = await t.post('/datasets', {
      sourceId: pgSource.id,
      schema: 'sales',
      table: 'Orders 2026',
    });
    assert.equal(again.status, 409);
    // CSV sources get datasets from uploads; bad names are refused.
    const csv = (await (await t.post('/sources', { name: 'files', type: 'csv' })).json()) as {
      id: string;
    };
    assert.equal(
      (await t.post('/datasets', { sourceId: csv.id, schema: 's', table: 't' })).status,
      409,
    );
    assert.equal(
      (await t.post('/datasets', { sourceId: pgSource.id, schema: '', table: 't' })).status,
      400,
    );
    const viewer = await tenant('viewer');
    assert.equal(
      (await viewer.post('/datasets', { sourceId: pgSource.id, schema: 's', table: 't' })).status,
      403,
    );
  });

  it('rotates a database login: one active credential, old one revoked, nothing echoed', async () => {
    const t = await tenant('engineer');
    const created = (await (await t.post('/sources', pg())).json()) as { id: string };
    const res = await t.post(`/sources/${created.id}/credentials/rotate`, {
      username: 'ds_reader2',
      password: 'N3w-Pa55word',
    });
    assert.equal(res.status, 200);
    assert.doesNotMatch(await res.text(), /N3w-Pa55|S3cret|ds_reader/);
    const rows = await prisma.sourceCredential.findMany({
      where: { sourceId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(rows.length, 2);
    assert.ok(rows[0]?.revokedAt);
    assert.equal(rows[1]?.revokedAt, null);
    const active = rows[1];
    assert.ok(active);
    assert.deepEqual(
      openSecret(
        testKeyRing,
        { ciphertext: Buffer.from(active.ciphertext), keyVersion: active.keyVersion },
        credentialContext(t.workspaceId, created.id),
      ),
      { username: 'ds_reader2', password: 'N3w-Pa55word' },
    );
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'source.credentials_rotated', targetId: created.id },
    });
    assert.doesNotMatch(JSON.stringify(audit.summary), /N3w|ds_reader/);
    const viewer = await tenant('viewer');
    assert.equal(
      (
        await viewer.post(`/sources/${viewer.source.id}/credentials/rotate`, {
          username: 'a',
          password: 'b',
        })
      ).status,
      403,
    );
  });
});
