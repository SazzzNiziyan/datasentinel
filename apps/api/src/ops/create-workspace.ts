import { createPrismaClient, type PrismaClient } from '@datasentinel/db';
import { slugify } from '../workspaces/workspaces.controller.js';

export type CreateWorkspaceOpResult =
  | { created: true; workspaceId: string; slug: string }
  | { created: false; reason: string };

/** Creates a workspace and assigns the specified user as the owner. */
export async function createWorkspaceOp(
  prisma: PrismaClient,
  input: { name: string; userEmail: string; timezone?: string },
): Promise<CreateWorkspaceOpResult> {
  const name = input.name.trim();
  const email = input.userEmail.trim().toLowerCase();
  const timezone = input.timezone ?? 'UTC';

  if (!name) return { created: false, reason: 'name_required' };

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const allUsers = await prisma.user.findMany({ select: { email: true } });
    const list = allUsers.map((u) => u.email).join(', ');
    return {
      created: false,
      reason: `user_not_found for "${email}". Available users: [${list || 'none'}]`,
    };
  }

  const slug = slugify(name);
  const existing = await prisma.workspace.findUnique({ where: { slug } });
  if (existing) {
    // If workspace exists, ensure the user is an owner/member
    await prisma.membership.upsert({
      where: {
        id: (
          await prisma.membership.findFirst({
            where: { workspaceId: existing.id, userId: user.id },
          })
        )?.id ?? '00000000-0000-0000-0000-000000000000',
      },
      update: { role: 'owner', status: 'active', acceptedAt: new Date() },
      create: {
        workspaceId: existing.id,
        userId: user.id,
        role: 'owner',
        status: 'active',
        acceptedAt: new Date(),
      },
    });
    return { created: true, workspaceId: existing.id, slug: existing.slug };
  }

  const workspace = await prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.create({
      data: { name, slug, timezone, aiEnabled: true },
    });
    await tx.membership.create({
      data: {
        workspaceId: ws.id,
        userId: user.id,
        role: 'owner',
        status: 'active',
        acceptedAt: new Date(),
      },
    });
    return ws;
  });

  return { created: true, workspaceId: workspace.id, slug: workspace.slug };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const email = process.env.USER_EMAIL;
  const name = process.env.WORKSPACE_NAME ?? 'Production Workspace';

  if (!databaseUrl) {
    console.error('Error: DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }
  if (!email) {
    console.error('Usage: Set USER_EMAIL (and optionally WORKSPACE_NAME) first.');
    console.error('Example (PowerShell):');
    console.error('  $env:USER_EMAIL = "your-email@example.com"');
    console.error('  $env:WORKSPACE_NAME = "Acme Analytics"');
    console.error('  pnpm --filter @datasentinel/api workspace:create');
    process.exitCode = 1;
    return;
  }

  const prisma = createPrismaClient(databaseUrl);
  try {
    const result = await createWorkspaceOp(prisma, { name, userEmail: email });
    if (result.created) {
      console.log(`✅ Workspace "${name}" (${result.slug}) created successfully!`);
      console.log(`User "${email}" is assigned as Owner.`);
    } else {
      console.error(`❌ Failed: ${result.reason}`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('create-workspace.js')) {
  main().catch((err) => {
    console.error('workspace:create failed:', err);
    process.exitCode = 1;
  });
}
