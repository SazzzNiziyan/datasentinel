import {
  ConnectorFailure,
  credentialContext,
  openSecret,
  type KeyRing,
  type PostgresLocation,
  type PostgresLogin,
} from '@datasentinel/connectors';
import type { PrismaClient } from '@datasentinel/db';

/** A database source's settings and decrypted login, for one job only.
 * No credential is auth_failed; one this process cannot open (missing key,
 * damaged row) is invalid_config: a setup problem, not the source's. */
export async function loadPostgresAccess(
  prisma: PrismaClient,
  ring: KeyRing,
  workspaceId: string,
  sourceId: string,
): Promise<{ location: PostgresLocation; login: PostgresLogin }> {
  const source = await prisma.dataSource.findFirst({
    where: { id: sourceId, workspaceId, type: 'postgres', status: { not: 'archived' } },
    select: {
      settings: true,
      credentials: {
        where: { revokedAt: null },
        take: 1,
        select: { ciphertext: true, keyVersion: true },
      },
    },
  });
  if (source === null) throw new ConnectorFailure('not_found');
  const stored = source.credentials[0];
  if (stored === undefined) throw new ConnectorFailure('auth_failed');
  let login: Record<string, string>;
  try {
    login = openSecret(
      ring,
      { ciphertext: Buffer.from(stored.ciphertext), keyVersion: stored.keyVersion },
      credentialContext(workspaceId, sourceId),
    );
  } catch (cause) {
    throw new ConnectorFailure('invalid_config', { cause });
  }
  return {
    location: source.settings as unknown as PostgresLocation,
    login: { username: login.username ?? '', password: login.password ?? '' },
  };
}
