import {
  canMoveRun,
  checkEventTime,
  PipelineRunEvent,
  PipelineRunUpdate,
  redactRunSummary,
  terminalRunStatuses,
  type PipelineRunStatus,
  type PipelineRunSummary,
} from '@datasentinel/contracts';
import type { Prisma, PrismaClient } from '@datasentinel/db';
import {
  Body,
  Controller,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/session.guard.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import { isUuid } from '../workspaces/workspace.guard.js';
import {
  CurrentIntegration,
  IntegrationTokenGuard,
  type Integration,
} from './integration-token.js';

export const runSelect = {
  id: true,
  sourceId: true,
  datasetId: true,
  externalRunId: true,
  name: true,
  status: true,
  trigger: true,
  startedAt: true,
  endedAt: true,
  lastEventAt: true,
  correlationId: true,
  summary: true,
  createdAt: true,
} as const;

type RunRow = Prisma.PipelineRunGetPayload<{ select: typeof runSelect }>;

export const toRunSummary = (r: RunRow): PipelineRunSummary => ({
  id: r.id,
  sourceId: r.sourceId,
  datasetId: r.datasetId,
  externalRunId: r.externalRunId,
  name: r.name,
  status: r.status,
  trigger: r.trigger as PipelineRunSummary['trigger'],
  startedAt: r.startedAt?.toISOString() ?? null,
  endedAt: r.endedAt?.toISOString() ?? null,
  lastEventAt: r.lastEventAt.toISOString(),
  correlationId: r.correlationId,
  summary: r.summary,
  createdAt: r.createdAt.toISOString(),
});

const invalid = (title: string) =>
  new ProblemException(HttpStatus.BAD_REQUEST, 'invalid_event', title);

const runNotFound = () =>
  new ProblemException(HttpStatus.NOT_FOUND, 'run_not_found', 'Pipeline run not found.');

const isTerminal = (s: PipelineRunStatus) => terminalRunStatuses.includes(s);

/** Refuses events outside the replay window (D-73). */
function eventTime(occurredAt: string): Date {
  const check = checkEventTime(occurredAt, new Date());
  if (check === 'too_old') throw invalid('This event is older than 7 days.');
  if (check === 'in_future') throw invalid('This event is more than 5 minutes in the future.');
  return new Date(occurredAt);
}

/** The time fields a state implies when the job does not send them. */
function times(status: PipelineRunStatus, at: Date, startedAt?: string, endedAt?: string) {
  return {
    startedAt:
      startedAt !== undefined ? new Date(startedAt) : status === 'running' ? at : undefined,
    endedAt: endedAt !== undefined ? new Date(endedAt) : isTerminal(status) ? at : undefined,
  };
}

/** Pipeline-run events from external jobs (D-73, D-74). The token decides
 * the workspace and source, so these routes carry no workspace ID. */
@Controller('integrations/pipeline-runs')
@Public()
@UseGuards(IntegrationTokenGuard)
export class PipelineEventsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** Records a run, or a later state of a run already recorded under the
   * same `externalRunId`: 201 when new, 200 when it existed. */
  @Post()
  async report(
    @CurrentIntegration() integration: Integration,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PipelineRunSummary> {
    const input = PipelineRunEvent.safeParse(body);
    if (!input.success) throw invalid('The event does not match the pipeline-run contract.');
    const event = input.data;
    const at = eventTime(event.occurredAt);
    const { workspaceId, sourceId, tokenId } = integration;
    const source = await this.prisma.dataSource.findFirst({
      where: { id: sourceId, workspaceId },
      select: { status: true },
    });
    if (source?.status !== 'active') {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'source_not_active',
        'This source is paused or archived.',
        'Events are accepted again once it is resumed.',
      );
    }
    if (event.datasetId !== undefined) {
      const dataset = await this.prisma.dataset.findFirst({
        where: { id: event.datasetId, workspaceId, sourceId },
        select: { id: true },
      });
      if (dataset === null) {
        throw new ProblemException(
          HttpStatus.NOT_FOUND,
          'dataset_not_found',
          'Dataset not found in this source.',
        );
      }
    }
    const summary = event.summary === undefined ? undefined : redactRunSummary(event.summary);
    const created = await this.prisma.pipelineRun.createManyAndReturn({
      data: [
        {
          workspaceId,
          sourceId,
          datasetId: event.datasetId ?? null,
          externalRunId: event.externalRunId,
          name: event.name,
          status: event.status,
          trigger: event.trigger,
          ...times(event.status, at, event.startedAt, event.endedAt),
          lastEventAt: at,
          correlationId: event.correlationId ?? null,
          summary: summary ?? null,
          createdByTokenId: tokenId,
        },
      ],
      skipDuplicates: true,
      select: runSelect,
    });
    const run = created[0];
    if (run !== undefined) {
      res.status(HttpStatus.CREATED);
      return toRunSummary(run);
    }
    res.status(HttpStatus.OK);
    const existing = await this.prisma.pipelineRun.findUniqueOrThrow({
      where: { sourceId_externalRunId: { sourceId, externalRunId: event.externalRunId } },
      select: runSelect,
    });
    return this.advance(existing, event.status, at, event.endedAt, summary);
  }

  /** A later state of a run, by its DataSentinel ID. */
  @Patch(':pipelineRunId')
  async update(
    @CurrentIntegration() { workspaceId, sourceId }: Integration,
    @Param('pipelineRunId') pipelineRunId: string,
    @Body() body: unknown,
  ): Promise<PipelineRunSummary> {
    const input = PipelineRunUpdate.safeParse(body);
    if (!input.success) throw invalid('The update does not match the pipeline-run contract.');
    const at = eventTime(input.data.occurredAt);
    const run = isUuid(pipelineRunId)
      ? await this.prisma.pipelineRun.findFirst({
          where: { id: pipelineRunId, workspaceId, sourceId },
          select: runSelect,
        })
      : null;
    if (run === null) throw runNotFound();
    const summary =
      input.data.summary === undefined ? undefined : redactRunSummary(input.data.summary);
    return this.advance(run, input.data.status, at, input.data.endedAt, summary);
  }

  /** Applies a state only if it moves the run forward and is not older
   * than the last event; otherwise returns the run unchanged, so retried
   * and out-of-order deliveries are harmless (D-73). */
  private async advance(
    run: RunRow,
    status: PipelineRunStatus,
    at: Date,
    endedAt: string | undefined,
    summary: string | undefined,
  ): Promise<PipelineRunSummary> {
    if (at < run.lastEventAt || !canMoveRun(run.status, status)) return toRunSummary(run);
    const implied = times(status, at, undefined, endedAt);
    await this.prisma.pipelineRun.updateMany({
      where: { id: run.id, status: run.status, lastEventAt: run.lastEventAt },
      data: {
        status,
        lastEventAt: at,
        ...(run.startedAt === null && implied.startedAt !== undefined
          ? { startedAt: implied.startedAt }
          : {}),
        ...(implied.endedAt === undefined ? {} : { endedAt: implied.endedAt }),
        ...(summary === undefined ? {} : { summary }),
      },
    });
    // A concurrent event won the race; report what it stored.
    const current = await this.prisma.pipelineRun.findUniqueOrThrow({
      where: { id: run.id },
      select: runSelect,
    });
    return toRunSummary(current);
  }
}
