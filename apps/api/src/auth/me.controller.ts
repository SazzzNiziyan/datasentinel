import type { MeResponse, WorkspaceSummary } from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import { Controller, Get, Inject } from '@nestjs/common';
import { PRISMA } from '../db.js';
import { CurrentPrincipal, type Principal } from './session.guard.js';

@Controller()
export class MeController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** The caller and the workspaces they can open. */
  @Get('auth/me')
  async me(@CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        memberships: {
          where: { status: 'active' },
          orderBy: { createdAt: 'asc' },
          select: { role: true, workspace: { select: { id: true, name: true, slug: true } } },
        },
      },
    });
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      memberships: user.memberships.map((m) => ({
        workspaceId: m.workspace.id,
        workspaceName: m.workspace.name,
        slug: m.workspace.slug,
        role: m.role,
      })),
    };
  }

  /** Only workspaces where the caller has an active membership. */
  @Get('workspaces')
  async workspaces(@CurrentPrincipal() principal: Principal): Promise<WorkspaceSummary[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId: principal.userId, status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        workspace: { select: { id: true, name: true, slug: true, timezone: true } },
      },
    });
    return memberships.map((m) => ({ ...m.workspace, role: m.role }));
  }
}
