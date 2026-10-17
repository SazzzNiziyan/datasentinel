import { S3Client } from '@aws-sdk/client-s3';
import type { ServerEnv } from '@datasentinel/config';
import { randomUUID } from 'node:crypto';

/** Settings for the private uploads bucket (D-38). */
export type StorageSettings = Pick<
  ServerEnv,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_BUCKET_UPLOADS'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
>;

/** One client per process. The bucket is private: objects are reached only
 * with these credentials or short-lived signed URLs, never anonymously. */
export function createStorageClient(settings: StorageSettings): S3Client {
  return new S3Client({
    endpoint: settings.S3_ENDPOINT,
    region: settings.S3_REGION,
    forcePathStyle: settings.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: settings.S3_ACCESS_KEY_ID,
      secretAccessKey: settings.S3_SECRET_ACCESS_KEY,
    },
  });
}

/** A new, unguessable key for an uploaded file. Nothing the user typed goes
 * into it (not the filename), so keys cannot collide, be guessed, or climb
 * out of the workspace's prefix. The original filename is stored separately. */
export function uploadObjectKey(workspaceId: string): string {
  return `workspaces/${workspaceId}/uploads/${randomUUID()}`;
}
