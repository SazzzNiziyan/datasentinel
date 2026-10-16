/** Number of bytes in an encryption or signing key (256 bits). */
export const KEY_BYTES = 32;

/**
 * Decodes a base64 key from the environment, or returns undefined if the
 * value is not a valid base64 encoding of exactly KEY_BYTES bytes.
 *
 * Keys are generated with:
 *   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
 *
 * Never include the value in an error or log message.
 */
export function decodeKey(value: string): Buffer | undefined {
  const buffer = Buffer.from(value, 'base64');
  // Buffer.from skips characters outside base64 instead of failing, so a
  // quoted, padded, or mangled value would still decode. Re-encoding gives
  // the canonical form; accept only values that already are canonical.
  if (buffer.length !== KEY_BYTES || buffer.toString('base64') !== value) {
    return undefined;
  }
  return buffer;
}
