import {
  validateRuleDefinition,
  type RuleDefinition,
  type RunCheckJobData,
} from '@datasentinel/contracts';
import {
  ConnectorFailure,
  DUPLICATE_SCAN_LIMIT,
  columnNullCount,
  duplicateCounts,
  rangeCounts,
  tableColumns,
  tableRowCount,
  latestTimestamp,
  withPostgres,
} from '@datasentinel/connectors';
import { evaluateFreshness } from '../checks/freshness.js';
import { evaluateNotNull } from '../checks/not-null.js';
import { comparisonWindow, evaluateMetricChange } from '../checks/metric-change.js';
import type { CheckOutcome } from '../checks/outcome.js';
import {
  RangeCounter,
  evaluateRange,
  parseCsvValue,
  rangeBounds,
  rangeKind,
  type RangeBounds,
  type RangeCounts,
  type RangeKind,
} from '../checks/range.js';
import { evaluateRowCount } from '../checks/row-count.js';
import { evaluateSchema } from '../checks/schema-rule.js';
import {
  DuplicateCounter,
  evaluateUniqueness,
  type DuplicateCounts,
} from '../checks/uniqueness.js';
import { CsvRejection, scanCsv } from '../csv/scan-csv.js';
import { unlimitedSlots } from '../queue/source-slots.js';
import { loadPostgresAccess } from './postgres-access.js';
import { readMeasurements } from './profile-metrics.js';
import { readSchemaColumns, type SchemaColumn } from './schema-diff.js';
import type { TestConnectionDeps } from './test-connection.js';
import { openIncidentForCheck } from '../incidents/open-incident.js';

type LatestUpload = {
  rowCount: number;
  /** Normalized type per column, from the profile. */
  types: ReadonlyMap<string, string>;
  objectKey: string;
  sizeBytes: number;
  checksumSha256: string;
};

/** The CSV dataset's latest profiled upload; null when there is none yet. */
async function latestUpload(
  { prisma }: TestConnectionDeps,
  target: Target,
): Promise<LatestUpload | null> {
  const profile = await prisma.profileSnapshot.findFirst({
    where: {
      workspaceId: target.workspaceId,
      datasetId: target.datasetId,
      status: 'succeeded',
      uploadId: { not: null },
    },
    orderBy: { observedAt: 'desc' },
    select: {
      rowCount: true,
      metrics: true,
      upload: { select: { objectKey: true, sizeBytes: true, checksumSha256: true } },
    },
  });
  if (profile?.upload == null) return null;
  const listed = (profile.metrics as { columns?: unknown }).columns;
  const types = new Map<string, string>();
  for (const c of Array.isArray(listed) ? (listed as unknown[]) : []) {
    const { name, type } = (c ?? {}) as { name?: unknown; type?: unknown };
    if (typeof name === 'string' && typeof type === 'string') types.set(name, type);
  }
  return { rowCount: Number(profile.rowCount ?? 0), types, ...profile.upload };
}

/** Reads the upload again in one pass (D-61), giving `onValues` the named
 * columns of each row. The file must still match its recorded size and
 * checksum; columns the profile lacks are not_found. */
async function rereadUpload(
  { open }: TestConnectionDeps,
  upload: LatestUpload,
  columns: readonly string[],
  onValues: (values: string[]) => void,
): Promise<void> {
  if (!columns.every((c) => upload.types.has(c))) throw new ConnectorFailure('not_found');
  if (open === undefined) throw new Error('run-check needs a storage opener for CSV checks');
  const body = await open(upload.objectKey);
  if (body === null) throw new ConnectorFailure('not_found');
  let indexes: number[] | undefined;
  try {
    await scanCsv(body, {
      sizeBytes: upload.sizeBytes,
      sha256: upload.checksumSha256,
      onRow: (values, header) => {
        indexes ??= columns.map((c) => header.indexOf(c));
        onValues(indexes.map((i) => values[i] ?? ''));
      },
    });
  } catch (error) {
    // The stored file no longer reads as it did when profiled.
    if (error instanceof CsvRejection) throw new ConnectorFailure('malformed');
    throw error;
  }
}

/** Duplicate counts of a CSV dataset (D-61); null without a profile. The
 * profile's row count must be within DUPLICATE_SCAN_LIMIT before reading. */
async function csvDuplicates(
  deps: TestConnectionDeps,
  target: Target,
  columns: readonly string[],
): Promise<DuplicateCounts | null> {
  const upload = await latestUpload(deps, target);
  if (upload === null) return null;
  if (upload.rowCount > DUPLICATE_SCAN_LIMIT) throw new ConnectorFailure('too_large');
  const counter = new DuplicateCounter();
  await rereadUpload(deps, upload, columns, (key) => counter.add(key));
  return counter.result();
}

/** Range counts of a CSV column (D-63); null without a profile. The column
 * must have a numeric or date type matching the bounds. Memory stays at a
 * few counters, so no row limit applies beyond the upload size limit. */
async function csvRange(
  deps: TestConnectionDeps,
  target: Target,
  column: string,
  bounds: RangeBounds,
): Promise<RangeCounts | null> {
  const upload = await latestUpload(deps, target);
  if (upload === null) return null;
  const type = upload.types.get(column);
  if (type === undefined) throw new ConnectorFailure('not_found');
  checkRangeKind(type, bounds.kind);
  const counter = new RangeCounter(bounds);
  await rereadUpload(deps, upload, [column], ([raw]) => {
    const value = parseCsvValue(bounds.kind, raw ?? '');
    if (value !== null) counter.add(value);
  });
  return counter.result();
}

/** Ranges apply to numeric and date columns (`unsupported` otherwise), and
 * the bounds must be of the column's kind (`invalid_config`). */
function checkRangeKind(type: string, kind: RangeKind): void {
  const columnKind = rangeKind(type);
  if (columnKind === null) throw new ConnectorFailure('unsupported');
  if (columnKind !== kind) throw new ConnectorFailure('invalid_config');
}

type Client = Parameters<Parameters<typeof withPostgres>[3]>[0];

/** The most past profiles one metric-change check reads (D-65). */
const HISTORY_LIMIT = 2000;

type Target = {
  workspaceId: string;
  sourceId: string;
  datasetId: string;
  sourceType: string;
  locator: unknown;
};

type Finish = CheckOutcome | { status: 'error'; error: Record<string, string | boolean | number> };

/** Runs one queued check (D-59). The run is claimed by moving it from
 * queued to running, so a repeated delivery does nothing. A connector
 * failure finishes the run as `error`; a busy source or an unexpected
 * error before the last attempt puts it back in the queue. */
export async function handleRunCheck(
  deps: TestConnectionDeps,
  { workspaceId, checkRunId }: RunCheckJobData,
  { finalAttempt, now = () => new Date() }: { finalAttempt: boolean; now?: () => Date },
): Promise<void> {
  const { prisma } = deps;
  const claimed = await prisma.checkRun.updateMany({
    where: { id: checkRunId, workspaceId, status: 'queued' },
    data: { status: 'running', startedAt: new Date() },
  });
  if (claimed.count === 0) {
    // A repeated delivery of a finished check still makes sure its incident
    // exists (D-80): attaching is idempotent.
    await openIncidentForCheck(prisma, workspaceId, checkRunId, now());
    return;
  }
  const started = Date.now();
  const finish = (result: Finish) =>
    prisma.checkRun.update({
      where: { id: checkRunId },
      data: { ...result, endedAt: new Date(), durationMs: Date.now() - started },
    });

  try {
    const run = await prisma.checkRun.findUniqueOrThrow({
      where: { id: checkRunId },
      select: {
        revision: { select: { definition: true } },
        rule: {
          select: {
            sourceId: true,
            datasetId: true,
            dataset: { select: { locator: true, source: { select: { type: true } } } },
          },
        },
      },
    });
    const parsed = validateRuleDefinition(run.revision.definition);
    if (!parsed.ok) throw new ConnectorFailure('invalid_config');
    const target: Target = {
      workspaceId,
      sourceId: run.rule.sourceId,
      datasetId: run.rule.datasetId,
      sourceType: run.rule.dataset.source.type,
      locator: run.rule.dataset.locator,
    };
    await finish(await evaluate(deps, parsed.definition, target, now));
  } catch (error) {
    const known = error instanceof ConnectorFailure;
    if (!finalAttempt && (!known || error.code === 'busy')) {
      await prisma.checkRun.update({
        where: { id: checkRunId },
        data: { status: 'queued', startedAt: null },
      });
      throw error;
    }
    const failure = known ? error : new ConnectorFailure('internal');
    await finish({ status: 'error', error: { ...failure.toJSON() } });
    if (!known) throw error;
    return;
  }
  // Outside the try: a problem here must not rewrite a finished check as
  // an error. The job retries, and the early return above heals it.
  await openIncidentForCheck(prisma, workspaceId, checkRunId, now());
}

async function evaluate(
  deps: TestConnectionDeps,
  rule: RuleDefinition,
  target: Target,
  now: () => Date,
): Promise<CheckOutcome> {
  switch (rule.type) {
    case 'freshness': {
      if (rule.timestampColumn === undefined) {
        const profile = await deps.prisma.profileSnapshot.findFirst({
          where: {
            workspaceId: target.workspaceId,
            datasetId: target.datasetId,
            status: 'succeeded',
          },
          orderBy: { observedAt: 'desc' },
          select: { lastUpdatedAt: true },
        });
        if (profile === null) {
          return {
            status: 'insufficient_data',
            expected: { maxAgeMinutes: rule.maxAgeMinutes, timestampColumn: null },
            actual: { reason: 'no_profile' },
          };
        }
        // Only CSV profiles know when the data changed (the upload time).
        if (profile.lastUpdatedAt === null) throw new ConnectorFailure('unsupported');
        return evaluateFreshness(rule, profile.lastUpdatedAt, now());
      }
      const column = rule.timestampColumn;
      const latest = await withTable(deps, target, (client, table) =>
        latestTimestamp(client, table, column),
      );
      return evaluateFreshness(rule, latest, now());
    }
    case 'not_null': {
      const column = rule.column;
      if (target.sourceType === 'csv') {
        const counts = await csvNullCount(deps, target, column);
        if (counts === null) {
          return {
            status: 'insufficient_data',
            expected: { column, maxNullPercent: rule.maxNullPercent },
            actual: { reason: 'no_profile' },
          };
        }
        return evaluateNotNull(rule, counts);
      }
      const counts = await withTable(deps, target, (client, table) =>
        columnNullCount(client, table, column),
      );
      return evaluateNotNull(rule, counts);
    }
    case 'uniqueness': {
      const columns = rule.columns;
      if (target.sourceType === 'csv') {
        const counts = await csvDuplicates(deps, target, columns);
        if (counts === null) {
          return {
            status: 'insufficient_data',
            expected: { columns, maxDuplicateRows: rule.maxDuplicateRows },
            actual: { reason: 'no_profile' },
          };
        }
        return evaluateUniqueness(rule, counts);
      }
      const counts = await withTable(deps, target, (client, table) =>
        duplicateCounts(client, table, columns),
      );
      return evaluateUniqueness(rule, counts);
    }
    case 'row_count': {
      if (target.sourceType === 'csv') {
        const rows = (await latestMeasurements(deps, target))?.find(
          (m) => m.metric === 'row_count',
        );
        if (rows === undefined) {
          return {
            status: 'insufficient_data',
            expected: { minRows: rule.minRows ?? null, maxRows: rule.maxRows ?? null },
            actual: { reason: 'no_profile' },
          };
        }
        return evaluateRowCount(rule, { rowCount: rows.value, method: rows.method });
      }
      const count = await withTable(deps, target, (client, table) => tableRowCount(client, table));
      return evaluateRowCount(rule, count);
    }
    case 'range': {
      const bounds = rangeBounds(rule);
      const expected = { column: rule.column, min: rule.min ?? null, max: rule.max ?? null };
      if (target.sourceType === 'csv') {
        const counts = await csvRange(deps, target, rule.column, bounds);
        if (counts === null) {
          return { status: 'insufficient_data', expected, actual: { reason: 'no_profile' } };
        }
        return evaluateRange(rule, counts);
      }
      const asParam = (v: number | null) =>
        v === null || bounds.kind === 'number' ? v : new Date(v).toISOString();
      const counts = await withTable(deps, target, (client, table) =>
        rangeCounts(client, table, rule.column, {
          kind: bounds.kind,
          low: asParam(bounds.low),
          high: asParam(bounds.high),
          highInclusive: bounds.highInclusive,
        }),
      );
      return evaluateRange(rule, counts);
    }
    case 'schema': {
      // Newest first: for CSV the newest is the current file's schema.
      const snapshots = await deps.prisma.schemaSnapshot.findMany({
        where: { workspaceId: target.workspaceId, datasetId: target.datasetId },
        orderBy: { observedAt: 'desc' },
        take: 2,
        select: { columns: true },
      });
      const read = (columns: unknown): SchemaColumn[] => {
        const parsed = readSchemaColumns(columns);
        if (parsed === null) throw new ConnectorFailure('malformed');
        return parsed;
      };
      const [newest, older] = snapshots;
      if (target.sourceType === 'csv') {
        if (newest === undefined) {
          return {
            status: 'insufficient_data',
            expected: {
              requiredColumns: rule.requiredColumns.map((c) => ({
                name: c.name,
                type: c.type ?? null,
              })),
            },
            actual: { reason: 'no_profile' },
          };
        }
        return evaluateSchema(
          rule,
          read(newest.columns),
          older === undefined ? null : read(older.columns),
        );
      }
      // Database: the live catalog, compared with the last recorded schema.
      const current = await withTable(deps, target, (client, table) => tableColumns(client, table));
      return evaluateSchema(rule, current, newest === undefined ? null : read(newest.columns));
    }
    case 'metric_change': {
      const { prisma } = deps;
      const column = rule.column ?? null;
      const pick = (metrics: unknown) =>
        readMeasurements(metrics).find((m) => m.metric === rule.metric && m.column === column);
      const where = {
        workspaceId: target.workspaceId,
        datasetId: target.datasetId,
        status: 'succeeded' as const,
      };
      const latest = await prisma.profileSnapshot.findFirst({
        where,
        orderBy: { observedAt: 'desc' },
        select: { observedAt: true, metrics: true },
      });
      const now = latest === null ? undefined : pick(latest.metrics);
      if (latest === null || now === undefined) return evaluateMetricChange(rule, null, []);
      const window = comparisonWindow(rule, latest.observedAt);
      // Bounded: at most HISTORY_LIMIT profiles, newest first.
      const past = await prisma.profileSnapshot.findMany({
        where: { ...where, observedAt: { gte: window.start, lt: window.end } },
        orderBy: { observedAt: 'desc' },
        take: HISTORY_LIMIT,
        select: { metrics: true },
      });
      const history = past.flatMap((p) => {
        const m = pick(p.metrics);
        return m === undefined ? [] : [m.value];
      });
      return evaluateMetricChange(
        rule,
        { value: now.value, method: now.method, observedAt: latest.observedAt },
        history,
      );
    }
  }
}

/** A CSV column's counts from the latest successful profile, which read
 * the whole uploaded file; null when there is no profile yet. A column the
 * profile does not have is not_found. */
async function csvNullCount(
  { prisma }: TestConnectionDeps,
  target: Target,
  column: string,
): Promise<{ rowCount: number; nullCount: number } | null> {
  const profile = await prisma.profileSnapshot.findFirst({
    where: { workspaceId: target.workspaceId, datasetId: target.datasetId, status: 'succeeded' },
    orderBy: { observedAt: 'desc' },
    select: { metrics: true },
  });
  if (profile === null) return null;
  const measurements = readMeasurements(profile.metrics);
  const rows = measurements.find((m) => m.metric === 'row_count');
  const nulls = measurements.find((m) => m.metric === 'null_count' && m.column === column);
  if (rows === undefined || nulls === undefined) throw new ConnectorFailure('not_found');
  return { rowCount: rows.value, nullCount: nulls.value };
}

/** Measurements of the dataset's latest successful profile (D-56); null
 * when there is none yet. */
async function latestMeasurements({ prisma }: TestConnectionDeps, target: Target) {
  const profile = await prisma.profileSnapshot.findFirst({
    where: { workspaceId: target.workspaceId, datasetId: target.datasetId, status: 'succeeded' },
    orderBy: { observedAt: 'desc' },
    select: { metrics: true },
  });
  return profile === null ? null : readMeasurements(profile.metrics);
}

/** Opens a read-only session on a database dataset's table, inside the
 * per-source session cap. Column checks on CSV datasets are unsupported. */
async function withTable<T>(
  { prisma, ring, policy, timeoutMs = 30_000, slots = unlimitedSlots }: TestConnectionDeps,
  target: Target,
  work: (client: Client, table: { schema: string; table: string }) => Promise<T>,
): Promise<T> {
  if (target.sourceType !== 'postgres') throw new ConnectorFailure('unsupported');
  const locator = target.locator as { schema?: unknown; table?: unknown };
  if (typeof locator.schema !== 'string' || typeof locator.table !== 'string') {
    throw new ConnectorFailure('invalid_config');
  }
  const table = { schema: locator.schema, table: locator.table };
  const { location, login } = await loadPostgresAccess(
    prisma,
    ring,
    target.workspaceId,
    target.sourceId,
  );
  return slots.run(target.sourceId, () =>
    withPostgres(location, login, { policy, timeoutMs }, (client) => work(client, table)),
  );
}
