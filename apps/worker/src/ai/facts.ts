import { assertRedacted, redactText, type RedactionCounts } from './redact.js';

/** The only things about an incident that may reach an AI provider (D-102):
 * typed, aggregate facts and the ids of stored evidence. There is no field
 * for a row, a sample value, a connection setting, or a secret, so none can
 * be passed by accident. */
export interface IncidentFacts {
  incident: {
    id: string;
    title: string;
    severity: string;
    status: string;
    failureCount: number;
    openedAt: string;
    datasetName: string;
    sourceName: string;
    sourceType: string;
  };
  rule: {
    name: string;
    type: string;
    /** Rule parameters: column names, thresholds, ages. */
    parameters: Record<string, number | boolean | string | string[]>;
  };
  /** Newest first; aggregates the rule engine computed. */
  checks: {
    id: string;
    status: string;
    finishedAt: string | null;
    expected: Record<string, number | boolean | string>;
    actual: Record<string, number | boolean | string>;
  }[];
  schemaChanges: { kind: string; column: string }[];
  pipelineRuns: { name: string; status: string; at: string }[];
  /** Every stored piece of evidence the report may cite, with the measured
   * values stored on it (never row samples). */
  evidence: {
    id: string;
    kind: string;
    observedAt?: string;
    summary?: Record<string, number | boolean | string>;
  }[];
}

const LIMITS = { checks: 10, changes: 20, runs: 10, evidence: 30, items: 20, text: 200 } as const;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** Fields that hold only an id or a time, validated by shape instead of
 * redacted (a timestamp looks like a long number to the redactor). */
const SHAPED_KEYS = new Set(['id', 'evidenceId', 'openedAt', 'finishedAt', 'observedAt', 'at']);

export interface ProviderInput {
  /** The trusted facts block, redacted. */
  text: string;
  /** What the report may cite. */
  evidenceIds: string[];
  /** How much was scrubbed, by kind. Counts only, never the values. */
  redactions: RedactionCounts;
}

/** Builds the redacted facts text and the citable evidence ids (D-102).
 * Every string is truncated and redacted; numbers and booleans pass as they
 * are; keys must look like identifiers; lists are capped. The finished text
 * is checked once more and refused if anything slipped through. */
export function buildProviderInput(facts: IncidentFacts): ProviderInput {
  const counts: RedactionCounts = {};
  const plain = (value: unknown): string =>
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
  const s = (value: unknown): string =>
    redactText(plain(value).replace(/\s+/g, ' ').trim().slice(0, LIMITS.text), counts).text;
  const id = (value: unknown): string =>
    typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : '[invalid-id]';
  const time = (value: unknown): string =>
    typeof value === 'string' && ISO_TIME.test(value) ? value : '[invalid-time]';
  const scalar = (value: unknown): number | boolean | string | null =>
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : typeof value === 'boolean'
        ? value
        : typeof value === 'string'
          ? s(value)
          : null;
  const record = (input: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input).slice(0, LIMITS.items)) {
      if (!KEY.test(key)) continue;
      if (Array.isArray(value)) {
        out[key] = value
          .slice(0, LIMITS.items)
          .map(scalar)
          .filter((v) => v !== null);
      } else {
        const v = scalar(value);
        if (v !== null) out[key] = v;
      }
    }
    return out;
  };
  const evidence = facts.evidence.slice(0, LIMITS.evidence);
  const document = {
    incident: {
      id: id(facts.incident.id),
      title: s(facts.incident.title),
      severity: s(facts.incident.severity),
      status: s(facts.incident.status),
      failureCount: facts.incident.failureCount,
      openedAt: time(facts.incident.openedAt),
      dataset: s(facts.incident.datasetName),
      source: s(facts.incident.sourceName),
      sourceType: s(facts.incident.sourceType),
    },
    rule: {
      name: s(facts.rule.name),
      type: s(facts.rule.type),
      parameters: record(facts.rule.parameters),
    },
    checks: facts.checks.slice(0, LIMITS.checks).map((c) => ({
      evidenceId: id(c.id),
      status: s(c.status),
      finishedAt: c.finishedAt === null ? null : time(c.finishedAt),
      expected: record(c.expected),
      actual: record(c.actual),
    })),
    schemaChanges: facts.schemaChanges
      .slice(0, LIMITS.changes)
      .map((c) => ({ kind: s(c.kind), column: s(c.column) })),
    pipelineRuns: facts.pipelineRuns
      .slice(0, LIMITS.runs)
      .map((r) => ({ name: s(r.name), status: s(r.status), at: time(r.at) })),
    evidence: evidence.map((e) => ({
      id: id(e.id),
      kind: s(e.kind),
      ...(e.observedAt === undefined ? {} : { observedAt: time(e.observedAt) }),
      ...(e.summary === undefined
        ? {}
        : {
            summary: record(
              Object.fromEntries(Object.entries(e.summary).filter(([k]) => k !== 'schemaHash')),
            ),
          }),
    })),
  };
  for (const piece of freeText(document)) assertRedacted(piece);
  return {
    text: JSON.stringify(document, null, 1),
    evidenceIds: evidence.map((e) => id(e.id)).filter((v) => v !== '[invalid-id]'),
    redactions: counts,
  };
}

/** Every string in the document except the shape-checked id and time fields. */
function freeText(value: unknown, key = ''): string[] {
  if (typeof value === 'string') return SHAPED_KEYS.has(key) ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((v) => freeText(v, key));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => freeText(v, k));
  }
  return [];
}
