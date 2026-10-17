import { credentialContext, keyRing, sealSecret } from '@datasentinel/connectors';
import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { handleDiscoverTables } from '../src/jobs/discover-tables.js';
import { handleProfileDataset } from '../src/jobs/profile-dataset.js';
import { profileMetrics, readMeasurements } from '../src/jobs/profile-metrics.js';
import { handleRunCheck } from '../src/jobs/run-check.js';
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

  it('runs freshness checks once each, recording results and safe errors', async (ctx) => {
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
    async function check(
      definition: object,
      key: string,
      datasetId = users.id,
      sourceId = at.sourceId,
    ) {
      const rule = await prisma.qualityRule.create({
        data: {
          ...at,
          sourceId,
          datasetId,
          name: key,
          type: 'freshness',
          severity: 'critical',
          currentVersion: 1,
        },
      });
      const revision = await prisma.ruleRevision.create({
        data: {
          workspaceId: at.workspaceId,
          ruleId: rule.id,
          version: 1,
          definition,
          severity: 'critical',
        },
      });
      const run = await prisma.checkRun.create({
        data: {
          workspaceId: at.workspaceId,
          ruleId: rule.id,
          ruleRevisionId: revision.id,
          trigger: 'manual',
          idempotencyKey: key,
        },
      });
      const job = { workspaceId: at.workspaceId, checkRunId: run.id };
      return { job, row: () => prisma.checkRun.findUniqueOrThrow({ where: { id: run.id } }) };
    }

    const fresh = await check(
      { version: 1, type: 'freshness', timestampColumn: 'created_at', maxAgeMinutes: 525_600 },
      'fresh',
    );
    // The newest user is this test's own, a minute ahead, so another suite
    // adding or deleting users cannot change what the check reads.
    const latest = await prisma.user.create({
      data: {
        email: `fresh-${randomUUID()}@test.example`,
        displayName: 'Fresh',
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    ctx.after(() => prisma.user.delete({ where: { id: latest.id } }).then(() => undefined));
    const now = () => new Date(latest.createdAt.getTime() + 5 * 60_000);
    await handleRunCheck(deps, fresh.job, { finalAttempt: false, now });
    const passed = await fresh.row();
    assert.equal(passed.status, 'passed');
    const actual = passed.actual as { lastUpdatedAt: string; ageMinutes: number };
    assert.ok(Date.parse(actual.lastUpdatedAt) >= latest.createdAt.getTime());
    assert.ok(actual.ageMinutes <= 5);
    assert.ok(passed.endedAt && passed.durationMs !== null);
    // A repeated delivery does nothing, and a finished run cannot change.
    await handleRunCheck(deps, fresh.job, { finalAttempt: false, now });
    assert.deepEqual(await fresh.row(), passed);
    await assert.rejects(
      prisma.checkRun.update({ where: { id: passed.id }, data: { status: 'failed' } }),
    );

    const textColumn = await check(
      { version: 1, type: 'freshness', timestampColumn: 'email', maxAgeMinutes: 60 },
      'text',
    );
    await handleRunCheck(deps, textColumn.job, { finalAttempt: false });
    const refused = await textColumn.row();
    assert.equal(refused.status, 'error');
    assert.equal((refused.error as { code: string }).code, 'unsupported');

    const noProfile = await check({ version: 1, type: 'freshness', maxAgeMinutes: 60 }, 'none');
    await handleRunCheck(deps, noProfile.job, { finalAttempt: false });
    assert.equal((await noProfile.row()).status, 'insufficient_data');

    const invalid = await check({ version: 1, type: 'freshness', maxAgeMinutes: 0 }, 'bad');
    await handleRunCheck(deps, invalid.job, { finalAttempt: false });
    assert.equal(((await invalid.row()).error as { code: string }).code, 'invalid_config');

    const notNull = await check(
      { version: 1, type: 'not_null', column: 'email', maxNullPercent: 0 },
      'nn',
    );
    await handleRunCheck(deps, notNull.job, { finalAttempt: false });
    const nn = await notNull.row();
    assert.equal(nn.status, 'passed');
    assert.equal((nn.actual as { nullCount: number }).nullCount, 0);

    // CSV: counts come from the latest upload's profile.
    const csv = await prisma.dataSource.create({
      data: { workspaceId: at.workspaceId, name: 'files', type: 'csv' },
    });
    const file = await prisma.dataset.create({
      data: { workspaceId: at.workspaceId, sourceId: csv.id, stableKey: 'f', name: 'f' },
    });
    await prisma.profileSnapshot.create({
      data: {
        workspaceId: at.workspaceId,
        sourceId: csv.id,
        datasetId: file.id,
        status: 'succeeded',
        observedAt: new Date(),
        durationMs: 1,
        rowCount: 4,
        rowCountMethod: 'exact',
        metrics: profileMetrics({
          observedAt: new Date(),
          rowCount: 4,
          rowCountMethod: 'exact',
          columns: [{ name: 'city', type: 'text', nullCount: 1 }],
        }),
      },
    });
    const csvCheck = await check(
      { version: 1, type: 'not_null', column: 'city', maxNullPercent: 20 },
      'csv',
      file.id,
      csv.id,
    );
    await handleRunCheck(deps, csvCheck.job, { finalAttempt: false });
    const csvRun = await csvCheck.row();
    assert.equal(csvRun.status, 'failed');
    assert.deepEqual(csvRun.actual, { rowCount: 4, nullCount: 1, nullPercent: 25 });

    // Uniqueness: PostgreSQL groups in the database; CSV reads the file again.
    const pgUnique = await check(
      { version: 1, type: 'uniqueness', columns: ['email'] },
      'pg-unique',
    );
    await handleRunCheck(deps, pgUnique.job, { finalAttempt: false });
    assert.equal((await pgUnique.row()).status, 'passed');

    const body = Buffer.from(
      ['id,city', '1,Oslo', '2,Oslo', '1,Oslo', '3,', ''].join(String.fromCharCode(10)),
    );
    const upload = await prisma.upload.create({
      data: {
        workspaceId: at.workspaceId,
        sourceId: csv.id,
        datasetId: file.id,
        objectKey: `test/${randomUUID()}.csv`,
        filename: 'f.csv',
        sizeBytes: body.length,
        checksumSha256: createHash('sha256').update(body).digest('hex'),
        status: 'succeeded',
        createdByMembershipId: test.requestedByMembershipId,
        uploadUrlExpiresAt: new Date(),
        retainUntil: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.profileSnapshot.create({
      data: {
        workspaceId: at.workspaceId,
        sourceId: csv.id,
        datasetId: file.id,
        uploadId: upload.id,
        status: 'succeeded',
        observedAt: new Date(),
        durationMs: 1,
        rowCount: 4,
        rowCountMethod: 'exact',
        metrics: profileMetrics({
          observedAt: new Date(),
          rowCount: 4,
          rowCountMethod: 'exact',
          columns: [
            { name: 'id', type: 'integer', nullCount: 0 },
            { name: 'city', type: 'text', nullCount: 1 },
          ],
        }),
      },
    });
    const files = {
      ...deps,
      open: (key: string) =>
        Promise.resolve(key === upload.objectKey ? Readable.from([body]) : null),
    };
    const csvUnique = await check(
      { version: 1, type: 'uniqueness', columns: ['id', 'city'] },
      'csv-unique',
      file.id,
      csv.id,
    );
    await handleRunCheck(files, csvUnique.job, { finalAttempt: false });
    const unique = await csvUnique.row();
    assert.equal(unique.status, 'failed');
    assert.deepEqual(unique.actual, { rowCount: 4, duplicateRows: 1, duplicateKeys: 1 });
    assert.doesNotMatch(JSON.stringify(unique), /Oslo/);

    const pgRows = await check({ version: 1, type: 'row_count', minRows: 1 }, 'pg-rows');
    await handleRunCheck(deps, pgRows.job, { finalAttempt: false });
    assert.equal((await pgRows.row()).status, 'passed');
    const csvRows = await check(
      { version: 1, type: 'row_count', maxRows: 3 },
      'csv-rows',
      file.id,
      csv.id,
    );
    await handleRunCheck(deps, csvRows.job, { finalAttempt: false });
    const rowsRun = await csvRows.row();
    assert.equal(rowsRun.status, 'failed');
    assert.deepEqual(rowsRun.actual, { rowCount: 4, rowCountMethod: 'exact' });

    const pgRange = await check(
      { version: 1, type: 'range', column: 'created_at', min: '2000-01-01' },
      'pg-range',
    );
    await handleRunCheck(deps, pgRange.job, { finalAttempt: false });
    assert.equal((await pgRange.row()).status, 'passed');
    const csvRange = await check(
      { version: 1, type: 'range', column: 'id', min: 1, max: 2 },
      'csv-range',
      file.id,
      csv.id,
    );
    await handleRunCheck(files, csvRange.job, { finalAttempt: false });
    const rangeRun = await csvRange.row();
    assert.equal(rangeRun.status, 'failed');
    assert.deepEqual(rangeRun.actual, { valuesChecked: 4, belowMin: 0, aboveMax: 1 });
    const textRange = await check(
      { version: 1, type: 'range', column: 'city', min: 1 },
      'csv-text-range',
      file.id,
      csv.id,
    );
    await handleRunCheck(files, textRange.job, { finalAttempt: false });
    assert.equal(((await textRange.row()).error as { code: string }).code, 'unsupported');

    const pgSchema = await check(
      {
        version: 1,
        type: 'schema',
        requiredColumns: [{ name: 'email', type: 'text' }, { name: 'no_such_column' }],
      },
      'pg-schema',
    );
    await handleRunCheck(deps, pgSchema.job, { finalAttempt: false });
    const schemaRun = await pgSchema.row();
    assert.equal(schemaRun.status, 'failed');
    assert.deepEqual((schemaRun.actual as { missing: string[] }).missing, ['no_such_column']);
    const csvSchema = await check(
      { version: 1, type: 'schema', requiredColumns: [{ name: 'id' }] },
      'csv-schema',
      file.id,
      csv.id,
    );
    await handleRunCheck(deps, csvSchema.job, { finalAttempt: false });
    assert.equal((await csvSchema.row()).status, 'insufficient_data');

    // Metric change: three days of 100 rows, then 60 today.
    const trend = await prisma.dataset.create({
      data: { workspaceId: at.workspaceId, sourceId: csv.id, stableKey: 't', name: 't' },
    });
    const today = Date.now();
    for (const [daysAgo, rows] of [
      [3, 100],
      [2, 90],
      [1, 110],
      [0, 60],
      [9, 5],
    ] as const) {
      const observedAt = new Date(today - daysAgo * 86_400_000);
      await prisma.profileSnapshot.create({
        data: {
          workspaceId: at.workspaceId,
          sourceId: csv.id,
          datasetId: trend.id,
          status: 'succeeded',
          observedAt,
          durationMs: 1,
          rowCount: rows,
          rowCountMethod: 'exact',
          metrics: profileMetrics({
            observedAt,
            rowCount: rows,
            rowCountMethod: 'exact',
            columns: [],
          }),
        },
      });
    }
    const drop = await check(
      {
        version: 1,
        type: 'metric_change',
        metric: 'row_count',
        comparisonWindowDays: 7,
        maxDropPercent: 30,
        minimumHistoryPoints: 3,
      },
      'trend',
      trend.id,
      csv.id,
    );
    await handleRunCheck(deps, drop.job, { finalAttempt: false });
    const dropRun = await drop.row();
    assert.equal(dropRun.status, 'failed');
    const trendActual = dropRun.actual as {
      baseline: number;
      historyPoints: number;
      current: number;
    };
    assert.deepEqual(
      [trendActual.current, trendActual.baseline, trendActual.historyPoints],
      [60, 100, 3],
    );
    const tooShort = await check(
      {
        version: 1,
        type: 'metric_change',
        metric: 'row_count',
        comparisonWindowDays: 7,
        maxDropPercent: 30,
        minimumHistoryPoints: 4,
      },
      'trend-short',
      trend.id,
      csv.id,
    );
    await handleRunCheck(deps, tooShort.job, { finalAttempt: false });
    assert.equal((await tooShort.row()).status, 'insufficient_data');
  });
});
