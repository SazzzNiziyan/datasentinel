import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', stored), true);
    assert.equal(await verifyPassword('correct horse battery stapler', stored), false);
  });

  it('salts every hash, so equal passwords give different hashes', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password'),
      hashPassword('same password'),
    ]);
    assert.notEqual(a, b);
    assert.match(a, /^scrypt\$N=131072,r=8,p=1\$/);
    assert.doesNotMatch(a, /same password/);
  });

  it('treats a malformed stored hash as a failed match, not an error', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
    assert.equal(await verifyPassword('anything', 'scrypt$N=1,r=8,p=1$AAAA$AAAA'), false);
  });
});
