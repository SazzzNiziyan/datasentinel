import type { RuleDefinition } from '@datasentinel/contracts';
import type { CheckOutcome } from './outcome.js';

/** Freshness (D-59): passes while the newest data is at most
 * `maxAgeMinutes` old, limit included. No timestamp at all is a failure,
 * not a pass; a timestamp in the future (clock skew) counts as age zero. */
export function evaluateFreshness(
  rule: Extract<RuleDefinition, { type: 'freshness' }>,
  lastUpdatedAt: Date | null,
  now: Date,
): CheckOutcome {
  const expected = {
    maxAgeMinutes: rule.maxAgeMinutes,
    timestampColumn: rule.timestampColumn ?? null,
  };
  if (lastUpdatedAt === null) {
    return { status: 'failed', expected, actual: { lastUpdatedAt: null, ageMinutes: null } };
  }
  const ageMs = Math.max(0, now.getTime() - lastUpdatedAt.getTime());
  return {
    status: ageMs <= rule.maxAgeMinutes * 60_000 ? 'passed' : 'failed',
    expected,
    actual: {
      lastUpdatedAt: lastUpdatedAt.toISOString(),
      ageMinutes: Math.floor(ageMs / 60_000),
    },
  };
}
