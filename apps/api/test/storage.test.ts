import { DeleteObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createStorageClient, uploadObjectKey } from '../src/storage/storage.js';

describe('upload object keys', () => {
  it('are random and stay under the workspace prefix', () => {
    const workspaceId = randomUUID();
    const a = uploadObjectKey(workspaceId);
    const b = uploadObjectKey(workspaceId);
    assert.notEqual(a, b);
    assert.match(a, new RegExp(`^workspaces/${workspaceId}/uploads/[0-9a-f-]{36}$`));
  });
});

const env = process.env;
const settings = {
  S3_ENDPOINT: env.S3_ENDPOINT ?? '',
  S3_REGION: env.S3_REGION ?? 'us-east-1',
  S3_FORCE_PATH_STYLE: env.S3_FORCE_PATH_STYLE === 'true',
  S3_BUCKET_UPLOADS: env.S3_BUCKET_UPLOADS ?? '',
  S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID ?? '',
  S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY ?? '',
};

async function storageSkipReason(): Promise<string | false> {
  if (settings.S3_ENDPOINT === '') return 'S3_ENDPOINT is not set';
  try {
    await createStorageClient(settings).send(
      new HeadBucketCommand({ Bucket: settings.S3_BUCKET_UPLOADS }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
    return false;
  } catch {
    return 'local storage is not running (pnpm services:up)';
  }
}

describe('uploads bucket', { skip: await storageSkipReason() }, () => {
  const urlFor = (key: string) => `${settings.S3_ENDPOINT}/${settings.S3_BUCKET_UPLOADS}/${key}`;

  it('refuses anonymous writes', async () => {
    const put = await fetch(urlFor(uploadObjectKey(randomUUID())), {
      method: 'PUT',
      body: 'a,b\n',
    });
    assert.ok(put.status === 403 || put.status === 401, `anonymous PUT gave ${put.status}`);
  });

  it('refuses anonymous reads of an object that exists', async () => {
    const client = createStorageClient(settings);
    const Key = uploadObjectKey(randomUUID());
    await client.send(
      new PutObjectCommand({ Bucket: settings.S3_BUCKET_UPLOADS, Key, Body: 'a,b\n1,2\n' }),
    );
    try {
      const get = await fetch(urlFor(Key));
      assert.ok(get.status === 403 || get.status === 401, `anonymous GET gave ${get.status}`);
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: settings.S3_BUCKET_UPLOADS, Key }));
    }
  });
});
