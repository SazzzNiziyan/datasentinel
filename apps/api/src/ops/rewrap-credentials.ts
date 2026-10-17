import { ConfigError, loadWorkerEnv } from '@datasentinel/config';
import { createPrismaClient } from '@datasentinel/db';
import { credentialKeyRing, rewrapCredentials } from '../credentials/credentials.js';

/** `pnpm --filter @datasentinel/api credentials:rewrap` after setting a new
 * SECRETS_ENCRYPTION_KEY (and its version) and moving the old key into
 * SECRETS_ENCRYPTION_PREVIOUS_KEYS. When it reports 0 failed, the old key
 * can be removed (D-46). Prints counts only. */
async function main() {
  const env = loadWorkerEnv();
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    const { rewrapped, failed } = await rewrapCredentials(prisma, credentialKeyRing(env));
    console.log(
      `Re-encrypted ${rewrapped} credential(s) with key version ${env.SECRETS_ENCRYPTION_KEY_VERSION}; ${failed} could not be opened.`,
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : 'credentials:rewrap failed');
  process.exitCode = 1;
});
