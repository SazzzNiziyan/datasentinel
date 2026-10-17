import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

// Models, enums, and the Prisma namespace for API and worker code.
export * from './generated/client.js';
export * from './documents.js';
export * from './outbox.js';

/** One client per process. Query logging stays off: queries can carry
 * user data, and docs/03 keeps secrets out of Prisma query logs. */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  // DB_POOL_MAX caps connections per client (default 10) for hosts with a low
  // connection limit, such as a free database plan.
  const max = Number.parseInt(process.env['DB_POOL_MAX'] ?? '', 10);
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseUrl,
      ...(Number.isInteger(max) && max > 0 ? { max } : {}),
    }),
  });
}
