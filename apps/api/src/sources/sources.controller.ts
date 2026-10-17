import {
  CreateSourceRequest,
  type DatasetDetail,
  type DatasetSummary,
  type LifecycleStatus,
  type ProfileDetail,
  type SourceDetail,
  type SourceSummary,
  type UploadFailure,
} from '@datasentinel/contracts';
import { Prisma, type PrismaClient } from '@datasentinel/db';
import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
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

const notFound = (what: 'source' | 'dataset') =>
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
      nullCount: typeof column.nullCount === 'number' ? column.nullCount : 0,
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
  lastUpdatedAt: p.lastUpdatedAt?.toISOString() ?? null,
  error: (p.error as UploadFailure | null) ?? null,
  columns: profileColumns(p.metrics),
});

const statuses: readonly string[] = ['active', 'paused', 'archived'] satisfies LifecycleStatus[];

/** Read routes for sources and datasets; any member may read (docs/04 §3).
 * Every query filters by the route's workspace, checked by WorkspaceGuard. */
@Controller('workspaces/:workspaceId')
export class SourcesController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

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

  /** Only CSV sources so far (D-44); PostgreSQL waits for its connector. */
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
        'Enter a name for the CSV source.',
        'Only CSV sources can be added so far.',
      );
    }
    const { name, type } = input.data;
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const source = await tx.dataSource.create({
          data: {
            workspaceId: access.workspaceId,
            name,
            type,
            ownerMembershipId: access.membershipId,
          },
          select: sourceSelect,
        });
        await recordAudit(tx, {
          action: 'source.created',
          actor: { type: 'user', id: principal.userId },
          request,
          workspaceId: access.workspaceId,
          target: { type: 'source', id: source.id },
          summary: { after: { name, type } },
        });
        return source;
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

  @Get('sources/:sourceId')
  async source(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('sourceId') sourceId: string,
  ): Promise<SourceDetail> {
    if (!isUuid(sourceId)) throw notFound('source');
    const s = await this.prisma.dataSource.findFirst({
      where: { id: sourceId, workspaceId: access.workspaceId },
      select: {
        ...sourceSelect,
        settings: true,
        createdAt: true,
        archivedAt: true,
        // Only whether one exists: the ciphertext is never selected.
        _count: { select: { datasets: true, credentials: { where: { revokedAt: null } } } },
      },
    });
    if (s === null) throw notFound('source');
    return {
      ...toSourceSummary(s),
      settings: asObject(s.settings),
      hasCredential: s._count.credentials > 0,
      createdAt: s.createdAt.toISOString(),
      archivedAt: s.archivedAt?.toISOString() ?? null,
    };
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

  @Get('datasets/:datasetId')
  async dataset(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('datasetId') datasetId: string,
  ): Promise<DatasetDetail> {
    if (!isUuid(datasetId)) throw notFound('dataset');
    const d = await this.prisma.dataset.findFirst({
      where: { id: datasetId, workspaceId: access.workspaceId },
      select: {
        ...datasetSelect,
        description: true,
        locator: true,
        createdAt: true,
        owner: ownerSelect,
        profileSnapshots: { orderBy: { observedAt: 'desc' }, take: 1, select: profileSelect },
      },
    });
    if (d === null) throw notFound('dataset');
    const latest = d.profileSnapshots[0];
    const good =
      latest === undefined || latest.status === 'succeeded'
        ? latest
        : await this.prisma.profileSnapshot.findFirst({
            where: { workspaceId: access.workspaceId, datasetId: d.id, status: 'succeeded' },
            orderBy: { observedAt: 'desc' },
            select: profileSelect,
          });
    return {
      ...toDatasetSummary(d),
      description: d.description,
      ownerName: d.owner?.user.displayName ?? null,
      locator: asObject(d.locator),
      createdAt: d.createdAt.toISOString(),
      latestProfile: latest === undefined ? null : toProfileDetail(latest),
      lastSuccessfulProfile: good == null ? null : toProfileDetail(good),
    };
  }
}
