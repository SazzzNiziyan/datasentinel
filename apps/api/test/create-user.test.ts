import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { createUser } from '../src/ops/create-user.js';
import { databaseSkipReason, prisma } from './helpers.js';

const skip = await databaseSkipReason();

describe('first user bootstrap', { skip }, () => {
  const emails: string[] = [];
  after(async () => {
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
  });

  it('creates a user who can be found, and refuses weak or repeated input', async () => {
    const email = `boot-${randomUUID()}@test.example`;
    emails.push(email);
    const password = 'a long enough password';
    assert.deepEqual(await createUser(prisma, { email, displayName: 'Boot', password: 'short' }), {
      created: false,
      reason: 'password_too_short',
    });
    assert.deepEqual(await createUser(prisma, { email: 'nope', displayName: 'B', password }), {
      created: false,
      reason: 'invalid_email',
    });
    assert.deepEqual(
      await createUser(prisma, { email: email.toUpperCase(), displayName: 'Boot', password }),
      {
        created: true,
      },
    );
    assert.deepEqual(await createUser(prisma, { email, displayName: 'Other', password }), {
      created: false,
      reason: 'user_exists',
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    assert.equal(user.displayName, 'Boot');
    assert.notEqual(user.passwordHash, null);
    assert.equal(user.passwordHash?.includes(password), false);
  });
});
