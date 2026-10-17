import type { ConnectionTestDetail, TableDiscovery, UploadFailure } from '@datasentinel/contracts';
import type { Prisma, PrismaClient } from '@datasentinel/db';
import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import {
  CurrentWorkspace,
  isUuid,
  RequireRole,
  type WorkspaceAccess,
} from '../workspaces/workspace.guard.js';
import { SOURCE_JOBS, type SourceJobs } from './source-jobs.js';
import { notFound } from './sources.controller.js';

const testSelect = {
  id: true,
  sourceId: true,
  status: true,
  serverVersion: true,
  latencyMs: true,
  error: true,
  createdAt: true,
  finishedAt: true,
} as const;

type TestRow = Prisma.ConnectionTestGetPayload<{ select: typeof testSelect }>;

const toDetail = (t: TestRow): ConnectionTestDetail => ({
  id: t.id,
  sourceId: t.sourceId,
  status: t.status,
  serverVersion: t.serverVersion,
  latencyMs: t.latencyMs,
  error: (t.error as UploadFailure | null) ?? null,
  createdAt: t.createdAt.toISOString(),
  finishedAt: t.finishedAt?.toISOString() ?? null,
});

const conflict = (code: string, title: string, detail: string) =>
  new ProblemException(HttpStatus.CONFLICT, code, title, detail);

/** Connection tests (docs/04 §3, D-49): queued here, run by the worker. */
@Controller('workspaces/:workspaceId')
export class ConnectionTestsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SOURCE_JOBS) private readonly queue: SourceJobs,
  ) {}

  /** A test already waiting or running for the source is returned instead
   * of starting another, so repeated clicks cannot pile up connections. */
  @RequireRole('engineer')
  @Post('sources/:sourceId/connection-tests')
  @HttpCode(HttpStatus.ACCEPTED)
  async start(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('sourceId') sourceId: string,
  ): Promise<ConnectionTestDetail> {
    const { workspaceId } = access;
    await this.testable(workspaceId, sourceId);
    const pending = await this.prisma.connectionTest.findFirst({
      where: { workspaceId, sourceId, status: { in: ['queued', 'running'] } },
      orderBy: { createdAt: 'desc' },
      select: testSelect,
    });
    const test =
      pending ??
      (await this.prisma.connectionTest.create({
        data: { workspaceId, sourceId, requestedByMembershipId: access.membershipId },
        select: testSelect,
      }));
    await this.queue.enqueueTest({ workspaceId, connectionTestId: test.id });
    return toDetail(test);
  }

  /** Lists the tables and views the source's login can read (D-50). The
   * worker connects; this waits up to 20 s for its answer. */
  @RequireRole('engineer')
  @Post('sources/:sourceId/discoveries')
  @HttpCode(HttpStatus.OK)
  async discover(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('sourceId') sourceId: string,
  ): Promise<TableDiscovery> {
    await this.testable(access.workspaceId, sourceId);
    const outcome = await this.queue.discover(
      { workspaceId: access.workspaceId, sourceId },
      20_000,
    );
    if (outcome === null) {
      throw new ProblemException(
        HttpStatus.GATEWAY_TIMEOUT,
        'discovery_timeout',
        'The source did not answer in time.',
        'Try again. If it keeps happening, test the connection.',
      );
    }
    if (!outcome.ok) {
      throw new ProblemException(
        HttpStatus.BAD_GATEWAY,
        `source_${outcome.error.code}`,
        outcome.error.message,
        outcome.error.hint,
      );
    }
    return outcome.discovery;
  }

  /** Queues a profile of a database dataset now (docs/04 §3, D-52). The
   * result appears as the dataset's latest profile. */
  @RequireRole('engineer')
  @Post('datasets/:datasetId/profile-runs')
  @HttpCode(HttpStatus.ACCEPTED)
  async profileNow(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('datasetId') datasetId: string,
  ): Promise<{ status: 'queued' }> {
    const { workspaceId } = access;
    const dataset = isUuid(datasetId)
      ? await this.prisma.dataset.findFirst({
          where: { id: datasetId, workspaceId },
          select: { status: true, sourceId: true, source: { select: { type: true } } },
        })
      : null;
    if (dataset === null) throw notFound('dataset');
    if (dataset.source.type !== 'postgres') {
      throw conflict(
        'not_profilable',
        'CSV datasets are profiled when a file is uploaded.',
        'Upload a new file to profile it again.',
      );
    }
    if (dataset.status === 'archived') {
      throw conflict(
        'dataset_archived',
        'This dataset is archived.',
        'Archived datasets are not profiled.',
      );
    }
    await this.testable(workspaceId, dataset.sourceId);
    await this.queue.enqueueProfile({ workspaceId, datasetId });
    return { status: 'queued' };
  }

  @Get('connection-tests/:testId')
  async detail(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('testId') testId: string,
  ): Promise<ConnectionTestDetail> {
    const test = isUuid(testId)
      ? await this.prisma.connectionTest.findFirst({
          where: { id: testId, workspaceId: access.workspaceId },
          select: testSelect,
        })
      : null;
    if (test === null) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'connection_test_not_found',
        'Connection test not found.',
      );
    }
    return toDetail(test);
  }

  /** A database source in this workspace, not archived, with a login. */
  private async testable(workspaceId: string, sourceId: string): Promise<void> {
    const source = isUuid(sourceId)
      ? await this.prisma.dataSource.findFirst({
          where: { id: sourceId, workspaceId },
          select: {
            type: true,
            status: true,
            _count: { select: { credentials: { where: { revokedAt: null } } } },
          },
        })
      : null;
    if (source === null) throw notFound('source');
    if (source.type !== 'postgres') {
      throw conflict(
        'not_testable',
        'Only database sources have a connection to test.',
        'CSV sources are checked when a file is uploaded.',
      );
    }
    if (source.status === 'archived') {
      throw conflict(
        'source_archived',
        'This source is archived.',
        'Archived sources are not used.',
      );
    }
    if (source._count.credentials === 0) {
      throw conflict(
        'no_credential',
        'This source has no stored login.',
        'Add a username and password first.',
      );
    }
  }
}
