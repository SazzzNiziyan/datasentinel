import {
  CORRELATION_AFTER_MS,
  CORRELATION_BEFORE_MS,
  correlatePipelineRuns,
  type PipelineRunCorrelation,
} from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import { Controller, Get, HttpStatus, Inject, Param } from '@nestjs/common';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import { CurrentWorkspace, isUuid, type WorkspaceAccess } from '../workspaces/workspace.guard.js';
import { runSelect, toRunSummary } from './pipeline-events.controller.js';

/** Pipeline runs near a check, by the documented ID and time rules
 * (D-76). Any member may read them. */
@Controller('workspaces/:workspaceId/check-runs')
export class RelatedRunsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get(':checkRunId/related-pipeline-runs')
  async related(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Param('checkRunId') checkRunId: string,
  ): Promise<PipelineRunCorrelation> {
    const check = isUuid(checkRunId)
      ? await this.prisma.checkRun.findFirst({
          where: { id: checkRunId, workspaceId },
          select: { createdAt: true, startedAt: true, rule: { select: { datasetId: true } } },
        })
      : null;
    if (check === null) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'check_run_not_found',
        'Check run not found.',
      );
    }
    const datasetId = check.rule.datasetId;
    const at = check.startedAt ?? check.createdAt;
    const from = new Date(at.getTime() - CORRELATION_BEFORE_MS);
    const to = new Date(at.getTime() + CORRELATION_AFTER_MS);
    // A coarse database filter; the shared function applies the exact rules.
    const rows = await this.prisma.pipelineRun.findMany({
      where: {
        workspaceId,
        OR: [{ datasetId }, { correlationId: datasetId }],
        lastEventAt: { gte: from },
        AND: [{ OR: [{ startedAt: null }, { startedAt: { lte: to } }] }],
      },
      orderBy: { lastEventAt: 'desc' },
      take: 50,
      select: {
        ...runSelect,
        source: { select: { name: true } },
        dataset: { select: { name: true } },
      },
    });
    const runs = correlatePipelineRuns({ datasetId, at }, rows).map(
      ({ run, reason, distanceMinutes }) => ({
        ...toRunSummary(run),
        sourceName: run.source.name,
        datasetName: run.dataset?.name ?? null,
        reason,
        distanceMinutes,
      }),
    );
    return { windowFrom: from.toISOString(), windowTo: to.toISOString(), runs };
  }
}
