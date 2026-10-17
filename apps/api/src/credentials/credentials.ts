import type { ServerEnv } from '@datasentinel/config';
import {
  credentialContext,
  destinationContext,
  keyRing,
  openSecret,
  sealSecret,
  type KeyRing,
  type NetworkPolicy,
} from '@datasentinel/connectors';
import type { PrismaClient } from '@datasentinel/db';
import { recordAudit } from '../audit/audit.js';

/** The process's keys (D-46): the current one seals, older ones only open. */
export function credentialKeyRing(
  env: Pick<
    ServerEnv,
    'SECRETS_ENCRYPTION_KEY' | 'SECRETS_ENCRYPTION_KEY_VERSION' | 'SECRETS_ENCRYPTION_PREVIOUS_KEYS'
  >,
): KeyRing {
  return keyRing({
    key: env.SECRETS_ENCRYPTION_KEY,
    version: env.SECRETS_ENCRYPTION_KEY_VERSION,
    previous: env.SECRETS_ENCRYPTION_PREVIOUS_KEYS,
  });
}

/** Re-encrypts every active credential that is not on the current key
 * version, one row at a time, so a retired key can be removed afterwards.
 * Rows that cannot be opened are counted and left alone; the secret itself
 * never leaves this function. Safe to run again. */
export async function rewrapCredentials(
  prisma: PrismaClient,
  ring: KeyRing,
): Promise<{ rewrapped: number; failed: number }> {
  let rewrapped = 0;
  let failed = 0;
  const rows = await prisma.sourceCredential.findMany({
    where: { revokedAt: null, keyVersion: { not: ring.version } },
    select: { id: true, workspaceId: true, sourceId: true, ciphertext: true, keyVersion: true },
  });
  for (const row of rows) {
    const context = credentialContext(row.workspaceId, row.sourceId);
    let sealed;
    try {
      const value = openSecret(
        ring,
        { ciphertext: Buffer.from(row.ciphertext), keyVersion: row.keyVersion },
        context,
      );
      sealed = sealSecret(ring, value, context);
    } catch {
      failed += 1;
      continue;
    }
    // Only if unchanged since it was read, so a concurrent rotation wins.
    const changed = await prisma.sourceCredential.updateMany({
      where: { id: row.id, keyVersion: row.keyVersion, revokedAt: null },
      data: { ciphertext: new Uint8Array(sealed.ciphertext), keyVersion: sealed.keyVersion },
    });
    rewrapped += changed.count;
  }
  // Alert destination secrets follow the same key rotation (D-94).
  const destinations = await prisma.destination.findMany({
    where: {
      ciphertext: { not: null },
      keyVersion: { not: ring.version },
      status: { not: 'archived' },
    },
    select: { id: true, workspaceId: true, ciphertext: true, keyVersion: true },
  });
  for (const row of destinations) {
    if (row.ciphertext === null || row.keyVersion === null) continue;
    const context = destinationContext(row.workspaceId, row.id);
    let sealed;
    try {
      const value = openSecret(
        ring,
        { ciphertext: Buffer.from(row.ciphertext), keyVersion: row.keyVersion },
        context,
      );
      sealed = sealSecret(ring, value, context);
    } catch {
      failed += 1;
      continue;
    }
    const changed = await prisma.destination.updateMany({
      where: { id: row.id, keyVersion: row.keyVersion, status: { not: 'archived' } },
      data: { ciphertext: new Uint8Array(sealed.ciphertext), keyVersion: sealed.keyVersion },
    });
    rewrapped += changed.count;
  }
  await recordAudit(prisma, {
    action: 'credentials.rewrapped',
    actor: { type: 'system' },
    summary: { after: { keyVersion: ring.version, rewrapped, failed } },
  });
  return { rewrapped, failed };
}

/** Keys and destination policy for source routes; tests replace it. */
export interface SourceSecurity {
  ring: KeyRing;
  networkPolicy: NetworkPolicy;
  /** Optional alert destinations enabled in this deployment (D-96). */
  features: { github: boolean; n8n: boolean };
}

export const SOURCE_SECURITY = Symbol('SOURCE_SECURITY');

/** SourceSecurity that loads its settings when first read, so the API
 * starts (and tests run) without them until a source route needs them. */
export function lazySourceSecurity(load: () => ServerEnv): SourceSecurity {
  let loaded: SourceSecurity | undefined;
  const get = () =>
    (loaded ??= (() => {
      const env = load();
      return {
        ring: credentialKeyRing(env),
        networkPolicy: env.SOURCE_NETWORK_POLICY,
        features: { github: env.FEATURE_DESTINATION_GITHUB, n8n: env.FEATURE_DESTINATION_N8N },
      };
    })());
  return {
    get ring() {
      return get().ring;
    },
    get networkPolicy() {
      return get().networkPolicy;
    },
    get features() {
      return get().features;
    },
  };
}
