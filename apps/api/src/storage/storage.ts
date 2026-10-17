import { HeadObjectCommand, NotFound, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { UploadInstructions } from '@datasentinel/contracts';
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

/** What storage reports about a stored object. */
export interface StoredObject {
  sizeBytes: number;
  /** Lowercase hex, or null when the provider does not report one. */
  sha256: string | null;
}

/** The two storage calls the upload routes need; tests replace it. */
export interface UploadStorage {
  /** A short-lived PUT URL whose signature covers size and checksum. */
  signUpload(key: string, sizeBytes: number, sha256: string): Promise<UploadInstructions>;
  /** Null when nothing is stored under the key. */
  stat(key: string): Promise<StoredObject | null>;
}

export const UPLOAD_STORAGE = Symbol('UPLOAD_STORAGE');

/** Signed upload URLs live 15 minutes. */
export const UPLOAD_URL_SECONDS = 15 * 60;

const hexToBase64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const base64ToHex = (b64: string) => Buffer.from(b64, 'base64').toString('hex');

/** Reads its settings on first use, so the API starts (and tests run)
 * without storage variables until an upload route needs them. */
export class S3UploadStorage implements UploadStorage {
  private s3?: { client: S3Client; bucket: string };

  constructor(private readonly loadSettings: () => StorageSettings) {}

  private get target() {
    if (this.s3 === undefined) {
      const settings = this.loadSettings();
      this.s3 = { client: createStorageClient(settings), bucket: settings.S3_BUCKET_UPLOADS };
    }
    return this.s3;
  }

  async signUpload(key: string, sizeBytes: number, sha256: string): Promise<UploadInstructions> {
    const checksum = hexToBase64(sha256);
    const { client, bucket } = this.target;
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentLength: sizeBytes,
      ContentType: 'text/csv',
      ChecksumSHA256: checksum,
    });
    const url = await getSignedUrl(client, command, {
      expiresIn: UPLOAD_URL_SECONDS,
      // Signed headers: storage refuses a different size or content.
      signableHeaders: new Set(['content-length', 'content-type', 'x-amz-checksum-sha256']),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    });
    return {
      method: 'PUT',
      url,
      // Browsers set Content-Length themselves from the file.
      headers: { 'content-type': 'text/csv', 'x-amz-checksum-sha256': checksum },
      expiresAt: new Date(Date.now() + UPLOAD_URL_SECONDS * 1000).toISOString(),
    };
  }

  async stat(key: string): Promise<StoredObject | null> {
    try {
      const { client, bucket } = this.target;
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }),
      );
      return {
        sizeBytes: head.ContentLength ?? 0,
        sha256: head.ChecksumSHA256 === undefined ? null : base64ToHex(head.ChecksumSHA256),
      };
    } catch (error) {
      if (error instanceof NotFound || (error as { name?: unknown }).name === 'NotFound') {
        return null;
      }
      throw error;
    }
  }
}
