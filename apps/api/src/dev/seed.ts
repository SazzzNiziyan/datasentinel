// Development seed: fake accounts and workspaces only (roadmap Phase E).
// Run after `pnpm build`: pnpm --filter @datasentinel/api seed
// Safe to run repeatedly; it updates the same records.
import { createPrismaClient, type Role } from '@datasentinel/db';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/password.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const databaseUrl = process.env.DATABASE_URL ?? '';
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed: NODE_ENV is production.');
}
if (!LOCAL_HOSTS.has(URL.parse(databaseUrl)?.hostname ?? '')) {
  throw new Error('Refusing to seed: DATABASE_URL does not point at a local database.');
}

// Every account shares one password: SEED_PASSWORD, or a new random one
// printed once below. .example addresses can never receive real mail.
const password = process.env.SEED_PASSWORD ?? randomBytes(12).toString('base64url');

const workspaces = [
  { slug: 'northwind-sample', name: 'Northwind Retail (sample)', timezone: 'Europe/Berlin' },
  { slug: 'contoso-sample', name: 'Contoso Logistics (sample)', timezone: 'America/New_York' },
] as const;

const people: { email: string; name: string; workspace: string; role: Role }[] = [
  {
    email: 'lena@northwind.example',
    name: 'Lena Fischer',
    workspace: 'northwind-sample',
    role: 'owner',
  },
  {
    email: 'ana@northwind.example',
    name: 'Ana Kovac',
    workspace: 'northwind-sample',
    role: 'engineer',
  },
  {
    email: 'ravi@northwind.example',
    name: 'Ravi Menon',
    workspace: 'northwind-sample',
    role: 'engineer',
  },
  {
    email: 'sam@northwind.example',
    name: 'Sam Ortiz',
    workspace: 'northwind-sample',
    role: 'analyst',
  },
  {
    email: 'mei@northwind.example',
    name: 'Mei Tanaka',
    workspace: 'northwind-sample',
    role: 'viewer',
  },
  // A second tenant, for checking that one workspace cannot see another.
  {
    email: 'omar@contoso.example',
    name: 'Omar Haddad',
    workspace: 'contoso-sample',
    role: 'owner',
  },
];

const prisma = createPrismaClient(databaseUrl);
try {
  const passwordHash = await hashPassword(password);
  const workspaceIds = new Map<string, string>();
  for (const w of workspaces) {
    const row = await prisma.workspace.upsert({
      where: { slug: w.slug },
      create: w,
      update: { name: w.name, timezone: w.timezone },
    });
    workspaceIds.set(w.slug, row.id);
  }
  for (const p of people) {
    const user = await prisma.user.upsert({
      where: { email: p.email },
      create: { email: p.email, displayName: p.name, passwordHash },
      update: { displayName: p.name, passwordHash, status: 'active' },
    });
    const workspaceId = workspaceIds.get(p.workspace) ?? '';
    await prisma.membership.upsert({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      create: { workspaceId, userId: user.id, role: p.role, acceptedAt: new Date() },
      update: { role: p.role, status: 'active' },
    });
  }
  console.log(`Seeded ${workspaces.length} workspaces and ${people.length} fake accounts.`);
  console.log(
    process.env.SEED_PASSWORD === undefined
      ? `Password for every seeded account (shown once): ${password}`
      : 'Password for every seeded account: the SEED_PASSWORD value.',
  );
} finally {
  await prisma.$disconnect();
}
