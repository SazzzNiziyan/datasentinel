import {
  canTransitionIncident,
  compareIncidentsByPriority,
  IncidentQuery,
  UpdateIncidentRequest,
  type EvidenceKind,
  type IncidentStatus,
  type IncidentDetail,
  type IncidentHistoryItem,
  type IncidentListItem,
  type IncidentPage,
  type IncidentRelatedRun,
} from '@datasentinel/contracts';
import type { Prisma, PrismaClient } from '@datasentinel/db';
import { Body, Controller, Get, HttpStatus, Inject, Param, Patch, Query } from '@nestjs/common';
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

/** Matches read for sorting; a bigger workspace narrows with filters. */
const SORT_WINDOW = 5000;
/** Evidence and history rows shown on one incident. */
const DETAIL_ROWS = 200;

const itemSelect = {
  id: true,
  title: true,
  severity: true,
  status: true,
  datasetId: true,
  ruleId: true,
  assignedMembershipId: true,
  failureCount: true,
  lastFailureAt: true,
  openedAt: true,
  resolvedAt: true,
  dataset: { select: { name: true } },
  assignee: { select: { user: { select: { displayName: true } } } },
} as const;

type ItemRow = Prisma.IncidentGetPayload<{ select: typeof itemSelect }>;

const toItem = (r: ItemRow): IncidentListItem => ({
  id: r.id,
  title: r.title,
  severity: r.severity,
  status: r.status,
  datasetId: r.datasetId,
  datasetName: r.dataset.name,
  ruleId: r.ruleId,
  assignedMembershipId: r.assignedMembershipId,
  assigneeName: r.assignee?.user.displayName ?? null,
  failureCount: r.failureCount,
  lastFailureAt: r.lastFailureAt.toISOString(),
  openedAt: r.openedAt.toISOString(),
  resolvedAt: r.resolvedAt?.toISOString() ?? null,
});

const incidentNotFound = () =>
  new ProblemException(HttpStatus.NOT_FOUND, 'incident_not_found', 'Incident not found.');

const conflict = (code: string, title: string, detail: string) =>
  new ProblemException(HttpStatus.CONFLICT, code, title, detail);

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Incidents for any member: the filtered list (D-82) and one incident
 * with its evidence and history (D-83). */
@Controller('workspaces/:workspaceId/incidents')
export class IncidentsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get()
  async list(
    @CurrentWorkspace() { workspaceId, membershipId }: WorkspaceAccess,
    @Query() query: unknown,
  ): Promise<IncidentPage> {
    const input = IncidentQuery.safeParse(query);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'The incident filters are not valid.',
      );
    }
    const { status, severity, datasetId, assignee, from, to, sort, limit, offset } = input.data;
    const where: Prisma.IncidentWhereInput = {
      workspaceId,
      ...(status === undefined
        ? {}
        : status === 'active'
          ? { status: { not: 'resolved' } }
          : { status }),
      ...(severity === undefined ? {} : { severity }),
      ...(datasetId === undefined ? {} : { datasetId }),
      ...(assignee === undefined
        ? {}
        : {
            assignedMembershipId:
              assignee === 'me' ? membershipId : assignee === 'unassigned' ? null : assignee,
          }),
      ...(from === undefined && to === undefined
        ? {}
        : {
            lastFailureAt: {
              ...(from === undefined ? {} : { gte: new Date(from) }),
              ...(to === undefined ? {} : { lte: new Date(to) }),
            },
          }),
    };
    const [total, keys] = await Promise.all([
      this.prisma.incident.count({ where }),
      this.prisma.incident.findMany({
        where,
        orderBy: [{ lastFailureAt: 'desc' }, { id: 'desc' }],
        take: SORT_WINDOW,
        select: { id: true, severity: true, status: true, lastFailureAt: true },
      }),
    ]);
    if (sort === 'priority') keys.sort(compareIncidentsByPriority);
    const ids = keys.slice(offset, offset + limit).map((k) => k.id);
    const rows = await this.prisma.incident.findMany({
      where: { workspaceId, id: { in: ids } },
      select: itemSelect,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const incidents = ids.flatMap((id) => {
      const r = byId.get(id);
      return r === undefined ? [] : [toItem(r)];
    });
    const next = offset + limit;
    return { incidents, total, nextOffset: next < Math.min(total, keys.length) ? next : null };
  }

  @Get(':incidentId')
  detail(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Param('incidentId') incidentId: string,
  ): Promise<IncidentDetail> {
    return this.load(workspaceId, incidentId);
  }

  /** Acknowledge, investigate, resolve, reopen, and assign (D-84). The
   * incident row is locked for the change, the status the person saw must
   * still be current, and every change writes a history event and an audit
   * record in the same transaction. */
  @RequireRole('engineer')
  @Patch(':incidentId')
  async update(
    @CurrentWorkspace() { workspaceId, membershipId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('incidentId') incidentId: string,
    @Body() body: unknown,
  ): Promise<IncidentDetail> {
    const input = UpdateIncidentRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'The incident change is not valid.',
        input.error.issues
          .map((i) => (i.path.length === 0 ? i.message : `${i.path.join('.')}: ${i.message}`))
          .join(' '),
      );
    }
    if (!isUuid(incidentId)) throw incidentNotFound();
    const { status, expectedStatus, resolutionNote, reason, assignedMembershipId } = input.data;
    const assignee =
      typeof assignedMembershipId === 'string'
        ? await this.prisma.membership.findFirst({
            where: { id: assignedMembershipId, workspaceId, status: 'active' },
            select: { id: true, user: { select: { displayName: true } } },
          })
        : null;
    if (typeof assignedMembershipId === 'string' && assignee === null) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_assignee',
        'Assign the incident to an active member of this workspace.',
      );
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const [current] = await tx.$queryRaw<
          { status: IncidentStatus; assignedMembershipId: string | null }[]
        >`SELECT status, assigned_membership_id AS "assignedMembershipId"
            FROM incidents
           WHERE id = ${incidentId}::uuid AND workspace_id = ${workspaceId}::uuid
             FOR UPDATE`;
        if (current === undefined) throw incidentNotFound();
        const now = new Date();
        const data: Prisma.IncidentUncheckedUpdateInput = {};
        const events: Omit<Prisma.IncidentEventCreateManyInput, 'createdAt'>[] = [];
        const actor = {
          workspaceId,
          incidentId,
          actorType: 'user',
          actorMembershipId: membershipId,
        };
        if (status !== undefined) {
          if (expectedStatus !== current.status) {
            throw conflict(
              'incident_changed',
              'Someone else changed this incident.',
              'Reload it and make your change again.',
            );
          }
          if (!canTransitionIncident(current.status, status)) {
            throw conflict(
              'invalid_transition',
              'That status change is not allowed.',
              `An incident that is ${current.status} cannot become ${status}.`,
            );
          }
          data.status = status;
          if (status === 'resolved') {
            data.resolvedAt = now;
            data.resolutionNote = resolutionNote ?? null;
          }
          if (status === 'reopened') data.resolvedAt = null;
          events.push({
            ...actor,
            type: status,
            fromStatus: current.status,
            toStatus: status,
            details:
              status === 'resolved'
                ? { resolutionNote: resolutionNote ?? null }
                : status === 'reopened'
                  ? { reason: reason ?? null, automatic: false }
                  : {},
          });
        }
        if (
          assignedMembershipId !== undefined &&
          assignedMembershipId !== current.assignedMembershipId
        ) {
          const previous =
            current.assignedMembershipId === null
              ? null
              : await tx.membership.findFirst({
                  where: { id: current.assignedMembershipId, workspaceId },
                  select: { user: { select: { displayName: true } } },
                });
          data.assignedMembershipId = assignedMembershipId;
          events.push({
            ...actor,
            type: assignedMembershipId === null ? 'unassigned' : 'assigned',
            details: {
              fromMembershipId: current.assignedMembershipId,
              fromName: previous?.user.displayName ?? null,
              toMembershipId: assignedMembershipId,
              toName: assignee?.user.displayName ?? null,
            },
          });
        }
        if (events.length === 0) return;
        await tx.incident.update({ where: { id: incidentId }, data });
        // One timestamp per event, in order, so the history reads in order.
        await tx.incidentEvent.createMany({
          data: events.map((e, i) => ({ ...e, createdAt: new Date(now.getTime() + i) })),
        });
        await recordAudit(tx, {
          action: 'incident.updated',
          actor: { type: 'user', id: principal.userId },
          request,
          workspaceId,
          target: { type: 'incident', id: incidentId },
          summary: {
            before: { status: current.status, assignedMembershipId: current.assignedMembershipId },
            after: {
              status: status ?? current.status,
              assignedMembershipId:
                assignedMembershipId === undefined
                  ? current.assignedMembershipId
                  : assignedMembershipId,
            },
          },
        });
      });
    } catch (error) {
      // Reopening an old incident while a newer unresolved one exists for
      // the same rule: the partial unique index (D-80) refuses it.
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'P2002'
      ) {
        throw conflict(
          'incident_exists',
          'A newer incident is already open for this rule.',
          'Work on that incident instead.',
        );
      }
      throw error;
    }
    return this.load(workspaceId, incidentId);
  }

  private async load(workspaceId: string, incidentId: string): Promise<IncidentDetail> {
    const row = isUuid(incidentId)
      ? await this.prisma.incident.findFirst({
          where: { id: incidentId, workspaceId },
          select: {
            ...itemSelect,
            sourceId: true,
            resolutionNote: true,
            rule: { select: { name: true, type: true } },
            evidence: {
              orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
              take: DETAIL_ROWS,
              select: { id: true, kind: true, referenceId: true, observedAt: true, summary: true },
            },
            events: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: DETAIL_ROWS,
              select: {
                id: true,
                type: true,
                actorType: true,
                fromStatus: true,
                toStatus: true,
                details: true,
                createdAt: true,
                actor: { select: { user: { select: { displayName: true } } } },
              },
            },
          },
        })
      : null;
    if (row === null) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'incident_not_found', 'Incident not found.');
    }
    const evidence = row.evidence.map((e) => ({
      id: e.id,
      kind: e.kind as EvidenceKind,
      referenceId: e.referenceId,
      observedAt: e.observedAt.toISOString(),
      summary: asObject(e.summary) ?? {},
    }));
    const check = evidence.find((e) => e.kind === 'check_run');
    const relatedRuns = evidence.flatMap((e): IncidentRelatedRun[] => {
      if (e.kind !== 'pipeline_run') return [];
      const s = e.summary;
      return typeof s.name === 'string' &&
        typeof s.status === 'string' &&
        typeof s.sourceName === 'string' &&
        (s.reason === 'dataset_id' || s.reason === 'correlation_id') &&
        typeof s.distanceMinutes === 'number'
        ? [
            {
              pipelineRunId: e.referenceId,
              name: s.name,
              status: s.status,
              sourceName: s.sourceName,
              reason: s.reason,
              distanceMinutes: s.distanceMinutes,
              observedAt: e.observedAt,
            },
          ]
        : [];
    });
    const history = row.events.map((h): IncidentHistoryItem => ({
      id: h.id,
      type: h.type,
      actorType: h.actorType,
      actorName: h.actor?.user.displayName ?? null,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      details: asObject(h.details) ?? {},
      createdAt: h.createdAt.toISOString(),
    }));
    return {
      ...toItem(row),
      sourceId: row.sourceId,
      ruleName: row.rule.name,
      ruleType: row.rule.type,
      resolutionNote: row.resolutionNote,
      latestCheck:
        check === undefined
          ? null
          : {
              checkRunId: check.referenceId,
              observedAt: check.observedAt,
              ruleVersion:
                typeof check.summary.ruleVersion === 'number' ? check.summary.ruleVersion : null,
              expected: asObject(check.summary.expected),
              actual: asObject(check.summary.actual),
            },
      relatedRuns,
      evidence,
      history,
    };
  }
}
