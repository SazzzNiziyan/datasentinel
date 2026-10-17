import type { LifecycleStatus, Role, Sensitivity, SourceType } from '@datasentinel/contracts';

/** Words for API values, as users say them (docs/06 sentence case). */
export const sourceTypeLabel: Record<SourceType, string> = {
  postgres: 'PostgreSQL',
  csv: 'CSV upload',
  http_api: 'HTTP/API check',
  pipeline_event: 'Pipeline events',
};

/** Lifecycle, not health: health comes from check results (Phase H). */
export const lifecycleLabel: Record<LifecycleStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

export const sensitivityLabel: Record<Sensitivity, string> = {
  public: 'Public',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
};

const columnTypes: Record<string, string> = {
  boolean: 'True/false',
  integer: 'Whole number',
  decimal: 'Decimal number',
  date: 'Date',
  timestamp: 'Date and time',
  text: 'Text',
  unknown: 'Unknown (all empty)',
};

/** Inferred column types (D-43) in plain words; unexpected ones as given. */
export const columnTypeLabel = (type: string): string => columnTypes[type] ?? type;

const RANK: Record<Role, number> = { viewer: 0, analyst: 1, engineer: 2, admin: 3, owner: 4 };

/** Data engineers and above change sources, datasets, and uploads (D-02). */
export const canEdit = (role: Role): boolean => RANK[role] >= RANK.engineer;
