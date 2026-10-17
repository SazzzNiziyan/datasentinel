import {
  PipelineRunQuery,
  type PipelineRunListItem,
  type PipelineRunPage,
} from '@datasentinel/contracts';
import type { Prisma, PrismaClient } from '@datasentinel/db';
import { Controller, Get, HttpStatus, Inject, Query } from '@nestjs/common';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import { CurrentWorkspace, type WorkspaceAccess } from '../workspaces/workspace.guard.js';
import { runSelect, toRunSummary } from './pipeline-events.controller.js';

/** Run history for members (D-75): filtered, newest first, paged by a
 * (last event, ID) cursor so a page never repeats or skips a run. */
@Controller('workspaces/:workspaceId/pipeline-runs')
export class PipelineRunsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get()
  async list(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Query() query: unknown,
  ): Promise<PipelineRunPage> {
    const input = PipelineRunQuery.safeParse(query);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'The run filters are not valid.',
      );
    }
    const { status, sourceId, datasetId, from, to, limit, cursor } = input.data;
    const and: Prisma.PipelineRunWhereInput[] = [];
    if (from !== undefined) and.push({ lastEventAt: { gte: new Date(from) } });
    if (to !== undefined) and.push({ lastEventAt: { lte: new Date(to) } });
    if (cursor !== undefined) {
      const [at = '', id = ''] = cursor.split('_');
      const date = new Date(at);
      if (Number.isNaN(date.getTime())) {
        throw new ProblemException(HttpStatus.BAD_REQUEST, 'invalid_request', 'Bad cursor.');
      }
      and.push({ OR: [{ lastEventAt: { lt: date } }, { lastEventAt: date, id: { lt: id } }] });
    }
    const rows = await this.prisma.pipelineRun.findMany({
      where: {
        workspaceId,
        ...(status === undefined ? {} : { status }),
        ...(sourceId === undefined ? {} : { sourceId }),
        ...(datasetId === undefined ? {} : { datasetId }),
        AND: and,
      },
      orderBy: [{ lastEventAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        ...runSelect,
        source: { select: { name: true } },
        dataset: { select: { name: true } },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const runs: PipelineRunListItem[] = page.map((r) => ({
      ...toRunSummary(r),
      sourceName: r.source.name,
      datasetName: r.dataset?.name ?? null,
    }));
    return {
      runs,
      nextCursor:
        rows.length > limit && last !== undefined
          ? `${last.lastEventAt.toISOString()}_${last.id}`
          : null,
    };
  }
}
