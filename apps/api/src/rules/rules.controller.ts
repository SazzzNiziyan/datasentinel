import {
  CreateRuleRequest,
  UpdateRuleRequest,
  validateRuleDefinition,
  type CheckRunSummary,
  type RuleDefinition,
  type RuleDetail,
  type RuleValidation,
} from '@datasentinel/contracts';
import type { Prisma, PrismaClient } from '@datasentinel/db';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CurrentRequest, recordAudit, type RequestMeta } from '../audit/audit.js';
import { CurrentPrincipal, type Principal } from '../auth/session.guard.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import { SOURCE_JOBS, type SourceJobs } from '../sources/source-jobs.js';
import { notFound } from '../sources/sources.controller.js';
import {
  CurrentWorkspace,
  isUuid,
  RequireRole,
  type WorkspaceAccess,
} from '../workspaces/workspace.guard.js';

/** Recent runs shown on a rule; the list shows only the latest. */
const RECENT_RUNS = 20;

const ruleNotFound = () =>
  new ProblemException(HttpStatus.NOT_FOUND, 'rule_not_found', 'Rule not found.');

const conflict = (code: string, title: string, detail: string) =>
  new ProblemException(HttpStatus.CONFLICT, code, title, detail);

/** JSON with object keys sorted, so a definition read back from jsonb
 * (which reorders keys) compares equal to the same definition sent again. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** A 400 naming each problem by field path with a fixed message (D-58). */
function invalidDefinition(result: Extract<RuleValidation, { ok: false }>): ProblemException {
  const detail = result.problems
    .map((p) => (p.path === '' ? p.message : `${p.path}: ${p.message}`))
    .join(' ');
  return new ProblemException(
    HttpStatus.BAD_REQUEST,
    'invalid_rule',
    'The rule definition is not valid.',
    detail,
  );
}

const runSelect = {
  id: true,
  trigger: true,
  status: true,
  expected: true,
  actual: true,
  error: true,
  createdAt: true,
  startedAt: true,
  endedAt: true,
  durationMs: true,
  revision: { select: { version: true } },
} as const;

const ruleSelect = (runs: number) =>
  ({
    id: true,
    datasetId: true,
    name: true,
    type: true,
    severity: true,
    enabled: true,
    currentVersion: true,
    createdAt: true,
    updatedAt: true,
    revisions: { orderBy: { version: 'desc' }, take: 1, select: { definition: true } },
    checkRuns: { orderBy: { createdAt: 'desc' }, take: runs, select: runSelect },
  }) as const;

type RuleRow = Prisma.QualityRuleGetPayload<{ select: ReturnType<typeof ruleSelect> }>;
type RunRow = RuleRow['checkRuns'][number];

const toRun = (r: RunRow): CheckRunSummary => ({
  id: r.id,
  ruleVersion: r.revision.version,
  trigger: r.trigger,
  status: r.status,
  expected: (r.expected as Record<string, unknown> | null) ?? null,
  actual: (r.actual as Record<string, unknown> | null) ?? null,
  error: (r.error as CheckRunSummary['error']) ?? null,
  createdAt: r.createdAt.toISOString(),
  startedAt: r.startedAt?.toISOString() ?? null,
  endedAt: r.endedAt?.toISOString() ?? null,
  durationMs: r.durationMs,
});

const toDetail = (r: RuleRow): RuleDetail => ({
  id: r.id,
  datasetId: r.datasetId,
  name: r.name,
  type: r.type as RuleDetail['type'],
  severity: r.severity,
  enabled: r.enabled,
  version: r.currentVersion,
  // Stored definitions were validated on save (D-58).
  definition: r.revisions[0]?.definition as RuleDefinition,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  recentRuns: r.checkRuns.map(toRun),
});

/** Quality rules (docs/04 §3, D-66). The definition and severity live in
 * immutable revisions: changing either writes the next version, so a past
 * check always points at the exact definition it ran. */
@Controller('workspaces/:workspaceId')
export class RulesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SOURCE_JOBS) private readonly queue: SourceJobs,
  ) {}

  @Get('datasets/:datasetId/rules')
  async list(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Param('datasetId') datasetId: string,
  ): Promise<RuleDetail[]> {
    await this.dataset(workspaceId, datasetId);
    const rows = await this.prisma.qualityRule.findMany({
      where: { workspaceId, datasetId },
      orderBy: { createdAt: 'asc' },
      select: ruleSelect(1),
    });
    return rows.map(toDetail);
  }

  @RequireRole('engineer')
  @Post('datasets/:datasetId/rules')
  async create(
    @CurrentWorkspace() { workspaceId, membershipId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('datasetId') datasetId: string,
    @Body() body: unknown,
  ): Promise<RuleDetail> {
    const input = CreateRuleRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Name the rule and choose its severity.',
      );
    }
    const checked = validateRuleDefinition(input.data.definition);
    if (!checked.ok) throw invalidDefinition(checked);
    const dataset = await this.dataset(workspaceId, datasetId);
    if (dataset.status === 'archived') {
      throw conflict(
        'dataset_archived',
        'This dataset is archived.',
        'Archived datasets have no new rules.',
      );
    }
    const { name, severity, enabled } = input.data;
    const id = await this.prisma.$transaction(async (tx) => {
      const rule = await tx.qualityRule.create({
        data: {
          workspaceId,
          sourceId: dataset.sourceId,
          datasetId,
          name,
          type: checked.definition.type,
          severity,
          enabled,
          currentVersion: 1,
          createdByMembershipId: membershipId,
        },
        select: { id: true },
      });
      await tx.ruleRevision.create({
        data: {
          workspaceId,
          ruleId: rule.id,
          version: 1,
          definition: checked.definition,
          severity,
          createdByMembershipId: membershipId,
        },
      });
      await recordAudit(tx, {
        action: 'rule.created',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'rule', id: rule.id },
        summary: { after: { type: checked.definition.type, severity, enabled, version: 1 } },
      });
      return rule.id;
    });
    return this.detail(workspaceId, id);
  }

  @Get('rules/:ruleId')
  get(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Param('ruleId') ruleId: string,
  ): Promise<RuleDetail> {
    return this.detail(workspaceId, ruleId);
  }

  /** Name and enabled change in place; a new definition or severity writes
   * the next revision. `expectedVersion` must match the current version, so
   * two editors cannot silently overwrite each other. */
  @RequireRole('engineer')
  @Patch('rules/:ruleId')
  async update(
    @CurrentWorkspace() { workspaceId, membershipId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('ruleId') ruleId: string,
    @Body() body: unknown,
  ): Promise<RuleDetail> {
    const input = UpdateRuleRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Send the current version and at least one change.',
      );
    }
    const { expectedVersion, name, severity, enabled, definition } = input.data;
    let next: RuleDefinition | undefined;
    if (definition !== undefined) {
      const checked = validateRuleDefinition(definition);
      if (!checked.ok) throw invalidDefinition(checked);
      next = checked.definition;
    }
    const current = isUuid(ruleId)
      ? await this.prisma.qualityRule.findFirst({
          where: { id: ruleId, workspaceId },
          select: {
            type: true,
            severity: true,
            currentVersion: true,
            revisions: { orderBy: { version: 'desc' }, take: 1, select: { definition: true } },
          },
        })
      : null;
    if (current === null) throw ruleNotFound();
    if (next !== undefined && next.type !== current.type) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'rule_type_fixed',
        'A rule keeps its type.',
        'Create a new rule for a different check.',
      );
    }
    const definitionChanged =
      next !== undefined && canonical(next) !== canonical(current.revisions[0]?.definition);
    const severityChanged = severity !== undefined && severity !== current.severity;
    const revise = definitionChanged || severityChanged;
    const version = revise ? expectedVersion + 1 : expectedVersion;

    await this.prisma.$transaction(async (tx) => {
      // Only applies while nobody else has changed the version meanwhile.
      const updated = await tx.qualityRule.updateMany({
        where: { id: ruleId, workspaceId, currentVersion: expectedVersion },
        data: {
          ...(name === undefined ? {} : { name }),
          ...(enabled === undefined ? {} : { enabled }),
          ...(severity === undefined ? {} : { severity }),
          currentVersion: version,
        },
      });
      if (updated.count === 0) {
        throw conflict(
          'rule_changed',
          'Someone else changed this rule.',
          'Reload it and make your change again.',
        );
      }
      if (revise) {
        await tx.ruleRevision.create({
          data: {
            workspaceId,
            ruleId,
            version,
            definition: (next ?? current.revisions[0]?.definition) as Prisma.InputJsonValue,
            severity: severity ?? current.severity,
            createdByMembershipId: membershipId,
          },
        });
      }
      await recordAudit(tx, {
        action: 'rule.updated',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'rule', id: ruleId },
        summary: {
          before: { version: expectedVersion, severity: current.severity },
          after: {
            version,
            severity: severity ?? current.severity,
            definitionChanged,
            ...(enabled === undefined ? {} : { enabled }),
            ...(name === undefined ? {} : { renamed: true }),
          },
        },
      });
    });
    return this.detail(workspaceId, ruleId);
  }

  /** Queues a manual check of the rule's current version (FR-06). An
   * `Idempotency-Key` header makes a retried request return the same run
   * instead of starting another. */
  @RequireRole('engineer')
  @Post('rules/:ruleId/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  async run(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Param('ruleId') ruleId: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<CheckRunSummary> {
    if (key !== undefined && !/^[\w.:-]{8,128}$/.test(key)) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_idempotency_key',
        'The Idempotency-Key header must be 8 to 128 letters, digits, or ._:- characters.',
      );
    }
    const rule = isUuid(ruleId)
      ? await this.prisma.qualityRule.findFirst({
          where: { id: ruleId, workspaceId },
          select: {
            enabled: true,
            currentVersion: true,
            dataset: { select: { status: true } },
            revisions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } },
          },
        })
      : null;
    if (rule === null) throw ruleNotFound();
    if (!rule.enabled) {
      throw conflict('rule_disabled', 'This rule is turned off.', 'Turn it on to run it.');
    }
    if (rule.dataset.status !== 'active') {
      throw conflict(
        'dataset_not_active',
        'This dataset is paused or archived.',
        'Resume it to run checks.',
      );
    }
    const revisionId = rule.revisions[0]?.id;
    if (revisionId === undefined) throw ruleNotFound();
    const idempotencyKey = `manual:${ruleId}:${key ?? randomUUID()}`;
    // Find, then create: an upsert would touch finished runs, which the
    // database refuses (D-59). A racing duplicate loses on the unique key.
    const where = { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } };
    const run =
      (await this.prisma.checkRun.findUnique({ where, select: runSelect })) ??
      (await this.prisma.checkRun
        .create({
          data: {
            workspaceId,
            ruleId,
            ruleRevisionId: revisionId,
            trigger: 'manual',
            idempotencyKey,
          },
          select: runSelect,
        })
        .catch(async (error: unknown) => {
          const again = await this.prisma.checkRun.findUnique({ where, select: runSelect });
          if (again === null) throw error;
          return again;
        }));
    // The job ID repeats for the same run, so a retry cannot run it twice.
    if (run.status === 'queued') await this.queue.enqueueCheck({ workspaceId, checkRunId: run.id });
    return toRun(run);
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

  private async detail(workspaceId: string, ruleId: string): Promise<RuleDetail> {
    const row = isUuid(ruleId)
      ? await this.prisma.qualityRule.findFirst({
          where: { id: ruleId, workspaceId },
          select: ruleSelect(RECENT_RUNS),
        })
      : null;
    if (row === null) throw ruleNotFound();
    return toDetail(row);
  }
}
