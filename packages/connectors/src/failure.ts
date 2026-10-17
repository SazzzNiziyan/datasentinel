/**
 * Normalized connector failures (docs/02 §6, D-35). Users see only these
 * fixed messages and hints, never driver or provider text, which can quote
 * hosts, usernames, queries, or data.
 */
export const failureCodes = [
  'invalid_config',
  'unreachable',
  'timeout',
  'auth_failed',
  'permission_denied',
  'not_found',
  'unsupported',
  'too_large',
  'malformed',
  'busy',
  'internal',
] as const;

export type FailureCode = (typeof failureCodes)[number];

interface FailureText {
  message: string;
  hint: string;
  retryable: boolean;
}

const text: Record<FailureCode, FailureText> = {
  invalid_config: {
    message: 'The connection settings are not valid.',
    hint: 'Check each field and save again.',
    retryable: false,
  },
  unreachable: {
    message: 'DataSentinel could not reach the source.',
    hint: 'Check the host and port, and that the source accepts connections from DataSentinel.',
    retryable: true,
  },
  timeout: {
    message: 'The source did not answer in time.',
    hint: 'Try again later. If it keeps happening, check the load on the source.',
    retryable: true,
  },
  auth_failed: {
    message: 'The source rejected the username or password.',
    hint: 'Check the credentials, or rotate them in the source settings.',
    retryable: false,
  },
  permission_denied: {
    message: 'The account cannot read this data.',
    hint: 'Grant read-only access to the tables DataSentinel checks.',
    retryable: false,
  },
  not_found: {
    message: 'The table, file, or endpoint was not found.',
    hint: 'Check that it still exists and the name is spelled correctly.',
    retryable: false,
  },
  unsupported: {
    message: 'This kind of data is not supported yet.',
    hint: 'See the list of supported sources and column types.',
    retryable: false,
  },
  too_large: {
    message: 'The input is larger than the allowed limit.',
    hint: 'Split the file, or check a smaller table or time range.',
    retryable: false,
  },
  malformed: {
    message: 'The data could not be read.',
    hint: 'Check that the file is valid CSV with a header row and UTF-8 text.',
    retryable: false,
  },
  busy: {
    message: 'DataSentinel is already running as many queries on this source as it allows.',
    hint: 'Try again in a minute.',
    retryable: true,
  },
  internal: {
    message: 'The check failed because of a problem on our side.',
    hint: 'Try again. If it keeps failing, contact support with the request reference.',
    retryable: true,
  },
};

/** A connector failure that is safe to show and store. The original error
 * stays in `cause` for server logs only (scrub it before logging). */
export class ConnectorFailure extends Error {
  readonly code: FailureCode;
  readonly hint: string;
  readonly retryable: boolean;

  constructor(code: FailureCode, options?: { cause?: unknown }) {
    super(text[code].message, options);
    this.name = 'ConnectorFailure';
    this.code = code;
    this.hint = text[code].hint;
    this.retryable = text[code].retryable;
  }

  /** The safe form for API responses, job results, and evidence. */
  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, retryable: this.retryable };
  }
}

/** True for a ConnectorFailure, even from another copy of this package. */
export function isConnectorFailure(error: unknown): error is ConnectorFailure {
  return (
    error instanceof Error &&
    error.name === 'ConnectorFailure' &&
    failureCodes.includes((error as { code?: unknown }).code as FailureCode)
  );
}
