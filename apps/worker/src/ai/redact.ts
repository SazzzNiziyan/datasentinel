/** Redaction and minimization before anything goes to an AI provider
 * (D-102). The main protection is structural: only typed, aggregate incident
 * facts are ever put into a prompt, never rows. This is the second layer: every
 * string that is included is scrubbed of identifiers and secrets, and the
 * final text is checked once more. Names of people cannot be recognised by
 * pattern; that is why no row value is ever included. */

export type RedactionKind = 'url' | 'email' | 'secret' | 'ip' | 'number';
export type RedactionCounts = Partial<Record<RedactionKind, number>>;

/** Ordered: broader, more specific shapes first. */
const RULES: { kind: RedactionKind; pattern: RegExp; replace: string }[] = [
  { kind: 'url', pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s"'<>]+/gi, replace: '[url]' },
  { kind: 'secret', pattern: /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, replace: '[secret]' },
  {
    kind: 'secret',
    pattern:
      /\b(?:sk|pk|rk)-[\w-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[\w]{20,}|\bwhsec_[\w-]{8,}|\bdsp_[\w-]{16,}|\bxox[abprs]-[\w-]{10,}/g,
    replace: '[secret]',
  },
  { kind: 'secret', pattern: /\bBearer\s+[\w.~+/=-]{8,}/gi, replace: 'Bearer [secret]' },
  {
    kind: 'secret',
    pattern: /\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[:=]\s*)[^\s,;"']+/gi,
    replace: '$1$2[secret]',
  },
  { kind: 'email', pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, replace: '[email]' },
  { kind: 'secret', pattern: /\b[A-Fa-f0-9]{32,}\b/g, replace: '[secret]' },
  { kind: 'secret', pattern: /[A-Za-z0-9+/_-]{40,}={0,2}/g, replace: '[secret]' },
  { kind: 'ip', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replace: '[ip]' },
  { kind: 'ip', pattern: /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, replace: '[ip]' },
  // Phone, card, and national-ID shapes: long digit runs with separators.
  { kind: 'number', pattern: /\+?\d[\d\s().-]{7,}\d/g, replace: '[number]' },
];

export function redactText(
  value: string,
  counts: RedactionCounts = {},
): { text: string; counts: RedactionCounts } {
  let text = value;
  for (const { kind, pattern, replace } of RULES) {
    text = text.replace(pattern, (...args) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      // Keep $1/$2 style replacements working with a function replacer.
      return replace.replace(/\$(\d)/g, (_, n: string) => String(args[Number(n)] ?? ''));
    });
  }
  return { text, counts };
}

export class RedactionError extends Error {
  constructor() {
    super('The AI input still contained something that must not leave DataSentinel.');
    this.name = 'RedactionError';
  }
}

/** The last check on the finished prompt text: if redacting it again would
 * change anything, something slipped through and nothing is sent. Redacted
 * text is a fixed point, so a clean text passes unchanged. */
export function assertRedacted(text: string): void {
  if (redactText(text).text !== text) throw new RedactionError();
}
