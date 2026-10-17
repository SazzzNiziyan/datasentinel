import type { TestConnectionJobData, UploadFailure } from '@datasentinel/contracts';
import {
  ConnectorFailure,
  testPostgresConnection,
  type KeyRing,
  type NetworkPolicy,
} from '@datasentinel/connectors';
import type { PrismaClient } from '@datasentinel/db';
import { unlimitedSlots, type SourceSlots } from '../queue/source-slots.js';
import { loadPostgresAccess } from './postgres-access.js';
import type { ObjectOpener } from './parse-upload.js';

export interface TestConnectionDeps {
  prisma: PrismaClient;
  ring: KeyRing;
  policy: NetworkPolicy;
  /** Tests shorten it; connection tests otherwise get 10 s (D-49). */
  timeoutMs?: number;
  /** Per-source session cap (D-54); none when omitted. */
  slots?: SourceSlots;
  /** Reads uploaded files, for checks that scan a CSV again (D-61). */
  open?: ObjectOpener;
}

/** Runs one connection test (D-49). Connector failures are the answer and
 * are stored as such; anything else (database, Redis) is rethrown, and
 * the last attempt stores a generic failure. Only a queued test runs. */
export async function handleTestConnection(
  { prisma, ring, policy, timeoutMs = 10_000, slots = unlimitedSlots }: TestConnectionDeps,
  { workspaceId, connectionTestId }: TestConnectionJobData,
  { finalAttempt, signal }: { finalAttempt: boolean; signal?: AbortSignal },
): Promise<void> {
  const claimed = await prisma.connectionTest.updateMany({
    where: { id: connectionTestId, workspaceId, status: { in: ['queued', 'running'] } },
    data: { status: 'running' },
  });
  if (claimed.count === 0) return;
  const finish = (data: {
    status: 'succeeded' | 'failed';
    error?: UploadFailure;
    serverVersion?: string;
    latencyMs?: number;
  }) =>
    prisma.connectionTest.updateMany({
      where: { id: connectionTestId, workspaceId, status: 'running' },
      data: { ...data, error: data.error && { ...data.error }, finishedAt: new Date() },
    });

  try {
    const test = await prisma.connectionTest.findFirstOrThrow({
      where: { id: connectionTestId, workspaceId },
      select: { sourceId: true },
    });
    const { location, login } = await loadPostgresAccess(prisma, ring, workspaceId, test.sourceId);
    const result = await slots.run(test.sourceId, () =>
      testPostgresConnection(location, login, { policy, signal, timeoutMs }),
    );
    await prisma.$transaction([
      prisma.connectionTest.updateMany({
        where: { id: connectionTestId, workspaceId, status: 'running' },
        data: {
          status: 'succeeded',
          serverVersion: result.serverVersion,
          latencyMs: result.latencyMs,
          finishedAt: new Date(),
        },
      }),
      prisma.dataSource.updateMany({
        where: { id: test.sourceId, workspaceId },
        data: { lastCheckedAt: new Date() },
      }),
    ]);
  } catch (error) {
    if (error instanceof ConnectorFailure) {
      await finish({ status: 'failed', error: error.toJSON() });
      return;
    }
    if (finalAttempt)
      await finish({ status: 'failed', error: new ConnectorFailure('internal').toJSON() });
    throw error;
  }
}
