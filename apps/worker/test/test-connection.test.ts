import { credentialContext, keyRing, sealSecret } from '@datasentinel/connectors';
import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { handleDiscoverTables } from '../src/jobs/discover-tables.js';
import { handleProfileDataset } from '../src/jobs/profile-dataset.js';
import { readMeasurements } from '../src/jobs/profile-metrics.js';
import { handleTestConnection } from '../src/jobs/test-connection.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');
const skip =
  databaseUrl === ''
    ? 'DATABASE_URL is not set'
    : await prisma.$queryRaw`SELECT 1`.then(
        () => false,
        () => 'local database is not running (pnpm services:up)',
      );

const ring = keyRing({ key: randomBytes(32), version: 3 });

describe('test-connection job', { skip }, () => {
  const workspaces: string[] = [];
  const users: string[] = [];
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  /** A queued test for a source pointing at the local database. */
  async function queued(password: string) {
    const url = new URL(databaseUrl);
    const user = await prisma.user.create({
      data: { email: `ct-${randomUUID()}@test.example`, displayName: 'C' },
    });
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'C', slug: `c-${randomUUID()}` } });
    workspaces.push(w.id);
    const m = await prisma.membership.create({
      data: { workspaceId: w.id, userId: user.id, role: 'engineer' },
    });
    const source = await prisma.dataSource.create({
      data: {
        workspaceId: w.id,
        name: 'local',
        type: 'postgres',
        settings: {
          host: url.hostname,
          port: Number(url.port || 5432),
          database: url.pathname.slice(1),
          sslMode: 'disable',
        },
      },
    });
    const sealed = sealSecret(
      ring,
      { username: decodeURIComponent(url.username), password },
      credentialContext(w.id, source.id),
    );
    await prisma.sourceCredential.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        ciphertext: new Uint8Array(sealed.ciphertext),
        keyVersion: sealed.keyVersion,
      },
    });
    const test = await prisma.connectionTest.create({
      data: { workspaceId: w.id, sourceId: source.id, requestedByMembershipId: m.id },
    });
    return {
      job: { workspaceId: w.id, connectionTestId: test.id },
      row: () => prisma.connectionTest.findUniqueOrThrow({ where: { id: test.id } }),
      source: () => prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } }),
    };
  }

  const deps = { prisma, ring, policy: 'allow-private' as const, timeoutMs: 3000 };

  it('connects with the stored login and records the result', async () => {
    const t = await queued(decodeURIComponent(new URL(databaseUrl).password));
    await handleTestConnection(deps, t.job, { finalAttempt: false });
    const row = await t.row();
    assert.equal(row.status, 'succeeded', JSON.stringify(row.error));
    assert.match(row.serverVersion ?? '', /^\d+/);
    assert.ok(row.finishedAt);
    assert.ok((await t.source()).lastCheckedAt);
  });

  it('records a safe failure for a wrong password', async () => {
    const t = await queued('definitely-wrong');
    await handleTestConnection(deps, t.job, { finalAttempt: false });
    const row = await t.row();
    assert.equal(row.status, 'failed');
    assert.equal((row.error as { code: string }).code, 'auth_failed');
    assert.equal((await t.source()).lastCheckedAt, null);
  });

  it('treats a credential the worker cannot open as a setup problem', async () => {
    const t = await queued('x');
    const otherRing = keyRing({ key: randomBytes(32), version: 3 });
    await handleTestConnection({ ...deps, ring: otherRing }, t.job, { finalAttempt: false });
    assert.equal(((await t.row()).error as { code: string }).code, 'invalid_config');
  });

  it('discovers tables through the stored login, and fails safely without it', async () => {
    const t = await queued(decodeURIComponent(new URL(databaseUrl).password));
    const test = await t.row();
    const found = await handleDiscoverTables(deps, {
      workspaceId: test.workspaceId,
      sourceId: test.sourceId,
    });
    assert.ok(found.ok && found.discovery.tables.some((x) => x.name === 'users'));
    const wrong = await handleDiscoverTables(
      { ...deps, ring: keyRing({ key: randomBytes(32), version: 3 }) },
      { workspaceId: test.workspaceId, sourceId: test.sourceId },
    );
    assert.deepEqual(wrong.ok ? null : wrong.error.code, 'invalid_config');
  });

  it('profiles a registered table into profile and schema history', async () => {
    const t = await queued(decodeURIComponent(new URL(databaseUrl).password));
    const test = await t.row();
    const at = { workspaceId: test.workspaceId, sourceId: test.sourceId };
    const users = await prisma.dataset.create({
      data: {
        ...at,
        stableKey: 'public.users',
        name: 'users',
        locator: { schema: 'public', table: 'users' },
      },
    });
    const gone = await prisma.dataset.create({
      data: {
        ...at,
        stableKey: 'public.gone',
        name: 'gone',
        locator: { schema: 'public', table: 'gone_x' },
      },
    });
    await handleProfileDataset(
      deps,
      { workspaceId: at.workspaceId, datasetId: users.id },
      { finalAttempt: false },
    );
    await handleProfileDataset(
      deps,
      { workspaceId: at.workspaceId, datasetId: gone.id },
      { finalAttempt: false },
    );

    const good = await prisma.profileSnapshot.findFirstOrThrow({
      where: { datasetId: users.id },
      include: { schema: true },
    });
    assert.equal(good.status, 'succeeded');
    assert.equal(good.rowCountMethod, 'exact');
    assert.deepEqual(readMeasurements(good.metrics)[0], {
      metric: 'row_count',
      column: null,
      value: Number(good.rowCount),
      method: 'exact',
      observedAt: good.observedAt.toISOString(),
    });
    const columns = (good.schema?.columns ?? []) as {
      name: string;
      type: string;
      nullable: boolean;
    }[];
    assert.deepEqual(
      columns.find((c) => c.name === 'email'),
      {
        name: 'email',
        type: 'text',
        nullable: false,
        ordinal: columns.findIndex((c) => c.name === 'email') + 1,
      },
    );

    const bad = await prisma.profileSnapshot.findFirstOrThrow({ where: { datasetId: gone.id } });
    assert.equal(bad.status, 'failed');
    assert.equal(bad.rowCount, null);
    assert.equal((bad.error as { code: string }).code, 'not_found');
  });
});
