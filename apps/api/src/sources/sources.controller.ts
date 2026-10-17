import type {
  DatasetDetail,
  DatasetSummary,
  LifecycleStatus,
  SourceDetail,
  SourceSummary,
} from '@datasentinel/contracts';
import type { Prisma, PrismaClient } from '@datasentinel/db';
import { Controller, Get, HttpStatus, Inject, Param, Query } from '@nestjs/common';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import { CurrentWorkspace, isUuid, type WorkspaceAccess } from '../workspaces/workspace.guard.js';

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
      },
    });
    if (d === null) throw notFound('dataset');
    return {
      ...toDatasetSummary(d),
      description: d.description,
      ownerName: d.owner?.user.displayName ?? null,
      locator: asObject(d.locator),
      createdAt: d.createdAt.toISOString(),
    };
  }
}
