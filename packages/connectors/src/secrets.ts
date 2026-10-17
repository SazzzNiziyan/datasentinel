/**
 * Encryption for stored source credentials (docs/05 §3, D-46). AES-256-GCM
 * with a random 96-bit IV per secret. The key version is stored next to
 * the ciphertext, so keys can rotate: the current key seals, older keys
 * only open. Ciphertext is bound to its workspace and source (GCM
 * additional data), so a row copied to another source does not open.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Blob layout: format byte, IV, ciphertext, auth tag. */
const FORMAT = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface KeyRing {
  readonly version: number;
  /** Version to key; includes the current one. */
  readonly keys: ReadonlyMap<number, Buffer>;
}

export function keyRing({
  key,
  version,
  previous = new Map(),
}: {
  key: Buffer;
  version: number;
  previous?: ReadonlyMap<number, Buffer>;
}): KeyRing {
  return { version, keys: new Map([...previous, [version, key]]) };
}

/** Stored as `source_credentials.ciphertext` and `key_version`. */
export interface SealedSecret {
  ciphertext: Buffer;
  keyVersion: number;
}

/** The additional data a source's credential is bound to. */
export const credentialContext = (workspaceId: string, sourceId: string): string =>
  `datasentinel/source-credential/v1/${workspaceId}/${sourceId}`;

/** The additional data an alert destination's secret is bound to (D-88). */
export const destinationContext = (workspaceId: string, destinationId: string): string =>
  `datasentinel/destination-secret/v1/${workspaceId}/${destinationId}`;

/** A secret that cannot be opened. Says why, never what. */
export class SecretUnavailable extends Error {
  readonly reason: 'unknown_key_version' | 'invalid';

  constructor(reason: 'unknown_key_version' | 'invalid') {
    super(
      reason === 'unknown_key_version'
        ? 'The stored secret uses a key version this process does not have.'
        : 'The stored secret could not be decrypted.',
    );
    this.name = 'SecretUnavailable';
    this.reason = reason;
  }
}

export function sealSecret(
  ring: KeyRing,
  value: Record<string, string>,
  context: string,
): SealedSecret {
  const key = ring.keys.get(ring.version);
  if (key === undefined) throw new SecretUnavailable('unknown_key_version');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([Buffer.from([FORMAT]), iv, body, cipher.getAuthTag()]),
    keyVersion: ring.version,
  };
}

export function openSecret(
  ring: KeyRing,
  { ciphertext, keyVersion }: SealedSecret,
  context: string,
): Record<string, string> {
  const key = ring.keys.get(keyVersion);
  if (key === undefined) throw new SecretUnavailable('unknown_key_version');
  if (ciphertext.length < 1 + IV_BYTES + TAG_BYTES || ciphertext[0] !== FORMAT) {
    throw new SecretUnavailable('invalid');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(1, 1 + IV_BYTES));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(ciphertext.subarray(1 + IV_BYTES, ciphertext.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    const value: unknown = JSON.parse(plain);
    if (
      typeof value !== 'object' ||
      value === null ||
      Object.values(value).some((v) => typeof v !== 'string')
    ) {
      throw new Error('not a string map');
    }
    return value as Record<string, string>;
  } catch {
    // The cause can hold decrypted fragments; it is dropped on purpose.
    throw new SecretUnavailable('invalid');
  }
}
