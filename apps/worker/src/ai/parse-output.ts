import { checkInvestigationReport, type InvestigationReport } from '@datasentinel/contracts';

export type ParsedOutput =
  | { ok: true; report: InvestigationReport }
  | { ok: false; reason: 'not_json' | 'invalid_report'; problems: string[] };

/** One fenced block, which some models add around JSON. */
const FENCED = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i;

/** Turns the model's reply into a report or a safe rejection (D-107). The
 * reply must be exactly one JSON object, optionally in a single code fence;
 * prose around it, several objects, or anything else is refused, never
 * "fixed up". The object must then pass the strict report schema, and may
 * cite only this incident's own evidence. Rejections carry short problem
 * strings that never echo the model's text, so nothing from a bad reply
 * reaches a log or the UI. */
export function parseModelOutput(
  reply: string,
  knownEvidenceIds: ReadonlySet<string>,
): ParsedOutput {
  const trimmed = reply.trim();
  const body = FENCED.exec(trimmed)?.[1]?.trim() ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'not_json', problems: ['The reply was not a single JSON object.'] };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not_json', problems: ['The reply was not a single JSON object.'] };
  }
  const checked = checkInvestigationReport(value, knownEvidenceIds);
  return checked.ok
    ? { ok: true, report: checked.report }
    : { ok: false, reason: 'invalid_report', problems: checked.problems };
}
