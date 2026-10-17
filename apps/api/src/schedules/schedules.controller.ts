import {
  CreateScheduleRequest,
  MAX_SCHEDULES_PER_DATASET,
  nextOccurrence,
  UpdateScheduleRequest,
  validateSchedule,
  type ScheduleDefinition,
  type ScheduleDetail,
  type ScheduleValidation,
} from '@datasentinel/contracts';
import type { Prisma, PrismaClient } from '@datasentinel/db';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
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

/** Occurrences shown with each schedule. */
const RECENT_OCCURRENCES = 10;

const scheduleNotFound = () =>
  new ProblemException(HttpStatus.NOT_FOUND, 'schedule_not_found', 'Schedule not found.');

const conflict = (code: string, title: string, detail: string) =>
  new ProblemException(HttpStatus.CONFLICT, code, title, detail);

/** A 400 naming each problem by field path (D-69). */
function invalidSchedule(result: Extract<ScheduleValidation, { ok: false }>): ProblemException {
  const detail = result.problems
    .map((p) => (p.path === '' ? p.message : `${p.path}: ${p.message}`))
    .join(' ');
  return new ProblemException(
    HttpStatus.BAD_REQUEST,
    'invalid_schedule',
    'The schedule is not valid.',
    detail,
  );
}

const scheduleSelect = {
  id: true,
  datasetId: true,
  ruleId: true,
  targetType: true,
  definition: true,
  enabled: true,
  nextRunAt: true,
  lastRunAt: true,
  createdAt: true,
  updatedAt: true,
  occurrences: {
    orderBy: { scheduledFor: 'desc' },
    take: RECENT_OCCURRENCES,
    select: { id: true, scheduledFor: true, status: true, skipReason: true, missedBefore: true },
  },
} as const;

type ScheduleRow = Prisma.ScheduleGetPayload<{ select: typeof scheduleSelect }>;

const toDetail = (s: ScheduleRow): ScheduleDetail => ({
  id: s.id,
  datasetId: s.datasetId,
  ruleId: s.ruleId,
  target: s.targetType,
  // Stored definitions were validated on save (D-69).
  definition: s.definition as ScheduleDefinition,
  enabled: s.enabled,
  nextRunAt: s.nextRunAt?.toISOString() ?? null,
  lastRunAt: s.lastRunAt?.toISOString() ?? null,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
  recentOccurrences: s.occurrences.map((o) => ({
    id: o.id,
    scheduledFor: o.scheduledFor.toISOString(),
    status: o.status,
    skipReason: o.skipReason,
    missedBefore: o.missedBefore,
  })),
});

/** Check schedules (D-69, D-72): create, pause, resume, change, delete.
 * The worker's scheduler claims them (D-70). */
@Controller('workspaces/:workspaceId')
export class SchedulesController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get('datasets/:datasetId/schedules')
  async list(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Param('datasetId') datasetId: string,
  ): Promise<ScheduleDetail[]> {
    await this.dataset(workspaceId, datasetId);
    const rows = await this.prisma.schedule.findMany({
      where: { workspaceId, datasetId },
      orderBy: { createdAt: 'asc' },
      select: scheduleSelect,
    });
    return rows.map(toDetail);
  }

  @RequireRole('engineer')
  @Post('datasets/:datasetId/schedules')
  async create(
    @CurrentWorkspace() { workspaceId, membershipId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('datasetId') datasetId: string,
    @Body() body: unknown,
  ): Promise<ScheduleDetail> {
    const input = CreateScheduleRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Send a schedule definition and, optionally, one rule.',
      );
    }
    const checked = validateSchedule(input.data.definition);
    if (!checked.ok) throw invalidSchedule(checked);
    const dataset = await this.dataset(workspaceId, datasetId);
    if (dataset.status === 'archived') {
      throw conflict(
        'dataset_archived',
        'This dataset is archived.',
        'Archived datasets have no new schedules.',
      );
    }
    const { ruleId, enabled } = input.data;
    if (ruleId !== undefined) {
      const rule = await this.prisma.qualityRule.findFirst({
        where: { id: ruleId, workspaceId, datasetId },
        select: { id: true },
      });
      if (rule === null) {
        throw new ProblemException(HttpStatus.NOT_FOUND, 'rule_not_found', 'Rule not found.');
      }
    }
    const now = new Date();
    const id = await this.prisma.$transaction(async (tx) => {
      const count = await tx.schedule.count({ where: { workspaceId, datasetId } });
      if (count >= MAX_SCHEDULES_PER_DATASET) {
        throw conflict(
          'schedule_limit',
          `A dataset can have at most ${MAX_SCHEDULES_PER_DATASET} schedules.`,
          'Change or delete one first.',
        );
      }
      const schedule = await tx.schedule.create({
        data: {
          workspaceId,
          sourceId: dataset.sourceId,
          datasetId,
          ruleId: ruleId ?? null,
          targetType: ruleId === undefined ? 'dataset' : 'rule',
          definition: checked.definition,
          enabled,
          anchorAt: now,
          nextRunAt: enabled ? nextOccurrence(checked.definition, now, now) : null,
          createdByMembershipId: membershipId,
        },
        select: { id: true },
      });
      await recordAudit(tx, {
        action: 'schedule.created',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'schedule', id: schedule.id },
        summary: { after: { kind: checked.definition.kind, enabled, ruleId: ruleId ?? null } },
      });
      return schedule.id;
    });
    return this.detail(workspaceId, id);
  }

  /** Pause, resume, or change the definition. Resuming starts at the next
   * due time; times missed while paused are not run. */
  @RequireRole('engineer')
  @Patch('schedules/:scheduleId')
  async update(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('scheduleId') scheduleId: string,
    @Body() body: unknown,
  ): Promise<ScheduleDetail> {
    const input = UpdateScheduleRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Send enabled, a definition, or both.',
      );
    }
    const current = await this.row(workspaceId, scheduleId);
    const changed = input.data.definition !== undefined;
    const checked = validateSchedule(changed ? input.data.definition : current.definition);
    if (!checked.ok) throw invalidSchedule(checked);
    const enabled = input.data.enabled ?? current.enabled;
    const now = new Date();
    const anchorAt = changed ? now : current.anchorAt;
    // A schedule the scheduler paused for a bad definition (enabled, no next
    // run) restarts here too.
    const recompute = changed || enabled !== current.enabled || current.nextRunAt === null;
    await this.prisma.$transaction(async (tx) => {
      await tx.schedule.update({
        where: { id: scheduleId },
        data: {
          enabled,
          ...(changed ? { definition: checked.definition, anchorAt } : {}),
          ...(recompute
            ? { nextRunAt: enabled ? nextOccurrence(checked.definition, now, anchorAt) : null }
            : {}),
        },
      });
      await recordAudit(tx, {
        action: 'schedule.updated',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'schedule', id: scheduleId },
        summary: {
          before: { enabled: current.enabled },
          after: { enabled, definitionChanged: changed },
        },
      });
    });
    return this.detail(workspaceId, scheduleId);
  }

  /** Deletes the schedule and its occurrence history; check runs it started
   * stay, unlinked (D-71). */
  @RequireRole('engineer')
  @Delete('schedules/:scheduleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('scheduleId') scheduleId: string,
  ): Promise<void> {
    await this.row(workspaceId, scheduleId);
    await this.prisma.$transaction(async (tx) => {
      await tx.schedule.deleteMany({ where: { id: scheduleId, workspaceId } });
      await recordAudit(tx, {
        action: 'schedule.deleted',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'schedule', id: scheduleId },
        summary: {},
      });
    });
  }

  private async dataset(workspaceId: string, datasetId: string) {
    const dataset = isUuid(datasetId)
      ? await this.prisma.dataset.findFirst({
          where: { id: datasetId, workspaceId },
          select: { sourceId: true, status: true },
        })
      : null;
    if (dataset === null) throw notFound('dataset');
    return dataset;
  }

  private async row(workspaceId: string, scheduleId: string) {
    const row = isUuid(scheduleId)
      ? await this.prisma.schedule.findFirst({
          where: { id: scheduleId, workspaceId },
          select: { definition: true, enabled: true, anchorAt: true, nextRunAt: true },
        })
      : null;
    if (row === null) throw scheduleNotFound();
    return row;
  }

  private async detail(workspaceId: string, scheduleId: string): Promise<ScheduleDetail> {
    const row = await this.prisma.schedule.findFirst({
      where: { id: scheduleId, workspaceId },
      select: scheduleSelect,
    });
    if (row === null) throw scheduleNotFound();
    return toDetail(row);
  }
}
