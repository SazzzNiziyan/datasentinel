import type { DatasetDetail, LifecycleStatus, SourceDetail } from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import { Controller, Delete, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { CurrentRequest, recordAudit, type RequestMeta } from '../audit/audit.js';
import { CurrentPrincipal, type Principal } from '../auth/session.guard.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import {
  CurrentWorkspace,
  isUuid,
  RequireRole,
  type WorkspaceAccess,
} from '../workspaces/workspace.guard.js';
import { findDatasetDetail, findSourceDetail, notFound } from './sources.controller.js';

type Target = LifecycleStatus;

const verb: Record<Target, string> = { paused: 'paused', active: 'resumed', archived: 'archived' };

const archivedProblem = (what: 'source' | 'dataset') =>
  new ProblemException(
    HttpStatus.CONFLICT,
    `${what}_archived`,
    what === 'source' ? 'This source is archived.' : 'This dataset is archived.',
    'Archived items stay readable, but cannot be paused or resumed.',
  );

/** Pause, resume, and archive (docs/04 §3, D-11, D-45). Pause and resume
 * need a data engineer; archive needs an administrator. Repeating an action
 * changes nothing and writes no audit entry; archived items stay readable
 * but cannot change again (purge comes later). Pausing stops future
 * scheduled checks once schedules exist (Phase I). */
@Controller('workspaces/:workspaceId')
export class LifecycleController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @RequireRole('engineer')
  @Post('sources/:sourceId/pause')
  @HttpCode(HttpStatus.OK)
  pauseSource(
    @CurrentWorkspace() a: WorkspaceAccess,
    @CurrentPrincipal() p: Principal,
    @CurrentRequest() r: RequestMeta,
    @Param('sourceId') id: string,
  ) {
    return this.source(a, p, r, id, 'paused');
  }

  @RequireRole('engineer')
  @Post('sources/:sourceId/resume')
  @HttpCode(HttpStatus.OK)
  resumeSource(
    @CurrentWorkspace() a: WorkspaceAccess,
    @CurrentPrincipal() p: Principal,
    @CurrentRequest() r: RequestMeta,
    @Param('sourceId') id: string,
  ) {
    return this.source(a, p, r, id, 'active');
  }

  /** Archives the source and its datasets (D-11): checks stop, history stays. */
  @RequireRole('admin')
  @Delete('sources/:sourceId')
  archiveSource(
    @CurrentWorkspace() a: WorkspaceAccess,
    @CurrentPrincipal() p: Principal,
    @CurrentRequest() r: RequestMeta,
    @Param('sourceId') id: string,
  ) {
    return this.source(a, p, r, id, 'archived');
  }

  @RequireRole('engineer')
  @Post('datasets/:datasetId/pause')
  @HttpCode(HttpStatus.OK)
  pauseDataset(
    @CurrentWorkspace() a: WorkspaceAccess,
    @CurrentPrincipal() p: Principal,
    @CurrentRequest() r: RequestMeta,
    @Param('datasetId') id: string,
  ) {
    return this.dataset(a, p, r, id, 'paused');
  }

  @RequireRole('engineer')
  @Post('datasets/:datasetId/resume')
  @HttpCode(HttpStatus.OK)
  resumeDataset(
    @CurrentWorkspace() a: WorkspaceAccess,
    @CurrentPrincipal() p: Principal,
    @CurrentRequest() r: RequestMeta,
    @Param('datasetId') id: string,
  ) {
    return this.dataset(a, p, r, id, 'active');
  }

  @RequireRole('admin')
  @Delete('datasets/:datasetId')
  archiveDataset(
    @CurrentWorkspace() a: WorkspaceAccess,
    @CurrentPrincipal() p: Principal,
    @CurrentRequest() r: RequestMeta,
    @Param('datasetId') id: string,
  ) {
    return this.dataset(a, p, r, id, 'archived');
  }

  private async source(
    access: WorkspaceAccess,
    principal: Principal,
    request: RequestMeta,
    sourceId: string,
    to: Target,
  ): Promise<SourceDetail> {
    const { workspaceId } = access;
    const current = isUuid(sourceId)
      ? await this.prisma.dataSource.findFirst({
          where: { id: sourceId, workspaceId },
          select: { status: true },
        })
      : null;
    if (current === null) throw notFound('source');
    if (current.status !== to) {
      if (current.status === 'archived') throw archivedProblem('source');
      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        // Conditional, so two requests cannot both apply (and audit) it.
        const changed = await tx.dataSource.updateMany({
          where: { id: sourceId, workspaceId, status: current.status },
          data: { status: to, ...(to === 'archived' ? { archivedAt: now } : {}) },
        });
        if (changed.count === 0) return;
        const datasets =
          to === 'archived'
            ? await tx.dataset.updateMany({
                where: { sourceId, workspaceId, status: { not: 'archived' } },
                data: { status: 'archived', archivedAt: now },
              })
            : { count: 0 };
        await recordAudit(tx, {
          action: `source.${verb[to]}`,
          actor: { type: 'user', id: principal.userId },
          request,
          workspaceId,
          target: { type: 'source', id: sourceId },
          summary: {
            before: { status: current.status },
            after: { status: to },
            ...(to === 'archived' ? { datasetsArchived: datasets.count } : {}),
          },
        });
      });
    }
    const detail = await findSourceDetail(this.prisma, workspaceId, sourceId);
    if (detail === null) throw notFound('source');
    return detail;
  }

  private async dataset(
    access: WorkspaceAccess,
    principal: Principal,
    request: RequestMeta,
    datasetId: string,
    to: Target,
  ): Promise<DatasetDetail> {
    const { workspaceId } = access;
    const current = isUuid(datasetId)
      ? await this.prisma.dataset.findFirst({
          where: { id: datasetId, workspaceId },
          select: { status: true, source: { select: { status: true } } },
        })
      : null;
    if (current === null) throw notFound('dataset');
    if (current.status !== to) {
      if (current.status === 'archived') throw archivedProblem('dataset');
      if (to === 'active' && current.source.status !== 'active') {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'source_not_active',
          'Its source is paused.',
          'Resume the source first.',
        );
      }
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.dataset.updateMany({
          where: { id: datasetId, workspaceId, status: current.status },
          data: { status: to, ...(to === 'archived' ? { archivedAt: new Date() } : {}) },
        });
        if (changed.count === 0) return;
        await recordAudit(tx, {
          action: `dataset.${verb[to]}`,
          actor: { type: 'user', id: principal.userId },
          request,
          workspaceId,
          target: { type: 'dataset', id: datasetId },
          summary: { before: { status: current.status }, after: { status: to } },
        });
      });
    }
    const detail = await findDatasetDetail(this.prisma, workspaceId, datasetId);
    if (detail === null) throw notFound('dataset');
    return detail;
  }
}
