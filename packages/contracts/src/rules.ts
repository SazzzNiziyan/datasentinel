/** Quality rule definitions (FR-05, D-58). Stored as versioned JSON and
 * validated here, by the API on save and by the worker before a run; there
 * is no user SQL. */
import { z } from 'zod';

/** Only critical opens an incident; warning and info show on the dashboard
 * (Q-02, D-58). */
export const ruleSeverities = ['critical', 'warning', 'info'] as const;
export type RuleSeverity = (typeof ruleSeverities)[number];

export const RULE_DEFINITION_VERSION = 1;

const column = z.string().min(1).max(256);
const percent = z.number().min(0).max(100);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A number, or a date or timestamp in ISO 8601 form. */
const bound = z.union([z.number().finite(), z.iso.date(), z.iso.datetime({ offset: true })]);

const unique = (names: readonly string[]) => new Set(names).size === names.length;

const FreshnessRule = z.strictObject({
  version: z.literal(1),
  type: z.literal('freshness'),
  /** Omitted: the dataset's last update time (for CSV, the upload time). */
  timestampColumn: column.optional(),
  maxAgeMinutes: z.number().int().min(1).max(525_600),
});

const NotNullRule = z.strictObject({
  version: z.literal(1),
  type: z.literal('not_null'),
  column,
  maxNullPercent: percent,
});

const UniquenessRule = z.strictObject({
  version: z.literal(1),
  type: z.literal('uniqueness'),
  /** Together form the key; at most 5. */
  columns: z
    .array(column)
    .min(1)
    .max(5)
    .refine(unique, { message: 'Each column can be listed once.' }),
  maxDuplicateRows: count.default(0),
});

const RowCountRule = z
  .strictObject({
    version: z.literal(1),
    type: z.literal('row_count'),
    minRows: count.optional(),
    maxRows: count.optional(),
  })
  .superRefine((r, ctx) => {
    if (r.minRows === undefined && r.maxRows === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['minRows'],
        message: 'Set a minimum, a maximum, or both.',
      });
    } else if (r.minRows !== undefined && r.maxRows !== undefined && r.maxRows < r.minRows) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxRows'],
        message: 'The maximum must not be below the minimum.',
      });
    }
  });

const RangeRule = z
  .strictObject({
    version: z.literal(1),
    type: z.literal('range'),
    column,
    min: bound.optional(),
    max: bound.optional(),
  })
  .superRefine((r, ctx) => {
    if (r.min === undefined && r.max === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['min'],
        message: 'Set a minimum, a maximum, or both.',
      });
      return;
    }
    if (r.min === undefined || r.max === undefined) return;
    if (typeof r.min !== typeof r.max) {
      ctx.addIssue({ code: 'custom', path: ['max'], message: 'Use two numbers or two dates.' });
      return;
    }
    const [low, high] =
      typeof r.min === 'number'
        ? [r.min, r.max as number]
        : [Date.parse(r.min), Date.parse(r.max as string)];
    if (high < low) {
      ctx.addIssue({
        code: 'custom',
        path: ['max'],
        message: 'The maximum must not be below the minimum.',
      });
    }
  });

const SchemaRule = z.strictObject({
  version: z.literal(1),
  type: z.literal('schema'),
  /** Each must exist; with `type`, it must also have that normalized type. */
  requiredColumns: z
    .array(z.strictObject({ name: column, type: z.string().min(1).max(64).optional() }))
    .min(1)
    .max(200)
    .refine((cs) => unique(cs.map((c) => c.name)), { message: 'Each column can be listed once.' }),
});

const MetricChangeRule = z
  .strictObject({
    version: z.literal(1),
    type: z.literal('metric_change'),
    metric: z.enum(['row_count', 'null_count']),
    /** Required for null_count, not allowed for row_count. */
    column: column.optional(),
    comparisonWindowDays: z.union([z.literal(7), z.literal(30)]),
    maxIncreasePercent: z.number().min(0).max(100_000).optional(),
    maxDropPercent: percent.optional(),
    /** Fewer successful profiles in the window gives insufficient_data (D-58). */
    minimumHistoryPoints: z.number().int().min(3).max(100).default(5),
  })
  .superRefine((r, ctx) => {
    if (r.metric === 'null_count' && r.column === undefined) {
      ctx.addIssue({ code: 'custom', path: ['column'], message: 'Choose the column to watch.' });
    }
    if (r.metric === 'row_count' && r.column !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['column'],
        message: 'Row count applies to the whole dataset.',
      });
    }
    if (r.maxIncreasePercent === undefined && r.maxDropPercent === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxDropPercent'],
        message: 'Set an allowed increase, an allowed drop, or both.',
      });
    }
  });

export const RuleDefinition = z.discriminatedUnion(
  'type',
  [
    FreshnessRule,
    NotNullRule,
    UniquenessRule,
    RowCountRule,
    RangeRule,
    SchemaRule,
    MetricChangeRule,
  ],
  { error: 'Choose a supported rule type.' },
);
export type RuleDefinition = z.infer<typeof RuleDefinition>;
export type RuleType = RuleDefinition['type'];

/** A safe validation problem: a field path and a fixed message, never the
 * submitted value. */
export interface RuleProblem {
  path: string;
  message: string;
}

export type RuleValidation =
  { ok: true; definition: RuleDefinition } | { ok: false; problems: RuleProblem[] };

export function validateRuleDefinition(input: unknown): RuleValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, problems: [{ path: '', message: 'A rule definition must be an object.' }] };
  }
  if ((input as { version?: unknown }).version !== RULE_DEFINITION_VERSION) {
    return {
      ok: false,
      problems: [{ path: 'version', message: 'This rule version is not supported.' }],
    };
  }
  const parsed = RuleDefinition.safeParse(input);
  if (parsed.success) return { ok: true, definition: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

const ruleName = z.string().trim().min(1).max(120);

/** POST …/datasets/{datasetId}/rules (engineer+, audited, D-66). The
 * definition is checked separately so its problems can be named. */
export const CreateRuleRequest = z.strictObject({
  name: ruleName,
  severity: z.enum(ruleSeverities),
  enabled: z.boolean().default(true),
  definition: z.unknown(),
});
export type CreateRuleRequest = z.infer<typeof CreateRuleRequest>;

/** PATCH …/rules/{ruleId} (engineer+, audited, D-66). `expectedVersion` is
 * the version the editor saw; a new definition or severity writes the next
 * revision. */
export const UpdateRuleRequest = z
  .strictObject({
    expectedVersion: z.number().int().min(1),
    name: ruleName.optional(),
    severity: z.enum(ruleSeverities).optional(),
    enabled: z.boolean().optional(),
    definition: z.unknown().optional(),
  })
  .refine(
    (r) =>
      r.name !== undefined ||
      r.severity !== undefined ||
      r.enabled !== undefined ||
      r.definition !== undefined,
    { message: 'Change at least one field.' },
  );
export type UpdateRuleRequest = z.infer<typeof UpdateRuleRequest>;

/** Q-04, D-58: insufficient_data is its own state, never a pass. */
export type CheckRunStatus =
  'queued' | 'running' | 'passed' | 'failed' | 'insufficient_data' | 'error';

export interface CheckRunSummary {
  id: string;
  /** The rule revision this run checked. */
  ruleVersion: number;
  trigger: 'manual' | 'schedule' | 'event';
  status: CheckRunStatus;
  /** The condition, e.g. { maxAgeMinutes }; measured values only. */
  expected: Record<string, unknown> | null;
  actual: Record<string, unknown> | null;
  /** Safe failure when status is error. */
  error: { code: string; message: string; hint?: string; retryable: boolean } | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

export interface RuleDetail {
  id: string;
  datasetId: string;
  name: string;
  type: RuleType;
  severity: RuleSeverity;
  enabled: boolean;
  /** Current revision; send it back as `expectedVersion` when editing. */
  version: number;
  definition: RuleDefinition;
  createdAt: string;
  updatedAt: string;
  /** Newest first: up to 20 on the rule, the latest one in lists. */
  recentRuns: CheckRunSummary[];
}
