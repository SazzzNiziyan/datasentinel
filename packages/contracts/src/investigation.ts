import { z } from 'zod';

/** The structured AI investigation report (D-100). The model must return
 * exactly this shape; anything else is rejected, never repaired. It keeps
 * what is known (facts) apart from what is guessed (hypotheses), says how
 * sure it is, links every claim to stored evidence, and lists what it could
 * not know. It is advice only: nothing in it is executable. */
export const INVESTIGATION_SCHEMA_VERSION = 1;

export const investigationConfidences = ['low', 'medium', 'high'] as const;
export type InvestigationConfidence = (typeof investigationConfidences)[number];

export const REPORT_LIMITS = {
  summary: 600,
  statement: 300,
  check: 300,
  limitation: 200,
  facts: 10,
  hypotheses: 5,
  checks: 5,
  limitations: 5,
  evidencePerClaim: 10,
} as const;

/** Plain text only: no control characters (a line break is fine), and no
 * links, because DataSentinel never follows a link found in model output
 * (docs/05). */
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((c) => {
    const code = c.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
  });
const hasLink = (value: string): boolean => /(https?:|ftp:|www\.|\/\/[a-z0-9])/i.test(value);
const hasMarkup = (value: string): boolean => /<\/?[a-z!][^>]*>/i.test(value);

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !hasControlCharacter(v), 'Plain text only.')
    .refine((v) => !hasLink(v), 'Links are not allowed.')
    .refine((v) => !hasMarkup(v), 'Markup is not allowed.');

const evidenceIds = z
  .array(z.uuid())
  .min(1, 'Every claim needs evidence.')
  .max(REPORT_LIMITS.evidencePerClaim);

export const InvestigationReport = z
  .strictObject({
    schemaVersion: z.literal(INVESTIGATION_SCHEMA_VERSION),
    summary: text(REPORT_LIMITS.summary),
    /** What the evidence shows. Not guesses. */
    facts: z
      .array(z.strictObject({ statement: text(REPORT_LIMITS.statement), evidenceIds }))
      .max(REPORT_LIMITS.facts),
    /** What might explain it. Guesses, each with its own confidence. */
    hypotheses: z
      .array(
        z.strictObject({
          statement: text(REPORT_LIMITS.statement),
          confidence: z.enum(investigationConfidences),
          evidenceIds,
        }),
      )
      .max(REPORT_LIMITS.hypotheses),
    /** Read-only things a person could look at. Never run by the system. */
    suggestedChecks: z
      .array(z.strictObject({ description: text(REPORT_LIMITS.check) }))
      .max(REPORT_LIMITS.checks),
    /** What the report could not know. At least one: no report is complete. */
    limitations: z.array(text(REPORT_LIMITS.limitation)).min(1).max(REPORT_LIMITS.limitations),
    confidence: z.enum(investigationConfidences),
  })
  .superRefine((report, ctx) => {
    // High confidence has to rest on more than one piece of evidence.
    report.hypotheses.forEach((h, i) => {
      if (h.confidence === 'high' && new Set(h.evidenceIds).size < 2) {
        ctx.addIssue({
          code: 'custom',
          path: ['hypotheses', i, 'confidence'],
          message: 'High confidence needs at least two pieces of evidence.',
        });
      }
    });
    if (report.facts.length === 0 && report.confidence !== 'low') {
      ctx.addIssue({
        code: 'custom',
        path: ['confidence'],
        message: 'A report with no facts can only be low confidence.',
      });
    }
  });
export type InvestigationReport = z.infer<typeof InvestigationReport>;

export type ReportCheck =
  { ok: true; report: InvestigationReport } | { ok: false; problems: string[] };

/** Validates untrusted model output (D-100). `knownEvidenceIds` are the
 * evidence rows of this incident: a report citing anything else is rejected,
 * so a model cannot invent or borrow evidence. At most 10 problems come
 * back, as plain strings that never echo the model's text. */
export function checkInvestigationReport(
  value: unknown,
  knownEvidenceIds: ReadonlySet<string>,
): ReportCheck {
  const parsed = InvestigationReport.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.') || 'report'}: ${i.message}`),
    };
  }
  const report = parsed.data;
  const cited = [...report.facts, ...report.hypotheses].flatMap((c) => c.evidenceIds);
  const unknown = [...new Set(cited)].filter((id) => !knownEvidenceIds.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      problems: [`evidence: ${unknown.length} cited id(s) do not belong to this incident.`],
    };
  }
  return { ok: true, report };
}

/** Stored investigation reports (D-108). A report row is created `pending`
 * by the API and finished by the worker as `ready` or `failed`; completed
 * rows never change. The incident and its checks never wait for it. */
export const investigationStatuses = ['pending', 'ready', 'failed'] as const;
export type InvestigationStatus = (typeof investigationStatuses)[number];

/** Why a report failed: short codes, never provider text. */
export const investigationFailureCodes = [
  'ai_disabled',
  'budget_exceeded',
  'input_too_large',
  'unavailable',
  'timeout',
  'rate_limited',
  'rejected',
  'invalid_response',
  'not_json',
  'invalid_report',
  'redaction_failed',
  'worker_interrupted',
  'incident_not_found',
] as const;
export type InvestigationFailureCode = (typeof investigationFailureCodes)[number];

/** Version of the prompt template; stored with every report (D-108). */
export const PROMPT_TEMPLATE_VERSION = 1;

/** At most this many reports a day per incident, so regenerating cannot
 * run up the provider bill. */
export const INVESTIGATIONS_PER_INCIDENT_PER_DAY = 10;

export const investigationRatings = ['helpful', 'not_helpful'] as const;

/** POST …/investigations/{id}/feedback (analyst or above). */
export const InvestigationFeedbackRequest = z.strictObject({
  rating: z.enum(investigationRatings),
  note: z.string().trim().max(500).optional(),
});
export type InvestigationFeedbackRequest = z.infer<typeof InvestigationFeedbackRequest>;

export type InvestigationReportItem = {
  id: string;
  version: number;
  status: InvestigationStatus;
  failureCode: InvestigationFailureCode | null;
  /** Present only when ready. */
  report: InvestigationReport | null;
  templateVersion: number;
  schemaVersion: number;
  providerName: string | null;
  model: string | null;
  excerptCount: number;
  createdAt: string;
  completedAt: string | null;
  feedback: {
    mine: (typeof investigationRatings)[number] | null;
    helpful: number;
    notHelpful: number;
  };
};
