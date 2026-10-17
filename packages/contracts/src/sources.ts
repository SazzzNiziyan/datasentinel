/** Source and dataset read models (D-37). Never contain credentials. */

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

/** GET /workspaces/{workspaceId}/datasets/{datasetId} */
export interface DatasetDetail extends DatasetSummary {
  description: string | null;
  ownerName: string | null;
  locator: Record<string, unknown>;
  createdAt: string;
}
