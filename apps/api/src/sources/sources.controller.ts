import {
  CreateSourceRequest,
  RegisterDatasetRequest,
  RotateCredentialsRequest,
  type DatasetDetail,
  type DatasetSummary,
  type LifecycleStatus,
  type PostgresSettings,
  type ProfileDetail,
  type SourceDetail,
  type SourceSummary,
  type UploadFailure,
} from '@datasentinel/contracts';
import { Prisma, type PrismaClient } from '@datasentinel/db';
import { isIP } from 'node:net';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  checkAddress,
  checkHostSyntax,
  checkPort,
  credentialContext,
  sealSecret,
  type NetworkPolicy,
} from '@datasentinel/connectors';
import { CurrentRequest, recordAudit, type RequestMeta } from '../audit/audit.js';
import { SOURCE_SECURITY, type SourceSecurity } from '../credentials/credentials.js';
import { CurrentPrincipal, type Principal } from '../auth/session.guard.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import {
  CurrentWorkspace,
  isUuid,
  RequireRole,
  type WorkspaceAccess,
} from '../workspaces/workspace.guard.js';

export const notFound = (what: 'source' | 'dataset') =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    `${what}_not_found`,
    what === 'source' ? 'Data source not found.' : 'Dataset not found.',
  );

/** JSON columns hold objects; anything else is shown as empty. */
const asObject = (value: Prisma.JsonValue): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};

const ownerSelect = { select: { user: { select: { displayName: true } } } } as const;

const sourceSelect = {
  id: true,
  name: true,
  type: true,
  status: true,
  lastCheckedAt: true,
  owner: ownerSelect,
  _count: { select: { datasets: true } },
} as const;

type SourceRow = Prisma.DataSourceGetPayload<{ select: typeof sourceSelect }>;

const toSourceSummary = (s: SourceRow): SourceSummary => ({
  id: s.id,
  name: s.name,
  type: s.type,
  status: s.status,
  ownerName: s.owner?.user.displayName ?? null,
  datasetCount: s._count.datasets,
  lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
});

const datasetSelect = {
  id: true,
  name: true,
  stableKey: true,
  sourceId: true,
  status: true,
  sensitivity: true,
  source: { select: { name: true } },
} as const;

type DatasetRow = Prisma.DatasetGetPayload<{ select: typeof datasetSelect }>;

const toDatasetSummary = (d: DatasetRow): DatasetSummary => ({
  id: d.id,
  name: d.name,
  stableKey: d.stableKey,
  sourceId: d.sourceId,
  sourceName: d.source.name,
  status: d.status,
  sensitivity: d.sensitivity,
});

const profileSelect = {
  id: true,
  status: true,
  observedAt: true,
  rowCount: true,
  rowCountMethod: true,
  lastUpdatedAt: true,
  error: true,
  metrics: true,
} as const;

type ProfileRow = Prisma.ProfileSnapshotGetPayload<{ select: typeof profileSelect }>;

/** Metrics hold `columns: [{name, type, nullCount}]` in file order (D-43). */
function profileColumns(metrics: Prisma.JsonValue): ProfileDetail['columns'] {
  const columns = asObject(metrics).columns;
  if (!Array.isArray(columns)) return [];
  return columns.map((c, i) => {
    const column = asObject(c as Prisma.JsonValue);
    return {
      name: typeof column.name === 'string' ? column.name : '',
      type: typeof column.type === 'string' ? column.type : 'unknown',
      nullCount: typeof column.nullCount === 'number' ? column.nullCount : null,
      ordinal: i + 1,
    };
  });
}

const toProfileDetail = (p: ProfileRow): ProfileDetail => ({
  id: p.id,
  status: p.status,
  observedAt: p.observedAt.toISOString(),
  // Counts stay far below 2^53; bigint does not serialize to JSON.
  rowCount: p.rowCount === null ? null : Number(p.rowCount),
  rowCountMethod:
    p.rowCountMethod === 'exact' || p.rowCountMethod === 'approximate' ? p.rowCountMethod : null,
  lastUpdatedAt: p.lastUpdatedAt?.toISOString() ?? null,
  error: (p.error as UploadFailure | null) ?? null,
  columns: profileColumns(p.metrics),
});

const statuses: readonly string[] = ['active', 'paused', 'archived'] satisfies LifecycleStatus[];

/** Read routes for sources and datasets; any member may read (docs/04 §3).
 * Every query filters by the route's workspace, checked by WorkspaceGuard. */
@Controller('workspaces/:workspaceId')
export class SourcesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SOURCE_SECURITY) private readonly security: SourceSecurity,
  ) {}

  /** Archived sources only when asked for with ?status=archived. */
  @Get('sources')
  async listSources(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Query('status') status?: string,
  ): Promise<SourceSummary[]> {
    const rows = await this.prisma.dataSource.findMany({
      where: {
        workspaceId: access.workspaceId,
        status:
          status !== undefined && statuses.includes(status)
            ? (status as LifecycleStatus)
            : { not: 'archived' },
      },
      orderBy: { name: 'asc' },
      select: sourceSelect,
    });
    return rows.map(toSourceSummary);
  }

  /** CSV (D-44) or PostgreSQL (D-47) sources. PostgreSQL settings must pass
   * the destination policy (D-48); the username and password are sealed
   * with the current key in the same transaction and never returned. */
  @RequireRole('engineer')
  @Post('sources')
  async createSource(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Body() body: unknown,
  ): Promise<SourceSummary> {
    const input = CreateSourceRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Check the source details.',
        'A CSV source needs a name; a PostgreSQL source also needs a host, database, username, and password.',
      );
    }
    const source = input.data;
    if (source.type === 'postgres') {
      const problem = checkPostgresSettings(source.settings, this.security.networkPolicy);
      if (problem !== undefined) {
        throw new ProblemException(HttpStatus.BAD_REQUEST, 'invalid_destination', problem);
      }
    }
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.dataSource.create({
          data: {
            workspaceId: access.workspaceId,
            name: source.name,
            type: source.type,
            ownerMembershipId: access.membershipId,
            settings: source.type === 'postgres' ? { ...source.settings } : {},
          },
          select: sourceSelect,
        });
        if (source.type === 'postgres') {
          const sealed = sealSecret(
            this.security.ring,
            { ...source.credentials },
            credentialContext(access.workspaceId, row.id),
          );
          await tx.sourceCredential.create({
            data: {
              workspaceId: access.workspaceId,
              sourceId: row.id,
              ciphertext: new Uint8Array(sealed.ciphertext),
              keyVersion: sealed.keyVersion,
            },
          });
        }
        await recordAudit(tx, {
          action: 'source.created',
          actor: { type: 'user', id: principal.userId },
          request,
          workspaceId: access.workspaceId,
          target: { type: 'source', id: row.id },
          // Settings are not secret; credentials never enter the audit trail.
          summary: {
            after: {
              name: source.name,
              type: source.type,
              ...(source.type === 'postgres' ? { settings: { ...source.settings } } : {}),
            },
          },
        });
        return row;
      });
      return toSourceSummary(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'source_name_taken',
          'A source with this name already exists.',
          'Choose another name.',
        );
      }
      throw error;
    }
  }

  /** Replaces a database source's login (D-53): the active credential is
   * revoked and the new one sealed in one transaction, so exactly one is
   * active afterwards. Neither value is returned, logged, or audited. */
  @RequireRole('engineer')
  @Post('sources/:sourceId/credentials/rotate')
  @HttpCode(HttpStatus.OK)
  async rotateCredentials(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
  ): Promise<SourceDetail> {
    const input = RotateCredentialsRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Enter the new username and password.',
      );
    }
    const { workspaceId } = access;
    const source = isUuid(sourceId)
      ? await this.prisma.dataSource.findFirst({
          where: { id: sourceId, workspaceId },
          select: { type: true, status: true },
        })
      : null;
    if (source === null) throw notFound('source');
    if (source.type !== 'postgres' || source.status === 'archived') {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'not_rotatable',
        'Only active or paused database sources have a login to replace.',
      );
    }
    const sealed = sealSecret(
      this.security.ring,
      { ...input.data },
      credentialContext(workspaceId, sourceId),
    );
    await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.sourceCredential.updateMany({
        where: { workspaceId, sourceId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.sourceCredential.create({
        data: {
          workspaceId,
          sourceId,
          ciphertext: new Uint8Array(sealed.ciphertext),
          keyVersion: sealed.keyVersion,
        },
      });
      await recordAudit(tx, {
        action: 'source.credentials_rotated',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'source', id: sourceId },
        summary: { after: { replacedActive: revoked.count, keyVersion: sealed.keyVersion } },
      });
    });
    const detail = await findSourceDetail(this.prisma, workspaceId, sourceId);
    if (detail === null) throw notFound('source');
    return detail;
  }

  @Get('sources/:sourceId')
  async source(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('sourceId') sourceId: string,
  ): Promise<SourceDetail> {
    const s = await findSourceDetail(this.prisma, access.workspaceId, sourceId);
    if (s === null) throw notFound('source');
    return s;
  }

  @Get('datasets')
  async listDatasets(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Query('sourceId') sourceId?: string,
  ): Promise<DatasetSummary[]> {
    const rows = await this.prisma.dataset.findMany({
      where: {
        workspaceId: access.workspaceId,
        status: { not: 'archived' },
        // A malformed ID matches nothing (a uuid column cannot hold it).
        ...(sourceId === undefined ? {} : { sourceId: { in: isUuid(sourceId) ? [sourceId] : [] } }),
      },
      orderBy: { name: 'asc' },
      select: datasetSelect,
    });
    return rows.map(toDatasetSummary);
  }

  /** Registers a table or view of a database source as a dataset (D-51).
   * The stable key is "schema.table"; the locator holds the two names as
   * data, quoted as identifiers whenever a query is generated. Whether the
   * table exists is checked by the first profile. */
  @RequireRole('engineer')
  @Post('datasets')
  async registerDataset(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Body() body: unknown,
  ): Promise<DatasetDetail> {
    const input = RegisterDatasetRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Choose a source, schema, and table.',
      );
    }
    const { sourceId, schema, table } = input.data;
    const { workspaceId } = access;
    const source = await this.prisma.dataSource.findFirst({
      where: { id: sourceId, workspaceId },
      select: { type: true, status: true },
    });
    if (source === null) throw notFound('source');
    if (source.type !== 'postgres' || source.status === 'archived') {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'source_not_registrable',
        'Tables can be registered only from an active or paused database source.',
        'CSV datasets are created by uploading a file.',
      );
    }
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const created = await tx.dataset.create({
          data: {
            workspaceId,
            sourceId,
            stableKey: `${schema}.${table}`,
            name: input.data.name ?? table,
            ownerMembershipId: access.membershipId,
            locator: { schema, table },
          },
          select: { id: true },
        });
        await recordAudit(tx, {
          action: 'dataset.created',
          actor: { type: 'user', id: principal.userId },
          request,
          workspaceId,
          target: { type: 'dataset', id: created.id },
          summary: { after: { sourceId, schema, table } },
        });
        return created.id;
      });
      const detail = await findDatasetDetail(this.prisma, workspaceId, id);
      if (detail === null) throw notFound('dataset');
      return detail;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'dataset_exists',
          'This table is already registered.',
          'Open the existing dataset instead.',
        );
      }
      throw error;
    }
  }

  @Get('datasets/:datasetId')
  async dataset(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('datasetId') datasetId: string,
  ): Promise<DatasetDetail> {
    const d = await findDatasetDetail(this.prisma, access.workspaceId, datasetId);
    if (d === null) throw notFound('dataset');
    return d;
  }
}

/** A source as GET …/sources/{id} returns it; null when missing, malformed,
 * or in another workspace. */
export async function findSourceDetail(
  prisma: PrismaClient,
  workspaceId: string,
  sourceId: string,
): Promise<SourceDetail | null> {
  if (!isUuid(sourceId)) return null;
  const s = await prisma.dataSource.findFirst({
    where: { id: sourceId, workspaceId },
    select: {
      ...sourceSelect,
      settings: true,
      createdAt: true,
      archivedAt: true,
      // Only whether one exists: the ciphertext is never selected.
      _count: { select: { datasets: true, credentials: { where: { revokedAt: null } } } },
    },
  });
  if (s === null) return null;
  return {
    ...toSourceSummary(s),
    settings: asObject(s.settings),
    hasCredential: s._count.credentials > 0,
    createdAt: s.createdAt.toISOString(),
    archivedAt: s.archivedAt?.toISOString() ?? null,
  };
}

/** A dataset as GET …/datasets/{id} returns it; null when not found. */
export async function findDatasetDetail(
  prisma: PrismaClient,
  workspaceId: string,
  datasetId: string,
): Promise<DatasetDetail | null> {
  if (!isUuid(datasetId)) return null;
  const d = await prisma.dataset.findFirst({
    where: { id: datasetId, workspaceId },
    select: {
      ...datasetSelect,
      description: true,
      locator: true,
      createdAt: true,
      archivedAt: true,
      owner: ownerSelect,
      profileSnapshots: { orderBy: { observedAt: 'desc' }, take: 1, select: profileSelect },
    },
  });
  if (d === null) return null;
  const latest = d.profileSnapshots[0];
  const good =
    latest === undefined || latest.status === 'succeeded'
      ? latest
      : await prisma.profileSnapshot.findFirst({
          where: { workspaceId, datasetId: d.id, status: 'succeeded' },
          orderBy: { observedAt: 'desc' },
          select: profileSelect,
        });
  return {
    ...toDatasetSummary(d),
    description: d.description,
    ownerName: d.owner?.user.displayName ?? null,
    locator: asObject(d.locator),
    createdAt: d.createdAt.toISOString(),
    archivedAt: d.archivedAt?.toISOString() ?? null,
    latestProfile: latest === undefined ? null : toProfileDetail(latest),
    lastSuccessfulProfile: good == null ? null : toProfileDetail(good),
  };
}

/** Save-time checks (D-48): host syntax, IP literals against the policy,
 * local names, port range, and TLS. Host names are checked again after
 * DNS resolution before every connection. */
export function checkPostgresSettings(
  settings: PostgresSettings,
  policy: NetworkPolicy,
): string | undefined {
  const localName = /^localhost$|\.localhost$|\.internal$/i.test(settings.host);
  return (
    checkHostSyntax(settings.host) ??
    (isIP(settings.host) !== 0 ? checkAddress(settings.host, policy) : undefined) ??
    (localName && policy === 'public-only'
      ? 'Private and local network addresses are not allowed here.'
      : undefined) ??
    checkPort(settings.port) ??
    (settings.sslMode === 'disable' && policy === 'public-only'
      ? 'Connections without TLS are not allowed. Choose "Verify certificate" or "Require encryption".'
      : undefined)
  );
}
