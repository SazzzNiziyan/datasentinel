import { createPrismaClient, type PrismaClient } from '@datasentinel/db';
import { hashPassword } from '../auth/password.js';

export const MIN_PASSWORD_LENGTH = 12;

export type ResetPasswordResult = { reset: true } | { reset: false; reason: string };

/** Resets a user's password and revokes existing sessions for security. */
export async function resetPassword(
  prisma: PrismaClient,
  input: { email: string; password: string },
): Promise<ResetPasswordResult> {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return { reset: false, reason: 'password_too_short' };
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return { reset: false, reason: 'user_not_found' };
  }
  const passwordHash = await hashPassword(input.password);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    }),
    prisma.session.deleteMany({
      where: { userId: user.id },
    }),
  ]);
  return { reset: true };
}

/** `pnpm --filter @datasentinel/api user:reset-password` with USER_EMAIL and
 * USER_PASSWORD in the environment and DATABASE_URL pointing at the database. */
async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const { USER_EMAIL: email, USER_PASSWORD: password } = process.env;
  if (databaseUrl === '' || !email || !password) {
    console.error('Set DATABASE_URL, USER_EMAIL, and USER_PASSWORD first.');
    process.exitCode = 1;
    return;
  }
  const prisma = createPrismaClient(databaseUrl);
  try {
    const result = await resetPassword(prisma, { email, password });
    console.log(
      result.reset
        ? 'Password reset successfully. Active sessions revoked. You can sign in now.'
        : `Password not reset: ${result.reason}`,
    );
    if (!result.reset) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('reset-password.js')) {
  main().catch((err) => {
    console.error('user:reset-password failed:', err);
    process.exitCode = 1;
  });
}
