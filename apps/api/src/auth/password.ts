import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt with OWASP's recommended minimum cost (N=2^17, r=8, p=1). The
// parameters are stored with each hash, so they can be raised later and
// old hashes still verify (D-27).
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must exceed 128 * N * r bytes or Node refuses the cost.
    scrypt(password, salt, KEY_BYTES, { N: n, r, p, maxmem: 256 * n * r }, (error, key) =>
      error === null ? resolve(key) : reject(error),
    );
  });
}

/** Returns `scrypt$N=…,r=…,p=…$<salt>$<hash>` (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$N=${N},r=${R},p=${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const STORED = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

/** Constant-time comparison. A malformed or too-weak stored value is a
 * failed match, so a damaged row can never sign anyone in. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = STORED.exec(stored);
  if (match === null) return false;
  const [, n, r, p, salt, hash] = match;
  const cost = Number(n);
  if (cost < 2 ** 14 || (cost & (cost - 1)) !== 0) return false;
  const expected = Buffer.from(hash ?? '', 'base64');
  if (expected.length !== KEY_BYTES) return false;
  const actual = await derive(
    password,
    Buffer.from(salt ?? '', 'base64'),
    cost,
    Number(r),
    Number(p),
  );
  return timingSafeEqual(actual, expected);
}
