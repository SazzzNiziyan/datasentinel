import type { z } from 'zod';
import { apiEnv, workerEnv, type ApiEnv, type ServerEnv } from './env.ts';

export type { ApiEnv, ServerEnv };
export { decodeKey, KEY_BYTES } from './secret-key.ts';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Thrown when configuration is missing or invalid. The message lists every
 * problem by variable name and never contains a value, so it is safe to log.
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(app: string, problems: readonly string[]) {
    super(`Invalid ${app} configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function parse<S extends z.ZodType>(app: string, schema: S, env: Env): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  // Built from path and message only; issue input values are never copied.
  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(environment)';
    // Zod omits the input from issues, so check the environment directly.
    const missing = issue.code === 'invalid_type' && env[name] === undefined;
    return `${name} ${missing ? 'is required' : issue.message}`;
  });
  throw new ConfigError(app, problems);
}

/** Validates the API process environment. Call once at startup. */
export function loadApiEnv(env: Env = process.env): ApiEnv {
  return parse('api', apiEnv, env);
}

/** Validates the worker process environment. Call once at startup. */
export function loadWorkerEnv(env: Env = process.env): ServerEnv {
  return parse('worker', workerEnv, env);
}
