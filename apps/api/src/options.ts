import type { LoggingOptions } from './logging/logging.js';

/** Everything the API module needs from its caller. main.ts builds it from
 * the validated environment; tests pass their own values. */
export interface AppOptions extends LoggingOptions {
  databaseUrl: string;
  redisUrl: string;
  /** The web app's origin: the only one allowed to change state. */
  webOrigin: string;
  /** Secure cookies need HTTPS; true in production. */
  secureCookies: boolean;
}

export const APP_OPTIONS = Symbol('APP_OPTIONS');
