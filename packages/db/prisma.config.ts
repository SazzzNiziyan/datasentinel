// Prisma CLI configuration (Prisma 7: the database URL lives here, not in
// the schema). Loads the root .env so `prisma migrate dev` finds DATABASE_URL.
import { existsSync } from 'node:fs';
import { defineConfig, env } from 'prisma/config';

if (existsSync('../../.env')) process.loadEnvFile('../../.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Migrations may need a direct (unpooled) connection, as on Neon.
  datasource: { url: process.env['DIRECT_DATABASE_URL'] ?? env('DATABASE_URL') },
});
