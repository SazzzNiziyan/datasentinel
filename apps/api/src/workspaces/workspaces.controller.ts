import {
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from '@datasentinel/contracts';
import { Prisma, type PrismaClient } from '@datasentinel/db';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Patch,
  Post,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CurrentRequest, recordAudit, type RequestMeta } from '../audit/audit.js';
import { CurrentPrincipal, type Principal } from '../auth/session.guard.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import { UPLOAD_STORAGE, type UploadStorage } from '../storage/storage.js';
import { CurrentWorkspace, RequireRole, type WorkspaceAccess } from './workspace.guard.js';

/** "Acme Analytics!" -> "acme-analytics". Falls back to "workspace". */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // accents split off by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/, '');
  return slug || 'workspace';
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const isSlugTaken = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

@Controller('workspaces')
export class WorkspacesController {
  private readonly logger = new Logger(WorkspacesController.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(UPLOAD_STORAGE) private readonly storage: UploadStorage,
  ) {}

  /** Creates the workspace and the caller's owner membership together:
   * a workspace never exists without an owner. */
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Body() body: unknown,
  ): Promise<WorkspaceSummary> {
    const input = CreateWorkspaceRequest.safeParse(body);
    if (!input.success || !isValidTimeZone(input.data.timezone)) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Enter a workspace name and a valid time zone.',
      );
    }
    const { name, timezone } = input.data;
    const base = slugify(name);

    // The first try uses the plain slug; if taken, add a short random suffix.
    for (let attempt = 0; attempt < 4; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
      try {
        const workspace = await this.prisma.$transaction(async (tx) => {
          const created = await tx.workspace.create({ data: { name, slug, timezone } });
          await tx.membership.create({
            data: {
              workspaceId: created.id,
              userId: principal.userId,
              role: 'owner',
              acceptedAt: new Date(),
            },
          });
          await recordAudit(tx, {
            action: 'workspace.created',
            actor: { type: 'user', id: principal.userId },
            request,
            workspaceId: created.id,
            target: { type: 'workspace', id: created.id },
            summary: { after: { name, slug, timezone } },
          });
          return created;
        });
        return {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          timezone: workspace.timezone,
          role: 'owner',
        };
      } catch (error) {
        if (!isSlugTaken(error)) throw error;
      }
    }
    throw new ProblemException(
      HttpStatus.CONFLICT,
      'slug_unavailable',
      'Could not find a free web address for this name.',
      'Try a slightly different workspace name.',
    );
  }

  /** Workspace settings; any member may read them. */
  @Get(':workspaceId')
  async detail(@CurrentWorkspace() access: WorkspaceAccess): Promise<WorkspaceDetail> {
    const w = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: access.workspaceId },
    });
    return {
      id: w.id,
      name: w.name,
      slug: w.slug,
      timezone: w.timezone,
      role: access.role,
      createdAt: w.createdAt.toISOString(),
    };
  }

  /** Name and time zone. The change and its audit record commit together. */
  @Patch(':workspaceId')
  @RequireRole('admin')
  async update(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Body() body: unknown,
  ): Promise<WorkspaceDetail> {
    const input = UpdateWorkspaceRequest.safeParse(body);
    const timezone = input.success ? input.data.timezone : undefined;
    if (!input.success || (timezone !== undefined && !isValidTimeZone(timezone))) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Enter a workspace name or a valid time zone.',
      );
    }
    const w = await this.prisma.$transaction(async (tx) => {
      const before = await tx.workspace.findUniqueOrThrow({ where: { id: access.workspaceId } });
      const after = await tx.workspace.update({
        where: { id: access.workspaceId },
        data: input.data,
      });
      const changed = (['name', 'timezone'] as const).filter((k) => before[k] !== after[k]);
      await recordAudit(tx, {
        action: 'workspace.updated',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId: access.workspaceId,
        target: { type: 'workspace', id: access.workspaceId },
        summary: {
          before: Object.fromEntries(changed.map((k) => [k, before[k]])),
          after: Object.fromEntries(changed.map((k) => [k, after[k]])),
        },
      });
      return after;
    });
    return {
      id: w.id,
      name: w.name,
      slug: w.slug,
      timezone: w.timezone,
      role: access.role,
      createdAt: w.createdAt.toISOString(),
    };
  }

  /** Deletes the workspace and everything in it (owner only). The caller
   * types the workspace slug to confirm. Rows go in one transaction (their
   * data cascades by foreign key); the audit record names no data. Stored
   * files are removed after the commit; any that could not be removed are
   * counted in the response so an operator can clean them up. */
  @Delete(':workspaceId')
  @HttpCode(HttpStatus.OK)
  @RequireRole('owner')
  async remove(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Body() body: unknown,
  ): Promise<{ deleted: true; objectsNotRemoved: number }> {
    const w = await this.prisma.workspace.findUniqueOrThrow({ where: { id: access.workspaceId } });
    const confirm = (body as { confirmSlug?: unknown } | null)?.confirmSlug;
    if (confirm !== w.slug) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'confirmation_required',
        'Type the workspace slug to confirm deletion.',
        'Send confirmSlug with the exact slug of this workspace.',
      );
    }
    const keys = (
      await this.prisma.upload.findMany({
        where: { workspaceId: w.id },
        select: { objectKey: true },
      })
    ).map((u) => u.objectKey);
    await this.prisma.$transaction(async (tx) => {
      await recordAudit(tx, {
        action: 'workspace.deleted',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId: w.id,
        target: { type: 'workspace', id: w.id },
        summary: { objects: keys.length },
      });
      await tx.workspace.delete({ where: { id: w.id } });
    });
    let notRemoved = 0;
    for (const key of keys) {
      try {
        await this.storage.remove(key);
      } catch {
        notRemoved += 1;
      }
    }
    if (notRemoved > 0) {
      this.logger.error(`workspace ${w.id} deleted; ${notRemoved} stored files not removed`);
    }
    return { deleted: true, objectsNotRemoved: notRemoved };
  }
}
