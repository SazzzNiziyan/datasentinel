import type { ServerEnv } from '@datasentinel/config';

/** What this deployment says about AI investigation (D-99). */
export interface AiConfig {
  /** The flag is on and provider, region, and retention are all disclosed. */
  available: boolean;
  provider: string | null;
  region: string | null;
  retention: string | null;
}

export const AI_CONFIG = Symbol('AI_CONFIG');

/** Reads the environment on first use, like the other lazy providers, so the
 * API starts (and tests run) without these settings. */
export function lazyAiConfig(load: () => ServerEnv): AiConfig {
  let loaded: AiConfig | undefined;
  const get = () =>
    (loaded ??= (() => {
      const env = load();
      const provider = env.AI_PROVIDER_NAME ?? null;
      const region = env.AI_PROVIDER_REGION ?? null;
      const retention = env.AI_RETENTION_NOTE ?? null;
      return {
        available: env.FEATURE_AI && provider !== null && region !== null && retention !== null,
        provider,
        region,
        retention,
      };
    })());
  return {
    get available() {
      return get().available;
    },
    get provider() {
      return get().provider;
    },
    get region() {
      return get().region;
    },
    get retention() {
      return get().retention;
    },
  };
}
