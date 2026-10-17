import { createPrismaClient, type PrismaClient } from '@datasentinel/db';
import { hashPassword } from '../auth/password.js';

export const MIN_PASSWORD_LENGTH = 12;

export type CreateUserResult = { created: true } | { created: false; reason: string };

/** Creates a user who can sign in with a password. There is no sign-up page
 * (accounts come from invitations, Google or GitHub), so this is how the
 * first person gets in. It never changes an existing account. */
export async function createUser(
  prisma: PrismaClient,
  input: { email: string; displayName: string; password: string },
): Promise<CreateUserResult> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { created: false, reason: 'invalid_email' };
  if (displayName === '') return { created: false, reason: 'name_required' };
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return { created: false, reason: 'password_too_short' };
  }
  if ((await prisma.user.findUnique({ where: { email } })) !== null) {
    return { created: false, reason: 'user_exists' };
  }
  await prisma.user.create({
    data: { email, displayName, passwordHash: await hashPassword(input.password) },
  });
  return { created: true };
}

/** `pnpm --filter @datasentinel/api user:create` with USER_EMAIL, USER_NAME and
 * USER_PASSWORD in the environment (never as arguments, which shells keep in
 * history) and DATABASE_URL pointing at the database to add the user to. Prints
 * the outcome only, never the password. */
async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const { USER_EMAIL: email, USER_NAME: name, USER_PASSWORD: password } = process.env;
  if (databaseUrl === '' || !email || !name || !password) {
    console.error('Set DATABASE_URL, USER_EMAIL, USER_NAME and USER_PASSWORD first.');
    process.exitCode = 1;
    return;
  }
  const prisma = createPrismaClient(databaseUrl);
  try {
    const result = await createUser(prisma, { email, displayName: name, password });
    console.log(
      result.created ? 'User created. They can sign in now.' : `Not created: ${result.reason}`,
    );
    if (!result.created) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Runs only when started directly, not when the tests import createUser.
if (process.argv[1]?.endsWith('create-user.js')) {
  main().catch(() => {
    console.error('user:create failed');
    process.exitCode = 1;
  });
}
