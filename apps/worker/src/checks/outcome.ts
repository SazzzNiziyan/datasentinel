/** A finished check's result as stored on the check run (FR-06). Values
 * are measurements only, never row samples. */
type OutcomeValue =
  string | number | null | readonly string[] | readonly Readonly<Record<string, string | null>>[];

export type CheckOutcome = {
  status: 'passed' | 'failed' | 'insufficient_data';
  expected: Record<string, OutcomeValue>;
  actual: Record<string, OutcomeValue>;
};
