/** One stored profile measurement (D-56). Rules read these, so each one
 * says how it was measured and when, and an estimate is never mistaken
 * for a count. */
export type Measurement = {
  metric: 'row_count' | 'null_count';
  /** Null for table-level metrics. */
  column: string | null;
  value: number;
  method: 'exact' | 'approximate';
  /** ISO time the value was read from the source. */
  observedAt: string;
};

type ProfiledColumn = {
  name: string;
  type: string;
  nativeType?: string;
  /** Null when not counted (big tables, D-52). */
  nullCount: number | null;
};

/** The `metrics` JSON of a succeeded profile snapshot: `columns` for display
 * and `measurements` for rules. Metrics that were not counted are left out. */
export function profileMetrics(profile: {
  observedAt: Date;
  rowCount: number;
  rowCountMethod: 'exact' | 'approximate';
  columns: readonly ProfiledColumn[];
}) {
  const observedAt = profile.observedAt.toISOString();
  const measurements: Measurement[] = [
    {
      metric: 'row_count',
      column: null,
      value: profile.rowCount,
      method: profile.rowCountMethod,
      observedAt,
    },
  ];
  for (const c of profile.columns) {
    if (c.nullCount === null) continue;
    // Null counts are only taken by a full scan, so they are exact.
    measurements.push({
      metric: 'null_count',
      column: c.name,
      value: c.nullCount,
      method: 'exact',
      observedAt,
    });
  }
  return {
    version: 1 as const,
    columns: profile.columns.map((c) => ({ ...c })),
    measurements,
  };
}

function isMeasurement(value: unknown): value is Measurement {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    (m.metric === 'row_count' || m.metric === 'null_count') &&
    (m.column === null || typeof m.column === 'string') &&
    typeof m.value === 'number' &&
    Number.isFinite(m.value) &&
    (m.method === 'exact' || m.method === 'approximate') &&
    typeof m.observedAt === 'string'
  );
}

/** Measurements of a stored snapshot. Snapshots written before D-56 have
 * none, and malformed entries are skipped rather than guessed. */
export function readMeasurements(metrics: unknown): Measurement[] {
  if (typeof metrics !== 'object' || metrics === null) return [];
  const { version, measurements } = metrics as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(measurements)) return [];
  return measurements.filter(isMeasurement);
}
