import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  credentialContext,
  keyRing,
  openSecret,
  SecretUnavailable,
  sealSecret,
} from '@datasentinel/connectors';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const ringV1 = keyRing({ key: k1, version: 1 });
const ringV2 = keyRing({ key: k2, version: 2, previous: new Map([[1, k1]]) });
const context = credentialContext('ws-1', 'src-1');
const secret = { username: 'reader', password: 'p@ss w0rd' };

describe('source credential encryption', () => {
  it('round-trips with the current key and records its version', () => {
    const sealed = sealSecret(ringV2, secret, context);
    assert.equal(sealed.keyVersion, 2);
    assert.deepEqual(openSecret(ringV2, sealed, context), secret);
  });

  it('never stores the plaintext and differs on every seal', () => {
    const a = sealSecret(ringV1, secret, context);
    const b = sealSecret(ringV1, secret, context);
    assert.notDeepEqual(a.ciphertext, b.ciphertext);
    assert.equal(a.ciphertext.includes(Buffer.from('p@ss')), false);
  });

  it('opens secrets sealed with a previous key version', () => {
    const old = sealSecret(ringV1, secret, context);
    assert.deepEqual(openSecret(ringV2, old, context), secret);
  });

  it('refuses another source’s context, tampering, and unknown versions', () => {
    const sealed = sealSecret(ringV2, secret, context);
    const fails = (fn: () => unknown, reason: string) =>
      assert.throws(fn, (e: unknown) => e instanceof SecretUnavailable && e.reason === reason);

    fails(() => openSecret(ringV2, sealed, credentialContext('ws-1', 'src-2')), 'invalid');
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    fails(() => openSecret(ringV2, { ...sealed, ciphertext: tampered }, context), 'invalid');
    fails(() => openSecret(ringV1, sealed, context), 'unknown_key_version');
  });

  it('never puts key or secret material in its error text', () => {
    const sealed = sealSecret(ringV2, secret, context);
    try {
      openSecret(ringV2, sealed, credentialContext('x', 'y'));
      assert.fail('expected a failure');
    } catch (error) {
      const text = `${String(error)} ${JSON.stringify(error)}`;
      assert.doesNotMatch(text, /p@ss|reader/);
      assert.doesNotMatch(text, new RegExp(k2.toString('hex').slice(0, 16)));
    }
  });
});
