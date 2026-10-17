import { UpdateAiSettingsRequest, type AiSettings } from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import { Body, Controller, Get, HttpStatus, Inject, Put } from '@nestjs/common';
import { CurrentRequest, recordAudit, type RequestMeta } from '../audit/audit.js';
import { CurrentPrincipal, type Principal } from '../auth/session.guard.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import {
  CurrentWorkspace,
  RequireRole,
  type WorkspaceAccess,
} from '../workspaces/workspace.guard.js';
import { AI_CONFIG, type AiConfig } from './ai-config.js';

/** AI investigation is off by default for the deployment and for every
 * workspace (D-99). Any member can see the state and the disclosure; only
 * admins and owners opt a workspace in or out. */
@Controller('workspaces/:workspaceId/ai-settings')
export class AiSettingsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AI_CONFIG) private readonly config: AiConfig,
  ) {}

  @Get()
  async get(@CurrentWorkspace() { workspaceId }: WorkspaceAccess): Promise<AiSettings> {
    return this.view(workspaceId);
  }

  @RequireRole('admin')
  @Put()
  async update(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Body() body: unknown,
  ): Promise<AiSettings> {
    const input = UpdateAiSettingsRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Turning AI on needs your acknowledgement.',
        'Send { "enabled": true, "acknowledge": true } to turn it on, or { "enabled": false }.',
      );
    }
    if (input.data.enabled && !this.config.available) {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'ai_unavailable',
        'AI investigation is not available in this deployment.',
        'The administrator of this deployment has not enabled it or named the provider, region, and retention.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { aiEnabled: true },
      });
      if (current.aiEnabled === input.data.enabled) return;
      await tx.workspace.update({
        where: { id: workspaceId },
        data: { aiEnabled: input.data.enabled },
      });
      await recordAudit(tx, {
        action: input.data.enabled ? 'workspace.ai_enabled' : 'workspace.ai_disabled',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'workspace', id: workspaceId },
        summary: {
          after: {
            aiEnabled: input.data.enabled,
            provider: this.config.provider,
            region: this.config.region,
          },
        },
      });
    });
    return this.view(workspaceId);
  }

  private async view(workspaceId: string): Promise<AiSettings> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { aiEnabled: true },
    });
    return {
      available: this.config.available,
      // Never reported on while the deployment cannot honour it.
      enabled: workspace.aiEnabled && this.config.available,
      provider: this.config.provider,
      region: this.config.region,
      retention: this.config.retention,
    };
  }
}
