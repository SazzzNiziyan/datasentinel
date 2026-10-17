import type { PrismaClient } from '@datasentinel/db';

/** What the provider is asked (D-101). Text only: the caller has already
 * redacted it (D-102). */
export interface LlmRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
}

export interface LlmResponse {
  text: string;
  /** The model that answered, as the provider names it; stored with the report. */
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

/** Provider-neutral completion. A real provider is one class implementing
 * this; no vendor, SDK, or URL is known to the rest of the worker. The
 * signal aborts the call at the deadline. */
export interface LlmProvider {
  complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

export type LlmErrorCode =
  | 'unavailable'
  | 'timeout'
  | 'rate_limited'
  | 'rejected'
  | 'budget_exceeded'
  | 'input_too_large'
  | 'invalid_response';

/** A failed call. Carries a code and whether trying again can help; never
 * the prompt, the response, or anything the provider said (D-101). */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    readonly retryable: boolean,
  ) {
    super(`The AI provider call failed: ${code}.`);
    this.name = 'LlmError';
  }
}

/** Used until a provider is configured: investigation fails visibly. */
export const unconfiguredLlm: LlmProvider = {
  complete: () => Promise.reject(new LlmError('unavailable', false)),
};

export interface LlmLimits {
  /** Per attempt. */
  timeoutMs: number;
  /** Tries in all, including the first. */
  maxAttempts: number;
  /** Wait before the second and later tries. */
  backoffMs: readonly number[];
  maxInputChars: number;
  maxOutputChars: number;
  /** Most tokens one workspace may use per UTC day. */
  dailyTokenBudget: number;
}

export const DEFAULT_LLM_LIMITS: Omit<LlmLimits, 'dailyTokenBudget'> = {
  timeoutMs: 30_000,
  maxAttempts: 3,
  backoffMs: [1_000, 4_000],
  maxInputChars: 24_000,
  maxOutputChars: 20_000,
};

/** Counts tokens against a workspace's daily budget (D-101). */
export interface UsageLedger {
  /** Atomically takes `tokens` from the day's budget; false (and nothing
   * taken) if that would pass `budget`. */
  reserve(workspaceId: string, day: Date, tokens: number, budget: number): Promise<boolean>;
  /** Adjusts the day's count by `delta` (negative gives tokens back). */
  adjust(workspaceId: string, day: Date, delta: number): Promise<void>;
}

/** The UTC calendar day a call counts against. */
export const usageDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Roughly four characters a token, rounded up: only a reservation, the
 * provider's own count settles it. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export function prismaUsageLedger(prisma: PrismaClient): UsageLedger {
  return {
    async reserve(workspaceId, day, tokens, budget) {
      if (tokens > budget) return false;
      // One statement: the row is created or raised only while it stays
      // within the budget, so parallel calls cannot overspend together.
      const rows = await prisma.$queryRaw<{ tokens: number }[]>`
        INSERT INTO ai_usage_daily (workspace_id, day, tokens, calls)
        VALUES (${workspaceId}::uuid, ${day}::date, ${tokens}, 1)
        ON CONFLICT (workspace_id, day) DO UPDATE
           SET tokens = ai_usage_daily.tokens + ${tokens}, calls = ai_usage_daily.calls + 1
         WHERE ai_usage_daily.tokens + ${tokens} <= ${budget}
        RETURNING tokens`;
      return rows.length === 1;
    },
    async adjust(workspaceId, day, delta) {
      await prisma.$executeRaw`
        UPDATE ai_usage_daily SET tokens = GREATEST(tokens + ${delta}, 0)
         WHERE workspace_id = ${workspaceId}::uuid AND day = ${day}::date`;
    },
  };
}

export interface LlmDeps {
  provider: LlmProvider;
  ledger: UsageLedger;
  limits: LlmLimits;
  /** Tests replace both. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const toLlmError = (error: unknown): LlmError => {
  if (error instanceof LlmError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return new LlmError('timeout', true);
  return new LlmError('unavailable', true);
};

/** One provider call with every limit applied (D-101): input size, the
 * workspace's daily token budget (reserved first, so it holds under
 * concurrency, and given back on failure), a deadline per attempt, a few
 * retries with backoff for errors that can pass, and a cap on what comes
 * back. Throws only LlmError. */
export async function callLlm(
  deps: LlmDeps,
  workspaceId: string,
  request: LlmRequest,
): Promise<LlmResponse> {
  const { provider, ledger, limits } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const inputChars = request.system.length + request.user.length;
  if (inputChars > limits.maxInputChars) throw new LlmError('input_too_large', false);

  const day = usageDay((deps.now ?? (() => new Date()))());
  const reserved = estimateTokens(inputChars) + request.maxOutputTokens;
  if (!(await ledger.reserve(workspaceId, day, reserved, limits.dailyTokenBudget))) {
    throw new LlmError('budget_exceeded', false);
  }

  let last = new LlmError('unavailable', true);
  for (let attempt = 1; attempt <= limits.maxAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(limits.backoffMs[Math.min(attempt - 2, limits.backoffMs.length - 1)] ?? 0);
    }
    try {
      const response = await provider.complete(request, AbortSignal.timeout(limits.timeoutMs));
      if (
        typeof response.text !== 'string' ||
        response.text.length > limits.maxOutputChars ||
        !Number.isFinite(response.inputTokens) ||
        !Number.isFinite(response.outputTokens)
      ) {
        throw new LlmError('invalid_response', false);
      }
      // Settle: the provider's count replaces the reservation.
      const used = Math.max(0, Math.round(response.inputTokens + response.outputTokens));
      await ledger.adjust(workspaceId, day, used - reserved);
      return response;
    } catch (error) {
      last = toLlmError(error);
      if (!last.retryable) break;
    }
  }
  // Nothing came back to pay for: give the reservation back.
  await ledger.adjust(workspaceId, day, -reserved);
  throw last;
}
