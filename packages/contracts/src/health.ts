/** Readiness report from GET /health/ready (D-22). States only: no URLs,
 * errors, or topology. HTTP 200 when ready, 503 when not. */
export type DependencyName = 'database' | 'redis' | 'storage';

export type DependencyState = 'up' | 'down';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  dependencies: Partial<Record<DependencyName, DependencyState>>;
}
