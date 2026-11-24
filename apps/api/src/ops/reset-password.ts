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
    return { reset: false, reason: `password_too_short (minimum ${MIN_PASSWORD_LENGTH} characters)` };
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const allUsers = await prisma.user.findMany({ select: { email: true } });
    const emails = allUsers.map((u) => u.email).join(', ');
    return {
      reset: false,
      reason: `user_not_found for "${email}". Available accounts: [${emails || 'no users found'}]`,
    };
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
  const email = process.env.USER_EMAIL;
  const password = process.env.USER_PASSWORD;

  if (!databaseUrl) {
    console.error('Error: DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }
  if (!email || !password) {
    console.error('Usage: Set USER_EMAIL and USER_PASSWORD in your environment first.');
    console.error('Example (PowerShell):');
    console.error('  $env:USER_EMAIL = "your-email@example.com"');
    console.error('  $env:USER_PASSWORD = "NewPassword1234!"');
    console.error('  pnpm --filter @datasentinel/api user:reset-password');
    process.exitCode = 1;
    return;
  }

  const prisma = createPrismaClient(databaseUrl);
  try {
    const result = await resetPassword(prisma, { email, password });
    if (result.reset) {
      console.log('✅ Password reset successfully! Active sessions revoked.');
      console.log(`You can now sign in at /sign-in with "${email}".`);
    } else {
      console.error(`❌ Password not reset: ${result.reason}`);
      process.exitCode = 1;
    }
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
