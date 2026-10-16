import { z } from 'zod';
import { decodeKey } from './secret-key.ts';

const nonEmpty = z.string().trim().min(1, 'is required');

/** Digits only: rejects '0x10', '1e3', and '1.0', which Number() would accept. */
function wholeNumber(min: number, max: number) {
  return z
    .string()
    .trim()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`));
}

/** A URL with one of the given schemes and a host (`postgresql:` alone is rejected). */
function serviceUrl(protocol: RegExp, error: string) {
  return z.url({ protocol, hostname: /.+/, error });
}

// Zod runs refinements even after z.url() rejected the value, so they must
// not throw: URL.parse returns null instead. Invalid URLs are reported once.
const httpUrl = serviceUrl(/^https?$/, 'must be an http(s) URL').refine((value) => {
  const url = URL.parse(value);
  return url === null || (url.username === '' && url.password === '');
}, 'must not contain credentials');

/** Exactly what browsers send in the Origin header: no path, query, or trailing slash. */
const origin = httpUrl.refine((value) => {
  const url = URL.parse(value);
  return url === null || url.origin === value;
}, 'must be an origin such as https://app.example.com (no path or trailing slash)');

const key = nonEmpty.transform((value, ctx) => {
  const decoded = decodeKey(value);
  if (decoded === undefined) {
    ctx.addIssue({ code: 'custom', message: 'must be base64 for exactly 32 bytes' });
    return z.NEVER;
  }
  return decoded;
});

/** Settings every server process (API and worker) needs. */
const serverEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: serviceUrl(/^postgres(ql)?$/, 'must be a postgresql:// URL with a host'),
  REDIS_URL: serviceUrl(/^rediss?$/, 'must be a redis:// or rediss:// URL with a host'),

  S3_ENDPOINT: httpUrl,
  S3_REGION: nonEmpty,
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  S3_BUCKET_UPLOADS: nonEmpty,
  S3_ACCESS_KEY_ID: nonEmpty,
  S3_SECRET_ACCESS_KEY: nonEmpty,

  SECRETS_ENCRYPTION_KEY: key,
  SECRETS_ENCRYPTION_KEY_VERSION: wholeNumber(1, Number.MAX_SAFE_INTEGER),
});

const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

/** API process: server settings plus HTTP, session, and sign-in providers. */
const apiEnv = serverEnv
  .extend({
    API_PORT: wholeNumber(1, 65_535).default(3000),
    WEB_ORIGIN: origin,
    SESSION_SECRET: key,
    OAUTH_CALLBACK_BASE_URL: httpUrl,
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    GITHUB_CLIENT_ID: optional,
    GITHUB_CLIENT_SECRET: optional,
  })
  .superRefine((env, ctx) => {
    // Zod runs this check even when fields failed, and then a field may hold
    // its raw input instead of the transformed type. Check at runtime.
    // One key per purpose: a leaked session key must not decrypt stored secrets.
    const session: unknown = env.SESSION_SECRET;
    const encryption: unknown = env.SECRETS_ENCRYPTION_KEY;
    if (Buffer.isBuffer(session) && Buffer.isBuffer(encryption) && session.equals(encryption)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'must be different from SECRETS_ENCRYPTION_KEY',
      });
    }
    // A provider is enabled by setting both values; half a pair is a mistake.
    for (const provider of ['GOOGLE', 'GITHUB'] as const) {
      const id = env[`${provider}_CLIENT_ID`];
      const secret = env[`${provider}_CLIENT_SECRET`];
      if ((id === undefined) !== (secret === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: [id === undefined ? `${provider}_CLIENT_ID` : `${provider}_CLIENT_SECRET`],
          message: `is required when the other ${provider} value is set`,
        });
      }
    }
    if (env.NODE_ENV === 'production') {
      for (const name of ['WEB_ORIGIN', 'OAUTH_CALLBACK_BASE_URL'] as const) {
        // Invalid URLs already have their own issue; only judge parseable ones.
        const url = URL.parse(String(env[name]));
        if (url !== null && url.protocol !== 'https:') {
          ctx.addIssue({ code: 'custom', path: [name], message: 'must use https in production' });
        }
      }
    }
  });

export type ServerEnv = z.output<typeof serverEnv>;
export type ApiEnv = z.output<typeof apiEnv>;

export { apiEnv, serverEnv };
