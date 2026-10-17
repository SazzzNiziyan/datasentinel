import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const CHUNK = 4 * 1024 * 1024;

/** SHA-256 of a file in lowercase hex, read 4 MB at a time so a large file
 * is never held in memory whole (Phase F gate). */
export async function hashFile(
  file: Blob,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    signal?.throwIfAborted();
    hash.update(new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer()));
    onProgress?.(Math.min(1, (offset + CHUNK) / file.size));
  }
  return bytesToHex(hash.digest());
}
