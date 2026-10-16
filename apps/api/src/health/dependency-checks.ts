import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { ServerEnv } from '@datasentinel/config';
import type { DependencyName } from '@datasentinel/contracts';
import { Redis } from 'ioredis';
import pg from 'pg';

export type { DependencyName };

/** Resolves when the dependency answers; rejects otherwise. */
export interface DependencyCheck {
  readonly name: DependencyName;
  check(): Promise<void>;
}

/** Injection token for the list of readiness checks. */
export const DEPENDENCY_CHECKS = Symbol('DEPENDENCY_CHECKS');

/** Each check gives up after this long, so readiness answers quickly. */
export const CHECK_TIMEOUT_MS = 2000;

/** Real checks against the configured services. Each opens a short-lived
 * connection: fine for a health probe, and nothing stays open on failure. */
export function createDependencyChecks(env: ServerEnv): DependencyCheck[] {
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    maxAttempts: 1,
  });

  return [
    {
      name: 'database',
      async check() {
        const client = new pg.Client({
          connectionString: env.DATABASE_URL,
          connectionTimeoutMillis: CHECK_TIMEOUT_MS,
          query_timeout: CHECK_TIMEOUT_MS,
        });
        try {
          await client.connect();
          await client.query('SELECT 1');
        } finally {
          await client.end().catch(() => {});
        }
      },
    },
    {
      name: 'redis',
      async check() {
        const client = new Redis(env.REDIS_URL, {
          lazyConnect: true,
          connectTimeout: CHECK_TIMEOUT_MS,
          maxRetriesPerRequest: 0,
          retryStrategy: () => null,
        });
        // Connection errors are reported by connect(); without a listener
        // ioredis would also print them as unhandled.
        client.on('error', () => {});
        try {
          await client.connect();
          await client.ping();
        } finally {
          client.disconnect();
        }
      },
    },
    {
      name: 'storage',
      async check() {
        await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET_UPLOADS }), {
          abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
      },
    },
  ];
}
