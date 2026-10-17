import type { ProfileDatasetJobData } from '@datasentinel/contracts';
import { ConnectorFailure, profilePostgresTable, withPostgres } from '@datasentinel/connectors';
import { schemaHash } from './parse-upload.js';
import { unlimitedSlots } from '../queue/source-slots.js';
import { loadPostgresAccess } from './postgres-access.js';
import { profileMetrics } from './profile-metrics.js';
import type { TestConnectionDeps } from './test-connection.js';

/** Profiles one database dataset (D-52) and appends its profile and schema
 * snapshots. A connector failure is recorded as a failed profile, never as
 * zero rows (FR-04); other errors are rethrown for the queue's retry, and
 * the last attempt records a generic failure. */
export async function handleProfileDataset(
  { prisma, ring, policy, timeoutMs = 30_000, slots = unlimitedSlots }: TestConnectionDeps,
  { workspaceId, datasetId }: ProfileDatasetJobData,
  { finalAttempt }: { finalAttempt: boolean },
): Promise<void> {
  const dataset = await prisma.dataset.findFirst({
    where: {
      id: datasetId,
      workspaceId,
      status: { not: 'archived' },
      source: { type: 'postgres' },
    },
    select: { sourceId: true, locator: true },
  });
  if (dataset === null) return;
  const at = { workspaceId, sourceId: dataset.sourceId, datasetId };
  const started = Date.now();
  const failed = (error: ConnectorFailure) =>
    prisma.profileSnapshot.create({
      data: {
        ...at,
        status: 'failed',
        observedAt: new Date(),
        durationMs: Date.now() - started,
        error: { ...error.toJSON() },
      },
    });

  try {
    const locator = dataset.locator as { schema?: unknown; table?: unknown };
    if (typeof locator.schema !== 'string' || typeof locator.table !== 'string') {
      throw new ConnectorFailure('invalid_config');
    }
    const target = { schema: locator.schema, table: locator.table };
    const { location, login } = await loadPostgresAccess(
      prisma,
      ring,
      workspaceId,
      dataset.sourceId,
    );
    const profile = await slots.run(dataset.sourceId, () =>
      withPostgres(location, login, { policy, timeoutMs }, (client) =>
        profilePostgresTable(client, target),
      ),
    );
    const observedAt = new Date();
    await prisma.$transaction(async (tx) => {
      const snapshot = await tx.profileSnapshot.create({
        data: {
          ...at,
          status: 'succeeded',
          observedAt,
          durationMs: Date.now() - started,
          rowCount: profile.rowCount,
          rowCountMethod: profile.rowCountMethod,
          metrics: profileMetrics({
            observedAt,
            rowCount: profile.rowCount,
            rowCountMethod: profile.rowCountMethod,
            columns: profile.columns.map((c) => ({
              name: c.name,
              type: c.type,
              nativeType: c.nativeType,
              nullCount: c.nullCount,
            })),
          }),
        },
        select: { id: true },
      });
      await tx.schemaSnapshot.create({
        data: {
          ...at,
          profileSnapshotId: snapshot.id,
          observedAt,
          rowCount: profile.rowCount,
          schemaHash: schemaHash(profile.columns),
          columns: profile.columns.map((c, i) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            ordinal: i + 1,
          })),
        },
      });
      await tx.dataSource.updateMany({
        where: { id: dataset.sourceId, workspaceId },
        data: { lastCheckedAt: observedAt },
      });
    });
  } catch (error) {
    // A busy source is not the source's fault: let the queue try later.
    if (error instanceof ConnectorFailure && error.code === 'busy' && !finalAttempt) {
      throw new Error('source busy, retrying later', { cause: error });
    }
    if (error instanceof ConnectorFailure) {
      await failed(error);
      return;
    }
    if (finalAttempt) await failed(new ConnectorFailure('internal'));
    throw error;
  }
}
