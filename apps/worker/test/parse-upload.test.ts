import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { handleParseUpload, type ObjectOpener } from '../src/jobs/parse-upload.js';
import { readMeasurements } from '../src/jobs/profile-metrics.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');

async function databaseSkipReason(): Promise<string | false> {
  if (databaseUrl === '') return 'DATABASE_URL is not set';
  try {
    await prisma.$queryRaw`SELECT 1`;
    return false;
  } catch {
    return 'local database is not running (pnpm services:up)';
  }
}

const skip = await databaseSkipReason();

/** Storage stand-in: objects by key; `broken` throws like a network fault. */
function storage(objects: Map<string, Buffer>, broken = false): ObjectOpener {
  return (key) => {
    if (broken) return Promise.reject(new Error('connection reset by storage.internal:9000'));
    const body = objects.get(key);
    if (body === undefined) return Promise.resolve(null);
    return Promise.resolve(
      (async function* () {
        await Promise.resolve();
        yield body;
      })(),
    );
  };
}

describe('parse-upload job', { skip }, () => {
  const workspaces: string[] = [];
  const users: string[] = [];

  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  /** A queued upload of `content` and the storage holding it. */
  async function queued(content: string) {
    const user = await prisma.user.create({
      data: { email: `worker-${randomUUID()}@test.example`, displayName: 'W' },
    });
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'W', slug: `w-${randomUUID()}` } });
    workspaces.push(w.id);
    const m = await prisma.membership.create({
      data: { workspaceId: w.id, userId: user.id, role: 'engineer' },
    });
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'files', type: 'csv' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'd', name: 'D' },
    });
    const body = Buffer.from(content);
    const objectKey = `workspaces/${w.id}/uploads/${randomUUID()}`;
    const upload = await prisma.upload.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        objectKey,
        filename: 'f.csv',
        sizeBytes: body.length,
        checksumSha256: createHash('sha256').update(body).digest('hex'),
        status: 'queued',
        completedAt: new Date(),
        createdByMembershipId: m.id,
        uploadUrlExpiresAt: new Date(),
        retainUntil: new Date(Date.now() + 86_400_000),
      },
    });
    return {
      job: { workspaceId: w.id, uploadId: upload.id },
      objects: new Map([[objectKey, body]]),
      row: () => prisma.upload.findUniqueOrThrow({ where: { id: upload.id } }),
    };
  }

  it('parses a good file and records its counts', async () => {
    const u = await queued('id,name\n1,Ada\n2,Grace\n');
    await handleParseUpload({ prisma, open: storage(u.objects) }, u.job, { finalAttempt: false });
    const row = await u.row();
    assert.equal(row.status, 'succeeded');
    assert.equal(row.rowCount, 2);
    assert.equal(row.columnCount, 2);
    assert.equal(row.error, null);

    const profile = await prisma.profileSnapshot.findFirstOrThrow({
      where: { uploadId: u.job.uploadId },
      include: { schema: true },
    });
    assert.equal(profile.status, 'succeeded');
    assert.equal(profile.rowCount, 2n);
    assert.equal(profile.rowCountMethod, 'exact');
    assert.equal(profile.datasetId, row.datasetId);
    assert.deepEqual(profile.lastUpdatedAt, row.completedAt);
    assert.deepEqual((profile.metrics as { columns: unknown }).columns, [
      { name: 'id', type: 'integer', nullCount: 0 },
      { name: 'name', type: 'text', nullCount: 0 },
    ]);
    const at = profile.observedAt.toISOString();
    assert.deepEqual(readMeasurements(profile.metrics), [
      { metric: 'row_count', column: null, value: 2, method: 'exact', observedAt: at },
      { metric: 'null_count', column: 'id', value: 0, method: 'exact', observedAt: at },
      { metric: 'null_count', column: 'name', value: 0, method: 'exact', observedAt: at },
    ]);
    assert.deepEqual(profile.schema?.columns, [
      { name: 'id', type: 'integer', nullable: false, ordinal: 1 },
      { name: 'name', type: 'text', nullable: false, ordinal: 2 },
    ]);
    assert.match(profile.schema?.schemaHash ?? '', /^[0-9a-f]{64}$/);
    // History is append-only.
    await assert.rejects(
      prisma.profileSnapshot.update({ where: { id: profile.id }, data: { durationMs: 1 } }),
    );
  });

  it('gives the same schema hash to the same columns, and a new one on drift', async () => {
    const hashOf = async (content: string) => {
      const u = await queued(content);
      await handleParseUpload({ prisma, open: storage(u.objects) }, u.job, { finalAttempt: false });
      const s = await prisma.schemaSnapshot.findFirstOrThrow({
        where: { profile: { uploadId: u.job.uploadId } },
      });
      return s.schemaHash;
    };
    const first = await hashOf('id,name\n1,Ada\n');
    assert.equal(await hashOf('id,name\n7,Grace\n8,\n'), first);
    assert.notEqual(await hashOf('id,name,city\n1,Ada,X\n'), first);
    assert.notEqual(await hashOf('id,name\nA1,Ada\n'), first);
  });

  it('fails a bad file with a safe message and does not retry', async () => {
    const u = await queued('id,name\n1\n');
    await handleParseUpload({ prisma, open: storage(u.objects) }, u.job, { finalAttempt: false });
    const row = await u.row();
    assert.equal(row.status, 'failed');
    assert.deepEqual(row.error, {
      code: 'malformed',
      message: 'Line 2 has 1 value; the header has 2.',
      hint: 'Fix the file and upload it again.',
      retryable: false,
    });
    // FR-04: the failed attempt is history too, not a zero-row profile.
    const profile = await prisma.profileSnapshot.findFirstOrThrow({
      where: { uploadId: u.job.uploadId },
      include: { schema: true },
    });
    assert.equal(profile.status, 'failed');
    assert.equal(profile.rowCount, null);
    assert.deepEqual(profile.error, row.error);
    assert.equal(profile.schema, null);
  });

  it('fails when the stored object is gone', async () => {
    const u = await queued('a\n1\n');
    await handleParseUpload({ prisma, open: storage(new Map()) }, u.job, { finalAttempt: false });
    const row = await u.row();
    assert.equal(row.status, 'failed');
    assert.equal((row.error as { code: string }).code, 'not_found');
  });

  it('rethrows storage faults for a retry, and fails safely on the last attempt', async () => {
    const u = await queued('a\n1\n');
    const deps = { prisma, open: storage(u.objects, true) };
    await assert.rejects(handleParseUpload(deps, u.job, { finalAttempt: false }));
    assert.equal((await u.row()).status, 'parsing');
    const profiles = () => prisma.profileSnapshot.count({ where: { uploadId: u.job.uploadId } });
    assert.equal(await profiles(), 0);

    await assert.rejects(handleParseUpload(deps, u.job, { finalAttempt: true }));
    const row = await u.row();
    assert.equal(row.status, 'failed');
    assert.equal((row.error as { code: string }).code, 'internal');
    assert.doesNotMatch(JSON.stringify(row.error), /storage\.internal/);
    assert.equal(await profiles(), 1);
  });

  it('ignores uploads that are finished or in another workspace', async () => {
    const u = await queued('a\n1\n');
    const deps = { prisma, open: storage(u.objects) };
    await handleParseUpload(deps, { ...u.job, workspaceId: randomUUID() }, { finalAttempt: false });
    assert.equal((await u.row()).status, 'queued');

    await handleParseUpload(deps, u.job, { finalAttempt: false });
    await prisma.upload.update({ where: { id: u.job.uploadId }, data: { rowCount: 99 } });
    await handleParseUpload(deps, u.job, { finalAttempt: false });
    assert.equal((await u.row()).rowCount, 99);
  });
});
