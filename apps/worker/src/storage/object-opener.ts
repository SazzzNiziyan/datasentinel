import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import type { ServerEnv } from '@datasentinel/config';
import type { ObjectOpener } from '../jobs/parse-upload.js';

type StorageSettings = Pick<
  ServerEnv,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_BUCKET_UPLOADS'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
>;

/** Reads uploads from the private bucket with the worker's credentials
 * (D-38). The body is streamed, never buffered whole. */
export function s3ObjectOpener(settings: StorageSettings): ObjectOpener {
  const client = new S3Client({
    endpoint: settings.S3_ENDPOINT,
    region: settings.S3_REGION,
    forcePathStyle: settings.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: settings.S3_ACCESS_KEY_ID,
      secretAccessKey: settings.S3_SECRET_ACCESS_KEY,
    },
  });
  return async (key, signal) => {
    try {
      const object = await client.send(
        new GetObjectCommand({ Bucket: settings.S3_BUCKET_UPLOADS, Key: key }),
        { abortSignal: signal },
      );
      // In Node the body is a Readable, which is an async iterable of bytes.
      return (object.Body as AsyncIterable<Uint8Array> | undefined) ?? null;
    } catch (error) {
      if (error instanceof NoSuchKey || (error as { name?: unknown }).name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  };
}
