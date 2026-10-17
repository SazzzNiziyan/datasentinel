import type { ParseUploadJobData, UploadFailure } from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import { createHash } from 'node:crypto';
import { CsvRejection, scanCsv, type CsvSummary } from '../csv/scan-csv.js';

/** Opens a stored object as a byte stream; null when it does not exist. */
export type ObjectOpener = (
  key: string,
  signal?: AbortSignal,
) => Promise<AsyncIterable<Uint8Array> | null>;

export interface ParseUploadDeps {
  prisma: PrismaClient;
  open: ObjectOpener;
}

const missing: UploadFailure = {
  code: 'not_found',
  message: 'The uploaded file is no longer in storage.',
  hint: 'Start a new upload.',
  retryable: false,
};

const internal: UploadFailure = {
  code: 'internal',
  message: 'DataSentinel could not read the uploaded file.',
  hint: 'Try the upload again later. If it keeps failing, contact support.',
  retryable: true,
};

/** Equal for the same column names, types, and order (D-43). */
export function schemaHash(columns: CsvSummary['columns']): string {
  return createHash('sha256')
    .update(JSON.stringify(columns.map((c) => [c.name, c.type])))
    .digest('hex');
}

/** Checks and profiles one completed upload (D-42, D-43). A bad file fails
 * at once with a safe message; storage or database faults are rethrown so
 * the queue retries, and the last attempt records a generic failure. Every
 * outcome also lands in the dataset's profile history, and a success in its
 * schema history. Repeats are harmless: only queued uploads, or ones left
 * in parsing by a crash, are picked up. */
export async function handleParseUpload(
  { prisma, open }: ParseUploadDeps,
  { workspaceId, uploadId }: ParseUploadJobData,
  { finalAttempt, signal }: { finalAttempt: boolean; signal?: AbortSignal },
): Promise<void> {
  const claimed = await prisma.upload.updateMany({
    where: { id: uploadId, workspaceId, status: { in: ['queued', 'parsing'] } },
    data: { status: 'parsing' },
  });
  if (claimed.count === 0) return;
  const upload = await prisma.upload.findFirstOrThrow({
    where: { id: uploadId, workspaceId },
    select: {
      objectKey: true,
      sizeBytes: true,
      checksumSha256: true,
      sourceId: true,
      datasetId: true,
      completedAt: true,
    },
  });
  const started = Date.now();

  /** Ends the upload and records the profile in one transaction; skipped
   * if another run already ended it. */
  const finish = (outcome: { summary: CsvSummary } | { error: UploadFailure }) =>
    prisma.$transaction(async (tx) => {
      const ended = await tx.upload.updateMany({
        where: { id: uploadId, workspaceId, status: 'parsing' },
        data:
          'summary' in outcome
            ? {
                status: 'succeeded',
                rowCount: outcome.summary.rowCount,
                columnCount: outcome.summary.columns.length,
              }
            : { status: 'failed', error: { ...outcome.error } },
      });
      // Completion always sets the dataset; without one there is no history.
      if (ended.count === 0 || upload.datasetId === null) return;
      const at = { workspaceId, sourceId: upload.sourceId, datasetId: upload.datasetId };
      const observedAt = new Date();
      const durationMs = Date.now() - started;
      if (!('summary' in outcome)) {
        await tx.profileSnapshot.create({
          data: {
            ...at,
            uploadId,
            status: 'failed',
            observedAt,
            durationMs,
            error: { ...outcome.error },
          },
        });
        return;
      }
      const { columns, rowCount } = outcome.summary;
      const profile = await tx.profileSnapshot.create({
        data: {
          ...at,
          uploadId,
          status: 'succeeded',
          observedAt,
          durationMs,
          rowCount,
          rowCountMethod: 'exact',
          lastUpdatedAt: upload.completedAt,
          metrics: { columns: columns.map((c) => ({ ...c })) },
        },
        select: { id: true },
      });
      await tx.schemaSnapshot.create({
        data: {
          ...at,
          profileSnapshotId: profile.id,
          observedAt,
          rowCount,
          schemaHash: schemaHash(columns),
          columns: columns.map((c, i) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullCount > 0,
            ordinal: i + 1,
          })),
        },
      });
    });

  try {
    const body = await open(upload.objectKey, signal);
    if (body === null) {
      await finish({ error: missing });
      return;
    }
    const summary = await scanCsv(body, {
      sizeBytes: upload.sizeBytes,
      sha256: upload.checksumSha256,
      signal,
    });
    await finish({ summary });
  } catch (error) {
    if (error instanceof CsvRejection) {
      await finish({ error: error.toJSON() });
      return;
    }
    if (finalAttempt) await finish({ error: internal });
    throw error;
  }
}
