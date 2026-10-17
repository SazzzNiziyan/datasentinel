import {
  CreateIntegrationTokenRequest,
  type IntegrationTokenSummary,
  type IssuedIntegrationToken,
} from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentRequest, recordAudit, type RequestMeta } from '../audit/audit.js';
import { CurrentPrincipal, type Principal } from '../auth/session.guard.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import { notFound } from '../sources/sources.controller.js';
import {
  CurrentWorkspace,
  isUuid,
  RequireRole,
  type WorkspaceAccess,
} from '../workspaces/workspace.guard.js';
import { newIntegrationToken } from './integration-token.js';

const tokenSelect = {
  id: true,
  name: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
} as const;

const toSummary = (t: {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): IntegrationTokenSummary => ({
  id: t.id,
  name: t.name,
  createdAt: t.createdAt.toISOString(),
  lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
  revokedAt: t.revokedAt?.toISOString() ?? null,
});

/** Tokens external jobs use to report pipeline runs (D-73, D-74). They are
 * credentials, so only admins manage them; the secret is shown once. */
@Controller('workspaces/:workspaceId/sources/:sourceId/integration-tokens')
@RequireRole('admin')
export class IntegrationTokensController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get()
  async list(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Param('sourceId') sourceId: string,
  ): Promise<IntegrationTokenSummary[]> {
    await this.source(workspaceId, sourceId);
    const rows = await this.prisma.integrationToken.findMany({
      where: { workspaceId, sourceId },
      orderBy: { createdAt: 'asc' },
      select: tokenSelect,
    });
    return rows.map(toSummary);
  }

  @Post()
  async create(
    @CurrentWorkspace() { workspaceId, membershipId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
  ): Promise<IssuedIntegrationToken> {
    const input = CreateIntegrationTokenRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(HttpStatus.BAD_REQUEST, 'invalid_request', 'Name the token.');
    }
    const source = await this.source(workspaceId, sourceId);
    if (source.type !== 'pipeline_event') {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'not_a_pipeline_source',
        'Only pipeline-event sources take integration tokens.',
      );
    }
    if (source.status === 'archived') {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'source_archived',
        'This source is archived.',
        'Archived sources get no new tokens.',
      );
    }
    const { id, hash, token } = newIntegrationToken();
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.integrationToken.create({
        data: {
          id,
          workspaceId,
          sourceId,
          name: input.data.name,
          secretHash: new Uint8Array(hash),
          createdByMembershipId: membershipId,
        },
        select: tokenSelect,
      });
      await recordAudit(tx, {
        action: 'integration_token.created',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'integration_token', id },
        summary: { after: { sourceId } },
      });
      return created;
    });
    return { ...toSummary(row), token };
  }

  /** Revokes at once; the next request with the token gets 401. */
  @Delete(':tokenId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('sourceId') sourceId: string,
    @Param('tokenId') tokenId: string,
  ): Promise<void> {
    await this.source(workspaceId, sourceId);
    if (!isUuid(tokenId)) throw tokenNotFound();
    await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.integrationToken.updateMany({
        where: { id: tokenId, workspaceId, sourceId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count === 0) throw tokenNotFound();
      await recordAudit(tx, {
        action: 'integration_token.revoked',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'integration_token', id: tokenId },
        summary: { after: { sourceId } },
      });
    });
  }

  private async source(workspaceId: string, sourceId: string) {
    const source = isUuid(sourceId)
      ? await this.prisma.dataSource.findFirst({
          where: { id: sourceId, workspaceId },
          select: { type: true, status: true },
        })
      : null;
    if (source === null) throw notFound('source');
    return source;
  }
}

const tokenNotFound = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'token_not_found',
    'Token not found or already revoked.',
  );
