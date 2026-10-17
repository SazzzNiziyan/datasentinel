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
  /** Empty or missing values. */
  nullCount: number;
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
  /** The newest profile attempt, which may have failed. */
  latestProfile: ProfileDetail | null;
  /** The newest successful one: what the dataset is known to look like. */
  lastSuccessfulProfile: ProfileDetail | null;
}

/** POST /workspaces/{workspaceId}/sources (engineer+). Only CSV sources can
 * be added so far; PostgreSQL waits for its connector (Phase G). */
export const CreateSourceRequest = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.literal('csv'),
});
export type CreateSourceRequest = z.infer<typeof CreateSourceRequest>;
