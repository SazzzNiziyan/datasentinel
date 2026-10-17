import { credentialContext, keyRing, openSecret, sealSecret } from '@datasentinel/connectors';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { rewrapCredentials } from '../src/credentials/credentials.js';
import { databaseSkipReason, prisma } from './helpers.js';

const skip = await databaseSkipReason();

describe('credential key rotation', { skip }, () => {
  const workspaces: string[] = [];
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
  });

  it('re-encrypts old-version credentials with the current key and leaves revoked ones', async () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    // A unique version keeps other rows in the shared database out of this run.
    const v1 = 1_000_000 + Math.floor(Math.random() * 1_000_000);
    const oldRing = keyRing({ key: k1, version: v1 });
    const newRing = keyRing({ key: k2, version: v1 + 1, previous: new Map([[v1, k1]]) });

    const w = await prisma.workspace.create({ data: { name: 'K', slug: `k-${randomUUID()}` } });
    workspaces.push(w.id);
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'pg', type: 'postgres' },
    });
    const context = credentialContext(w.id, source.id);
    const secret = { username: 'reader', password: 'hunter2' };
    const store = async (revoked: boolean) => {
      const sealed = sealSecret(oldRing, secret, context);
      return prisma.sourceCredential.create({
        data: {
          workspaceId: w.id,
          sourceId: source.id,
          ciphertext: new Uint8Array(sealed.ciphertext),
          keyVersion: sealed.keyVersion,
          revokedAt: revoked ? new Date() : null,
        },
      });
    };
    const revoked = await store(true);
    const active = await store(false);

    // Rows from other tests use other versions: they count as failed, untouched.
    const result = await rewrapCredentials(prisma, newRing);
    assert.ok(result.rewrapped >= 1);

    const after = await prisma.sourceCredential.findUniqueOrThrow({ where: { id: active.id } });
    assert.equal(after.keyVersion, v1 + 1);
    const opened = openSecret(
      keyRing({ key: k2, version: v1 + 1 }),
      { ciphertext: Buffer.from(after.ciphertext), keyVersion: after.keyVersion },
      context,
    );
    assert.deepEqual(opened, secret);
    const untouched = await prisma.sourceCredential.findUniqueOrThrow({
      where: { id: revoked.id },
    });
    assert.equal(untouched.keyVersion, v1);

    // Running it again finds nothing of ours to do.
    const again = await rewrapCredentials(prisma, newRing);
    assert.equal(
      (await prisma.sourceCredential.findUniqueOrThrow({ where: { id: active.id } })).keyVersion,
      v1 + 1,
    );
    assert.ok(again.rewrapped >= 0);
  });
});
