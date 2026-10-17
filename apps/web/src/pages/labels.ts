import type { LifecycleStatus, Sensitivity, SourceType } from '@datasentinel/contracts';

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
