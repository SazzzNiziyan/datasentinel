import type { DiscoverTablesJobData, DiscoveryOutcome } from '@datasentinel/contracts';
import { ConnectorFailure, discoverTables, withPostgres } from '@datasentinel/connectors';
import { unlimitedSlots } from '../queue/source-slots.js';
import { loadPostgresAccess } from './postgres-access.js';
import type { TestConnectionDeps } from './test-connection.js';

/** Lists readable tables for the API, which waits for this answer (D-50).
 * Connector failures are the answer too; anything else is rethrown. */
export async function handleDiscoverTables(
  { prisma, ring, policy, timeoutMs = 15_000, slots = unlimitedSlots }: TestConnectionDeps,
  { workspaceId, sourceId }: DiscoverTablesJobData,
): Promise<DiscoveryOutcome> {
  try {
    const { location, login } = await loadPostgresAccess(prisma, ring, workspaceId, sourceId);
    const discovery = await slots.run(sourceId, () =>
      withPostgres(location, login, { policy, timeoutMs }, discoverTables),
    );
    return { ok: true, discovery };
  } catch (error) {
    if (error instanceof ConnectorFailure) return { ok: false, error: error.toJSON() };
    throw error;
  }
}
