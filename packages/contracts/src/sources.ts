/** Source and dataset read models (D-37). Never contain credentials. */
import { z } from 'zod';
import type { UploadFailure } from './uploads.ts';

export type SourceType = 'postgres' | 'csv' | 'http_api' | 'pipeline_event';
export type LifecycleStatus = 'active' | 'paused' | 'archived';
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

/** One entry of GET /workspaces/{workspaceId}/sources */
export interface SourceSummary {
  id: string;
  name: string;
  type: SourceType;
  status: LifecycleStatus;
  ownerName: string | null;
  datasetCount: number;
  lastCheckedAt: string | null;
}

/** GET /workspaces/{workspaceId}/sources/{sourceId} */
export interface SourceDetail extends SourceSummary {
  /** Non-secret connection settings, e.g. host and database name. */
  settings: Record<string, unknown>;
  /** Whether an active credential is stored; its value is never returned. */
  hasCredential: boolean;
  createdAt: string;
  archivedAt: string | null;
}

/** One entry of GET /workspaces/{workspaceId}/datasets */
export interface DatasetSummary {
  id: string;
  name: string;
  stableKey: string;
  sourceId: string;
  sourceName: string;
  status: LifecycleStatus;
  sensitivity: Sensitivity;
}

/** One column of a profile: what was observed, never sample values. */
export interface ProfileColumn {
  name: string;
  /** Normalized type, e.g. "integer", "text", "timestamp" (D-43). */
  type: string;
  /** Empty or missing values; null when not counted (big tables, D-52). */
  nullCount: number | null;
  /** 1-based position. */
  ordinal: number;
}

/** The newest profile attempt of a dataset (D-43, D-44). */
export interface ProfileDetail {
  id: string;
  status: 'succeeded' | 'failed';
  observedAt: string;
  /** Null when the attempt failed: a failure is never a zero-row profile. */
  rowCount: number | null;
  /** "approximate" when the row count is the database's estimate. */
  rowCountMethod: 'exact' | 'approximate' | null;
  /** When the data last changed; for CSV, the upload time. */
  lastUpdatedAt: string | null;
  error: UploadFailure | null;
  /** Empty when the attempt failed. */
  columns: ProfileColumn[];
}

/** GET /workspaces/{workspaceId}/datasets/{datasetId} */
export interface DatasetDetail extends DatasetSummary {
  description: string | null;
  ownerName: string | null;
  locator: Record<string, unknown>;
  createdAt: string;
  archivedAt: string | null;
  /** The newest profile attempt, which may have failed. */
  latestProfile: ProfileDetail | null;
  /** The newest successful one: what the dataset is known to look like. */
  lastSuccessfulProfile: ProfileDetail | null;
}

/** TLS for PostgreSQL sources (D-48): verify-full checks the certificate and
 * host name; require only encrypts; disable is refused unless the server
 * allows private networks (development). */
export const postgresSslModes = ['verify-full', 'require', 'disable'] as const;

/** Non-secret PostgreSQL settings, stored as the source's `settings`. */
export const PostgresSettings = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65_535).default(5432),
  database: z.string().trim().min(1).max(63),
  sslMode: z.enum(postgresSslModes).default('verify-full'),
});
export type PostgresSettings = z.infer<typeof PostgresSettings>;

const sourceName = z.string().trim().min(1).max(80);

/** POST /workspaces/{workspaceId}/sources (engineer+). The PostgreSQL
 * username and password are write-only: stored encrypted, never returned. */
export const CreateSourceRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('csv'), name: sourceName }),
  z.object({
    type: z.literal('postgres'),
    name: sourceName,
    settings: PostgresSettings,
    credentials: z.object({
      username: z.string().min(1).max(63),
      password: z.string().min(1).max(1024),
    }),
  }),
]);
export type CreateSourceRequest = z.infer<typeof CreateSourceRequest>;

/** POST …/sources/{sourceId}/connection-tests and GET …/connection-tests/{id} (D-49). */
export interface ConnectionTestDetail {
  id: string;
  sourceId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  /** e.g. "16.4", when it succeeded. */
  serverVersion: string | null;
  latencyMs: number | null;
  error: UploadFailure | null;
  createdAt: string;
  finishedAt: string | null;
}

/** One readable table or view of a database source (D-50). */
export interface DiscoveredTable {
  schema: string;
  name: string;
  kind: 'table' | 'view' | 'materialized_view' | 'foreign_table';
  estimatedRows: number | null;
}

/** POST …/sources/{sourceId}/discoveries */
export interface TableDiscovery {
  tables: DiscoveredTable[];
  truncated: boolean;
}

/** What the worker answers for a discovery job: the tables, or a safe failure. */
export type DiscoveryOutcome =
  { ok: true; discovery: TableDiscovery } | { ok: false; error: UploadFailure };

/** A PostgreSQL identifier as stored: 1–63 characters, no NUL. */
const identifier = z
  .string()
  .min(1)
  .max(63)
  .refine((v) => !v.includes('\0'));

/** POST /workspaces/{workspaceId}/datasets (engineer+): register a table or
 * view of a database source (D-51). The locator is never SQL. */
export const RegisterDatasetRequest = z.object({
  sourceId: z.uuid(),
  schema: identifier,
  table: identifier,
  /** Shown name; defaults to the table name. */
  name: z.string().trim().min(1).max(120).optional(),
});
export type RegisterDatasetRequest = z.infer<typeof RegisterDatasetRequest>;

/** POST …/sources/{sourceId}/credentials/rotate (engineer+, audited, D-53).
 * Write-only: the old and new values are never returned or logged. */
export const RotateCredentialsRequest = z.object({
  username: z.string().min(1).max(63),
  password: z.string().min(1).max(1024),
});
export type RotateCredentialsRequest = z.infer<typeof RotateCredentialsRequest>;
