import { z } from 'zod';

/** What a workspace admin sees about AI investigation (D-99). The provider,
 * region, and retention note come from the deployment's configuration and
 * are null until the deployer sets them; AI is unavailable until they are. */
export type AiSettings = {
  /** The deployment allows AI and has disclosed provider, region, retention. */
  available: boolean;
  /** This workspace opted in. Never true while `available` is false. */
  enabled: boolean;
  provider: string | null;
  region: string | null;
  retention: string | null;
};

/** PUT …/ai-settings (admin or owner, audited). Turning AI on needs an
 * explicit acknowledgement that incident facts, redacted, go to the named
 * provider. Turning it off needs nothing. */
export const UpdateAiSettingsRequest = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({ enabled: z.literal(true), acknowledge: z.literal(true) }),
]);
export type UpdateAiSettingsRequest = z.infer<typeof UpdateAiSettingsRequest>;
