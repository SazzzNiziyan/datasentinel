import {
  checkAddress,
  checkHostSyntax,
  destinationContext,
  sealSecret,
  type NetworkPolicy,
} from '@datasentinel/connectors';
import {
  CreateDestinationRequest,
  destinationTypes,
  DESTINATION_TEST_COOLDOWN_MS,
  DESTINATION_TEST_KIND,
  notificationKinds,
  RotateDestinationSecretRequest,
  TestDestinationRequest,
  UpdateDestinationRequest,
  type CreatedDestination,
  type DeliveryItem,
  type DestinationOptions,
  type DestinationSummary,
  type DestinationTestResult,
  type NotificationKind,
} from '@datasentinel/contracts';
import { Prisma, type PrismaClient } from '@datasentinel/db';
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
import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
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

const destinationSelect = {
  id: true,
  name: true,
  type: true,
  status: true,
  events: true,
  settings: true,
  ciphertext: true,
  secretRotatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type Row = Prisma.DestinationGetPayload<{ select: typeof destinationSelect }>;

type Settings = {
  recipients?: string[];
  url?: string;
  owner?: string;
  repo?: string;
  labels?: string[];
};

const toSummary = (row: Row): DestinationSummary => {
  const settings = row.settings as Settings;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    events: row.events.filter((e): e is NotificationKind =>
      (notificationKinds as readonly string[]).includes(e),
    ),
    recipients: settings.recipients ?? [],
    url: settings.url ?? null,
    repository:
      settings.owner !== undefined && settings.repo !== undefined
        ? `${settings.owner}/${settings.repo}`
        : null,
    hasSecret: row.ciphertext !== null,
    secretRotatedAt: row.secretRotatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};

/** A webhook address must not point inside the network (D-88). Host names
 * are checked again after DNS resolution before every delivery. */
export function checkWebhookAddress(url: string, policy: NetworkPolicy): string | undefined {
  const { hostname } = new URL(url);
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const localName = /^localhost$|\.localhost$|\.internal$|\.local$/i.test(host);
  return (
    checkHostSyntax(host) ??
    (isIP(host) !== 0 ? checkAddress(host, policy) : undefined) ??
    (localName && policy === 'public-only'
      ? 'Private and local network addresses are not allowed here.'
      : undefined)
  );
}

/** Alert destinations (D-88). They hold secrets and send data out, so only
 * admins manage them; secrets are sealed and never returned again. */
@Controller('workspaces/:workspaceId/destinations')
@RequireRole('admin')
export class DestinationsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SOURCE_SECURITY) private readonly security: SourceSecurity,
  ) {}

  @Get()
  async list(@CurrentWorkspace() { workspaceId }: WorkspaceAccess): Promise<DestinationSummary[]> {
    const rows = await this.prisma.destination.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: destinationSelect,
    });
    return rows.map(toSummary);
  }

  /** The destination types this deployment allows (D-96). */
  @Get('options')
  options(): DestinationOptions {
    const { features } = this.security;
    return {
      types: destinationTypes.filter(
        (t) => (t !== 'github' || features.github) && (t !== 'n8n' || features.n8n),
      ),
    };
  }

  @Post()
  async create(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Body() body: unknown,
  ): Promise<CreatedDestination> {
    const input = CreateDestinationRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Check the destination details.',
        input.error.issues[0]?.message,
      );
    }
    const data = input.data;
    this.assertEnabled(data.type);
    const events = data.type === 'github' ? ['incident_opened'] : data.events;
    const id = randomUUID();
    let settings: Settings = {};
    let secret: Record<string, string> | undefined;
    let signingSecret: string | undefined;
    if (data.type === 'email') {
      settings = { recipients: data.recipients };
    } else if (data.type === 'slack') {
      secret = { webhookUrl: data.webhookUrl };
    } else if (data.type === 'github') {
      settings = { owner: data.owner, repo: data.repo, labels: data.labels };
      secret = { token: data.token };
    } else {
      this.assertAddress(data.url);
      signingSecret = `whsec_${randomBytes(32).toString('base64url')}`;
      settings = { url: data.url };
      secret = { signingSecret };
    }
    const sealed =
      secret === undefined
        ? undefined
        : sealSecret(this.security.ring, secret, destinationContext(workspaceId, id));
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.destination.create({
          data: {
            id,
            workspaceId,
            name: data.name,
            type: data.type,
            events,
            settings,
            ...(sealed === undefined
              ? {}
              : {
                  ciphertext: new Uint8Array(sealed.ciphertext),
                  keyVersion: sealed.keyVersion,
                  secretRotatedAt: new Date(),
                }),
          },
          select: destinationSelect,
        });
        await recordAudit(tx, {
          action: 'destination.created',
          actor: { type: 'user', id: principal.userId },
          request,
          workspaceId,
          target: { type: 'destination', id },
          summary: { after: { type: data.type, name: data.name, events } },
        });
        return created;
      });
      return { ...toSummary(row), ...(signingSecret === undefined ? {} : { signingSecret }) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw nameTaken();
      }
      throw error;
    }
  }

  @Patch(':destinationId')
  async update(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('destinationId') destinationId: string,
    @Body() body: unknown,
  ): Promise<DestinationSummary> {
    const input = UpdateDestinationRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Check the destination details.',
        input.error.issues[0]?.message,
      );
    }
    const change = input.data;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = isUuid(destinationId)
          ? await tx.destination.findFirst({
              where: { id: destinationId, workspaceId },
              select: destinationSelect,
            })
          : null;
        if (current === null) throw destinationNotFound();
        if (current.status === 'archived') {
          throw new ProblemException(
            HttpStatus.CONFLICT,
            'destination_archived',
            'This destination is archived.',
          );
        }
        if (
          current.type === 'github' &&
          change.events !== undefined &&
          !(change.events.length === 1 && change.events[0] === 'incident_opened')
        ) {
          throw new ProblemException(
            HttpStatus.BAD_REQUEST,
            'invalid_request',
            'GitHub destinations only hear about opened incidents.',
          );
        }
        if (change.recipients !== undefined && current.type !== 'email') {
          throw wrongType('recipients', 'email');
        }
        if (change.url !== undefined) {
          if (current.type !== 'webhook' && current.type !== 'n8n') {
            throw wrongType('url', 'webhook or n8n');
          }
          this.assertAddress(change.url);
        }
        const settings = { ...(current.settings as Settings) };
        if (change.recipients !== undefined) settings.recipients = change.recipients;
        if (change.url !== undefined) settings.url = change.url;
        const row = await tx.destination.update({
          where: { id: current.id },
          data: {
            ...(change.name === undefined ? {} : { name: change.name }),
            ...(change.events === undefined ? {} : { events: change.events }),
            ...(change.status === undefined ? {} : { status: change.status }),
            settings,
          },
          select: destinationSelect,
        });
        await recordAudit(tx, {
          action: 'destination.updated',
          actor: { type: 'user', id: principal.userId },
          request,
          workspaceId,
          target: { type: 'destination', id: current.id },
          summary: {
            before: { name: current.name, status: current.status, events: current.events },
            after: { name: row.name, status: row.status, events: row.events },
          },
        });
        return toSummary(row);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw nameTaken();
      }
      throw error;
    }
  }

  /** Archives: delivery stops and the destination cannot be changed, but
   * its record stays for the delivery history. */
  @Delete(':destinationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archive(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('destinationId') destinationId: string,
  ): Promise<void> {
    if (!isUuid(destinationId)) throw destinationNotFound();
    await this.prisma.$transaction(async (tx) => {
      const archived = await tx.destination.updateMany({
        where: { id: destinationId, workspaceId, status: { not: 'archived' } },
        // The secret is wiped: an archived destination can never send again.
        data: { status: 'archived', archivedAt: new Date(), ciphertext: null, keyVersion: null },
      });
      if (archived.count === 0) throw destinationNotFound();
      await recordAudit(tx, {
        action: 'destination.archived',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'destination', id: destinationId },
        summary: {},
      });
    });
  }

  /** Replaces the destination's secret (D-94): the new Slack URL, or a new
   * server-generated webhook signing secret shown once. The old secret stops
   * working at once, since the sealed value is replaced in one statement. */
  @Post(':destinationId/rotate-secret')
  async rotateSecret(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('destinationId') destinationId: string,
    @Body() body: unknown,
  ): Promise<CreatedDestination> {
    const input = RotateDestinationSecretRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Check the new secret.',
        input.error.issues[0]?.message,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const current = isUuid(destinationId)
        ? await tx.destination.findFirst({
            where: { id: destinationId, workspaceId },
            select: destinationSelect,
          })
        : null;
      if (current === null) throw destinationNotFound();
      if (current.status === 'archived') {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'destination_archived',
          'This destination is archived.',
        );
      }
      this.assertEnabled(current.type);
      let secret: Record<string, string>;
      let signingSecret: string | undefined;
      if (current.type === 'github') {
        if (input.data.token === undefined) {
          throw new ProblemException(
            HttpStatus.BAD_REQUEST,
            'invalid_request',
            'Paste the new GitHub access token.',
          );
        }
        secret = { token: input.data.token };
      } else if (current.type === 'slack') {
        if (input.data.webhookUrl === undefined) {
          throw new ProblemException(
            HttpStatus.BAD_REQUEST,
            'invalid_request',
            'Enter the new Slack incoming-webhook URL.',
          );
        }
        secret = { webhookUrl: input.data.webhookUrl };
      } else if (current.type === 'webhook' || current.type === 'n8n') {
        if (input.data.webhookUrl !== undefined) throw wrongType('webhookUrl', 'slack');
        if (input.data.token !== undefined) throw wrongType('token', 'github');
        signingSecret = `whsec_${randomBytes(32).toString('base64url')}`;
        secret = { signingSecret };
      } else {
        throw new ProblemException(
          HttpStatus.BAD_REQUEST,
          'no_secret',
          'Email destinations have no secret to rotate.',
        );
      }
      const sealed = sealSecret(
        this.security.ring,
        secret,
        destinationContext(workspaceId, current.id),
      );
      const row = await tx.destination.update({
        where: { id: current.id },
        data: {
          ciphertext: new Uint8Array(sealed.ciphertext),
          keyVersion: sealed.keyVersion,
          secretRotatedAt: new Date(),
        },
        select: destinationSelect,
      });
      await recordAudit(tx, {
        action: 'destination.secret_rotated',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'destination', id: current.id },
        summary: { type: current.type },
      });
      return { ...toSummary(row), ...(signingSecret === undefined ? {} : { signingSecret }) };
    });
  }

  /** Sends one clearly labelled test through the real delivery path (D-92).
   * Needs `{ "confirm": true }`, an active destination, and at most one test
   * a minute per destination. The result shows up in the delivery history. */
  @Post(':destinationId/test')
  @HttpCode(HttpStatus.ACCEPTED)
  async test(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('destinationId') destinationId: string,
    @Body() body: unknown,
  ): Promise<DestinationTestResult> {
    if (!TestDestinationRequest.safeParse(body).success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'confirmation_required',
        'Confirm that you want to send a test.',
        'Send { "confirm": true }.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const destination = isUuid(destinationId)
        ? await tx.destination.findFirst({
            where: { id: destinationId, workspaceId },
            select: { id: true, status: true },
          })
        : null;
      if (destination === null) throw destinationNotFound();
      if (destination.status !== 'active') {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'destination_not_active',
          'Resume this destination before sending a test.',
        );
      }
      const recent = await tx.notificationDelivery.findFirst({
        where: {
          workspaceId,
          destinationId,
          kind: DESTINATION_TEST_KIND,
          createdAt: { gt: new Date(Date.now() - DESTINATION_TEST_COOLDOWN_MS) },
        },
        select: { id: true },
      });
      if (recent !== null) {
        throw new ProblemException(
          HttpStatus.TOO_MANY_REQUESTS,
          'test_too_soon',
          'A test was sent a moment ago.',
          'Wait a minute before sending another.',
        );
      }
      const delivery = await tx.notificationDelivery.create({
        data: {
          workspaceId,
          destinationId,
          // No incident is involved: the destination stands in for it.
          incidentId: destinationId,
          incidentEventId: randomUUID(),
          kind: DESTINATION_TEST_KIND,
          payload: {
            title: 'Test notification from DataSentinel',
            severity: 'info',
            datasetName: 'none (this is a test)',
          },
        },
        select: { id: true },
      });
      await recordAudit(tx, {
        action: 'destination.tested',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'destination', id: destinationId },
        summary: { deliveryId: delivery.id },
      });
      return { deliveryId: delivery.id, status: 'pending' as const };
    });
  }

  /** The destination's recent deliveries, newest first (D-93). Reasons are
   * short codes; nothing a provider said is stored or shown. */
  @Get(':destinationId/deliveries')
  async deliveries(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Param('destinationId') destinationId: string,
  ): Promise<DeliveryItem[]> {
    if (!isUuid(destinationId)) throw destinationNotFound();
    const destination = await this.prisma.destination.findFirst({
      where: { id: destinationId, workspaceId },
      select: { id: true },
    });
    if (destination === null) throw destinationNotFound();
    const rows = await this.prisma.notificationDelivery.findMany({
      where: { workspaceId, destinationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      nextAttemptAt: r.nextAttemptAt.toISOString(),
      incidentId: r.kind === DESTINATION_TEST_KIND ? null : r.incidentId,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
    }));
  }

  /** Puts a failed delivery back in the queue with a fresh attempt budget
   * (D-93). Only failed deliveries of an active destination; audited. */
  @Post(':destinationId/deliveries/:deliveryId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('destinationId') destinationId: string,
    @Param('deliveryId') deliveryId: string,
  ): Promise<{ deliveryId: string; status: 'pending' }> {
    if (!isUuid(destinationId) || !isUuid(deliveryId)) throw deliveryNotFound();
    await this.prisma.$transaction(async (tx) => {
      const destination = await tx.destination.findFirst({
        where: { id: destinationId, workspaceId },
        select: { status: true },
      });
      if (destination === null) throw destinationNotFound();
      if (destination.status !== 'active') {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'destination_not_active',
          'Resume this destination before retrying.',
        );
      }
      const requeued = await tx.notificationDelivery.updateMany({
        where: { id: deliveryId, workspaceId, destinationId, status: 'failed' },
        data: { status: 'pending', attempts: 0, nextAttemptAt: new Date() },
      });
      if (requeued.count === 0) {
        const exists = await tx.notificationDelivery.findFirst({
          where: { id: deliveryId, workspaceId, destinationId },
          select: { id: true },
        });
        if (exists === null) throw deliveryNotFound();
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'delivery_not_failed',
          'Only failed deliveries can be retried.',
        );
      }
      await recordAudit(tx, {
        action: 'destination.delivery_retried',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'destination', id: destinationId },
        summary: { deliveryId },
      });
    });
    return { deliveryId, status: 'pending' };
  }

  /** Optional destination types are refused while their flag is off (D-96). */
  private assertEnabled(type: DestinationOptions['types'][number]): void {
    const features = this.security.features;
    if ((type === 'github' && !features.github) || (type === 'n8n' && !features.n8n)) {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'feature_disabled',
        `${type === 'github' ? 'GitHub issue' : 'n8n'} destinations are not enabled here.`,
        'An administrator of this deployment can turn them on.',
      );
    }
  }

  private assertAddress(url: string): void {
    const problem = checkWebhookAddress(url, this.security.networkPolicy);
    if (problem !== undefined) {
      throw new ProblemException(HttpStatus.BAD_REQUEST, 'invalid_request', problem);
    }
  }
}

const destinationNotFound = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'destination_not_found',
    'Destination not found or already archived.',
  );

const nameTaken = () =>
  new ProblemException(
    HttpStatus.CONFLICT,
    'destination_name_taken',
    'A destination with this name already exists.',
  );

const wrongType = (field: string, type: string) =>
  new ProblemException(
    HttpStatus.BAD_REQUEST,
    'invalid_request',
    `${field} applies only to ${type} destinations.`,
  );

const deliveryNotFound = () =>
  new ProblemException(HttpStatus.NOT_FOUND, 'delivery_not_found', 'Delivery not found.');
