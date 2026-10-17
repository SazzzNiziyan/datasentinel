import type { RuleDefinition } from '@datasentinel/contracts';
import { diffSchemas, type SchemaColumn } from '../jobs/schema-diff.js';
import type { CheckOutcome } from './outcome.js';

/** Schema (D-64): passes when every required column exists (exact,
 * case-sensitive name) and, where a type is given, has that normalized
 * type. Drift against the previous schema (D-57) is reported alongside but
 * does not decide the result; only the rule's requirements do. */
export function evaluateSchema(
  rule: Extract<RuleDefinition, { type: 'schema' }>,
  current: readonly SchemaColumn[],
  previous: readonly SchemaColumn[] | null,
): CheckOutcome {
  const byName = new Map(current.map((c) => [c.name, c]));
  const missing: string[] = [];
  const wrongType: { name: string; expected: string; actual: string }[] = [];
  for (const required of rule.requiredColumns) {
    const found = byName.get(required.name);
    if (found === undefined) missing.push(required.name);
    else if (required.type !== undefined && found.type !== required.type) {
      wrongType.push({ name: required.name, expected: required.type, actual: found.type });
    }
  }
  const drift = previous === null ? null : diffSchemas(previous, current);
  return {
    status: missing.length + wrongType.length === 0 ? 'passed' : 'failed',
    expected: {
      requiredColumns: rule.requiredColumns.map((c) => ({ name: c.name, type: c.type ?? null })),
    },
    actual: {
      missing,
      wrongType,
      added: drift?.added.map((c) => c.name) ?? [],
      removed: drift?.removed.map((c) => c.name) ?? [],
      typeChanged: drift?.typeChanged ?? [],
    },
  };
}
