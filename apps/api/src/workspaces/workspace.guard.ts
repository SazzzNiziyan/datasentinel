import type { Role } from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import {
  createParamDecorator,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Principal } from '../auth/session.guard.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';

/** D-02 order, lowest first. */
const RANK: Record<Role, number> = { viewer: 0, analyst: 1, engineer: 2, admin: 3, owner: 4 };

export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

/** The caller's membership in the workspace named by the route. */
export interface WorkspaceAccess {
  workspaceId: string;
  membershipId: string;
  role: Role;
}

type TenantRequest = Request & { principal?: Principal; workspace?: WorkspaceAccess };

const REQUIRED_ROLE = 'datasentinel:required-role';

/** Minimum role for a workspace route; viewer when not set. */
export const RequireRole = (role: Role) => SetMetadata(REQUIRED_ROLE, role);

/** The checked membership, inside a workspace route. */
export const CurrentWorkspace = createParamDecorator(
  (_: unknown, context: ExecutionContext): WorkspaceAccess => {
    const access = context.switchToHttp().getRequest<TenantRequest>().workspace;
    if (access === undefined) throw new Error('CurrentWorkspace used outside a workspace route');
    return access;
  },
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route IDs are checked before querying: a uuid column rejects other text
 * with a database error, which must be a 404 instead. */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

const notFound = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'workspace_not_found',
    'Workspace not found.',
    'It does not exist, or you are not a member.',
  );

/** Every route with a :workspaceId parameter requires an active membership
 * there (deny by default for tenant data). Non-members get 404, the same as
 * a missing workspace, so other tenants' workspaces are never confirmed. */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TenantRequest>();
    const workspaceId = req.params.workspaceId;
    if (workspaceId === undefined) return true;
    // A workspace route is never public, so the session guard has run.
    const principal = req.principal;
    if (principal === undefined || !isUuid(workspaceId)) {
      throw notFound();
    }

    const membership = await this.prisma.membership.findFirst({
      where: { workspaceId, userId: principal.userId, status: 'active' },
      select: { id: true, role: true },
    });
    if (membership === null) throw notFound();

    const required =
      this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'viewer';
    if (!hasRole(membership.role, required)) {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        'insufficient_role',
        'Your role cannot do this.',
        `This needs the ${required} role or higher. Ask a workspace administrator.`,
      );
    }
    req.workspace = { workspaceId, membershipId: membership.id, role: membership.role };
    return true;
  }
}
