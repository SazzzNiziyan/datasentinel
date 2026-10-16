import { z } from 'zod';

/** POST /auth/sessions body. Limits stop oversized input before hashing. */
export const SignInRequest = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

/** Error body for every API failure (docs/04 §1, RFC 9457 shape). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** The request ID, so users can quote it to support. */
  instance: string;
  /** Stable application code, e.g. "invalid_credentials". */
  code: string;
}
