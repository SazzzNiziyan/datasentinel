/**
 * The interface every source adapter implements (docs/02 §6, D-35):
 * PostgreSQL, CSV/object storage, and HTTP/API, each independently.
 * Methods reject only with ConnectorFailure.
 */

/** Matches DataSource.type in the data model. */
export type SourceKind = 'postgres' | 'csv' | 'http_api';

/** One column as observed (docs/03 SchemaSnapshot.columns). No sample
 * values: schema history must not hold data. */
export interface ObservedColumn {
  name: string;
  /** Normalized type, e.g. "integer", "text", "timestamp". */
  type: string;
  nullable: boolean;
  /** 1-based position. */
  ordinal: number;
}

/** What profile() returns; per-column metrics are added in Phase H. */
export interface ProfileResult {
  rowCount: number;
  /** How rowCount was obtained: an exact count or a planner estimate. */
  rowCountMethod: 'exact' | 'approximate';
  columns: ObservedColumn[];
  observedAt: Date;
}

/** Limits every call gets, so a slow or huge source cannot stall a worker. */
export interface CallOptions {
  signal: AbortSignal;
}

export interface Connector<Locator> {
  readonly kind: SourceKind;
  /** Checks that the source answers and the credentials work. */
  validate(options: CallOptions): Promise<void>;
  /** Row count and columns of one dataset (table, file, or endpoint). */
  profile(locator: Locator, options: CallOptions): Promise<ProfileResult>;
  /** Releases connections. Safe to call more than once. */
  close(): Promise<void>;
  // runCheck() is added with the rule engine (roadmap Phase H), when the
  // check and evidence shapes are defined.
}
