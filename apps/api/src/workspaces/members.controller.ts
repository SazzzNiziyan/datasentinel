import { UpdateMemberRequest, type MemberSummary } from '@datasentinel/contracts';
import { Prisma, type PrismaClient } from '@datasentinel/db';
import { Body, Controller, Get, HttpStatus, Inject, Param, Patch } from '@nestjs/common';
import { CurrentRequest, recordAudit, type RequestMeta } from '../audit/audit.js';
import { CurrentPrincipal, type Principal } from '../auth/session.guard.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import { CurrentWorkspace, hasRole, RequireRole, type WorkspaceAccess } from './workspace.guard.js';

const memberSelect = {
  id: true,
  userId: true,
  role: true,
  status: true,
  user: { select: { displayName: true, email: true } },
} as const;

type MemberRow = Prisma.MembershipGetPayload<{ select: typeof memberSelect }>;

const toSummary = (m: MemberRow): MemberSummary => ({
  membershipId: m.id,
  userId: m.userId,
  displayName: m.user.displayName,
  email: m.user.email,
  role: m.role,
  status: m.status,
});

const problem = (status: HttpStatus, code: string, title: string, detail?: string) =>
  new ProblemException(status, code, title, detail);

@RequireRole('admin')
@Controller('workspaces/:workspaceId/members')
export class MembersController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get()
  async list(@CurrentWorkspace() access: WorkspaceAccess): Promise<MemberSummary[]> {
    const rows = await this.prisma.membership.findMany({
      where: { workspaceId: access.workspaceId, status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: memberSelect,
    });
    return rows.map(toSummary);
  }

  /** Role change or removal. Roles are read from the database on every
   * request, so the change applies on the member's next request. */
  @Patch(':membershipId')
  async update(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ): Promise<MemberSummary> {
    const input = UpdateMemberRequest.safeParse(body);
    if (!input.success) {
      throw problem(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Choose a role or remove the member.',
      );
    }
    const { role, status } = input.data;

    // Serializable, so two owners demoting each other at the same moment
    // cannot leave the workspace with none.
    const run = () =>
      this.prisma.$transaction(
        async (tx) => {
          // Scoped to the route's workspace: another tenant's membership is 404.
          const target = await tx.membership.findFirst({
            where: { id: membershipId, workspaceId: access.workspaceId, status: 'active' },
            select: { id: true, role: true },
          });
          if (target === null) {
            throw problem(HttpStatus.NOT_FOUND, 'member_not_found', 'Member not found.');
          }
          if (role !== undefined && !hasRole(access.role, role)) {
            throw problem(
              HttpStatus.FORBIDDEN,
              'role_ceiling',
              'You cannot give a role above your own.',
            );
          }
          if ((target.role === 'owner' || role === 'owner') && access.role !== 'owner') {
            throw problem(HttpStatus.FORBIDDEN, 'owner_only', 'Only an owner can change owners.');
          }
          const losesOwner = target.role === 'owner' && (status === 'removed' || role !== 'owner');
          if (losesOwner) {
            const owners = await tx.membership.count({
              where: { workspaceId: access.workspaceId, role: 'owner', status: 'active' },
            });
            if (owners <= 1) {
              throw problem(
                HttpStatus.CONFLICT,
                'last_owner',
                'A workspace needs at least one owner.',
                'Make someone else an owner first.',
              );
            }
          }
          const updated = await tx.membership.update({
            where: { id: target.id },
            data: {
              ...(role === undefined ? {} : { role }),
              ...(status === undefined ? {} : { status }),
            },
            select: memberSelect,
          });
          const removed = status === 'removed';
          await recordAudit(tx, {
            action: removed ? 'member.removed' : 'member.role_changed',
            actor: { type: 'user', id: principal.userId },
            request,
            workspaceId: access.workspaceId,
            target: { type: 'membership', id: target.id },
            summary: removed
              ? { before: { role: target.role }, after: { status: 'removed' } }
              : { before: { role: target.role }, after: { role: updated.role } },
          });
          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

    try {
      return toSummary(await run());
    } catch (error) {
      // P2034: a concurrent change won; one retry sees its result.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        return toSummary(await run());
      }
      throw error;
    }
  }
}
