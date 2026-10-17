import {
  INVESTIGATION_SCHEMA_VERSION,
  INVESTIGATIONS_PER_INCIDENT_PER_DAY,
  InvestigationFeedbackRequest,
  InvestigationReport,
  PROMPT_TEMPLATE_VERSION,
  investigationFailureCodes,
  type InvestigationFailureCode,
  type InvestigationReportItem,
} from '@datasentinel/contracts';
import type { Prisma, PrismaClient } from '@datasentinel/db';
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { AI_CONFIG, type AiConfig } from '../ai/ai-config.js';
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

const reportSelect = {
  id: true,
  version: true,
  status: true,
  failureCode: true,
  report: true,
  templateVersion: true,
  schemaVersion: true,
  providerName: true,
  model: true,
  excerptCount: true,
  createdAt: true,
  completedAt: true,
  feedback: { select: { membershipId: true, rating: true } },
} as const;

type Row = Prisma.InvestigationReportGetPayload<{ select: typeof reportSelect }>;

function toItem(row: Row, membershipId: string): InvestigationReportItem {
  // Re-checked on the way out: a stored report that no longer fits the
  // schema is shown as missing, never as is.
  const parsed = row.report === null ? null : InvestigationReport.safeParse(row.report);
  const mine = row.feedback.find((f) => f.membershipId === membershipId)?.rating;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    failureCode: investigationFailureCodes.includes(row.failureCode as InvestigationFailureCode)
      ? (row.failureCode as InvestigationFailureCode)
      : null,
    report: parsed?.success === true ? parsed.data : null,
    templateVersion: row.templateVersion,
    schemaVersion: row.schemaVersion,
    providerName: row.providerName,
    model: row.model,
    excerptCount: row.excerptCount,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    feedback: {
      mine: mine === 'helpful' || mine === 'not_helpful' ? mine : null,
      helpful: row.feedback.filter((f) => f.rating === 'helpful').length,
      notHelpful: row.feedback.filter((f) => f.rating === 'not_helpful').length,
    },
  };
}

const incidentNotFound = () =>
  new ProblemException(HttpStatus.NOT_FOUND, 'incident_not_found', 'Incident not found.');
const reportNotFound = () =>
  new ProblemException(HttpStatus.NOT_FOUND, 'investigation_not_found', 'Report not found.');

/** AI investigation reports for an incident (D-108 to D-110). Asking for one
 * only records a pending report; the worker writes it later, so an incident
 * and its checks never wait for AI, and a provider failure shows up as a
 * failed report, nothing more. */
@Controller('workspaces/:workspaceId/incidents/:incidentId/investigations')
export class InvestigationsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AI_CONFIG) private readonly config: AiConfig,
  ) {}

  @RequireRole('viewer')
  @Get()
  async list(
    @CurrentWorkspace() { workspaceId, membershipId }: WorkspaceAccess,
    @Param('incidentId') incidentId: string,
  ): Promise<InvestigationReportItem[]> {
    await this.incident(workspaceId, incidentId);
    const rows = await this.prisma.investigationReport.findMany({
      where: { workspaceId, incidentId },
      orderBy: { version: 'desc' },
      take: 20,
      select: reportSelect,
    });
    return rows.map((r) => toItem(r, membershipId));
  }

  /** Requests a new version (also how a report is regenerated). Analysts and
   * above; the workspace must have opted in, one report at a time per
   * incident, and a daily cap per incident. */
  @RequireRole('analyst')
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async request(
    @CurrentWorkspace() { workspaceId, membershipId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() meta: RequestMeta,
    @Param('incidentId') incidentId: string,
  ): Promise<InvestigationReportItem> {
    await this.incident(workspaceId, incidentId);
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { aiEnabled: true },
    });
    if (!workspace.aiEnabled || !this.config.available) {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'ai_not_enabled',
        'AI investigation is not turned on for this workspace.',
        'An administrator can turn it on in Settings.',
      );
    }
    const row = await this.prisma.$transaction(async (tx) => {
      // Serialises requests for one incident, so versions never collide.
      await tx.$queryRaw`SELECT id FROM incidents WHERE id = ${incidentId}::uuid FOR UPDATE`;
      if ((await tx.investigationReport.count({ where: { incidentId, status: 'pending' } })) > 0) {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'investigation_running',
          'A report is already being written for this incident.',
        );
      }
      const today = await tx.investigationReport.count({
        where: { incidentId, createdAt: { gt: new Date(Date.now() - 86_400_000) } },
      });
      if (today >= INVESTIGATIONS_PER_INCIDENT_PER_DAY) {
        throw new ProblemException(
          HttpStatus.TOO_MANY_REQUESTS,
          'investigation_limit',
          'This incident has reached its daily limit of reports.',
          'Try again tomorrow.',
        );
      }
      const latest = await tx.investigationReport.aggregate({
        where: { incidentId },
        _max: { version: true },
      });
      const created = await tx.investigationReport.create({
        data: {
          workspaceId,
          incidentId,
          version: (latest._max.version ?? 0) + 1,
          schemaVersion: INVESTIGATION_SCHEMA_VERSION,
          templateVersion: PROMPT_TEMPLATE_VERSION,
          providerName: this.config.provider,
          requestedByMembershipId: membershipId,
        },
        select: reportSelect,
      });
      await recordAudit(tx, {
        action: 'incident.investigation_requested',
        actor: { type: 'user', id: principal.userId },
        request: meta,
        workspaceId,
        target: { type: 'incident', id: incidentId },
        summary: { reportId: created.id, version: created.version },
      });
      return created;
    });
    return toItem(row, membershipId);
  }

  /** One rating per member per report; rating again replaces it. */
  @RequireRole('analyst')
  @Post(':reportId/feedback')
  @HttpCode(HttpStatus.OK)
  async feedback(
    @CurrentWorkspace() { workspaceId, membershipId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() meta: RequestMeta,
    @Param('incidentId') incidentId: string,
    @Param('reportId') reportId: string,
    @Body() body: unknown,
  ): Promise<InvestigationReportItem> {
    const input = InvestigationFeedbackRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Choose helpful or not helpful, with an optional note of up to 500 characters.',
      );
    }
    await this.incident(workspaceId, incidentId);
    if (!isUuid(reportId)) throw reportNotFound();
    const row = await this.prisma.$transaction(async (tx) => {
      const report = await tx.investigationReport.findFirst({
        where: { id: reportId, workspaceId, incidentId },
        select: { id: true, status: true },
      });
      if (report === null) throw reportNotFound();
      if (report.status !== 'ready') {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'investigation_not_ready',
          'Only a finished report can be rated.',
        );
      }
      await tx.investigationFeedback.upsert({
        where: { reportId_membershipId: { reportId, membershipId } },
        create: {
          workspaceId,
          reportId,
          membershipId,
          rating: input.data.rating,
          note: input.data.note ?? null,
        },
        update: { rating: input.data.rating, note: input.data.note ?? null },
      });
      await recordAudit(tx, {
        action: 'incident.investigation_rated',
        actor: { type: 'user', id: principal.userId },
        request: meta,
        workspaceId,
        target: { type: 'incident', id: incidentId },
        summary: { reportId, rating: input.data.rating },
      });
      return tx.investigationReport.findUniqueOrThrow({
        where: { id: reportId },
        select: reportSelect,
      });
    });
    return toItem(row, membershipId);
  }

  private async incident(workspaceId: string, incidentId: string): Promise<void> {
    const found = isUuid(incidentId)
      ? await this.prisma.incident.findFirst({
          where: { id: incidentId, workspaceId },
          select: { id: true },
        })
      : null;
    if (found === null) throw incidentNotFound();
  }
}
