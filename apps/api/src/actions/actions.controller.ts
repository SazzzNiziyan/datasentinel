import {
  ACTION_POLICY,
  actionHashInput,
  actionPayloadSchemas,
  actionTypes,
  APPROVAL_VALID_MS,
  DecideActionRequest,
  describeAction,
  PROPOSAL_VALID_MS,
  ProposeActionRequest,
  roleAtLeast,
  UpdateActionPolicyRequest,
  type ActionEventItem,
  type ActionItem,
  type ActionNames,
  type ActionOptions,
  type ActionType,
} from '@datasentinel/contracts';
import type { Prisma, PrismaClient } from '@datasentinel/db';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CurrentRequest, recordAudit, type RequestMeta } from '../audit/audit.js';
import { CurrentPrincipal, type Principal } from '../auth/session.guard.js';
import { SOURCE_SECURITY, type SourceSecurity } from '../credentials/credentials.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import {
  CurrentWorkspace,
  isUuid,
  RequireRole,
  type WorkspaceAccess,
} from '../workspaces/workspace.guard.js';

type Tx = Prisma.TransactionClient;

export const hashAction = (input: {
  type: string;
  workspaceId: string;
  incidentId: string;
  payload: unknown;
}): string => createHash('sha256').update(actionHashInput(input)).digest('hex');

const problem = (status: HttpStatus, code: string, title: string, detail?: string) =>
  new ProblemException(status, code, title, detail);

const actionNotFound = () => problem(HttpStatus.NOT_FOUND, 'action_not_found', 'Action not found.');
const incidentNotFound = () =>
  problem(HttpStatus.NOT_FOUND, 'incident_not_found', 'Incident not found.');

const isActionType = (value: string): value is ActionType =>
  (actionTypes as readonly string[]).includes(value);

/** Appends to an action's log (D-117). */
async function logEvent(
  tx: Tx,
  workspaceId: string,
  actionId: string,
  type: string,
  actor: { membershipId: string } | null,
  data: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  await tx.actionEvent.create({
    data: {
      workspaceId,
      actionId,
      type,
      actorType: actor === null ? 'system' : 'user',
      actorMembershipId: actor?.membershipId ?? null,
      data,
    },
  });
}

/** Moves proposals and approvals that ran out of time to `expired` (D-114),
 * with a log entry each, so nothing stale can ever be approved or run. */
async function expireStale(prisma: PrismaClient, workspaceId: string, incidentId?: string) {
  const now = new Date();
  const stale = await prisma.actionProposal.findMany({
    where: {
      workspaceId,
      ...(incidentId === undefined ? {} : { incidentId }),
      OR: [
        { status: 'proposed', proposalExpiresAt: { lt: now } },
        { status: 'approved', approvalExpiresAt: { lt: now } },
      ],
    },
    select: { id: true, status: true },
    take: 50,
  });
  for (const row of stale) {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.actionProposal.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: 'expired', finishedAt: now },
      });
      if (moved.count === 1) {
        await logEvent(tx, workspaceId, row.id, 'expired', null, { was: row.status });
      }
    });
  }
}

/** Recovery actions: propose, preview, approve, reject, cancel (D-113 to
 * D-117). Nothing here runs an action; an approved action is picked up by the
 * worker, which checks everything again (D-118). */
@Controller('workspaces/:workspaceId')
export class ActionsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SOURCE_SECURITY) private readonly security: SourceSecurity,
  ) {}

  @RequireRole('viewer')
  @Get('action-policy')
  async policy(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
  ): Promise<{ requireSecondApprover: boolean }> {
    const w = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { requireSecondApprover: true },
    });
    return { requireSecondApprover: w.requireSecondApprover };
  }

  /** Owners decide whether a second person must approve (D-116). */
  @RequireRole('owner')
  @Put('action-policy')
  async setPolicy(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Body() body: unknown,
  ): Promise<{ requireSecondApprover: boolean }> {
    const input = UpdateActionPolicyRequest.safeParse(body);
    if (!input.success) {
      throw problem(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Send { "requireSecondApprover": true or false }.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { requireSecondApprover: true },
      });
      if (current.requireSecondApprover === input.data.requireSecondApprover) return;
      await tx.workspace.update({
        where: { id: workspaceId },
        data: { requireSecondApprover: input.data.requireSecondApprover },
      });
      await recordAudit(tx, {
        action: 'workspace.action_policy_changed',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'workspace', id: workspaceId },
        summary: {
          before: { requireSecondApprover: current.requireSecondApprover },
          after: { requireSecondApprover: input.data.requireSecondApprover },
        },
      });
    });
    return { requireSecondApprover: input.data.requireSecondApprover };
  }

  @RequireRole('viewer')
  @Get('incidents/:incidentId/actions')
  async list(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('incidentId') incidentId: string,
  ): Promise<ActionItem[]> {
    await this.incident(access.workspaceId, incidentId);
    await expireStale(this.prisma, access.workspaceId, incidentId);
    const rows = await this.prisma.actionProposal.findMany({
      where: { workspaceId: access.workspaceId, incidentId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    return this.items(access, rows);
  }

  /** What a proposal can point at, by name; no secrets. */
  @RequireRole('analyst')
  @Get('incidents/:incidentId/actions/options')
  async options(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Param('incidentId') incidentId: string,
  ): Promise<ActionOptions> {
    const incident = await this.incident(workspaceId, incidentId);
    const [rules, uploads, destinations] = await Promise.all([
      this.prisma.qualityRule.findMany({
        where: { workspaceId, datasetId: incident.datasetId, enabled: true },
        orderBy: { name: 'asc' },
        take: 50,
        select: { id: true, name: true },
      }),
      this.prisma.upload.findMany({
        where: { workspaceId, sourceId: incident.sourceId, status: 'failed' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, filename: true },
      }),
      this.prisma.destination.findMany({
        where: {
          workspaceId,
          status: 'active',
          type: {
            in: [
              'email',
              'slack',
              'webhook',
              ...(this.security.features.github ? (['github'] as const) : []),
              ...(this.security.features.n8n ? (['n8n'] as const) : []),
            ],
          },
        },
        orderBy: { name: 'asc' },
        take: 50,
        select: { id: true, name: true, type: true },
      }),
    ]);
    return { rules, uploads, destinations };
  }

  @RequireRole('analyst')
  @Post('incidents/:incidentId/actions')
  @HttpCode(HttpStatus.CREATED)
  async propose(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('incidentId') incidentId: string,
    @Body() body: unknown,
  ): Promise<ActionItem> {
    const input = ProposeActionRequest.safeParse(body);
    if (!input.success) {
      throw problem(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Check the action.',
        'Choose an action type and the one thing it applies to.',
      );
    }
    const { workspaceId, membershipId } = access;
    const proposal = input.data;
    if (!roleAtLeast(access.role, ACTION_POLICY[proposal.type].propose)) {
      throw problem(
        HttpStatus.FORBIDDEN,
        'forbidden',
        'Your role cannot propose this action.',
        `It needs at least the ${ACTION_POLICY[proposal.type].propose} role.`,
      );
    }
    const incident = await this.incident(workspaceId, incidentId);
    const created = await this.prisma.$transaction(async (tx) => {
      await this.checkTargets(tx, workspaceId, incident, proposal.type, proposal.payload);
      const payloadHash = hashAction({
        type: proposal.type,
        workspaceId,
        incidentId,
        payload: proposal.payload,
      });
      const open = await tx.actionProposal.findFirst({
        where: {
          workspaceId,
          incidentId,
          payloadHash,
          status: { in: ['proposed', 'approved', 'running'] },
        },
        select: { id: true },
      });
      if (open !== null) {
        throw problem(
          HttpStatus.CONFLICT,
          'action_already_pending',
          'This action is already waiting or running.',
        );
      }
      const row = await tx.actionProposal.create({
        data: {
          workspaceId,
          incidentId,
          type: proposal.type,
          payload: proposal.payload,
          payloadHash,
          note: proposal.note || null,
          proposedByMembershipId: membershipId,
          proposalExpiresAt: new Date(Date.now() + PROPOSAL_VALID_MS),
        },
      });
      await logEvent(
        tx,
        workspaceId,
        row.id,
        'proposed',
        { membershipId },
        {
          hash: payloadHash.slice(0, 12),
        },
      );
      await recordAudit(tx, {
        action: 'action.proposed',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'incident', id: incidentId },
        summary: { actionId: row.id, type: proposal.type, hash: payloadHash.slice(0, 12) },
      });
      return row;
    });
    return (await this.items(access, [created]))[0]!;
  }

  @RequireRole('engineer')
  @Post('actions/:actionId/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ): Promise<ActionItem> {
    const note = this.note(body);
    const { workspaceId, membershipId } = access;
    if (!isUuid(actionId)) throw actionNotFound();
    // Expiry is saved before anything can fail, so it is never rolled back.
    await expireStale(this.prisma, workspaceId);
    const row = await this.prisma.$transaction(async (tx) => {
      const action = await this.lock(tx, workspaceId, actionId);
      const type = this.typeOf(action.type);
      if (action.status === 'expired') {
        throw problem(
          HttpStatus.CONFLICT,
          'action_expired',
          'This proposal has expired. Propose it again.',
        );
      }
      if (!roleAtLeast(access.role, ACTION_POLICY[type].approve)) {
        throw problem(
          HttpStatus.FORBIDDEN,
          'forbidden',
          'Your role cannot approve this action.',
          `It needs at least the ${ACTION_POLICY[type].approve} role.`,
        );
      }
      if (action.status !== 'proposed') {
        throw problem(
          HttpStatus.CONFLICT,
          'action_not_proposed',
          'This action is no longer waiting for approval.',
        );
      }
      if (action.proposalExpiresAt.getTime() <= Date.now()) {
        throw problem(
          HttpStatus.CONFLICT,
          'action_expired',
          'This proposal has expired. Propose it again.',
        );
      }
      const workspace = await tx.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { requireSecondApprover: true },
      });
      if (workspace.requireSecondApprover && action.proposedByMembershipId === membershipId) {
        throw problem(
          HttpStatus.CONFLICT,
          'self_approval',
          'You cannot approve your own proposal.',
          'This workspace needs a second person to approve.',
        );
      }
      // What is stored must still hash to what was proposed.
      const hash = hashAction({
        type: action.type,
        workspaceId,
        incidentId: action.incidentId,
        payload: action.payload,
      });
      if (hash !== action.payloadHash) {
        throw problem(
          HttpStatus.CONFLICT,
          'payload_changed',
          'This action no longer matches what was proposed.',
        );
      }
      const incident = await this.incident(workspaceId, action.incidentId, tx);
      await this.checkTargets(tx, workspaceId, incident, type, action.payload);
      const approved = await tx.actionProposal.update({
        where: { id: actionId },
        data: {
          status: 'approved',
          approvedPayloadHash: action.payloadHash,
          approvalExpiresAt: new Date(Date.now() + APPROVAL_VALID_MS),
          decidedByMembershipId: membershipId,
          decidedAt: new Date(),
          decisionNote: note,
          nextAttemptAt: new Date(),
        },
      });
      await logEvent(
        tx,
        workspaceId,
        actionId,
        'approved',
        { membershipId },
        {
          hash: action.payloadHash.slice(0, 12),
        },
      );
      await recordAudit(tx, {
        action: 'action.approved',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'incident', id: action.incidentId },
        summary: { actionId, type: action.type, hash: action.payloadHash.slice(0, 12) },
      });
      return approved;
    });
    return (await this.items(access, [row]))[0]!;
  }

  @RequireRole('engineer')
  @Post('actions/:actionId/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ): Promise<ActionItem> {
    const note = this.note(body);
    const { workspaceId, membershipId } = access;
    if (!isUuid(actionId)) throw actionNotFound();
    const row = await this.prisma.$transaction(async (tx) => {
      const action = await this.lock(tx, workspaceId, actionId);
      const type = this.typeOf(action.type);
      if (!roleAtLeast(access.role, ACTION_POLICY[type].approve)) {
        throw problem(HttpStatus.FORBIDDEN, 'forbidden', 'Your role cannot reject this action.');
      }
      if (action.status !== 'proposed') {
        throw problem(
          HttpStatus.CONFLICT,
          'action_not_proposed',
          'This action is no longer waiting for approval.',
        );
      }
      const rejected = await tx.actionProposal.update({
        where: { id: actionId },
        data: {
          status: 'rejected',
          decidedByMembershipId: membershipId,
          decidedAt: new Date(),
          decisionNote: note,
          finishedAt: new Date(),
        },
      });
      await logEvent(tx, workspaceId, actionId, 'rejected', { membershipId });
      await recordAudit(tx, {
        action: 'action.rejected',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'incident', id: action.incidentId },
        summary: { actionId, type: action.type },
      });
      return rejected;
    });
    return (await this.items(access, [row]))[0]!;
  }

  /** The proposer can withdraw, and approvers can cancel, until it runs. */
  @RequireRole('analyst')
  @Post('actions/:actionId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('actionId') actionId: string,
  ): Promise<ActionItem> {
    const { workspaceId, membershipId } = access;
    if (!isUuid(actionId)) throw actionNotFound();
    const row = await this.prisma.$transaction(async (tx) => {
      const action = await this.lock(tx, workspaceId, actionId);
      const type = this.typeOf(action.type);
      const allowed =
        action.proposedByMembershipId === membershipId ||
        roleAtLeast(access.role, ACTION_POLICY[type].approve);
      if (!allowed)
        throw problem(HttpStatus.FORBIDDEN, 'forbidden', 'You cannot cancel this action.');
      if (action.status !== 'proposed' && action.status !== 'approved') {
        throw problem(
          HttpStatus.CONFLICT,
          'action_not_cancellable',
          'This action can no longer be cancelled.',
        );
      }
      const cancelled = await tx.actionProposal.update({
        where: { id: actionId },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      await logEvent(
        tx,
        workspaceId,
        actionId,
        'cancelled',
        { membershipId },
        { was: action.status },
      );
      await recordAudit(tx, {
        action: 'action.cancelled',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'incident', id: action.incidentId },
        summary: { actionId, type: action.type },
      });
      return cancelled;
    });
    return (await this.items(access, [row]))[0]!;
  }

  // ---- helpers ----

  private note(body: unknown): string | null {
    const parsed = DecideActionRequest.safeParse(body ?? {});
    if (!parsed.success) {
      throw problem(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'A note can be up to 300 characters.',
      );
    }
    return parsed.data.note || null;
  }

  private typeOf(value: string): ActionType {
    if (!isActionType(value))
      throw problem(HttpStatus.CONFLICT, 'action_type_unknown', 'Unknown action type.');
    return value;
  }

  private async incident(
    workspaceId: string,
    incidentId: string,
    db: PrismaClient | Tx = this.prisma,
  ) {
    const found = isUuid(incidentId)
      ? await db.incident.findFirst({
          where: { id: incidentId, workspaceId },
          select: { id: true, datasetId: true, sourceId: true },
        })
      : null;
    if (found === null) throw incidentNotFound();
    return found;
  }

  /** The row, locked for the rest of the transaction. */
  private async lock(tx: Tx, workspaceId: string, actionId: string) {
    await tx.$queryRaw`SELECT id FROM action_proposals WHERE id = ${actionId}::uuid FOR UPDATE`;
    const action = await tx.actionProposal.findFirst({ where: { id: actionId, workspaceId } });
    if (action === null) throw actionNotFound();
    return action;
  }

  /** The thing an action points at must exist in this workspace, belong to
   * this incident's dataset or source, and be in a state the action fits. */
  private async checkTargets(
    tx: Tx,
    workspaceId: string,
    incident: { datasetId: string; sourceId: string },
    type: ActionType,
    payload: unknown,
  ): Promise<void> {
    const parsed = actionPayloadSchemas[type].safeParse(payload);
    if (!parsed.success)
      throw problem(HttpStatus.BAD_REQUEST, 'invalid_request', 'The action payload is not valid.');
    const data = parsed.data as Record<string, string>;
    const unavailable = (what: string) =>
      problem(
        HttpStatus.CONFLICT,
        'target_unavailable',
        `${what} is not available for this incident.`,
      );
    if (type === 'rerun_validation') {
      const rule = await tx.qualityRule.findFirst({
        where: { id: data.ruleId, workspaceId, datasetId: incident.datasetId, enabled: true },
        select: { id: true },
      });
      if (rule === null) throw unavailable('That rule');
    } else if (type === 'retry_import') {
      const upload = await tx.upload.findFirst({
        where: { id: data.uploadId, workspaceId, sourceId: incident.sourceId, status: 'failed' },
        select: { id: true },
      });
      if (upload === null) throw unavailable('That file');
    } else {
      const wanted =
        type === 'create_github_issue'
          ? ['github']
          : type === 'trigger_n8n'
            ? ['n8n']
            : ['email', 'slack', 'webhook'];
      if (type === 'create_github_issue' && !this.security.features.github) {
        throw problem(
          HttpStatus.CONFLICT,
          'feature_disabled',
          'GitHub issue destinations are not enabled here.',
        );
      }
      if (type === 'trigger_n8n' && !this.security.features.n8n) {
        throw problem(
          HttpStatus.CONFLICT,
          'feature_disabled',
          'n8n destinations are not enabled here.',
        );
      }
      const destination = await tx.destination.findFirst({
        where: {
          id: data.destinationId,
          workspaceId,
          status: 'active',
          type: { in: wanted as ('email' | 'slack' | 'webhook' | 'github' | 'n8n')[] },
        },
        select: { id: true },
      });
      if (destination === null) throw unavailable('That destination');
    }
  }

  /** Builds the API shape: names for the preview, who did what, the log, and
   * what this caller may do next. */
  private async items(
    access: WorkspaceAccess,
    rows: Prisma.ActionProposalGetPayload<object>[],
  ): Promise<ActionItem[]> {
    if (rows.length === 0) return [];
    const { workspaceId, membershipId, role } = access;
    const payloadOf = (r: { payload: unknown }) => r.payload as Record<string, string>;
    const ids = (key: string) => [
      ...new Set(
        rows.map((r) => payloadOf(r)[key]).filter((v): v is string => typeof v === 'string'),
      ),
    ];
    const [rules, uploads, destinations, events, workspace] = await Promise.all([
      this.prisma.qualityRule.findMany({
        where: { workspaceId, id: { in: ids('ruleId') } },
        select: { id: true, name: true, dataset: { select: { name: true } } },
      }),
      this.prisma.upload.findMany({
        where: { workspaceId, id: { in: ids('uploadId') } },
        select: { id: true, filename: true },
      }),
      this.prisma.destination.findMany({
        where: { workspaceId, id: { in: ids('destinationId') } },
        select: { id: true, name: true, type: true, settings: true },
      }),
      this.prisma.actionEvent.findMany({
        where: { workspaceId, actionId: { in: rows.map((r) => r.id) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 400,
      }),
      this.prisma.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { requireSecondApprover: true },
      }),
    ]);
    const people = new Set<string>();
    for (const r of rows) {
      people.add(r.proposedByMembershipId);
      if (r.decidedByMembershipId !== null) people.add(r.decidedByMembershipId);
    }
    for (const e of events) if (e.actorMembershipId !== null) people.add(e.actorMembershipId);
    const members = await this.prisma.membership.findMany({
      where: { workspaceId, id: { in: [...people] } },
      select: { id: true, user: { select: { displayName: true } } },
    });
    const nameOf = new Map(members.map((m) => [m.id, m.user.displayName]));
    const now = Date.now();
    return rows.map((r) => {
      const type = isActionType(r.type) ? r.type : 'rerun_validation';
      const payload = payloadOf(r);
      const rule = rules.find((x) => x.id === payload.ruleId);
      const destination = destinations.find((x) => x.id === payload.destinationId);
      const settings = (destination?.settings ?? {}) as {
        owner?: string;
        repo?: string;
        url?: string;
      };
      const names: ActionNames = {
        ...(rule === undefined ? {} : { ruleName: rule.name, datasetName: rule.dataset.name }),
        ...(destination === undefined
          ? {}
          : {
              destinationName: destination.name,
              destinationType: destination.type,
              repository:
                settings.owner && settings.repo ? `${settings.owner}/${settings.repo}` : null,
              webhookHost: settings.url ? safeHost(settings.url) : null,
            }),
        ...(() => {
          const upload = uploads.find((x) => x.id === payload.uploadId);
          return upload === undefined ? {} : { uploadFilename: upload.filename };
        })(),
      };
      const mine = r.proposedByMembershipId === membershipId;
      const mayApprove = roleAtLeast(role, ACTION_POLICY[type].approve);
      const waiting = r.status === 'proposed' && r.proposalExpiresAt.getTime() > now;
      const log: ActionEventItem[] = events_(events, r.id, nameOf);
      return {
        id: r.id,
        type,
        status: r.status,
        payload,
        payloadHash: r.payloadHash.slice(0, 12),
        preview: describeAction(type, names),
        note: r.note,
        proposedByName: nameOf.get(r.proposedByMembershipId) ?? null,
        decidedByName:
          r.decidedByMembershipId === null ? null : (nameOf.get(r.decidedByMembershipId) ?? null),
        decisionNote: r.decisionNote,
        proposalExpiresAt: r.proposalExpiresAt.toISOString(),
        approvalExpiresAt: r.approvalExpiresAt?.toISOString() ?? null,
        attempts: r.attempts,
        failureCode: r.failureCode,
        output: (r.output ?? null) as Record<string, string> | null,
        createdAt: r.createdAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        events: log,
        can: {
          approve: waiting && mayApprove && !(workspace.requireSecondApprover && mine),
          reject: waiting && mayApprove,
          cancel: (r.status === 'proposed' || r.status === 'approved') && (mine || mayApprove),
        },
      };
    });
  }
}

function events_(
  all: Prisma.ActionEventGetPayload<object>[],
  actionId: string,
  names: Map<string, string>,
): ActionEventItem[] {
  return all
    .filter((e) => e.actionId === actionId)
    .slice(0, 30)
    .map((e) => ({
      id: e.id,
      type: e.type,
      actorType: e.actorType === 'user' ? 'user' : 'system',
      actorName: e.actorMembershipId === null ? null : (names.get(e.actorMembershipId) ?? null),
      data: e.data as Record<string, string | number | boolean | null>,
      createdAt: e.createdAt.toISOString(),
    }));
}

const safeHost = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};
